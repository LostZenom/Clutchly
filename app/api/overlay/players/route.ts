import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { type OverlayPlayer, type OverlayPayload, enrichOverlayPlayers } from "@/lib/overlay";
import { ensureLiveFeed } from "@/src/worker/liveFeed";

// MUST run at request time: Next 14 otherwise statically optimizes this route
// at build time (bakes a .body file) and the handler — including the live-feed
// start — never executes when the overlay polls it.
export const dynamic = "force-dynamic";

export const revalidate = 0;

const CAREER_PREFIX = "CST-CAREER-";
const LIVE_KEY = "overlay:live";

type FeedStatus = "live" | "waiting" | "last-match";

// The live GC feed must be running for the overlay to show the CURRENT game.
// It used to require a manual login to start — this starts it the first time
// anyone polls for players (the overlay polls every few seconds), so it comes
// up on its own at app launch. ensureLiveFeed is lock-guarded, so repeated
// triggers are no-ops. (Static import: the same as the login routes — dynamic
// imports of this module don't load in the standalone server.)
let feedStarted = false;
function maybeStartFeed(): void {
  if (feedStarted) return;
  feedStarted = true;
  console.log("[players] starting live feed…");
  ensureLiveFeed()
    .then((f) => console.log("[players] live feed resolved:", f.name))
    .catch((e: unknown) => {
      console.error("[players] live feed start failed:", e instanceof Error ? e.message : e);
    });
}

/**
 * GET /api/overlay/players
 * Everything the desktop overlay needs — everyone in the CURRENT game.
 *
 * Priority:
 *  1. A fresh live snapshot written by the GC live-feed worker (real players
 *     in the current game), when present and not expired.
 *  2. Otherwise the roster of the most recent real parsed match.
 *
 * `status` tells the UI whether the live feed is capturing (live), connected
 * but waiting for the account to enter a match (waiting), or not available so
 * it's showing the last parsed match (last-match).
 */
export async function GET(): Promise<NextResponse<OverlayPayload & { status: FeedStatus }>> {
  maybeStartFeed();

  // 1) Live GC snapshot first.
  const live = await prisma.statCache.findUnique({ where: { key: LIVE_KEY } }).catch(() => null);
  const fresh = !!live && live.expiresAt.getTime() > Date.now();
  const p = (live?.payload as OverlayPayload | null | undefined) ?? undefined;

  if (fresh && p?.live && Array.isArray(p.players) && p.players.length >= 2) {
    return NextResponse.json({
      ...p,
      players: await enrichOverlayPlayers(p.players as OverlayPlayer[]),
      status: "live",
      fetchedAt: live.fetchedAt.toISOString(),
    } as OverlayPayload & { status: FeedStatus });
  }

  // 2) Fall back to the latest parsed match.
  const match = await prisma.match
    .findFirst({
      where: { NOT: { shareCode: { startsWith: CAREER_PREFIX } } },
      orderBy: { matchDate: "desc" },
      select: {
        mapName: true,
        scoreCT: true,
        scoreT: true,
        matchDate: true,
        playerStats: {
          include: { user: { select: { username: true, avatarUrl: true } } },
        },
      },
    })
    .catch(() => null);

  const players: OverlayPlayer[] = match
    ? match.playerStats
        .filter((s) => s.steam64.length >= 17 && s.team !== "SPECTATOR")
        .map((s) => ({
          steam64: s.steam64,
          username: s.user?.username || s.username || s.steam64,
          avatarUrl: s.user?.avatarUrl ?? null,
          team: s.team as "CT" | "T",
          initial: (s.user?.username || s.username || "?").charAt(0).toUpperCase(),
          trust: null,
          bans: null,
          level: null,
        }))
        .sort((a, b) => (a.team === b.team ? a.username.localeCompare(b.username) : a.team === "CT" ? -1 : 1))
    : [];

  const status: FeedStatus = fresh ? "waiting" : "last-match";

  return NextResponse.json({
    live: false,
    inGame: players.length > 0,
    map: match?.mapName ?? null,
    scoreCT: match?.scoreCT ?? 0,
    scoreT: match?.scoreT ?? 0,
    round: 0,
    matchId: null,
    matchDate: match?.matchDate?.toISOString() ?? null,
    players: await enrichOverlayPlayers(players),
    status,
  } as OverlayPayload & { matchDate: string | null; status: FeedStatus });
}