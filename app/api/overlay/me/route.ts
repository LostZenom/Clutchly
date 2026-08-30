import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CST_CAREER_PREFIX } from "@/lib/stats/persistCstracker";
import { getPlayer } from "@/lib/profile";
import { getPlayerHeaderData } from "@/lib/player-header";
import { loadPlayerExtras } from "@/lib/overlay";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const STEAM64_RE = /^\d{17}$/;

/**
 * GET /api/overlay/me
 * Returns everything the home page shows about the currently signed-in Steam
 * account (the one set by `/api/overlay/login-client` or `/api/overlay/login`):
 * profile, record (W/L/T), recent matches with kills, level, trust and bans.
 *
 * Pass `?steam64=` to override (e.g. from localStorage on the browser side);
 * otherwise it falls back to the env-tracked GC account.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  let steam64 = url.searchParams.get("steam64") || "";
  if (!STEAM64_RE.test(steam64)) steam64 = env.overlayTrackSteam64 || "";

  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json(
      { ok: false, error: "No Steam account linked yet — sign in first." },
      { status: 200 },
    );
  }

  try {
    const [profile, header, extras, rows] = await Promise.all([
      getPlayer(steam64).catch(() => null),
      getPlayerHeaderData(steam64).catch(() => null),
      loadPlayerExtras([steam64]).catch(() => new Map()),
      prisma.playerMatchStat
        .findMany({
          where: {
            userSteam64: steam64,
            match: { NOT: { shareCode: { startsWith: CST_CAREER_PREFIX } } },
          },
          include: { match: true },
          orderBy: { match: { matchDate: "desc" } },
          take: 8,
        })
        .catch(() => []),
    ]);

    const extras0 = extras.get(steam64);

    return NextResponse.json({
      ok: true,
      steam64,
      accountName: process.env.STEAM_GC_ACCOUNT_NAME || null,
      profile: {
        username: profile?.username || null,
        avatarUrl: profile?.avatarUrl || null,
        level: profile?.level ?? extras0?.level ?? null,
        cs2Hours: profile?.cs2Hours ?? null,
        cs2Hours2Weeks: profile?.cs2Hours2Weeks ?? null,
        country: profile?.country ?? null,
      },
      record: header?.record ?? { wins: 0, losses: 0, ties: 0 },
      premierRating: header?.premierRating ?? null,
      lastSyncedAt: header?.lastSyncedAt ?? null,
      trust: extras0?.trust ?? header?.trust ?? null,
      bans: extras0?.bans ?? null,
      recent: (header?.recent ?? []).slice(0, 8).map((r, i) => {
        const row = rows[i];
        return {
          outcome: r.outcome,
          scoreCT: r.scoreCT,
          scoreT: r.scoreT,
          mapName: row?.match.mapName ?? null,
          matchDate: row?.match.matchDate?.toISOString() ?? null,
          matchId: row?.matchId ?? null,
          kills: row?.kills ?? null,
          deaths: row?.deaths ?? null,
          assists: row?.assists ?? null,
          kdRatio: row?.kdRatio ?? null,
          hltvRating: row?.hltvRating ?? null,
          adr: row?.adr ?? null,
          mvp: row?.mvp ?? null,
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}