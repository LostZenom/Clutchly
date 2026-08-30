import { NextResponse } from "next/server";
import { z } from "zod";
import { testGcConnection, ensureLiveFeed, type GcLoginResult } from "@/src/worker/liveFeed";

const Body = z.object({
  account: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  guardCode: z.string().max(32).optional(),
  twoFactorCode: z.string().max(32).optional(),
  trackedSteam64: z.string().max(32).optional(),
  apiKey: z.string().max(128).optional(),
});

/**
 * POST /api/overlay/login
 * Body: { account, password, guardCode?, twoFactorCode?, trackedSteam64?, apiKey? }
 *
 * One-click Steam setup: validates the credentials against the CS2 Game
 * Coordinator, then — on success — applies every field to the process
 * environment and starts the live GC feed, so the overlay goes live while you
 * play without running `npm run feed` manually.
 */
export async function POST(req: Request): Promise<NextResponse<GcLoginResult & { feedStarted?: boolean }>> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, message: "Provide account + password." } as GcLoginResult, {
      status: 400,
    });
  }

  const result = await testGcConnection({
    accountName: body.account,
    password: body.password,
    guardCode: body.guardCode,
    twoFactorCode: body.twoFactorCode,
  });

  if (result.ok) {
    // Apply everything to the running process, then start the feed.
    if (body.apiKey) process.env.STEAM_API_KEY = body.apiKey;
    process.env.STEAM_GC_ACCOUNT_NAME = body.account;
    process.env.STEAM_GC_PASSWORD = body.password;
    if (body.guardCode) process.env.STEAM_GC_GUARD_CODE = body.guardCode;
    if (body.twoFactorCode) process.env.STEAM_GC_2FA_CODE = body.twoFactorCode;
    if (body.trackedSteam64) process.env.OVERLAY_TRACK_STEAM64 = body.trackedSteam64;
    // The refresh token was persisted to .env by testGcConnection already;
    // keep the running process in sync too.
    if (result.refreshToken) process.env.STEAM_GC_REFRESH_TOKEN = result.refreshToken;

    try {
      await ensureLiveFeed();
      return NextResponse.json({
        ok: true,
        steamId: result.steamId,
        refreshToken: result.refreshToken,
        feedStarted: true,
        message: "Connected to Steam ✓ — live feed started. The overlay updates while you play.",
      });
    } catch {
      return NextResponse.json({
        ok: true,
        steamId: result.steamId,
        refreshToken: result.refreshToken,
        feedStarted: false,
        message: "Connected to Steam ✓ — start “npm run feed” to watch live games.",
      });
    }
  }

  return NextResponse.json(result);
}