import * as http from "node:http";
import * as https from "node:https";
import { ProxyAgent } from "proxy-agent";
import { prisma } from "@/lib/prisma";

/**
 * Free-proxy pool + proxied HTTP client.
 *
 * cstracker.gg is a Cloudflare-fronted site that throttles/bans heavy scrapers
 * that hammer it from a single IP. This module pulls the free proxy list from
 * proxyscrape (the URL the operator provided) and rotates a fresh proxy for
 * every upstream request, retrying across different proxies when one fails.
 * ProxyAgent (proxy-agent) transparently handles http://, https://, socks4://
 * and socks5:// proxies — covering everything proxyscrape returns.
 *
 * Free-proxy reality check: most entries are dead or flaky. Selection therefore
 * scores proxies by liveness/uptime (never random), remembers proxies that
 * actually worked, cools down failures, and only falls back to a direct
 * request (no proxy) as a last resort when the whole list fails.
 */

export const PROXY_LIST_URL =
  process.env.CSTACKER_PROXY_LIST_URL ??
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json";

export interface ProxyEntry {
  url: string; // e.g. "socks5://1.2.3.4:1080"
  protocol: string; // "http" | "https" | "socks4" | "socks5"
  ip: string;
  port: number;
  countryCode?: string;
  ssl?: boolean;
  alive?: boolean;
  uptime?: number; // 0 - 100
  timeout?: number; // ms
  anonymity?: string;
}

export interface ProxiedFetchOptions {
  /** Max distinct proxies to try before giving up. */
  maxAttempts?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const LIST_TTL_MS = 10 * 60 * 1000; // refresh the free list every 10 min
const PROXY_TTL_MS = 5 * 60 * 1000; // proxies come and go fast — retest often
const FAIL_COOLDOWN_MS = 90_000;

/** statCache key where the pool persists entries + working proxies between restarts. */
const POOL_STATE_KEY = "cstracker:proxy-pool";
const POOL_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Proxy protocols that actually tunnel TLS reliably for free lists. */
const PROTOCOL_PREFERENCE = { http: 3, https: 3, socks5: 2, socks4: 0 };

class ProxyPool {
  private entries: ProxyEntry[] = [];
  private listExpiresAt = 0;
  private fetching: Promise<ProxyEntry[]> | null = null;

  /** Proxies currently being used, so parallel scrapes don't overlap. */
  private inFlight = new Set<string>();
  /** Failed proxies kept out of rotation for a while. */
  private cooldownUntil = new Map<string, number>();
  /** Proxies that recently succeeded — heavily preferred. */
  private working = new Set<string>();
  private workingUntil = new Map<string, number>();

  private restoring: Promise<void> | null = null;

  /** Restore entries + working proxies persisted by a previous process run. */
  private async restore(): Promise<void> {
    if (this.entries.length > 0 || this.restoring) return;
    this.restoring = (async () => {
      try {
        const row = await prisma.statCache.findUnique({ where: { key: POOL_STATE_KEY } });
        if (!row) return;
        const payload = row.payload as { entries?: ProxyEntry[]; working?: string[] } | null;
        if (payload?.entries?.length) {
          this.entries = payload.entries;
          for (const url of payload.working ?? []) {
            this.working.add(url);
            this.workingUntil.set(url, Date.now() + PROXY_TTL_MS);
          }
        }
      } catch {
        // DB unavailable — fall through to a fresh list fetch.
      }
    })().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  async load(force = false): Promise<ProxyEntry[]> {
    if (this.entries.length === 0) await this.restore();
    // Stale-while-revalidate: if we have ANY entries, hand them out
    // immediately — a scrape never blocks on the proxyscrape endpoint (which
    // can take ~20s). Only force/first-load actually fetches the list.
    if (!force && this.entries.length > 0) {
      return this.entries;
    }
    if (this.fetching) return this.fetching;

    this.fetching = (async () => {
      const list = await fetchProxyList();
      if (list.length > 0) {
        this.entries = list;
        this.listExpiresAt = Date.now() + LIST_TTL_MS;
        this.markSave();
      }
      return this.entries;
    })().finally(() => {
      this.fetching = null;
    });

    return this.fetching;
  }

  /**
   * Best-effort freshness: fetch a new list in the background when the current
   * one is stale. Never called from load() — only from the refresh timer and
   * failure paths — so there is no recursion.
   */
  refreshBackground(): void {
    if (Date.now() < this.listExpiresAt || this.fetching) return;
    void this.load(true).catch(() => {});
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced persist of entries + working proxies so warm pools survive restarts. */
  private markSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveState();
    }, 4_000);
  }

  private async saveState(): Promise<void> {
    try {
      await prisma.statCache.upsert({
        where: { key: POOL_STATE_KEY },
        update: {
          payload: { entries: this.entries, working: [...this.working] } as object,
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + POOL_STATE_TTL_MS),
        },
        create: {
          key: POOL_STATE_KEY,
          payload: { entries: this.entries, working: [...this.working] } as object,
          source: "proxy-pool",
          expiresAt: new Date(Date.now() + POOL_STATE_TTL_MS),
        },
      });
    } catch {
      // Non-fatal — the pool just starts cold next time.
    }
  }

  /** Score + order candidates so we probe live, fast, reliable proxies first. */
  private candidates(): ProxyEntry[] {
    const now = Date.now();
    for (const [key, until] of this.cooldownUntil) {
      if (now > until) this.cooldownUntil.delete(key);
    }
    for (const [key, until] of this.workingUntil) {
      if (now > until) this.working.delete(key);
    }

    const scored = this.entries
      .filter(
        (p) =>
          !this.inFlight.has(p.url) &&
          (this.cooldownUntil.get(p.url) ?? 0) <= now,
      )
      .map((p) => {
        let score = 0;
        if (p.alive === true) score += 40;
        if (p.alive === false) score -= 100;
        score += (PROTOCOL_PREFERENCE[p.protocol as keyof typeof PROTOCOL_PREFERENCE] ?? 0) * 10;
        if (this.working.has(p.url)) score += 120;
        score += (p.uptime ?? 50) / 5; // 0..20
        if (p.timeout != null && p.timeout > 0) score += Math.max(0, 10 - p.timeout / 1000);
        if (p.anonymity === "elite" || p.anonymity === "anonymous") score += 8;
        return { p, score: score + Math.random() * 6 };
      })
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, 60).map((s) => s.p);
  }

  private markFailed(proxy: ProxyEntry): void {
    this.inFlight.delete(proxy.url);
    this.cooldownUntil.set(proxy.url, Date.now() + FAIL_COOLDOWN_MS);
  }

  private markSuccess(proxy: ProxyEntry): void {
    this.inFlight.delete(proxy.url);
    this.working.add(proxy.url);
    this.workingUntil.set(proxy.url, Date.now() + PROXY_TTL_MS);
    this.markSave();
  }

  async fetchText(url: string, opts: ProxiedFetchOptions = {}): Promise<string> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? Number(process.env.CSTACKER_MAX_PROXY_ATTEMPTS ?? 4));
    const timeoutMs = opts.timeoutMs ?? 12_000;
    const headers = { ...DEFAULT_HEADERS, ...opts.headers };

    // Optional bypass for local dev (no proxy infra).
    if (process.env.CSTACKER_USE_PROXIES === "false") {
      return directFetch(url, { timeoutMs, headers });
    }

    await this.load();
    const used = new Set<string>();
    const errors: string[] = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const proxy = this.candidates().find((p) => !used.has(p.url));
      if (!proxy) {
        errors.push("no available proxies (list empty or all cooling down)");
        break;
      }
      used.add(proxy.url);
      this.inFlight.add(proxy.url);

      try {
        const res = await requestViaProxy(url, proxy.url, { timeoutMs, headers });
        if (res.status >= 200 && res.status < 300) {
          this.markSuccess(proxy);
          return res.text;
        }
        errors.push(`${proxy.url} -> HTTP ${res.status}`);
        this.markFailed(proxy);
      } catch (err) {
        errors.push(`${proxy.url} -> ${err instanceof Error ? err.message : String(err)}`);
        this.markFailed(proxy);
      }
    }

    // Last resort: one direct request (opt-out with CSTACKER_ALLOW_DIRECT_FALLBACK="false").
    if (process.env.CSTACKER_ALLOW_DIRECT_FALLBACK !== "false") {
      try {
        return await directFetch(url, { timeoutMs: timeoutMs * 2, headers });
      } catch (err) {
        errors.push(`direct -> ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(`proxied fetch failed (${errors.slice(0, 4).join("; ")})`);
  }
}

interface RequestResult {
  status: number;
  text: string;
}

async function directFetch(
  url: string,
  { timeoutMs, headers }: { timeoutMs: number; headers: Record<string, string> },
): Promise<string> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.text();
}

/** Node http(s).request routed through a proxy-agent ProxyAgent. */
function requestViaProxy(
  targetUrl: string,
  proxyUrl: string,
  { timeoutMs, headers }: { timeoutMs: number; headers: Record<string, string> },
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith("https://") ? https : http;
    let agent: ProxyAgent;
    try {
      agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
    } catch (err) {
      reject(err);
      return;
    }

    const req = mod.request(
      targetUrl,
      { agent, method: "GET", headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    // Hard deadline for the WHOLE request (connect + headers + body): free
    // proxies can stall at any phase — dead SOCKS proxies accept TCP but never
    // finish the handshake, and a dribbling body resets the socket inactivity
    // timeout — so force-destroy at timeoutMs + slack, unconditionally. Pages
    // are small; anything slower than this marks the proxy failed and moves on.
    const kill = setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, timeoutMs + 5_000);

    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      clearTimeout(kill);
      reject(err);
    });
    req.on("close", () => clearTimeout(kill));
    req.end();
  });
}

/** Singleton pool used across the app. */
const pool = new ProxyPool();

// Warm the pool in the background so the first scrape never pays the
// proxyscrape list fetch (restored from DB when available, refreshed in the
// background when stale). Fire-and-forget — never blocks module import.
setTimeout(() => {
  void pool.load().catch(() => {});
}, 0);

// Keep the free-proxy list fresh: the list TTL is 10 minutes, so check once a
// minute and refresh in the background when it expires (stale entries stay
// available meanwhile). unref() so it never keeps the process alive.
setInterval(() => pool.refreshBackground(), 60_000).unref();

/** Fetch the proxyscrape proxy list (itself a plain fetch — it is the source). */
export async function fetchProxyList(): Promise<ProxyEntry[]> {
  const res = await fetch(PROXY_LIST_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`proxy list endpoint responded ${res.status}`);
  const data = (await res.json()) as { proxies?: unknown[] };
  return (data.proxies ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const p = raw as Record<string, unknown>;
    const url = typeof p.proxy === "string" ? p.proxy : null;
    const protocol = typeof p.protocol === "string" ? p.protocol : null;
    const ip = typeof p.ip === "string" ? p.ip : null;
    const port = typeof p.port === "number" ? p.port : Number(p.port) || 0;
    if (!url || !protocol || !ip || !port) return [];
    const uptime = typeof p.uptime === "number" ? p.uptime : undefined;
    return [{
      url,
      protocol,
      ip,
      port,
      countryCode: typeof p.countryCode === "string" ? p.countryCode : undefined,
      ssl: typeof p.ssl === "boolean" ? p.ssl : undefined,
      alive: typeof p.alive === "boolean" ? p.alive : undefined,
      uptime,
      timeout: typeof p.timeout === "number" ? p.timeout : undefined,
      anonymity: typeof p.anonymity === "string" ? p.anonymity : undefined,
    }];
  });
}

/**
 * Fetch a URL's body through a rotating free proxy. Retries across up to
 * `maxAttempts` distinct proxies (best-scored first). Prefer this over raw
 * `fetch()` in scrapers.
 */
export async function proxiedFetchText(
  url: string,
  opts: ProxiedFetchOptions = {},
): Promise<string> {
  try {
    return await pool.fetchText(url, opts);
  } catch (err) {
    pool.refreshBackground(); // list is probably stale — schedule a refresh
    throw err;
  }
}

export function proxyPoolStats() {
  return {
    total: pool["entries"].length,
    inFlight: pool["inFlight"].size,
    working: pool["working"].size,
    coolingDown: pool["cooldownUntil"].size,
  };
}

/** Flush the pool state (entries + working proxies) to the DB right now. */
export async function flushProxyPool(): Promise<void> {
  if (pool["saveTimer"]) {
    clearTimeout(pool["saveTimer"]);
    pool["saveTimer"] = null;
  }
  await pool["saveState"]();
}