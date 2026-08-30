import { prisma } from "@/lib/prisma";
import { getPlayer } from "@/lib/profile";
import type { PartialStats, ProviderName } from "@/lib/stats/types";

export interface ProviderResult {
  name: ProviderName;
  data: PartialStats;
  /** When true the provider simply had nothing to contribute (not an error). */
  empty: boolean;
}

/** Steam Web API: identity + CS2 hours (never empty — always resolvable). */
export async function steamProvider(steam64: string): Promise<ProviderResult> {
  const p = await getPlayer(steam64).catch(() => null);
  if (!p) return { name: "steam", data: {}, empty: true };
  return {
    name: "steam",
    empty: false,
    data: {
      username: p.username !== steam64 ? p.username : null,
      avatarUrl: p.avatarUrl,
      level: p.level,
      country: p.country,
      profileUrl: p.profileUrl,
      vacBans: p.vacBans,
      gameBans: p.gameBans,
      cs2Hours: p.cs2Hours,
      cs2Hours2Weeks: p.cs2Hours2Weeks,
    },
  };
}

/** Local replays / parsed demos from the database: matches, maps, weapons, totals. */
export async function replaysProvider(steam64: string): Promise<ProviderResult> {
  const rows = await prisma.playerMatchStat
    .findMany({
      where: { userSteam64: steam64 },
      include: { match: { select: { id: true, shareCode: true, mapName: true, scoreCT: true, scoreT: true, winningTeam: true, matchDate: true } } },
    })
    .catch(() => []);

  if (rows.length === 0) return { name: "replays", data: {}, empty: true };

  const matches: NonNullable<PartialStats["matches"]> = rows.map((r) => ({
    id: r.match.id,
    shareCode: r.match.shareCode,
    map: r.match.mapName,
    scoreCT: r.match.scoreCT,
    scoreT: r.match.scoreT,
    winningTeam:
      r.match.winningTeam === "CT" || r.match.winningTeam === "T"
        ? r.match.winningTeam
        : null,
    outcome:
      r.match.winningTeam == null ? "TIE" : r.match.winningTeam === r.team ? "WIN" : "LOSS",
    date: r.match.matchDate.toISOString(),
    kills: r.kills,
    deaths: r.deaths,
    assists: r.assists,
    kdRatio: r.kdRatio,
    rating: r.hltvRating,
    adr: r.adr,
    mvp: r.mvp,
  }));

  // Totals
  const totals = rows.reduce(
    (acc, r) => {
      acc.kills += r.kills;
      acc.deaths += r.deaths;
      acc.assists += r.assists;
      acc.headshots += r.headshots;
      acc.adr += r.adr;
      acc.kast += r.kast;
      acc.hsPercent += r.hsPercent;
      return acc;
    },
    { matches: 0, wins: 0, losses: 0, ties: 0, kills: 0, deaths: 0, assists: 0, headshots: 0, kdRatio: 0, hltvRating: 0, adr: 0, kast: 0, hsPercent: 0 },
  );
  totals.matches = rows.length;
  totals.wins = rows.filter((r) => r.match.winningTeam === r.team).length;
  totals.losses = rows.filter((r) => r.match.winningTeam !== null && r.match.winningTeam !== r.team).length;
  totals.ties = rows.filter((r) => r.match.winningTeam === null).length;
  totals.kdRatio = totals.deaths ? totals.kills / totals.deaths : totals.kills;
  totals.hltvRating = totals.matches ? rows.reduce((s, r) => s + r.hltvRating, 0) / totals.matches : 0;
  totals.adr = totals.matches ? totals.adr / totals.matches : 0;
  totals.kast = totals.matches ? totals.kast / totals.matches : 0;
  totals.hsPercent = totals.matches ? totals.hsPercent / totals.matches : 0;

  // Per-map
  const byMap = new Map<string, { matches: number; wins: number; losses: number; ties: number; kdSum: number; ratingSum: number }>();
  for (const r of rows) {
    const m = byMap.get(r.match.mapName) ?? { matches: 0, wins: 0, losses: 0, ties: 0, kdSum: 0, ratingSum: 0 };
    m.matches += 1;
    if (r.match.winningTeam == null) m.ties += 1;
    else if (r.match.winningTeam === r.team) m.wins += 1;
    else m.losses += 1;
    m.kdSum += r.kdRatio;
    m.ratingSum += r.hltvRating;
    byMap.set(r.match.mapName, m);
  }
  const maps: NonNullable<PartialStats["maps"]> = [...byMap.entries()].map(([map, m]) => ({
    map,
    matches: m.matches,
    wins: m.wins,
    losses: m.losses,
    ties: m.ties,
    winRate: m.matches ? Math.round((m.wins / m.matches) * 100) : 0,
    kdRatio: m.matches ? m.kdSum / m.matches : 0,
    rating: m.matches ? m.ratingSum / m.matches : 0,
  }));

  // Per-weapon
  const weaponRows = await prisma.weaponMatchStat
    .groupBy({ by: ["weapon"], where: { userSteam64: steam64 }, _sum: { kills: true } })
    .catch(() => []);
  const weapons: NonNullable<PartialStats["weapons"]> = weaponRows.map((w) => ({
    weapon: w.weapon,
    kills: w._sum.kills ?? 0,
  }));

  return {
    name: "replays",
    empty: false,
    data: {
      username: rows[0].username || null,
      matches,
      maps,
      weapons,
      totals,
    },
  };
}

/** CS2 Game Coordinator: only contributes when GC creds + a stored auth code exist. */
export async function gcProvider(steam64: string): Promise<ProviderResult> {
  if (!process.env.STEAM_GC_ACCOUNT_NAME || !process.env.STEAM_GC_PASSWORD) {
    return { name: "gc", data: {}, empty: true };
  }
  const user = await prisma.user
    .findUnique({ where: { steam64 }, select: { matchAuthCode: true } })
    .catch(() => null);
  if (!user?.matchAuthCode) return { name: "gc", data: {}, empty: true };

  const { syncGcHistory } = await import("@/lib/gc");
  try {
    const result = await syncGcHistory(steam64, user.matchAuthCode, { parseLimit: 5 });
    // After parsing, the persisted rows are the source of truth — the replays
    // provider picks them up on the next aggregation.
    return { name: "gc", data: {}, empty: result.matchesFound === 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gc] sync failed for ${steam64}: ${message}`);
    return { name: "gc", data: {}, empty: true };
  }
}
