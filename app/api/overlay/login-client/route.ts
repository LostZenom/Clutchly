import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { findSteamClientUser, loginViaSteamClient } from "@/src/worker/steamClient";
import { ensureLiveFeed } from "@/src/worker/liveFeed";

/** Idempotently set Steam keys in the project .env so the session survives restarts. */
function writeEnv(patch: Record<string, string>): void {
  const file = path.join(process.cwd(), ".env");
  let lines: string[] = [];
  if (fs.existsSync(file)) lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const done = new Set<string>();
  const out = lines.map((line) => {
    for (const [key, value] of Object.entries(patch)) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
        done.add(key);
        return `${key}="${value}"`;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(patch)) {
    if (!done.has(key)) out.push(`${key}="${value}"`);
  }
  try {
    fs.writeFileSync(file, out.join("\n").replace(/\n+/g, "\n") + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * POST /api/overlay/login-client
 * One-click auto-login: uses the Steam desktop client session already logged in
 * on this PC (refresh token from loginusers.vdf) — no username/password needed.
 * On success it applies the account to the running process and starts the feed.
 */
export async function POST(): Promise<NextResponse> {
  const found = findSteamClientUser();
  if (!found) {
    return NextResponse.json({
      ok: false,
      message: "No logged-in Steam client found — open Steam and log in once, then retry.",
    });
  }

  const result = await loginViaSteamClient();
  if (!result.ok) {
    return NextResponse.json(result);
  }

  // Apply the session to the running process + persist it for later restarts.
  process.env.STEAM_GC_ACCOUNT_NAME = result.accountName || found.accountName;
  process.env.STEAM_GC_REFRESH_TOKEN = found.refreshToken;
  if (result.steamId) process.env.OVERLAY_TRACK_STEAM64 = result.steamId;
  writeEnv({
    STEAM_GC_ACCOUNT_NAME: result.accountName || found.accountName,
    STEAM_GC_REFRESH_TOKEN: found.refreshToken,
    ...(result.steamId ? { OVERLAY_TRACK_STEAM64: result.steamId } : {}),
  });

  try {
    await ensureLiveFeed();
    return NextResponse.json({
      ok: true,
      steamId: result.steamId,
      accountName: result.accountName,
      feedStarted: true,
      message: `Auto-logged in as ${result.accountName} ✓ — live feed started.`,
    });
  } catch {
    return NextResponse.json({
      ok: true,
      steamId: result.steamId,
      accountName: result.accountName,
      feedStarted: false,
      message: `Auto-logged in as ${result.accountName} ✓ — start “npm run feed” to watch live games.`,
    });
  }
}