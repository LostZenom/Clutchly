import { NextResponse } from "next/server";
import { z } from "zod";
import { syncReplays, defaultReplaysDir } from "@/lib/replays";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // each demo takes ~30-90s to parse

const Body = z.object({
  steamId: z.string().regex(/^\d{17}$/),
});

/**
 * POST /api/matches/sync-replays
 * Body: { steamId }
 * Scans the local CS2 replays folder and parses every new .dem (all 10 players
 * per match), exactly like leetify's desktop app — no share codes needed.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Provide a valid 17-digit steamId." },
      { status: 400 },
    );
  }

  try {
    const result = await syncReplays(defaultReplaysDir());
    return NextResponse.json({ ok: true, steamId: body.steamId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}