import { NextResponse } from "next/server";
import { aggregateStats } from "@/lib/stats/aggregate";
import { getOrFetch } from "@/lib/stats/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STEAM64_RE = /^\d{17}$/;

/**
 * GET /api/stats/[steamId]
 *
 * The clean JSON endpoint the frontend reads. Caching flow (the crucial part):
 *   1. User searches → resolve to Steam64 → hit this endpoint.
 *   2. If a fresh (< 12h) cache entry exists, serve it — no source is touched.
 *   3. If stale/missing, run the providers (Steam API, GC, replays, scraper)
 *      in the background of the request, persist the merged result, serve it.
 *   4. If a provider fails, fall back to the stale copy instead of erroring.
 */
export async function GET(
  _req: Request,
  { params }: { params: { steamId: string } },
) {
  const steam64 = params.steamId;
  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json({ ok: false, error: "Invalid Steam64." }, { status: 400 });
  }

  try {
    const { data, fromCache, stale } = await getOrFetch(
      `stats:${steam64}`,
      12 * 60 * 60, // 12h TTL — never re-fetch on every page load
      () => aggregateStats(steam64),
      { source: "merged", allowStaleOnError: true },
    );

    return NextResponse.json({
      ok: true,
      steam64,
      fromCache,
      stale,
      data,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** POST /api/stats/[steamId] — force a refresh and bust the cache. */
export async function POST(
  _req: Request,
  { params }: { params: { steamId: string } },
) {
  const steam64 = params.steamId;
  if (!STEAM64_RE.test(steam64)) {
    return NextResponse.json({ ok: false, error: "Invalid Steam64." }, { status: 400 });
  }
  const data = await aggregateStats(steam64);
  await getOrFetch(`stats:${steam64}`, 12 * 60 * 60, async () => data, { source: "merged" });
  return NextResponse.json({ ok: true, steam64, data });
}
