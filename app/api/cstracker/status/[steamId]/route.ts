import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AUTO_SYNC_MIN_AGE_MS, isCstrackerSyncing } from "@/lib/stats/autoSync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STEAM64_RE = /^\d{17}$/;
const Path = z.object({ steamId: z.string() });

/**
 * GET /api/cstracker/status/[steamId]
 *
 * Lightweight sync status for a player: when the cached extraction was fetched,
 * whether a background sync is in flight, and whether the cache is stale enough
 * to warrant one. Used by the client auto-sync poller to refresh the page the
 * moment a sync completes.
 */
export async function GET(
  _req: Request,
  { params }: { params: { steamId: string } },
) {
  const steam64 = Path.parse(params).steamId;
  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json({ ok: false, error: "Invalid Steam64." }, { status: 400 });
  }

  const row = await prisma.statCache
    .findUnique({ where: { key: `cstracker:${steam64}` } })
    .catch(() => null);

  const fetchedAt = row?.fetchedAt?.getTime() ?? null;
  const inFlight = isCstrackerSyncing(steam64);
  const stale = fetchedAt == null || Date.now() - fetchedAt > AUTO_SYNC_MIN_AGE_MS;

  return NextResponse.json({
    ok: true,
    steam64,
    lastSyncedAt: fetchedAt != null ? new Date(fetchedAt).toISOString() : null,
    inFlight,
    stale,
  });
}
