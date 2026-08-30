import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { syncGcHistory } from "@/lib/gc";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // login + match list + a few demo parses

const Body = z.object({
  steamId: z.string().regex(/^\d{17}$/),
  /** The target player's CS2 Match History Authentication Code (opt-in sharing). */
  authCode: z.string().min(4).max(16),
  /** How many demos to download + parse in this request (default 5, repeat to continue). */
  parseLimit: z.number().int().min(1).max(20).optional(),
});

/**
 * POST /api/matches/sync-gc
 * Body: { steamId, authCode, parseLimit? }
 * Logs the app's Steam account into the CS2 Game Coordinator, fetches the
 * target player's match history (auth code), then downloads + parses demos —
 * the same pipeline cstracker/csstats use. Works for ANY player who has match
 * sharing enabled and whose auth code you provide.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Provide a valid steamId and the player's Match History Authentication Code." },
      { status: 400 },
    );
  }

  try {
    const result = await syncGcHistory(body.steamId, body.authCode, {
      parseLimit: body.parseLimit ?? 5,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * GET /api/matches/sync-gc?steamId=...
 * Returns the stored auth code for a profile (so the UI can prefill it).
 */
export async function GET(req: Request) {
  const steamId = new URL(req.url).searchParams.get("steamId") ?? "";
  if (!/^\d{17}$/.test(steamId)) {
    return NextResponse.json({ error: "Invalid steamId." }, { status: 400 });
  }
  const user = await prisma.user
    .findUnique({ where: { steam64: steamId }, select: { matchAuthCode: true } })
    .catch(() => null);
  return NextResponse.json({ ok: true, authCode: user?.matchAuthCode ?? null });
}

/**
 * PUT /api/matches/sync-gc
 * Body: { steamId, authCode }
 * Stores the auth code against the profile for future syncs.
 */
export async function PUT(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Provide a valid steamId and authCode." }, { status: 400 });
  }
  await prisma.user
    .upsert({
      where: { steam64: body.steamId },
      update: { matchAuthCode: body.authCode },
      create: { steam64: body.steamId, username: body.steamId, matchAuthCode: body.authCode },
    })
    .catch(() => null);
  return NextResponse.json({ ok: true });
}