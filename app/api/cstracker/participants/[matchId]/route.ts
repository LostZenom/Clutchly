import { NextResponse } from "next/server";
import { resolveMatchParticipants } from "@/lib/stats/participants";

/**
 * Scrape (via the cached proxy-aware match report) + persist the 10 players AND
 * their in-match chat for a cstracker match. Used by the chat archive to reveal
 * who a player was in a game with and what everyone said. Idempotent.
 */
export async function POST(
  request: Request,
  { params }: { params: { matchId: string } },
) {
  const matchId = params.matchId;
  if (!/^\d+$/.test(matchId)) {
    return NextResponse.json({ ok: false, error: "invalid match id" }, { status: 400 });
  }

  const selfSteam64 = new URL(request.url).searchParams.get("selfSteam64") ?? "";
  if (!/^\d{17}$/.test(selfSteam64)) {
    return NextResponse.json({ ok: false, error: "missing selfSteam64" }, { status: 400 });
  }

  try {
    const { participants, chatAdded, chatLogs } = await resolveMatchParticipants(matchId, selfSteam64);
    return NextResponse.json({ ok: true, matchId, participants, chatAdded, chatLogs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}