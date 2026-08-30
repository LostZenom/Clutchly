import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveSteamId, getPlayerSummaries } from "@/lib/steam";
import { prisma } from "@/lib/prisma";

const Body = z.object({
  input: z.string().min(1).max(128),
});

/**
 * POST /api/steam/resolve
 * Body: { input: "steam64 | profile URL | vanity | steam2 | steam3" }
 * Resolves to a canonical Steam64 and returns enriched profile/profile data.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Provide a non-empty `input` string." }, { status: 400 });
  }

  try {
    const { kind, steam64 } = await resolveSteamId(body.input);

    // Enrich with the cached User row + a live Steam summary when possible.
    const [user, summaries] = await Promise.all([
      prisma.user.findUnique({ where: { steam64 } }).catch(() => null),
      getPlayerSummaries([steam64]).catch(() => [null]),
    ]);
    const profile = summaries[0];
    const username = profile?.personaname || user?.username || null;
    const avatarUrl = profile?.avatarfull || user?.avatarUrl || null;

    return NextResponse.json({
      steam64,
      kind,
      ok: true,
      profile: {
        username,
        avatarUrl,
        country: profile?.countrycode ?? user?.country ?? null,
        existing: !!user,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve Steam ID.";
    return NextResponse.json({ error: message, ok: false }, { status: 400 });
  }
}