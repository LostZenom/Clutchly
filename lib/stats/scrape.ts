import * as cheerio from "cheerio";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PartialStats, ProviderName } from "@/lib/stats/types";

/**
 * Polite scraper framework.
 *
 * Design notes (read before enabling):
 * - Target sites' ToS usually forbid scraping; respect robots.txt and keep
 *   request volume low. The caching layer means each URL is fetched at most
 *   once per TTL — that is the real "industry standard" protection against
 *   bans: fetch rarely, cache aggressively. Stealth/residential-proxy evasion
 *   of Cloudflare/DataDome is against ToS, gets IPs banned, and can carry
 *   legal risk — this module deliberately does NOT implement it.
 * - SPA sites (csstats, leetify) render nothing in raw HTML. To get their data
 *   cleanly: open DevTools → Network → filter XHR/Fetch → trigger a search →
 *   find the JSON endpoint → plug it in as a `json` adapter below. That is the
 *   documented way to discover internal APIs; no HTML parsing needed.
 */

interface ScrapeAdapter {
  site: string;
  /** "json" (discovered XHR endpoint) or "html" (server-rendered page + selectors). */
  mode: "json" | "html";
  /** URL template; "{steam64}" is replaced with the target's SteamID64. */
  url: string;
  /** For mode "json": dot-path → target stat. */
  fields?: Record<string, string>;
  /** For mode "html": CSS selector → target stat. */
  selectors?: Record<string, string>;
  /** Min ms between requests to this site's host (default 2000). */
  intervalMs?: number;
}

/** Minimal dot-path getter: "a.b[0].c". */
function getPath(obj: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// Per-host minimum-interval enforcement (simple token bucket).
const lastFetchByHost = new Map<string, number>();
async function rateLimitedFetch(url: string, intervalMs: number): Promise<Response> {
  const host = new URL(url).host;
  const last = lastFetchByHost.get(host) ?? 0;
  const wait = Math.max(0, last + intervalMs - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchByHost.set(host, Date.now());

  return fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function runAdapter(adapter: ScrapeAdapter, steam64: string): Promise<Record<string, unknown>> {
  const url = adapter.url.replace("{steam64}", steam64);
  const ttlSeconds = 12 * 60 * 60;

  // Cache-before-fetch: same URL is only requested once per TTL.
  const cached = await prisma.statCache
    .findUnique({ where: { key: `scrape:${adapter.site}:${steam64}` } })
    .catch(() => null);
  if (cached && cached.expiresAt.getTime() > Date.now()) {
    return (cached.payload as Record<string, unknown>) ?? {};
  }

  const res = await rateLimitedFetch(url, adapter.intervalMs ?? 2000);
  if (!res.ok) throw new Error(`${adapter.site} responded ${res.status}`);

  const out: Record<string, unknown> = {};
  if (adapter.mode === "json") {
    const body = (await res.json()) as unknown;
    for (const [stat, path] of Object.entries(adapter.fields ?? {})) {
      out[stat] = getPath(body, path);
    }
  } else {
    const html = await res.text();
    const $ = cheerio.load(html);
    for (const [stat, sel] of Object.entries(adapter.selectors ?? {})) {
      out[stat] = $(sel).first().text().trim() || null;
    }
  }

  const payload = out as Prisma.InputJsonValue;
  await prisma.statCache
    .upsert({
      where: { key: `scrape:${adapter.site}:${steam64}` },
      update: { payload, source: `scrape:${adapter.site}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000), fetchedAt: new Date() },
      create: { key: `scrape:${adapter.site}:${steam64}`, payload, source: `scrape:${adapter.site}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000) },
    })
    .catch(() => null);

  return out;
}

/** Map raw adapter output onto the unified shape (loose — override in your adapter fields). */
function toPartial(raw: Record<string, unknown>): PartialStats {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v.replace(/[^\d.]/g, "")) : NaN);
  const dto: PartialStats = {};
  if (raw.username) dto.username = String(raw.username);
  if (raw.avatarUrl) dto.avatarUrl = String(raw.avatarUrl);
  if (raw.level) dto.level = num(raw.level);
  if (raw.hours) dto.cs2Hours = num(raw.hours);
  if (raw.kills !== undefined) {
    dto.totals = {
      matches: num(raw.matches) || 0,
      wins: 0, losses: 0, ties: 0,
      kills: num(raw.kills) || 0,
      deaths: num(raw.deaths) || 0,
      assists: num(raw.assists) || 0,
      headshots: num(raw.headshots) || 0,
      kdRatio: num(raw.kd) || 0,
      hltvRating: num(raw.rating) || 0,
      adr: num(raw.adr) || 0,
      kast: num(raw.kast) || 0,
      hsPercent: num(raw.hsPercent) || 0,
    };
  }
  return dto;
}

/**
 * Provider: runs every adapter configured in the SCRAPE_TARGETS env var
 * (a JSON array of ScrapeAdapter). Contributors are merged downstream.
 */
export async function scrapeProvider(steam64: string): Promise<{ name: ProviderName; data: PartialStats; empty: boolean }> {
  let targets: ScrapeAdapter[];
  try {
    targets = JSON.parse(process.env.SCRAPE_TARGETS ?? "[]") as ScrapeAdapter[];
  } catch {
    targets = [];
  }
  if (targets.length === 0) return { name: "scrape", data: {}, empty: true };

  const parts: PartialStats[] = [];
  for (const t of targets) {
    try {
      parts.push(toPartial(await runAdapter(t, steam64)));
    } catch (err) {
      console.error(`[scrape] ${t.site} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const merged: PartialStats = {};
  for (const p of parts) Object.assign(merged, p);
  return { name: "scrape", data: merged, empty: Object.keys(merged).length === 0 };
}
