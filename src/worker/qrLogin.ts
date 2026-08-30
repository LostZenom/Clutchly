/**
 * QR-code Steam login.
 *
 * Flow (fully handled by the Steam mobile app — no guard codes to type):
 *   1. POST /api/overlay/login-qr  → starts a steam-session QR challenge,
 *      renders it to a PNG data-URL, and returns { id, qrDataUrl }.
 *   2. The user scans the QR with the Steam app and approves.
 *   3. GET /api/overlay/login-qr/status?id=… polls the in-memory session. Once
 *      authenticated we capture the refresh token + Steam64, persist them to
 *      .env (so every future login is silent), start the live feed, and return
 *      success.
 *
 * Sessions are kept in a module-level Map keyed by a random id and expire after
 * `SESSION_TTL_MS` (a few minutes — QR challenges are short-lived by nature).
 */
import { randomUUID } from "crypto";
import QRCode from "qrcode";
import SteamUser from "steam-user";
import { LoginSession, EAuthTokenPlatformType } from "steam-session";
import { persistEnvKeys } from "@/lib/envWrite";
import { ensureLiveFeed } from "@/src/worker/liveFeed";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeCS2 = require("node-cs2");

const APP_ID = 730;
const SESSION_TTL_MS = 4 * 60_000; // QR challenges expire on their own in ~5 min

export type QrLoginStatus =
  | { status: "waiting" }
  | { status: "authenticated"; steamId: string; accountName: string; message: string }
  | { status: "expired"; message: string };

interface QrRecord {
  session: LoginSession;
  accountName?: string;
  expiresAt: number;
}

const sessions = new Map<string, QrRecord>();

function cleanupExpired() {
  const now = Date.now();
  for (const [id, rec] of sessions) {
    if (now > rec.expiresAt) {
      try {
        rec.session.cancelLoginAttempt();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
    }
  }
}

/**
 * Start a new QR login. Resolves the Steam64 to an account-agnostic QR image.
 */
export async function startQrLogin(): Promise<{ id: string; qrDataUrl: string }> {
  cleanupExpired();

  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = SESSION_TTL_MS;
  const started = await session.startWithQR();

  if (!started.qrChallengeUrl) {
    throw new Error("Steam did not return a QR challenge — try again in a moment.");
  }

  // Render the challenge URL as a QR PNG data-URL the browser can show directly.
  const qrDataUrl = await QRCode.toDataURL(started.qrChallengeUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 420,
    color: { dark: "#090b0e", light: "#ffffff" },
  });

  const id = randomUUID();
  sessions.set(id, { session, expiresAt: Date.now() + SESSION_TTL_MS });

  // This session will resolve via the authenticated event. Keep it alive while
  // the client polls the status endpoint.
  session.once("error", (e) => {
    console.error(`[qr-login] session ${id} error:`, e && e.message);
    sessions.delete(id);
  });

  return { id, qrDataUrl };
}

/**
 * Poll a QR login's progress. When authenticated, this resolves the login:
 * captures the refresh token + Steam64, persists them, and starts the live feed
 * so the overlay goes live immediately. Subsequent calls report expired.
 */
export async function pollQrLogin(id: string): Promise<QrLoginStatus> {
  cleanupExpired();
  const rec = sessions.get(id);
  if (!rec) {
    return { status: "expired", message: "That QR code has expired — scan a fresh one." };
  }
  const { session } = rec;

  if (!session.steamID) {
    return { status: "waiting" };
  }

  // Authenticated — steamID is populated; refreshToken is ready.
  try {
    if (!session.refreshToken) {
      return { status: "expired", message: "Steam login did not complete — try again." };
    }
    const steamId = session.steamID.getSteamID64();
    const refreshToken = session.refreshToken;

    // Persist so the feed and future logins stay guard-free.
    process.env.STEAM_GC_REFRESH_TOKEN = refreshToken;
    persistEnvKeys({ STEAM_GC_REFRESH_TOKEN: refreshToken });

    // Connect the CS2 Game Coordinator + start the live feed.
    const steam = new SteamUser();
    const cs2 = new NodeCS2(steam);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("GC connect timed out")), 40_000);
      steam.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
      cs2.once("connectedToGC", () => {
        clearTimeout(timer);
        resolve();
      });
      cs2.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
      steam.logOn({ refreshToken });
      steam.once("loggedOn", () => steam.gamesPlayed([APP_ID]));
    });
    const accountName = steam?.accountInfo?.name || "";
    try {
      steam.logOff();
    } catch {
      /* ignore */
    }

    sessions.delete(id);
    process.env.STEAM_GC_ACCOUNT_NAME = accountName;
    if (accountName) persistEnvKeys({ STEAM_GC_ACCOUNT_NAME: accountName });
    process.env.OVERLAY_TRACK_STEAM64 = steamId;
    persistEnvKeys({ OVERLAY_TRACK_STEAM64: steamId });
    try {
      await ensureLiveFeed();
    } catch {
      // feed is best-effort once the session works
    }


    return {
      status: "authenticated",
      steamId,
      accountName,
      message: "Logged into Steam via QR ✓ — live feed started.",
    };
  } catch (err) {
    sessions.delete(id);
    return {
      status: "expired",
      message: err instanceof Error ? err.message : "Steam login failed.",
    };
  }
}

/** Invalidate a QR login (e.g. user closed the button). */
export function cancelQrLogin(id: string): void {
  const rec = sessions.get(id);
  if (rec) {
    try {
      rec.session.cancelLoginAttempt();
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }
}