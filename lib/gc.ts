import SteamUser from "steam-user";
import { encodeShareCode } from "@/lib/shareCode";
import { prisma } from "@/lib/prisma";
import { runDemoPipeline } from "@/src/worker/pipeline";

// node-cs2 ships no TypeScript types; pull the internals we need via require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeCS2 = require("node-cs2");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Language = require("node-cs2/language.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Protos = require("node-cs2/protobufs/generated/_load.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SteamID = require("steamid");

const APP_ID = 730;

type GcClient = InstanceType<typeof NodeCS2>;

const RECENT_GAMES_MSG = 9141; // Language.MatchListRequestRecentUserGames

export interface GcMatchInfo {
  matchid: string;
  outcomeid: string;
  token: string;
}

export interface GcSyncResult {
  connected: boolean;
  matchesFound: number;
  created: number;
  already: number;
  parsed: number;
  parseFailed: { shareCode: string; error: string }[];
}

/**
 * Append `auth_code` (field 2, string) to the encoded RecentUserGames request.
 * The library's bundled proto only defines `accountid` (field 1); Valve added
 * the auth-code field on the wire, which the GC reads regardless of our local
 * schema. This is what unlocks a target player's FULL match history.
 */
function appendAuthCode(base: Buffer, authCode: string): Buffer {
  const code = Buffer.from(authCode, "utf8");
  const lenBytes: number[] = [];
  let len = code.length;
  while (len > 0x7f) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  lenBytes.push(len);
  return Buffer.concat([base, Buffer.from([0x12, ...lenBytes]), code]);
}

/** Pull matchid/outcomeid/token out of a GC match entry (defensive across shapes). */
function extractMatch(m: Record<string, unknown>): GcMatchInfo | null {
  const w = (m.watchablematchinfo ?? {}) as Record<string, unknown>;
  const mid = m.matchid ?? m.match_id ?? w.match_id ?? w.matchid;
  const out = m.outcomeid ?? m.outcome_id ?? w.outcome_id ?? w.outcomeid ?? w.reservation_id;
  const tok = m.token ?? w.token;
  if (mid == null || out == null || tok == null) return null;
  return { matchid: String(mid), outcomeid: String(out), token: String(tok) };
}

function connectGc(): Promise<{ steam: any; cs2: GcClient }> {
  const accountName = process.env.STEAM_GC_ACCOUNT_NAME;
  const password = process.env.STEAM_GC_PASSWORD;
  if (!accountName || !password) {
    return Promise.reject(
      new Error(
        "STEAM_GC_ACCOUNT_NAME / STEAM_GC_PASSWORD are not set. Add the Steam account the app uses to query the CS2 Game Coordinator.",
      ),
    );
  }

  const steam = new SteamUser();
  const cs2 = new NodeCS2(steam);

  const connected = new Promise<{ steam: any; cs2: GcClient }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out connecting to the CS2 Game Coordinator (check credentials / Steam Guard).")),
      60_000,
    );
    const done = (err?: Error) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ steam, cs2 });
    };

    steam.on("error", (err: Error) => done(err));
    cs2.once("connectedToGC", () => done());
    cs2.once("error", (err: Error) => done(err));

    steam.on("steamGuard", (domain: string | null, callback: (code: string) => void) => {
      console.error(`[gc] Steam Guard required for ${domain ?? "Steam Guard"}. Set STEAM_GC_GUARD_CODE (email) or STEAM_GC_2FA_CODE (mobile).`);
      // give the env-provided codes a chance to flow through logOn before failing
      setTimeout(() => callback(process.env.STEAM_GC_GUARD_CODE ?? process.env.STEAM_GC_2FA_CODE ?? ""), 500);
    });
    steam.on("twoFactorCodeRequired", () => {
      console.error("[gc] Two-factor code required. Set STEAM_GC_2FA_CODE (mobile authenticator) or STEAM_GC_SHARED_SECRET.");
    });

    steam.logOn({
      accountName,
      password,
      twoFactorCode: process.env.STEAM_GC_2FA_CODE ?? undefined,
      authCode: process.env.STEAM_GC_GUARD_CODE ?? undefined,
    });
    steam.once("loggedOn", () => steam.gamesPlayed([APP_ID]));
  });

  return connected;
}

/** Request the target player's match list (with their auth code) and resolve with the parsed entries. */
function requestMatchList(
  steam: any,
  cs2: GcClient,
  steamId: string,
  authCode: string,
): Promise<GcMatchInfo[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for the GC match list response.")),
      45_000,
    );
    cs2.once("matchList", (matches: Record<string, unknown>[]) => {
      clearTimeout(timeout);
      if (matches[0]) {
        console.error(`[gc] match entry keys: ${Object.keys(matches[0]).join(",")}`);
      }
      const infos = matches.map(extractMatch).filter((m): m is GcMatchInfo => m !== null);
      resolve(infos);
    });

    const sid = new SteamID(steamId);
    const proto = Protos.CMsgGCCStrike15_v2_MatchListRequestRecentUserGames;
    const base = proto.encode({ accountid: sid.accountid }).finish();
    const bytes = appendAuthCode(base, authCode);
    steam.sendToGC(APP_ID, RECENT_GAMES_MSG, {}, bytes);
  });
}

/**
 * Fetch a player's match history from the CS2 Game Coordinator and parse it.
 * Requires: the app's Steam account (env) + the target player's Match History
 * Authentication Code (they must have "match sharing" enabled in CS2).
 * Parses at most `parseLimit` matches per call so the request stays bounded;
 * call again to continue.
 */
export async function syncGcHistory(
  steamId: string,
  authCode: string,
  options: { parseLimit?: number } = {},
): Promise<GcSyncResult> {
  const parseLimit = options.parseLimit ?? 5;
  const { steam, cs2 } = await connectGc();

  const result: GcSyncResult = {
    connected: true,
    matchesFound: 0,
    created: 0,
    already: 0,
    parsed: 0,
    parseFailed: [],
  };

  try {
    const matches = await requestMatchList(steam, cs2, steamId, authCode);
    result.matchesFound = matches.length;

    let parsedCount = 0;
    for (const m of matches) {
      const shareCode = encodeShareCode(m.matchid, m.outcomeid, m.token);
      const existing = await prisma.match
        .findUnique({ where: { shareCode }, select: { id: true, parseStatus: true } })
        .catch(() => null);

      if (existing && existing.parseStatus === "PARSED") {
        result.already += 1;
        continue;
      }

      let matchId = existing?.id ?? null;
      if (!matchId) {
        // demoUrl is derived from the share code inside runDemoPipeline.
        const created = await prisma.match
          .create({
            data: {
              shareCode,
              mapName: "de_unknown",
              parseStatus: "QUEUED",
            },
          })
          .catch(() => null);
        matchId = created?.id ?? null;
      }

      if (!matchId) {
        result.parseFailed.push({ shareCode, error: "Could not create Match row (is the DB up?)" });
        continue;
      }

      result.created += existing ? 0 : 1;
      if (parsedCount >= parseLimit) continue;

      try {
        await runDemoPipeline(matchId, steamId);
        result.parsed += 1;
        parsedCount += 1;
      } catch (err) {
        result.parseFailed.push({
          shareCode,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  } finally {
    steam.logOff();
  }
}