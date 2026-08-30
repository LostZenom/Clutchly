/**
 * Steam-client auto-login: if the user is already logged into the Steam desktop
 * client on this PC, we can read the session refresh token from
 * `<Steam>/config/loginusers.vdf` and log into the CS2 Game Coordinator
 * WITHOUT asking for a username or password again.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import SteamUser from "steam-user";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeCS2 = require("node-cs2");

export interface SteamClientUser {
  steamPath: string;
  steamId: string;
  accountName: string;
  refreshToken: string;
}

/** Where the Steam client might be installed (registry first, then common paths). */
function candidatePaths(): string[] {
  const out: string[] = [];
  try {
    const reg = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const m = reg.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m && m[1]) out.push(m[1].trim());
  } catch {
    /* registry not available — fall through to common paths */
  }
  out.push(
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
    "D:\\Steam",
    "E:\\Steam",
    path.join(require("os").homedir(), ".steam", "steam"),
  );
  return [...new Set(out)];
}

interface ParsedUser {
  steamId: string;
  accountName: string;
  refreshToken: string;
  mostRecent: boolean;
}

/** Parse the flat "users" blocks of loginusers.vdf (both modern formats). */
function parseLoginUsers(vdf: string): ParsedUser[] {
  const users: ParsedUser[] = [];
  const blockRe = /"(\d{17})"\s+(?:"\d+"\s+)?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(vdf)) !== null) {
    const steamId = m[1];
    const body = m[2];
    let accountName = "";
    let refreshToken = "";
    let mostRecent = false;
    const kvRe = /"([^"]+)"\s+"([^"]*)"/g;
    let k: RegExpExecArray | null;
    while ((k = kvRe.exec(body)) !== null) {
      if (k[1] === "AccountName") accountName = k[2];
      else if (k[1] === "RefreshToken") refreshToken = k[2];
      else if (k[1] === "MostRecent") mostRecent = k[2] === "1";
    }
    users.push({ steamId, accountName, refreshToken, mostRecent });
  }
  return users;
}

/** Find the logged-in Steam client user (refresh token present only if Steam
 * was told to remember the password). */
export function findSteamClientUser(): SteamClientUser | null {
  for (const dir of candidatePaths()) {
    const file = path.join(dir, "config", "loginusers.vdf");
    if (!fs.existsSync(file)) continue;
    try {
      const users = parseLoginUsers(fs.readFileSync(file, "utf8")).filter((u) => u.accountName);
      if (users.length === 0) continue;
      const pick = users.find((u) => u.mostRecent) || users[0];
      return {
        steamPath: dir,
        steamId: pick.steamId,
        accountName: pick.accountName,
        refreshToken: pick.refreshToken || "",
      };
    } catch {
      /* try next install */
    }
  }
  return null;
}

export interface GcClientLoginResult {
  ok: boolean;
  needsGuard?: boolean;
  /** True when the account is known but password-less login needs the password once. */
  needsPassword?: boolean;
  steamId?: string;
  accountName?: string;
  message: string;
}

/**
 * Silently log into Steam using the client's refresh token, then connect to the
 * CS2 Game Coordinator. No password involved. Logs off as soon as verified.
 */
export function loginViaSteamClient(): Promise<GcClientLoginResult> {
  return new Promise((resolve) => {
    const user = findSteamClientUser();
    if (!user) {
      resolve({
        ok: false,
        message: "No logged-in Steam client found — open Steam and log in once.",
      });
      return;
    }
    if (!user.refreshToken) {
      // Account detected, but Steam hasn't stored a session token for it.
      resolve({
        ok: false,
        needsPassword: true,
        steamId: user.steamId,
        accountName: user.accountName,
        message: `Steam is logged in as ${user.accountName}, but password-less login needs “Remember my password” ticked in Steam once. Enter your password below, or tick it and retry.`,
      });
      return;
    }

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
        resolve({ ok: false, message: "Timed out connecting to Steam (60s)." });
      }
    }, 60_000);
    const done = (r: GcClientLoginResult) => {
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
        steamId: steam?.steamID?.getSteamID64 ? steam.steamID.getSteamID64() : user.steamId,
        accountName: user.accountName,
        message: `Auto-logged in as ${user.accountName} via your Steam client.`,
      }),
    );
    cs2.on("error", (e: Error) => {
      if (!settled) done({ ok: false, message: e?.message || "GC connection failed." });
    });

    steam.logOn({ accountName: user.accountName, refreshToken: user.refreshToken });
    steam.once("loggedOn", () => steam.gamesPlayed([730]));
  });
}