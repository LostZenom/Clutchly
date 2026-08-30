import * as cheerio from "cheerio";
import { prisma } from "@/lib/prisma";
import { getOrFetch } from "@/lib/stats/cache";
import { proxiedFetchText } from "@/lib/stats/proxies";

/**
 * cstracker.gg match report scraper.
 *
 * The match page (https://cstracker.gg/matches/<id>) is server-rendered with
 * the header (map, absolute team scores, played time, duration, server, avg
 * rank); the 10-player scoreboard is an HTMX fragment at
 * /matches/<id>/sections/scoreboard that renders two team panels with full
 * performance columns (K/D/A, +/-, ADR, HS%, KAST, HLTV, TRUST, FK, TRADE,
 * BHOP, MVP).
 *
 * Both are fetched through the rotating free-proxy pool (proxies.ts) and the
 * result is cached (6h) so the report page never waits on a cold scrape.
 */

export interface MatchReportPlayer {
  steam64: string | null;
  name: string | null;
  avatarUrl: string | null;
  ratingBefore: number | null;
  ratingAfter: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  flashAssists: number | null;
  kdDiff: number | null; // +/-
  adr: number | null;
  hsPercent: number | null;
  kast: number | null;
  hltv: number | null;
  trust: number | null;
  fk: number | null;
  trade: number | null;
  bhopPct: string | null;
  mvp: number | null;
}

export interface MatchReportTeam {
  side: "CT" | "T";
  name: string | null;
  score: number | null;
  win: boolean | null;
  avgElo: number | null;
  players: MatchReportPlayer[];
}

export interface MatchReport {
  matchId: string;
  map: string | null;
  /** Absolute team scores: ct : t (team 1 = CT, team 2 = T on cstracker). */
  score: { ct: number | null; t: number | null };
  playedTs: number | null;
  duration: string | null;
  server: string | null;
  avgRank: number | null;
  teams: MatchReportTeam[];
}

const TTL_SECONDS = 6 * 60 * 60;

function textOf($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string | null {
  const t = $(el).first().text().trim().replace(/\s+/g, " ");
  return t || null;
}

function num(str: string | null | undefined): number | null {
  if (str == null) return null;
  const f = parseFloat(String(str).replace(/[,%°$]/g, "").trim());
  return Number.isNaN(f) ? null : f;
}

function parseRatingChange(title: string | null, $: cheerio.CheerioAPI, cell: cheerio.Cheerio<any>) {
  let before: number | null = null;
  let after: number | null = null;
  const m = title?.match(/([\d,]+)\s*->\s*([\d,]+)/);
  if (m) {
    before = num(m[1]);
    after = num(m[2]);
  } else {
    const badges = $(cell).find(".cs2rating");
    if (badges.length >= 1) before = num(textOf($, badges.eq(0)));
    if (badges.length >= 2) after = num(textOf($, badges.eq(1)));
  }
  return { ratingBefore: before, ratingAfter: after };
}

function parseMatchHeader($: cheerio.CheerioAPI): {
  map: string | null;
  score: { ct: number | null; t: number | null };
  playedTs: number | null;
  duration: string | null;
  server: string | null;
  avgRank: number | null;
} {
  const map = textOf($, $("h1.display-serif-off"));
  const scoreNums = $(".display-num")
    .map((_, el) => num(textOf($, $(el))))
    .get()
    .filter((n): n is number => n != null);
  const score = { ct: scoreNums[0] ?? null, t: scoreNums[1] ?? null };

  let playedTs: number | null = null;
  const tsEl = $("[data-time-ago]").first();
  const tsRaw = tsEl.attr("data-time-ago");
  if (tsRaw && /^\d+$/.test(tsRaw)) playedTs = Number(tsRaw);

  let duration: string | null = null;
  let server: string | null = null;
  let avgRank: number | null = null;
  $(".meta-readout > span").each((_, raw) => {
    const span = $(raw);
    const label = textOf($, span.find(".label"))?.toLowerCase();
    const spanText = textOf($, span) ?? "";
    if (label === "dur") duration = spanText.replace(/^dur\s*/i, "").trim() || null;
    else if (label === "server") server = textOf($, span.find(".cursor-help")) ?? (spanText.replace(/^server\s*/i, "").trim() || null);
    else if (label === "avg·rank") avgRank = num(textOf($, span.find(".cs2rating")));
  });

  return { map, score, playedTs, duration, server, avgRank };
}

function parseTeamPanel($: cheerio.CheerioAPI, panel: cheerio.Cheerio<any>, side: "CT" | "T"): MatchReportTeam {
  const band = panel.find(".team-band").first();
  const name = textOf($, band.find(".display-serif-off"));
  const score = num(textOf($, band.find(".display-num")));
  const winStamp = textOf($, band.find(".stamp span"));
  const win = winStamp == null ? null : /win/i.test(winStamp);
  const avgElo = num(textOf($, band.find(".cs2rating")));

  const players: MatchReportPlayer[] = [];
  panel.find("tbody tr").each((_, rowRaw) => {
    const row = $(rowRaw);
    const tds = row.find("td");
    if (tds.length === 0) return;
    const first = tds.eq(0);

    const link = first.find('a[href^="/players/"]').first();
    const steam64 = (link.attr("href") ?? "").split("/players/").pop() ?? null;
    const img = first.find("img").first();
    const name = textOf($, link) ?? img.attr("alt") ?? null;
    const avatarUrl = img.attr("src") ?? null;
    const ratingCell = first.find("span[title^='Premier rating']").first();
    const rating = parseRatingChange(ratingCell.attr("title") ?? null, $, ratingCell);

    const at = (i: number) => textOf($, tds.eq(i));
    const aCell = at(3) ?? "";
    const aMatch = String(aCell).match(/([\d,]+)/);
    const flashMatch = String(aCell).match(/\+(\d+)/);

    players.push({
      steam64,
      name,
      avatarUrl,
      ...rating,
      kills: num(at(1)),
      deaths: num(at(2)),
      assists: aMatch ? num(aMatch[1]) : null,
      flashAssists: flashMatch ? num(flashMatch[1]) : null,
      kdDiff: num(at(4)),
      adr: num(at(5)),
      hsPercent: num(at(6)),
      kast: num(at(7)),
      hltv: num(at(8)),
      trust: num(at(9)),
      fk: num(at(10)),
      trade: num(at(11)),
      bhopPct: textOf($, tds.eq(12).find("div").first()) ?? at(12) ?? null,
      mvp: num(at(13)),
    });
  });

  return { side, name, score, win, avgElo, players };
}

/** Fetch + parse a cstracker.gg match report (header + scoreboard). */
export async function fetchMatchReport(matchId: string, opts: { force?: boolean } = {}): Promise<MatchReport> {
  const cacheKey = `cstracker-match:${matchId}`;
  if (!opts.force) {
    const cached = await getOrFetch(cacheKey, TTL_SECONDS, () => scrapeMatchReport(matchId), {
      source: "cstracker-match",
      allowStaleOnError: true,
    });
    return cached.data;
  }
  return scrapeMatchReport(matchId);
}

async function scrapeMatchReport(matchId: string): Promise<MatchReport> {
  const base = `https://cstracker.gg/matches/${matchId}`;
  const [pageHtml, scoreboardHtml] = await Promise.all([
    proxiedFetchText(base, { timeoutMs: 15_000 }),
    proxiedFetchText(`${base}/sections/scoreboard`, { timeoutMs: 15_000 }),
  ]);

  const $page = cheerio.load(pageHtml);
  const $sb = cheerio.load(scoreboardHtml);

  const header = parseMatchHeader($page);

  const teams: MatchReportTeam[] = [];
  $sb(".panel").each((_, raw) => {
    const panel = $sb(raw);
    const bandCls = panel.find(".team-band").attr("class") ?? "";
    if (bandCls.includes("team-band-ct")) teams.push(parseTeamPanel($sb, panel, "CT"));
    else if (bandCls.includes("team-band-t")) teams.push(parseTeamPanel($sb, panel, "T"));
  });
  // Ensure CT first even if the DOM order differs.
  teams.sort((a, b) => (a.side === "CT" ? -1 : 1) - (b.side === "CT" ? -1 : 1));

  return {
    matchId,
    map: header.map,
    score: header.score,
    playedTs: header.playedTs,
    duration: header.duration,
    server: header.server,
    avgRank: header.avgRank,
    teams,
  };
}

/** Invalidate the cached report (used by force-refresh flows). */
export async function invalidateMatchReport(matchId: string): Promise<void> {
  const { invalidateCache } = await import("@/lib/stats/cache");
  await invalidateCache(`cstracker-match:${matchId}`);
}

/**
 * Load a locally parsed (.dem) match as a MatchReport so the same report view
 * renders it: scoreboard from PlayerMatchStat, chat from ChatLog, server from
 * ServerLocation. Rating-before/after, trade, bhop and telemetry are cstracker
 * concepts and stay null for local matches.
 */
export interface LocalMatchChatMessage {
  id: string;
  round: number;
  tick: number;
  message: string;
  username: string;
  userSteam64: string;
  isTeamChat: boolean;
  sentAt: Date;
}

export async function fetchLocalMatchReport(matchId: string): Promise<{
  report: MatchReport;
  chat: LocalMatchChatMessage[];
} | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      playerStats: { include: { user: { select: { avatarUrl: true } } } },
      chatLogs: { orderBy: [{ round: "asc" }, { tick: "asc" }] },
      server: true,
    },
  });
  if (!match) return null;

  const toPlayer = (p: (typeof match.playerStats)[number]): MatchReportPlayer => ({
    steam64: p.steam64,
    name: p.username || p.steam64,
    avatarUrl: p.user?.avatarUrl ?? null,
    ratingBefore: null,
    ratingAfter: null,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    flashAssists: null,
    kdDiff: p.kills - p.deaths,
    adr: p.adr,
    hsPercent: p.hsPercent,
    kast: p.kast,
    hltv: p.hltvRating,
    trust: null,
    fk: p.firstKillCount,
    trade: null,
    bhopPct: null,
    mvp: p.mvp,
  });

  const team = (side: "CT" | "T") => ({
    side,
    name: side === "CT" ? "Counter-Terrorist" : "Terrorist",
    score: side === "CT" ? match.scoreCT : match.scoreT,
    win: match.winningTeam == null ? null : match.winningTeam === side,
    avgElo: null,
    players: match.playerStats.filter((p) => p.team === side).map(toPlayer),
  });

  const durationSecs = match.durationSecs;
  const report: MatchReport = {
    matchId,
    map: match.mapName.replace(/^de_/i, ""),
    score: { ct: match.scoreCT, t: match.scoreT },
    playedTs: Math.floor(match.matchDate.getTime() / 1000),
    duration:
      durationSecs != null
        ? `${Math.floor(durationSecs / 60)}m ${String(durationSecs % 60).padStart(2, "0")}s`
        : null,
    server: match.server?.city ?? match.server?.country ?? null,
    avgRank: null,
    teams: [team("CT"), team("T")].filter((t) => t.players.length > 0),
  };

  return {
    report,
    chat: match.chatLogs.map((m) => ({
      id: m.id,
      round: m.round,
      tick: m.tick,
      message: m.message,
      username: m.username,
      userSteam64: m.userSteam64,
      isTeamChat: m.isTeamChat,
      sentAt: m.sentAt,
    })),
  };
}
