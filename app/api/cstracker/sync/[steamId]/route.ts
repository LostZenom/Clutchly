import { NextResponse } from "next/server";
import { z } from "zod";
import { isCstrackerSyncing, startCstrackerSync } from "@/lib/stats/autoSync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STEAM64_RE = /^\d{17}$/;
const Path = z.object({ steamId: z.string() });

/**
 * POST /api/cstracker/sync/[steamId]
 *
 * Starts a background cstracker.gg sync (scrape + persist) for the player and
 * returns immediately — the page never waits on a cold scrape. Deduped per
 * player: if a sync is already running, it just reports that. The caller polls
 * GET /api/cstracker/status/[steamId] and refreshes when it lands.
 */
export async function POST(
  _req: Request,
  { params }: { params: { steamId: string } },
) {
  const steam64 = Path.parse(params).steamId;
  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json({ ok: false, error: "Invalid Steam64." }, { status: 400 });
  }
  const { started } = startCstrackerSync(steam64);
  return NextResponse.json({
    ok: true,
    steam64,
    started,
    inFlight: isCstrackerSyncing(steam64),
  });
}
