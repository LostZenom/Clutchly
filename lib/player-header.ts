import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { AUTO_SYNC_MIN_AGE_MS } from "@/lib/stats/autoSync";
import { CST_CAREER_PREFIX } from "@/lib/stats/persistCstracker";
import type { PlayerStatsDto } from "@/lib/stats/types";

export interface PlayerHeaderData {
  record: { wins: number; losses: number; ties: number };
  /** Most recent outcomes, newest first (max 9), with the match score for hover tooltips. */
  recent: { outcome: "WIN" | "LOSS" | "TIE"; scoreCT: number; scoreT: number }[];
  premierRating: number | null;
  lastSyncedAt: string | null;
  /** True when the cstracker cache is missing or older than the auto-sync window — a look-up should trigger a background resync. */
  stale: boolean;
  /** Teammate-adjusted trust score (from the cstracker trust card). */
  trust: { value: number | null; level: "good" | "suspicious" | "bad" | null; updated: string | null } | null;
  /** FACEIT level + ELO (from the cstracker profile header badge). */
  faceit: {
    level: number | null;
    elo: number | null;
    iconSrc: string | null;
  } | null;
}

/**
 * Everything the profile-header card needs beyond the Steam profile itself.
 * React.cache keeps it to one fetch set per request, shared across layout +
 * page renders.
 */
export const getPlayerHeaderData = cache(async (steam64: string): Promise<PlayerHeaderData> => {
  const [matches, cacheRow] = await Promise.all([
    prisma.match
      .findMany({
        where: {
          playerStats: { some: { userSteam64: steam64 } },
          NOT: { shareCode: { startsWith: CST_CAREER_PREFIX } },
        },
        select: {
          matchOutcome: true,
          winningTeam: true,
          matchDate: true,
          scoreCT: true,
          scoreT: true,
          playerStats: { where: { userSteam64: steam64 }, select: { team: true } },
        },
        orderBy: { matchDate: "desc" },
        take: 120,
      })
      .catch(() => []),
    prisma.statCache
      .findUnique({ where: { key: `cstracker:${steam64}` } })
      .catch(() => null),
  ]);

  const outcomeOf = (m: (typeof matches)[number]): "WIN" | "LOSS" | "TIE" => {
    if (m.matchOutcome === "WIN" || m.matchOutcome === "LOSS" || m.matchOutcome === "TIE") {
      return m.matchOutcome;
    }
    const self = m.playerStats[0];
    if (m.winningTeam == null || !self) return "TIE";
    return m.winningTeam === self.team ? "WIN" : "LOSS";
  };

  const record = { wins: 0, losses: 0, ties: 0 };
  for (const m of matches) {
    const oc = outcomeOf(m);
    if (oc === "WIN") record.wins += 1;
    else if (oc === "LOSS") record.losses += 1;
    else record.ties += 1;
  }

  const recent = matches.slice(0, 9).map((m) => ({
    outcome: outcomeOf(m),
    scoreCT: m.scoreCT ?? 0,
    scoreT: m.scoreT ?? 0,
  }));

  let premierRating: number | null = null;
  let lastSyncedAt: string | null = null;
  let trust: PlayerHeaderData["trust"] = null;
  let faceit: PlayerHeaderData["faceit"] = null;
  let stale = true;
  if (cacheRow) {
    lastSyncedAt = cacheRow.fetchedAt.toISOString();
    stale = Date.now() - cacheRow.fetchedAt.getTime() > AUTO_SYNC_MIN_AGE_MS;
    const payload = cacheRow.payload as PlayerStatsDto | null;
    if (payload && typeof payload === "object" && "premierRating" in payload) {
      premierRating = payload.premierRating ?? null;
    }
    const extras = payload?.cstracker as PlayerStatsDto["cstracker"] | null;
    if (extras?.profile?.trust) trust = extras.profile.trust;
    const f = extras?.profile?.faceit;
    if (f?.connected && f.level != null) {
      faceit = { level: f.level, elo: f.elo, iconSrc: f.iconSrc };
    }
  }

  return { record, recent, premierRating, lastSyncedAt, stale, trust, faceit };
});
