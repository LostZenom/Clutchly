import { prisma } from "@/lib/prisma";
import type { CstrackerExtras } from "@/lib/stats/types";

/**
 * Persist a cstracker.gg extraction into the app's relational tables so the
 * existing player overview page (which reads Match / PlayerMatchStat /
 * WeaponMatchStat / ChatLog) shows the scraped data.
 *
 * Design:
 * - Every match in the embedded telemetry becomes a Match row (shareCode
 *   `CST-<cstrackerId>`) + a PlayerMatchStat row for the player, carrying the
 *   real per-match rating/ADR/KAST/K/D. W/L/T comes from the telemetry's
 *   player-relative `outcome` (stored in `matchOutcome`, since we don't know
 *   which side the player was on).
 * - Career kills/deaths/assists/headshots (from the "Detailed stats" panel)
 *   and career weapon kills (from the weapons table) are stored on ONE
 *   synthetic match per player: shareCode `CST-CAREER-<steam64>`. The
 *   overview page filters this synthetic row out of match lists/maps, but its
 *   PlayerMatchStat + WeaponMatchStat rows feed the career-summary cards and
 *   the weapons grid.
 * - Chat messages (from the HTMX /sections/chat fragment) are stored in
 *   ChatLog with deterministic ids (`cst-<messageId>`).
 *
 * Everything is upsert-based, so re-scraping is idempotent.
 */

export const CST_CAREER_PREFIX = "CST-CAREER-";

export function careerShareCode(steam64: string): string {
  return `${CST_CAREER_PREFIX}${steam64}`;
}

/** Run async work over a list with bounded concurrency (keeps DB load sane). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** cstracker pretty weapon name → demoparser-style key used by our SVG icons. */
const CST_WEAPON_KEYS: Record<string, string> = {
  "AK-47": "ak47",
  "M4A4": "m4a1",
  "M4A1-S": "m4a1_silencer",
  "M4A1 Silencer": "m4a1_silencer",
  "AWP": "awp",
  "SSG 08": "ssg08",
  "SCAR-20": "scar20",
  "G3SG1": "g3sg1",
  "Galil AR": "galilar",
  "FAMAS": "famas",
  "SG 553": "sg556",
  "AUG": "aug",
  "MP9": "mp9",
  "MP7": "mp7",
  "MP5-SD": "mp5sd",
  "MP5SD": "mp5sd",
  "MAC-10": "mac10",
  "PP-Bizon": "bizon",
  "UMP-45": "ump45",
  "P90": "p90",
  "XM1014": "xm1014",
  "Nova": "nova",
  "MAG-7": "mag7",
  "Sawed-Off": "sawedoff",
  "Glock-18": "glock",
  "USP-S": "usp_silencer",
  "USP Silencer": "usp_silencer",
  "P2000": "hkp2000",
  "P250": "p250",
  "Five-SeveN": "fiveseven",
  "Tec-9": "tec9",
  "CZ75-Auto": "cz75a",
  "Desert Eagle": "deagle",
  "R8 Revolver": "revolver",
  "Dual Berettas": "elite",
  "Zeus x27": "taser",
  "Taser": "taser",
  "Knife": "knife",
};

export function weaponKey(name: string): string {
  const direct = CST_WEAPON_KEYS[name];
  if (direct) return direct;
  // Last resort: lowercase alphanumeric slug (covers melee variants etc.).
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function num(str: string | null | undefined): number | null {
  if (str == null) return null;
  const f = parseFloat(String(str).replace(/[,%]/g, ""));
  return Number.isNaN(f) ? null : f;
}

function parseScore(score: string): { ct: number; t: number } {
  const parts = String(score).split(/[–—-]/).map((s) => Number(s.trim()));
  return { ct: Number.isFinite(parts[0]) ? parts[0] : 0, t: Number.isFinite(parts[1]) ? parts[1] : 0 };
}

function parseKda(kda: string | null | undefined): { kills: number; deaths: number; assists: number } | null {
  if (!kda) return null;
  const m = String(kda).match(/([\d,]+)\s*\/\s*([\d,]+)\s*\/\s*([\d,]+)/);
  if (!m) return null;
  return { kills: num(m[1]) ?? 0, deaths: num(m[2]) ?? 0, assists: num(m[3]) ?? 0 };
}

async function ensureUser(steam64: string, extras: CstrackerExtras): Promise<void> {
  const name = extras.profile.name ?? extras.directLookup?.name ?? steam64;
  await prisma.user
    .upsert({
      where: { steam64 },
      update: { username: name, lastSeenAt: new Date() },
      create: { steam64, username: name, lastSeenAt: new Date() },
    })
    .catch(() => {});
}

export interface PersistSummary {
  matches: number;
  playerStats: number;
  career: boolean;
  weapons: number;
  chat: number;
}

/** Upsert Match + PlayerMatchStat rows for every telemetry match (parallel, idempotent). */
async function persistMatches(steam64: string, extras: CstrackerExtras): Promise<{ matches: number; stats: number }> {
  const username = extras.profile.name ?? extras.directLookup?.name ?? steam64;

  // NOTE: per-match kills/deaths/assists are NOT stored here — the career
  // totals live on the synthetic career row (persistCareer), so the overview's
  // sums don't double-count. Per-match kdRatio/rating/adr/kast are real.

  // Phase 1: all Match rows (concurrency-bounded), remembering their ids.
  const shareToId = new Map<string, string>();
  await mapLimit(extras.matchTelemetry, 6, async (item) => {
    const shareCode = `CST-${item.id}`;
    const score = parseScore(item.score);
    const outcome: "WIN" | "LOSS" | "TIE" = item.outcome === "W" ? "WIN" : item.outcome === "L" ? "LOSS" : "TIE";
    const match = await prisma.match
      .upsert({
        where: { shareCode },
        update: { mapName: item.map, scoreCT: score.ct, scoreT: score.t, matchDate: new Date(item.ts * 1000), matchOutcome: outcome, parseStatus: "PARSED" },
        create: { shareCode, mapName: item.map, scoreCT: score.ct, scoreT: score.t, matchDate: new Date(item.ts * 1000), matchOutcome: outcome, parseStatus: "PARSED" },
      })
      .catch(() => null);
    if (match) shareToId.set(shareCode, match.id);
  });

  // Phase 2: PlayerMatchStat rows for the matches that exist.
  const statIds = await mapLimit(extras.matchTelemetry, 6, async (item) => {
    const matchId = shareToId.get(`CST-${item.id}`);
    if (!matchId) return null;
    return prisma.playerMatchStat
      .upsert({
        where: { matchId_userSteam64: { matchId, userSteam64: steam64 } },
        update: {
          // Keep career totals single-sourced on the career row — never
          // double-count K/D/A on the per-match rows.
          kills: 0,
          deaths: 0,
          assists: 0,
          headshots: 0,
          kdRatio: item.kd ?? 0,
          hltvRating: item.rating ?? 0,
          adr: item.adr ?? 0,
          kast: item.kast ?? 0,
        },
        create: {
          matchId,
          userSteam64: steam64,
          steam64,
          username,
          team: "CT",
          kills: 0,
          deaths: 0,
          assists: 0,
          kdRatio: item.kd ?? 0,
          hltvRating: item.rating ?? 0,
          adr: item.adr ?? 0,
          kast: item.kast ?? 0,
        },
      })
      .catch(() => null)
      .then((row) => row?.id ?? null);
  });

  return { matches: shareToId.size, stats: statIds.filter(Boolean).length };
}

/** Career totals + weapon kills on the synthetic career match. */
async function persistCareer(steam64: string, extras: CstrackerExtras): Promise<number> {
  const general = extras.detailedStats["general"] ?? {};
  const kda = parseKda(general["K/D/A"]);
  const headshots = num(general["HS kills"]) ?? 0;
  const hsPctMatch = String(general["HS kills"] ?? "").match(/([\d.]+)%/);
  const hsPercent = hsPctMatch ? num(hsPctMatch[1]) ?? 0 : 0;

  const telemetry = extras.matchTelemetry;
  const avgRating = telemetry.length ? telemetry.reduce((s, m) => s + (m.rating ?? 0), 0) / telemetry.length : 0;
  const avgAdr = telemetry.length ? telemetry.reduce((s, m) => s + (m.adr ?? 0), 0) / telemetry.length : 0;
  const avgKast = telemetry.length ? telemetry.reduce((s, m) => s + (m.kast ?? 0), 0) / telemetry.length : 0;

  const kills = kda?.kills ?? 0;
  const deaths = kda?.deaths ?? 0;
  const assists = kda?.assists ?? 0;
  if (kills === 0 && extras.weaponDetails.length === 0) return 0;

  const shareCode = careerShareCode(steam64);
  const match = await prisma.match
    .upsert({
      where: { shareCode },
      update: { mapName: "Career Summary", parseStatus: "PARSED", matchOutcome: null, winningTeam: null },
      create: { shareCode, mapName: "Career Summary", parseStatus: "PARSED", matchOutcome: null, matchDate: new Date() },
    })
    .catch(() => null);
  if (!match) return 0;

  await prisma.playerMatchStat
    .upsert({
      where: { matchId_userSteam64: { matchId: match.id, userSteam64: steam64 } },
      update: { kills, deaths, assists, headshots, hsPercent, kdRatio: deaths > 0 ? kills / deaths : kills, hltvRating: avgRating, adr: avgAdr, kast: avgKast },
      create: {
        matchId: match.id,
        userSteam64: steam64,
        steam64,
        username: extras.profile.name ?? steam64,
        team: "CT",
        kills,
        deaths,
        assists,
        headshots,
        hsPercent,
        kdRatio: deaths > 0 ? kills / deaths : kills,
        hltvRating: avgRating,
        adr: avgAdr,
        kast: avgKast,
      },
    })
    .catch(() => {});

  let weapons = 0;
  for (const w of extras.weaponDetails) {
    const key = weaponKey(w.weapon);
    if (!key || w.kills <= 0) continue;
    const row = await prisma.weaponMatchStat
      .upsert({
        where: { matchId_userSteam64_weapon: { matchId: match.id, userSteam64: steam64, weapon: key } },
        update: { kills: w.kills },
        create: { matchId: match.id, userSteam64: steam64, weapon: key, kills: w.kills },
      })
      .catch(() => null);
    if (row) weapons += 1;
  }
  return weapons;
}

/** Chat messages from the /sections/chat fragment → ChatLog. */
async function persistChat(steam64: string, extras: CstrackerExtras): Promise<number> {
  const messages = extras.chat?.messages ?? [];
  if (messages.length === 0) return 0;
  const username = extras.profile.name ?? extras.directLookup?.name ?? steam64;

  // Resolve each match once (many messages share a match) instead of one
  // findUnique per message. Creates a minimal Match row when the match isn't in
  // the telemetry (e.g. older matches).
  const matchIdByShare = new Map<string, string | null>();
  async function resolveMatch(matchId: string): Promise<string | null> {
    const shareCode = `CST-${matchId}`;
    const cached = matchIdByShare.get(shareCode);
    if (cached !== undefined) return cached;
    const existing = await prisma.match.findUnique({ where: { shareCode } }).catch(() => null);
    let id: string | null = existing?.id ?? null;
    if (!id) {
      const msg = messages.find((m) => m.matchId === matchId);
      const created = await prisma.match
        .create({
          data: {
            shareCode,
            mapName: msg?.map ?? "de_unknown",
            parseStatus: "PARSED",
            matchOutcome: null,
            matchDate: msg?.matchTs ? new Date(msg.matchTs * 1000) : new Date(),
          },
        })
        .catch(() => null);
      id = created?.id ?? null;
    }
    matchIdByShare.set(shareCode, id);
    return id;
  }

  const storedIds = await mapLimit(messages, 6, async (msg) => {
    const matchId = await resolveMatch(msg.matchId);
    if (!matchId) return null;
    const round = msg.round != null && msg.round > 0 ? msg.round - 1 : 0; // 0-based like the demo parser
    const row = await prisma.chatLog
      .upsert({
        where: { id: `cst-${msg.id}` },
        update: { message: msg.text, round, tick: msg.tickSeconds ?? 0, sentAt: msg.matchTs ? new Date(msg.matchTs * 1000) : new Date() },
        create: {
          id: `cst-${msg.id}`,
          matchId,
          userSteam64: steam64,
          username,
          message: msg.text,
          isTeamChat: false,
          round,
          tick: msg.tickSeconds ?? 0,
          sentAt: msg.matchTs ? new Date(msg.matchTs * 1000) : new Date(),
        },
      })
      .catch(() => null);
    return row?.id ?? null;
  });
  return storedIds.filter(Boolean).length;
}

/** Full idempotent persistence of a cstracker extraction. */
export async function persistCstracker(steam64: string, extras: CstrackerExtras): Promise<PersistSummary> {
  await ensureUser(steam64, extras);
  // Matches + career totals are independent — run them together. Chat rows
  // reference the Match rows, so it runs after matches exist.
  const [m, weapons] = await Promise.all([
    persistMatches(steam64, extras),
    persistCareer(steam64, extras),
  ]);
  const chat = await persistChat(steam64, extras);
  return { matches: m.matches, playerStats: m.stats, career: weapons > 0 || m.matches > 0, weapons, chat };
}