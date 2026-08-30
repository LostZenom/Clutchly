/**
 * Live overlay feed: keeps a persistent connection to the CS2 Game Coordinator
 * (via the app's Steam account) and repeatedly asks the GC for that account's
 * CURRENT live game (`MatchListRequestLiveGameForUser`). When a live match is
 * returned we persist its roster to StatCache "overlay:live", which the overlay
 * API reads so the desktop overlay shows the ACTUAL players in the game right
 * now — not just the last completed parsed match.
 *
 * Requirements to actually go live:
 * - STEAM_GC_ACCOUNT_NAME / STEAM_GC_PASSWORD (+ any Steam Guard codes) set.
 * - That Steam account must be the one playing CS2 (its own live game).
 * Without credentials this worker logs a notice and stays idle, and the overlay
 * gracefully falls back to the most recent parsed match.
 *
 * Steam Guard / phone approval: auth goes through steam-session's LoginSession
 * directly. When a guard prompt fires we keep the attempt PENDING and silently
 * wait for the user to approve the notification on their phone — Steam holds
 * the login open, so no re-attempts are needed and exactly ONE push is sent.
 * On success the refresh token is persisted to .env so every later connect is
 * fully silent (no guard at all).
 */
import * as os from "os";
import * as path from "path";
import * as fsp from "fs/promises";
import SteamUser from "steam-user";
import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } from "steam-session";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rosterFromGc, type OverlayPayload } from "@/lib/overlay";
import { persistEnvKeys } from "@/lib/envWrite";

const asJson = (v: object) => v as unknown as Prisma.InputJsonValue;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeCS2 = require("node-cs2");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Protos = require("node-cs2/protobufs/generated/_load.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Language = require("node-cs2/language.js");

const APP_ID = 730;
const LIVE_GAME_MSG = 9146; // Language.MatchListRequestLiveGameForUser
const POLL_INTERVAL_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const LIVE_KEY = "overlay:live";
/** How long to wait for the phone/email Steam Guard approval (Steam holds the
 * login open while we wait — one push, no re-attempts). */
const GUARD_WAIT_MS = 150_000;
/** Reconnect delay after a guard-code failure (avoids log/attempt spam). */
const GUARD_RETRY_DELAY_MS = 300_000;

type GcClient = InstanceType<typeof NodeCS2>;

export interface LiveFeed {
  name: string;
  close: () => Promise<void>;
}

function creds(): { accountName: string; password: string; refreshToken: string } | null {
  const accountName = process.env.STEAM_GC_ACCOUNT_NAME || "";
  const password = process.env.STEAM_GC_PASSWORD || "";
  const refreshToken = process.env.STEAM_GC_REFRESH_TOKEN || "";
  // A refresh token alone is enough to connect (QR / steam-client auto-login);
  // otherwise a password requires an account name.
  if (refreshToken) return { accountName, password, refreshToken };
  if (!accountName || !password) return null;
  return { accountName, password, refreshToken };
}

/** Which Steam64 to watch — optional override, otherwise the connecting account. */
function targetSteamId(self: string): string {
  const t = process.env.OVERLAY_TRACK_STEAM64;
  return t && /^7\d{16}$/.test(t) ? t : self;
}

// --- simple cross-process lock so the feed runs once even when the app server,
// the worker, and/or a second dev instance all start it at boot. ---
const LOCK_PATH = path.join(os.tmpdir(), "clutchly-overlay-live-feed.lock");
async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function tryAcquireLock(): Promise<boolean> {
  try {
    const raw = await fsp.readFile(LOCK_PATH, "utf8");
    const pid = Number(raw.trim());
    if (pid && pid !== process.pid && (await pidAlive(pid))) return false;
  } catch {
    /* no lock yet */
  }
  try {
    await fsp.writeFile(LOCK_PATH, String(process.pid));
    return true;
  } catch {
    return true;
  }
}
async function releaseLock(): Promise<void> {
  try {
    const raw = await fsp.readFile(LOCK_PATH, "utf8");
    if (Number(raw.trim()) === process.pid) await fsp.unlink(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * Authenticate with account + password via steam-session (bypasses steam-user's
 * guard handling, which cancels each pending approval and spams new pushes).
 *
 * - No guard needed → resolves immediately.
 * - Device/email confirmation → keeps the attempt pending and waits silently
 *   for the phone approval (ONE push; Steam completes the login once approved).
 * - Email/TOTP code required but none provided → throws with `needsGuard`.
 *
 * Resolves with a refresh token + Steam64, which is all steam-user needs to
 * connect — and makes every later connect guard-free.
 */
async function authWithPassword(opts: {
  accountName: string;
  password: string;
  guardCode?: string;
  twoFactorCode?: string;
}): Promise<{ refreshToken: string; steamId: string }> {
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = GUARD_WAIT_MS;

  const code = opts.guardCode || opts.twoFactorCode || "";
  const start = await session.startWithCredentials({
    accountName: opts.accountName,
    password: opts.password,
    steamGuardCode: code || undefined,
  });

  if (!start.actionRequired) {
    // No guard — authenticated immediately.
    return { refreshToken: session.refreshToken, steamId: session.steamID.getSteamID64() };
  }

  const types = (start.validActions || []).map((a) => a.type);
  const canApprove =
    types.includes(EAuthSessionGuardType.DeviceConfirmation) ||
    types.includes(EAuthSessionGuardType.EmailConfirmation);

  if (canApprove) {
    // Polling already started inside startWithCredentials. Steam holds this
    // attempt open, so we just WAIT for `authenticated` — approving on the
    // phone completes the login. No re-attempts, exactly one push.
    return await new Promise<{ refreshToken: string; steamId: string }>((resolve, reject) => {
      const onAuth = () => {
        cleanup();
        resolve({ refreshToken: session.refreshToken, steamId: session.steamID.getSteamID64() });
      };
      const onTimeout = () => {
        cleanup();
        const err: Error & { needsGuard?: boolean } = new Error(
          "Steam Guard approval timed out — approve the notification on your phone, then try again.",
        );
        err.needsGuard = true;
        reject(err);
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        session.removeListener("authenticated", onAuth);
        session.removeListener("timeout", onTimeout);
        session.removeListener("error", onError);
      };
      session.once("authenticated", onAuth);
      session.once("timeout", onTimeout);
      session.once("error", onError);
    });
  }

  const err: Error & { needsGuard?: boolean } = new Error(
    "Steam Guard code required — add it above and try again.",
  );
  err.needsGuard = true;
  throw err;
}

async function connectGc(): Promise<{ steam: any; cs2: GcClient }> {
  const cred = creds();
  if (!cred) throw new Error("STEAM_GC credentials not set");

  // Get a refresh token first (already have one → fully silent, no guard).
  let refreshToken = cred.refreshToken;
  if (!refreshToken && cred.password) {
    const auth = await authWithPassword({
      accountName: cred.accountName,
      password: cred.password,
      guardCode: process.env.STEAM_GC_GUARD_CODE || undefined,
      twoFactorCode: process.env.STEAM_GC_2FA_CODE || undefined,
    });
    refreshToken = auth.refreshToken;
    // Persist so future connects (and app restarts) skip Steam Guard entirely.
    process.env.STEAM_GC_REFRESH_TOKEN = refreshToken;
    persistEnvKeys({ STEAM_GC_REFRESH_TOKEN: refreshToken });
  }

  const steam = new SteamUser();
  const cs2 = new NodeCS2(steam);

  return await new Promise<{ steam: any; cs2: GcClient; accountName?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("GC connect timed out")), 60_000);
    const done = (err?: Error, accountName?: string) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ steam, cs2, accountName });
    };

    steam.on("error", (e: Error) => done(e));
    cs2.once("connectedToGC", () => done(undefined, steam?.accountInfo?.name));
    cs2.on("error", (e: Error) => done(e));

    steam.logOn(cred.accountName ? { accountName: cred.accountName, refreshToken } : { refreshToken });
    steam.once("loggedOn", () => steam.gamesPlayed([APP_ID]));
  });
}



/** Ask the GC for the user's current live game. */
function requestLiveGame(cs2: GcClient, steamId: string): void {
  try {
    const SteamID = require("steamid");
    const sid = new SteamID(steamId);
    cs2._send(LIVE_GAME_MSG, Protos.CMsgGCCStrike15_v2_MatchListRequestLiveGameForUser, {
      accountid: sid.accountid,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Extract the live roster from a matchList payload. Returns null when the match
 * list carries no usable live players (e.g. the account isn't in a match yet).
 */
function toLivePayload(matches: unknown[]): OverlayPayload | null {
  const m = (matches && matches[0]) || null;
  if (!m || typeof m !== "object") return null;
  const rec = m as Record<string, unknown>;
  const w = (typeof rec.watchablematchinfo === "object" && rec.watchablematchinfo
    ? rec.watchablematchinfo
    : {}) as Record<string, unknown>;

  const num = (v: unknown, def = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  const players = Array.isArray(rec.players) ? rec.players : Array.isArray(rec.match_players) ? rec.match_players : [];
  const rows = players
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      accountId: (p.account_id ?? p.accountid ?? p.steamid ?? p.id) as number | string,
      name: str(p.name ?? p.persona ?? p.personaname) ?? String(p.account_id ?? p.id ?? ""),
      team: (num(p.team) === 3 ? "T" : num(p.team) === 2 ? "CT" : undefined) as "CT" | "T" | undefined,
    }))
    .filter((r) => r.accountId != null && String(r.accountId) !== "");

  const mid = str(rec.matchid ?? rec.match_id ?? w.matchid ?? w.match_id);
  return rosterFromGc(rows, {
    map: str(w.map ?? rec.map),
    scoreCT: num(w.score_ct ?? w["score_ct"] ?? rec.score_ct),
    scoreT: num(w.score_t ?? w["score_t"] ?? rec.score_t),
    round: num(w.round ?? 0),
    matchId: mid,
  });
}

/** Persist a live snapshot so the overlay API can read it without a GC socket. */
async function cacheLive(payload: OverlayPayload | null): Promise<void> {
  const now = new Date();
  const json = asJson(payload ?? { live: false, inGame: false, players: [] });
  await prisma.statCache
    .upsert({
      where: { key: LIVE_KEY },
      update: {
        payload: json,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
        fetchedAt: now,
      },
      create: {
        key: LIVE_KEY,
        source: "gc",
        payload: json,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      },
    })
    .catch(() => {});
}

export function startLiveFeed(): LiveFeed {
  const name = "live-overlay-feed";
  const cred = creds();
  if (!cred) {
    console.log(`[${name}] Steam GC credentials not set — overlay will show last parsed match.`);
    return { name, close: async () => {} };
  }

  let stopping = false;
  let steam: any = null;
  let cs2: GcClient | null = null;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  async function pollOnce(): Promise<void> {
    if (!cs2 || !steam?.steamID || polling) return;
    polling = true;
    try {
      const who = targetSteamId(steam.steamID.getSteamID64());
      requestLiveGame(cs2, who);
    } finally {
      polling = false;
    }
  }

  async function handleMatchList(matches: unknown[]): Promise<void> {
    const payload = toLivePayload(matches);
    console.log(`[${name}] ${payload ? `live match (${payload.players.length} players)` : "no live match"}`);
    await cacheLive(payload);
  }

  async function run(): Promise<void> {
    if (stopping) return;
    try {
      const conn = await connectGc();
      steam = conn.steam;
      cs2 = conn.cs2;

      cs2.on("matchList", (matches: unknown[]) => {
        void handleMatchList(matches);
      });
      cs2.on("disconnectedFromGC", () => {
        console.log(`[${name}] disconnected — reconnecting`);
        cs2 = null;
        stopTimer();
        scheduleReconnect();
      });

      // Prime + poll while connected.
      await pollOnce();
      timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
      console.log(`[${name}] connected to GC as ${steam?.steamID?.getSteamID64?.() ?? "?"}`);
    } catch (err) {
      const e = err as Error & { needsGuard?: boolean };
      console.error(`[${name}] connect failed: ${e instanceof Error ? e.message : e}`);
      // Guard-code failures need a human action (add the code / approve) —
      // back off much harder so we don't spam attempts or logs.
      scheduleReconnect(e?.needsGuard ? GUARD_RETRY_DELAY_MS : 20_000);
    }
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  let reconnectTimer: NodeJS.Timeout | null = null;
  function scheduleReconnect(delayMs = 20_000) {
    if (stopping || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await run();
    }, delayMs);
  }

  void run();

  return {
    name,
    close: async () => {
      stopping = true;
      stopTimer();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (steam) {
        try {
          steam.logOff();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export interface GcLoginResult {
  ok: boolean;
  needsGuard?: boolean;
  /** Steam64 of the account that just logged in — lets the UI auto-fill tracking. */
  steamId?: string;
  /** Fresh refresh token — persisted so later connects skip Steam Guard. */
  refreshToken?: string;
  message: string;
}

/**
 * One-shot Steam/GC login test (used by the overlay settings “Log in to Steam”
 * button). Authenticates via steam-session (waiting silently for phone
 * approval when Steam Guard fires), connects the CS2 Game Coordinator, then
 * logs off immediately. Does not start the feed.
 */
export function testGcConnection(opts: {
  accountName: string;
  password: string;
  guardCode?: string;
  twoFactorCode?: string;
}): Promise<GcLoginResult> {
  return new Promise((resolve) => {
    void (async () => {
      const steam = new SteamUser();
      const cs2 = new NodeCS2(steam);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            steam.logOff();
          } catch {
            /* ignore */
          }
          resolve({ ok: false, message: "Timed out connecting to Steam." });
        }
      }, GUARD_WAIT_MS + 40_000);
      const done = (r: GcLoginResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          steam.logOff();
        } catch {
          /* ignore */
        }
        resolve(r);
      };

      steam.on("error", (e: Error) => done({ ok: false, message: e?.message || "Steam login failed." }));
      cs2.once("connectedToGC", () =>
        done({
          ok: true,
          steamId: steam?.steamID?.getSteamID64 ? steam.steamID.getSteamID64() : undefined,
          refreshToken: authToken,
          message: "Connected to Steam + CS2 Game Coordinator.",
        }),
      );
      cs2.on("error", (e: Error) => {
        if (!settled) done({ ok: false, message: e?.message || "GC connection failed." });
      });

      let authToken: string | undefined;
      try {
        const auth = await authWithPassword(opts);
        authToken = auth.refreshToken;
        // Remember the token so the feed (and next app start) never asks again.
        process.env.STEAM_GC_REFRESH_TOKEN = authToken;
        persistEnvKeys({ STEAM_GC_REFRESH_TOKEN: authToken });
        steam.logOn({ accountName: opts.accountName, refreshToken: authToken });
        steam.once("loggedOn", () => steam.gamesPlayed([APP_ID]));
      } catch (err) {
        const e = err as Error & { needsGuard?: boolean };
        if (e?.needsGuard) {
          done({ ok: false, needsGuard: true, message: e.message || "Steam Guard code required." });
        } else {
          done({ ok: false, message: e?.message || "Steam login failed." });
        }
      }
    })();
  });
}

let _feed: LiveFeed | null = null;

/**
 * Start the live feed exactly once per machine (lock-guarded). This is called
 * automatically by the Next server at boot (instrumentation) and by the worker.
 */
export async function ensureLiveFeed(): Promise<LiveFeed> {
  if (_feed) return _feed;
  if (!creds()) {
    console.log(
      "[live-overlay-feed] no Steam GC credentials — overlay will show the last parsed match until STEAM_GC_ACCOUNT_NAME (+ password or refresh token) are set.",
    );
    _feed = { name: "live-overlay-feed", close: async () => {} };
    return _feed;
  }
  if (!(await tryAcquireLock())) {
    console.log("[live-overlay-feed] already running in another process — skipping.");
    _feed = { name: "live-overlay-feed", close: async () => {} };
    return _feed;
  }
  const inner = startLiveFeed();
  _feed = {
    ...inner,
    close: async () => {
      await inner.close();
      await releaseLock();
      _feed = null;
    },
  };
  return _feed;
}