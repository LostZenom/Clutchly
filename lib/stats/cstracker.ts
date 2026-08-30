import * as cheerio from "cheerio";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { proxiedFetchText } from "@/lib/stats/proxies";
import type {
  CstrackerChat,
  CstrackerChatMessage,
  CstrackerExtras,
  CstrackerHistoryRow,
  CstrackerInsightMode,
  CstrackerMatchTelemetryItem,
  CstrackerTelemetryCard,
  CstrackerWeaponDetail,
  MapStatDto,
  MatchDto,
  PartialStats,
  ProviderName,
  WeaponStatDto,
} from "@/lib/stats/types";

/**
 * cstracker.gg scraper.
 *
 * cstracker.gg is a Next.js app whose player pages are server-rendered with
 * everything embedded as HTML + data-attributes:
 *   - `[data-histogram-matches]` — the ~90 most-recent matches (rating/adr/kast)
 *   - `[data-histogram-config]`  — the telemetry cards (TTD, aim, preaim …)
 *   - `/sections/history`         — the full match-history table (KDA/ADR/…)
 *   - `/sections/weapons`         — the weapon breakdown table
 *   - `/sections/history-insights`— Premier/Wingman rank + win-rate
 *
 * So no headless browser is needed: proxy-rotate a plain GET and parse the HTML
 * with cheerio — a faithful server-side port of the "Profile Extractor"
 * userscript. Requests go through the rotating free-proxy pool (proxies.ts).
 */

const TTL_SECONDS = 12 * 60 * 60;

interface CstrackerResult {
  name: ProviderName;
  data: PartialStats;
  empty: boolean;
  fromCache: boolean;
}

// --- tiny helpers (mirror the userscript's `txt` / `num`) -------------------

function num(str: string | null | undefined): number | null {
  if (str == null) return null;
  const cleaned = String(str).replace(/[,%°$s]/g, "").trim();
  const f = parseFloat(cleaned);
  return Number.isNaN(f) ? null : f;
}

function textOf($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string | null {
  const t = $(el).first().text().trim().replace(/\s+/g, " ");
  return t || null;
}

function parseJsonAttr<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function firstNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).match(/-?[\d][\d,.]*/);
  if (!m) return null;
  return num(m[0]);
}

/** Extract the rating number from "6,559 played …" (null when none exists). */
function ratingBeforePlayed(text: string | null | undefined): number | null {
  if (!text) return null;
  const before = text.includes("played") ? text.slice(0, text.indexOf("played")) : text;
  if (!/\d/.test(before)) return null;
  return firstNumber(before);
}

function parseScore(score: string): { ct: number; t: number } {
  const parts = String(score).split(/[–—-]/).map((s) => Number(s.trim()));
  return { ct: Number.isFinite(parts[0]) ? parts[0] : 0, t: Number.isFinite(parts[1]) ? parts[1] : 0 };
}

// --- per-section extraction --------------------------------------------------

function extractDirectLookup($: cheerio.CheerioAPI) {
  const card = $("#search-direct-lookup").find('a[href^="/players/"]').first();
  if (card.length === 0) return null;
  const href = card.attr("href") ?? "";
  const matchesText = textOf($, card.find(".mono span")) ?? "";
  const m = matchesText.match(/(\d[\d,.]*)\s*matches?/);
  return {
    name: textOf($, card.find(".truncate")),
    rating: num(textOf($, card.find(".cs2rating"))),
    matches: m ? num(m[1]) : null,
    steam64: href.split("/players/").pop() ?? null,
  };
}

function extractProfile($: cheerio.CheerioAPI) {
  const section = $("#player-profile-section");
  const ratingText = textOf($, section.find(".cs2rating"));
  return {
    name: textOf($, section.find("h1")),
    rating: num(ratingText),
    ratingText,
    record: { wins: null, losses: null, ties: null },
    trust: extractTrust($),
    faceit: extractFaceit($),
  };
}

/** FACEIT badge in the profile header: level icon + ELO (title "FACEIT level 2 · 638 ELO"). */
function extractFaceit($: cheerio.CheerioAPI): CstrackerExtras["profile"]["faceit"] {
  const img = $('img[src*="faceit_levels"]').first();
  if (img.length === 0) return null;
  const badge = img.closest("span[title]").first();
  const title = badge.attr("title") ?? "";
  const m = String(title).match(/FACEIT\s+level\s+(\d+)\s*[·•]\s*([\d,]+)\s*ELO/i);
  if (!m) return null; // "FACEIT: no account" → not connected
  return {
    level: Number(m[1]) || null,
    elo: num(m[2]),
    connected: true,
    iconSrc: img.attr("src") ?? null,
  };
}

/** "// trust rating" card: value + level color (border-emerald/amber/red). */
function extractTrust($: cheerio.CheerioAPI) {
  const card = $("#player-trust-rating-card");
  if (card.length === 0) return null;
  const cls = card.attr("class") ?? "";
  const level: "good" | "suspicious" | "bad" | null = cls.includes("border-emerald")
    ? "good"
    : cls.includes("border-amber")
      ? "suspicious"
      : cls.includes("border-red")
        ? "bad"
        : null;
  const cardText = textOf($, card) ?? "";
  // e.g. "updated 20d ago Score breakdown …" → "20d ago"
  const updated = cardText.match(/updated\s+([\w.]+\s*[\w.]*\s*ago|\d[\w.]*\s*\w+)/i)?.[1]?.trim() ?? null;
  return {
    value: num(textOf($, card.find(".text-5xl"))),
    level,
    updated,
  };
}

function extractMatchTelemetry($: cheerio.CheerioAPI): CstrackerMatchTelemetryItem[] {
  const el = $("[data-histogram-matches]").first();
  if (el.length === 0) return [];
  const raw = el.attr("data-histogram-matches") ?? null;
  return parseJsonAttr<CstrackerMatchTelemetryItem[]>(raw) ?? [];
}

function extractTelemetryCards($: cheerio.CheerioAPI): Record<string, CstrackerTelemetryCard> {
  const out: Record<string, CstrackerTelemetryCard> = {};
  $("[data-histogram-config]").each((_, elRaw) => {
    const el = $(elRaw);
    const raw = el.attr("data-histogram-config") ?? null;
    const cfg = parseJsonAttr<{
      label?: string;
      valueKey?: string;
      lowerIsSuspicious?: boolean;
      suspiciousCutoff?: number;
      verySuspiciousCutoff?: number;
    }>(raw);
    if (!cfg?.label) return;
    out[cfg.label] = {
      label: cfg.label,
      valueKey: cfg.valueKey ?? "",
      percentile: textOf($, el.find("span.border")),
      value: textOf($, el.find(".text-xl.font-semibold")) ?? textOf($, el.find(".display-num")),
      lowerIsSuspicious: cfg.lowerIsSuspicious ?? false,
      suspiciousCutoff: cfg.suspiciousCutoff ?? null,
      verySuspiciousCutoff: cfg.verySuspiciousCutoff ?? null,
    };
  });
  return out;
}

function cellTone($: cheerio.CheerioAPI, cell: cheerio.Cheerio<any>): "danger" | "warn" | null {
  const cls = $(cell).attr("class") ?? "";
  if (cls.includes("text-red-400")) return "danger";
  if (cls.includes("text-amber-400")) return "warn";
  return null;
}

function parseRankCell(rankText: string | null): { before: number | null; after: number | null; delta: number | null } {
  if (!rankText) return { before: null, after: null, delta: null };
  const m = String(rankText).match(/^([\d,]+)\s*(?:([+-][\d,]+))?\s*(?:[⟶→]|->)?\s*([\d,]+)$/);
  if (!m) return { before: null, after: null, delta: null };
  return {
    before: num(m[1]),
    after: num(m[3]),
    delta: m[2] ? num(m[2]) : null,
  };
}

function extractHistoryTable($: cheerio.CheerioAPI): CstrackerHistoryRow[] {
  const rows: CstrackerHistoryRow[] = [];
  $(".player-history-table table tbody tr, #player-match-history-section table tbody tr, table tbody tr").each((_, rowRaw) => {
    const cells = $(rowRaw).find("td");
    if (cells.length < 3) return;
    const link = cells.eq(0).find('a[href*="/matches/"]').first();
    // The match cell renders like "Nuke13–9" — split map from score cleanly.
    const cell0Text = textOf($, cells.eq(0)) ?? "";
    const linkText = textOf($, link) ?? cell0Text;
    // Score lives in its own span — reading it directly avoids map names that
    // end in digits ("Dust2" + "4–13" must not become "Dust24–13").
    const scoreText = textOf($, link.find("span").first()) ?? linkText.match(/\d{1,2}\s*[–—-]\s*\d{1,2}/)?.[0] ?? null;

    // Sub-line under the map name: "Premier · Chicago". (dot in mt-0.5 escaped)
    const sub = cells.eq(0).find(".mt-0\\.5.text-xs").first();
    const cityEl = sub.find("span.cursor-help").first();
    const city = textOf($, cityEl);
    const modeText = textOf($, sub);
    const mode = modeText ? modeText.replace(city ?? "", "").replace(/\s+/g, " ").trim() || null : null;

    const rankText = textOf($, cells.eq(1));
    const rank = parseRankCell(rankText);

    const row: CstrackerHistoryRow = {
      matchId: (link.attr("href") ?? "").split("/matches/").pop() ?? null,
      map: linkText.replace(scoreText ?? "", "").trim() || null,
      score: scoreText,
      rank: rankText,
      mode,
      city,
      rankBefore: rank.before,
      rankAfter: rank.after,
      rankDelta: rank.delta,
      kda: textOf($, cells.eq(2)),
      kd: cells.length > 3 ? textOf($, cells.eq(3)) : null,
      adr: cells.length > 4 ? textOf($, cells.eq(4)) : null,
      rating: cells.length > 5 ? textOf($, cells.eq(5)) : null,
      kast: cells.length > 6 ? textOf($, cells.eq(6)) : null,
      acc: cells.length > 7 ? textOf($, cells.eq(7)) : null,
      preaim: cells.length > 8 ? textOf($, cells.eq(8)) : null,
      preaimTone: cells.length > 8 ? cellTone($, cells.eq(8)) : null,
      ttd: cells.length > 9 ? textOf($, cells.eq(9)) : null,
      ttdTone: cells.length > 9 ? cellTone($, cells.eq(9)) : null,
      when: cells.length > 10 ? textOf($, cells.eq(10)) : null,
    };
    if (row.matchId || row.map) rows.push(row);
  });
  return rows;
}

/** Chat archive fragment (HTMX /sections/chat): per-match groups + messages. */
function extractChat($: cheerio.CheerioAPI): CstrackerChat | null {
  const section = $("#player-chat-section");
  if (section.length === 0) return null;

  const headerText = textOf($, section.find("header")) ?? "";
  const countMatch = headerText.match(/([\d,]+)\s*messages?\s*·\s*([\d,]+)\s*matches?/);

  const messages: CstrackerChatMessage[] = [];
  section.find("section").each((_, groupRaw) => {
    const group = $(groupRaw);
    const link = group.find('a[href^="/matches/"]').first();
    const href = link.attr("href") ?? "";
    const matchId = href.split("/matches/").pop()?.split("#")[0] ?? null;
    if (!matchId) return;
    const map = textOf($, link);
    const tsEl = group.find("[data-time-ago]").first();
    const matchTs = tsEl.length ? Number(tsEl.attr("data-time-ago")) || null : null;

    group.find('a[href*="timeline-chat-"]').each((_, msgRaw) => {
      const a = $(msgRaw);
      const id = (a.attr("href") ?? "").split("timeline-chat-").pop() ?? null;
      const timeText = textOf($, a.find("span").first());
      const text = textOf($, a.find(".whitespace-pre-wrap").first());
      if (!id || !text) return;
      const roundMatch = timeText?.match(/R(\d+)/);
      const tickMatch = timeText?.match(/(\d+):(\d{2})(?:\.(\d+))?/);
      messages.push({
        id,
        matchId,
        map,
        round: roundMatch ? Number(roundMatch[1]) : null,
        timeText,
        tickSeconds: tickMatch ? Number(tickMatch[1]) * 60 + Number(tickMatch[2]) : null,
        text,
        matchTs,
      });
    });
  });

  return {
    messageCount: countMatch ? num(countMatch[1]) ?? messages.length : messages.length,
    matchCount: countMatch ? num(countMatch[2]) ?? 0 : 0,
    messages,
  };
}

/** "Kill breakdown" donut cards: // wallbangs 31 / 1,020 kills 3%. */
function extractKillProfile($: cheerio.CheerioAPI): CstrackerExtras["killProfile"] {
  const out: CstrackerExtras["killProfile"] = {};
  const section = $("section")
    .toArray()
    .find((s) => $(s).text().includes("Kill breakdown"));
  if (!section) return out;
  $(section)
    .find("[title]")
    .each((_, cardRaw) => {
      const card = $(cardRaw);
      const label = card
        .find(".mono")
        .filter((_, el) => /^\/\//.test($(el).text().trim()))
        .first();
      const labelText = textOf($, label);
      if (!labelText) return;
      out[labelText.replace(/^\/\/\s*/, "").trim()] = {
        fraction: textOf($, card.find(".mt-2.mono")),
        percent: textOf($, card.find(".mono.text-xs.font-semibold")),
        description: card.attr("title") ?? null,
      };
    });
  return out;
}

/** "Detailed stats" panels: { group: { rowLabel: value } }. */
function extractDetailedStats($: cheerio.CheerioAPI): CstrackerExtras["detailedStats"] {
  const out: CstrackerExtras["detailedStats"] = {};
  const section = $("section")
    .toArray()
    .find((s) => $(s).text().includes("Detailed stats"));
  if (!section) return out;
  $(section)
    .find(".panel.p-5.hud-frame")
    .each((_, panelRaw) => {
      const panel = $(panelRaw);
      const groupName = textOf($, panel.find(".text-\\[10px\\]").first());
      if (!groupName) return;
      const group: Record<string, string> = {};
      panel
        .find(".flex.items-baseline.justify-between")
        .each((_, rowRaw) => {
          const spans = $(rowRaw).find("span");
          if (spans.length < 2) return;
          const k = textOf($, spans.eq(0));
          const v = textOf($, spans.eq(1));
          if (k) group[k] = v ?? "";
        });
      out[groupName.replace(/^\/\/\s*/, "").trim()] = group;
    });
  return out;
}

function extractWeapons($: cheerio.CheerioAPI): CstrackerWeaponDetail[] {
  const out: CstrackerWeaponDetail[] = [];
  $("table tbody tr").each((_, rowRaw) => {
    const cells = $(rowRaw).find("td");
    if (cells.length < 3) return;
    const weapon = textOf($, cells.eq(0).find(".font-medium")) ?? textOf($, cells.eq(0));
    if (!weapon) return;
    const killsText = textOf($, cells.eq(1));
    const shotsText = cells.length > 3 ? textOf($, cells.eq(3)) : null;
    out.push({
      weapon,
      killsText,
      kills: firstNumber(killsText) ?? 0,
      headshotsFraction: killsText ? killsText.split("/").slice(1).join("/").trim() || null : null,
      headshotPct: cells.length > 2 ? textOf($, cells.eq(2)) : null,
      shots: shotsText,
      accuracyPct: cells.length > 4 ? textOf($, cells.eq(4)) : null,
      damage: cells.length > 5 ? textOf($, cells.eq(5)) : null,
      hitgroups: cells.length > 6 ? textOf($, cells.eq(6)) : null,
    });
  });
  return out;
}

function extractInsights($: cheerio.CheerioAPI): CstrackerInsightMode[] {
  const out: CstrackerInsightMode[] = [];
  $("table tbody tr").each((_, rowRaw) => {
    const cells = $(rowRaw).find("td");
    if (cells.length < 5) return;
    const mode = textOf($, cells.eq(0)) ?? "";
    if (!mode || /rank|mode|name/i.test(mode) && mode.length < 3) return;
    const rankText = textOf($, cells.eq(1));
    const bestText = textOf($, cells.eq(2));
    // e.g. "6,559 played 2026-08-16 00:06" -> rating 6559. Rows without a
    // rating read "played 2026-…" — don't mistake the year for a rating.
    const ratingNum = ratingBeforePlayed(rankText);
    const bestNum = ratingBeforePlayed(bestText);
    out.push({
      mode,
      rankRating: ratingNum != null ? String(ratingNum) : null,
      rankPlayed: rankText ?? null,
      bestRating: bestNum != null ? String(bestNum) : null,
      bestPlayed: bestText ?? null,
      matches: firstNumber(textOf($, cells.eq(3))) ?? 0,
      winRatePct: firstNumber(textOf($, cells.eq(4))) ?? 0,
    });
  });
  return out;
}

// --- provider ------------------------------------------------------------

function buildDto(extras: CstrackerExtras, telemetry: CstrackerMatchTelemetryItem[]): PartialStats {
  // Matches
  const matches: MatchDto[] = telemetry.map((m) => {
    const score = parseScore(m.score);
    const outcome: MatchDto["outcome"] = m.outcome === "W" ? "WIN" : m.outcome === "L" ? "LOSS" : "TIE";
    return {
      id: `cst-${m.id}`,
      shareCode: `CST-${m.id}`,
      map: m.map,
      scoreCT: score.ct,
      scoreT: score.t,
      winningTeam: null,
      outcome,
      date: new Date(m.ts * 1000).toISOString(),
      kills: 0,
      deaths: 0,
      assists: 0,
      kdRatio: m.kd ?? 0,
      rating: m.rating ?? 0,
      adr: m.adr ?? 0,
      mvp: 0,
    };
  });

  // Totals — telemetry gives matches/W/L + rating/adr; the embedded
  // "Detailed stats" panel gives true career kills/deaths/assists/HS.
  const general = extras.detailedStats["general"] ?? {};
  const kdaMatch = String(general["K/D/A"] ?? "").match(/([\d,]+)\s*\/\s*([\d,]+)\s*\/\s*([\d,]+)/);
  const careerKills = kdaMatch ? num(kdaMatch[1]) ?? 0 : 0;
  const careerDeaths = kdaMatch ? num(kdaMatch[2]) ?? 0 : 0;
  const careerAssists = kdaMatch ? num(kdaMatch[3]) ?? 0 : 0;
  const hsNum = firstNumber(general["HS kills"]);
  const hsPctMatch = String(general["HS kills"] ?? "").match(/([\d.]+)%/);

  const totals = {
    matches: matches.length,
    wins: matches.filter((m) => m.outcome === "WIN").length,
    losses: matches.filter((m) => m.outcome === "LOSS").length,
    ties: matches.filter((m) => m.outcome === "TIE").length,
    kills: careerKills,
    deaths: careerDeaths,
    assists: careerAssists,
    headshots: hsNum ?? 0,
    kdRatio: careerDeaths > 0 ? careerKills / careerDeaths : telemetry.length
      ? matches.reduce((s, m) => s + m.kdRatio, 0) / telemetry.length
      : 0,
    hltvRating: telemetry.length
      ? matches.reduce((s, m) => s + m.rating, 0) / telemetry.length
      : 0,
    adr: telemetry.length ? matches.reduce((s, m) => s + m.adr, 0) / telemetry.length : 0,
    kast: 0,
    hsPercent: hsPctMatch ? num(hsPctMatch[1]) ?? 0 : 0,
  };

  // Maps
  const byMap = new Map<string, { matches: number; wins: number; losses: number; ties: number; ratingSum: number; kdSum: number }>();
  for (const m of matches) {
    const g = byMap.get(m.map) ?? { matches: 0, wins: 0, losses: 0, ties: 0, ratingSum: 0, kdSum: 0 };
    g.matches += 1;
    if (m.outcome === "WIN") g.wins += 1;
    else if (m.outcome === "LOSS") g.losses += 1;
    else g.ties += 1;
    g.ratingSum += m.rating;
    g.kdSum += m.kdRatio;
    byMap.set(m.map, g);
  }
  const maps: MapStatDto[] = [...byMap.entries()].map(([map, g]) => ({
    map,
    matches: g.matches,
    wins: g.wins,
    losses: g.losses,
    ties: g.ties,
    winRate: g.matches ? Math.round((g.wins / g.matches) * 100) : 0,
    kdRatio: g.matches ? g.kdSum / g.matches : 0,
    rating: g.matches ? g.ratingSum / g.matches : 0,
  }));

  // Weapons
  const weapons: WeaponStatDto[] = extras.weaponDetails
    .filter((w) => w.kills > 0)
    .map((w) => ({ weapon: w.weapon, kills: w.kills }));

  const premier = (() => {
    const mode = extras.insights.find((i) => /premier/i.test(i.mode));
    if (mode?.rankRating != null) {
      const f = Number(String(mode.rankRating).replace(/,/g, ""));
      if (Number.isFinite(f)) return f;
    }
    return extras.profile.rating;
  })();
  return {
    username: extras.profile.name ?? extras.directLookup?.name ?? null,
    premierRating: premier,
    matches,
    maps,
    weapons,
    totals,
    cstracker: extras,
  };
}

interface ScrapeOptions {
  force?: boolean;
  /** Override page list (useful for tests / manual tooling). */
  urls?: Partial<Record<"profile" | "history" | "weapons" | "insights" | "lookup" | "chat", string>>;
}

const DEFAULT_URLS = {
  lookup: (id: string) => `https://cstracker.gg/search/direct-lookup?q=${id}`,
  profile: (id: string) => `https://cstracker.gg/players/${id}`,
  history: (id: string) => `https://cstracker.gg/players/${id}/sections/history`,
  weapons: (id: string) => `https://cstracker.gg/players/${id}/sections/weapons`,
  insights: (id: string) => `https://cstracker.gg/players/${id}/sections/history-insights`,
  chat: (id: string) => `https://cstracker.gg/players/${id}/sections/chat`,
};

/** Run the cstracker scrape for a Steam64 and return it as a PartialStats. */
export async function cstrackerProvider(steam64: string, opts: ScrapeOptions = {}): Promise<CstrackerResult> {
  if (process.env.CSTACKER_ENABLED === "false") {
    return { name: "cstracker", data: {}, empty: true, fromCache: false };
  }

  const cacheKey = `cstracker:${steam64}`;
  if (!opts.force) {
    const cached = await prisma.statCache.findUnique({ where: { key: cacheKey } }).catch(() => null);
    if (cached && cached.expiresAt.getTime() > Date.now()) {
      const payload = cached.payload as Record<string, unknown> | null;
      if (payload && typeof payload === "object") {
        return { name: "cstracker", data: payload as unknown as PartialStats, empty: false, fromCache: true };
      }
    }
  }

  const u = DEFAULT_URLS;
  const lookupUrl = opts.urls?.lookup ?? u.lookup(steam64);
  const profileUrl = opts.urls?.profile ?? u.profile(steam64);
  const historyUrl = opts.urls?.history ?? u.history(steam64);
  const weaponsUrl = opts.urls?.weapons ?? u.weapons(steam64);
  const insightsUrl = opts.urls?.insights ?? u.insights(steam64);
  const chatUrl = opts.urls?.chat ?? u.chat(steam64);

  // Fetch pages (each through a fresh rotating proxy). Failures are tolerated
  // per-section so a single dead proxy never blanks the whole profile. The
  // direct-lookup is a fallback name source only — cap its attempts so a dead
  // lookup proxy never drags the (parallel) batch.
  const pages = await Promise.allSettled([
    proxiedFetchText(lookupUrl, { maxAttempts: 2, timeoutMs: 6_000 }).then((html) => ({ kind: "lookup", html })),
    proxiedFetchText(profileUrl).then((html) => ({ kind: "profile", html })),
    proxiedFetchText(historyUrl).then((html) => ({ kind: "history", html })),
    proxiedFetchText(weaponsUrl).then((html) => ({ kind: "weapons", html })),
    proxiedFetchText(insightsUrl).then((html) => ({ kind: "insights", html })),
    proxiedFetchText(chatUrl).then((html) => ({ kind: "chat", html })),
  ]);

  const loaded = new Map<string, cheerio.CheerioAPI>();
  for (const p of pages) {
    if (p.status !== "fulfilled") {
      console.error(`[cstracker] ${p.reason instanceof Error ? p.reason.message : String(p.reason)}`);
      continue;
    }
    loaded.set(p.value.kind, cheerio.load(p.value.html));
  }

  const $profile = loaded.get("profile");
  if (!$profile) {
    return { name: "cstracker", data: {}, empty: true, fromCache: false };
  }

  const extras: CstrackerExtras = {
    sourceUrl: profileUrl,
    extractedAt: new Date().toISOString(),
    profile: extractProfile($profile),
    directLookup: loaded.get("lookup") ? extractDirectLookup(loaded.get("lookup")!) : null,
    telemetryCards: extractTelemetryCards($profile),
    matchTelemetry: extractMatchTelemetry($profile),
    historyTable: loaded.get("history") ? extractHistoryTable(loaded.get("history")!) : [],
    weaponDetails: loaded.get("weapons") ? extractWeapons(loaded.get("weapons")!) : [],
    insights: loaded.get("insights") ? extractInsights(loaded.get("insights")!) : [],
    killProfile: extractKillProfile($profile),
    detailedStats: extractDetailedStats($profile),
    chat: loaded.get("chat") ? extractChat(loaded.get("chat")!) : null,
  };

  const data = buildDto(extras, extras.matchTelemetry);
  const empty =
    (data.matches?.length ?? 0) === 0 &&
    (data.weapons?.length ?? 0) === 0 &&
    !extras.profile.name;

  if (!empty) {
    const payload = data as unknown as Prisma.InputJsonValue;
    await prisma.statCache
      .upsert({
        where: { key: cacheKey },
        update: { payload, source: "cstracker", fetchedAt: new Date(), expiresAt: new Date(Date.now() + TTL_SECONDS * 1000) },
        create: { key: cacheKey, payload, source: "cstracker", expiresAt: new Date(Date.now() + TTL_SECONDS * 1000) },
      })
      .catch(() => null);
  }

  return { name: "cstracker", data, empty, fromCache: false };
}

export async function invalidateCstrackerCache(steam64: string): Promise<void> {
  await prisma.statCache.deleteMany({ where: { key: `cstracker:${steam64}` } }).catch(() => {});
}