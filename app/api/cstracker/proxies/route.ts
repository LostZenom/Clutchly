import { NextResponse } from "next/server";
import { fetchProxyList } from "@/lib/stats/proxies";

export const dynamic = "force-dynamic";

/**
 * GET /api/cstracker/proxies
 * Diagnostic: number of live free proxies + a compact sample with their
 * protocols/countries. Useful to confirm the proxyscrape feed is reachable.
 */
export async function GET() {
  try {
    const list = await fetchProxyList();
    const byProtocol = list.reduce<Record<string, number>>((acc, p) => {
      acc[p.protocol] = (acc[p.protocol] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({
      ok: true,
      total: list.length,
      byProtocol,
      sample: list.slice(0, 8).map((p) => ({
        url: p.url,
        protocol: p.protocol,
        country: (p.countryCode ?? "").toUpperCase() || null,
        ssl: p.ssl ?? null,
        alive: p.alive ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}