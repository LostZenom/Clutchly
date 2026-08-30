import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cstrackerProvider,
  invalidateCstrackerCache,
} from "@/lib/stats/cstracker";
import { persistCstracker } from "@/lib/stats/persistCstracker";
import { isCstrackerSyncing } from "@/lib/stats/autoSync";
import { proxyPoolStats } from "@/lib/stats/proxies";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STEAM64_RE = /^\d{17}$/;
const Path = z.object({ steamId: z.string() });

/**
 * GET /api/cstracker/[steamId]
 * Returns the full cstracker.gg extraction (profile + match telemetry + history
 * table + weapons + insights + chat) fetched through the rotating free-proxy
 * pool, and persists it into Match/PlayerMatchStat/WeaponMatchStat/ChatLog so
 * the player overview page shows it. Serves the cached copy when fresh.
 */
export async function GET(
  _req: Request,
  { params }: { params: { steamId: string } },
) {
  const steam64 = Path.parse(params).steamId;
  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json({ ok: false, error: "Invalid Steam64." }, { status: 400 });
  }
  const result = await cstrackerProvider(steam64);
  let persisted = null;
  if (!result.fromCache && !result.empty && result.data.cstracker) {
    persisted = await persistCstracker(steam64, result.data.cstracker);
  }
  return NextResponse.json({
    ok: true,
    steam64,
    empty: result.empty,
    fromCache: result.fromCache,
    persisted,
    proxies: proxyPoolStats(),
    data: result.data,
  });
}

/**
 * POST /api/cstracker/[steamId]?force=1
 * Busts the cache, rescrapes every page through fresh rotating proxies, and
 * persists the fresh extraction into the DB.
 */
export async function POST(
  req: Request,
  { params }: { params: { steamId: string } },
) {
  const steam64 = Path.parse(params).steamId;
  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json({ ok: false, error: "Invalid Steam64." }, { status: 400 });
  }
  if (isCstrackerSyncing(steam64)) {
    return NextResponse.json(
      { ok: false, error: "A cstracker sync is already in progress for this player." },
      { status: 409 },
    );
  }
  const force = new URL(req.url).searchParams.get("force") !== "0";
  if (force) await invalidateCstrackerCache(steam64);

  const result = await cstrackerProvider(steam64, { force });
  let persisted = null;
  if (!result.empty && result.data.cstracker) {
    persisted = await persistCstracker(steam64, result.data.cstracker);
  }
  return NextResponse.json({
    ok: true,
    steam64,
    empty: result.empty,
    fromCache: result.fromCache,
    persisted,
    proxies: proxyPoolStats(),
    data: result.data,
  });
}