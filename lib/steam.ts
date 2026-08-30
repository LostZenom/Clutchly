import { env, requireSteamKey } from "@/lib/env";

/** Offset used to convert SteamID32 → SteamID64 (public universe). */
export const STEAM64_OFFSET = 76561197960265728n;

export type SteamInputKind = "steam64" | "steam3" | "steam2" | "vanity";

export interface SteamProfile {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarfull: string;
  steamID64?: string;
  communityvisibilitystate?: number;
  personastate?: number;
  lastlogoff?: number;
  timecreated?: number;
  realname?: string;
  countrycode?: string;
  loccityid?: number;
}

export interface SteamGame {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_2weeks: number;
}

export interface SteamBan {
  SteamId: string;
  CommunityBanned: boolean;
  VACBanned: boolean;
  NumberOfVACBans: number;
  DaysSinceLastBan: number;
  NumberOfGameBans: number;
  EconomyBan: string;
}

export interface OwnedGame {
  appid: number;
  name?: string;
  playtime_forever: number;
  playtime_2weeks?: number;
}

function assertOk(res: Response, endpoint: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`Steam API ${endpoint} responded ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Parse flexibly-typed JSON into a profile record (guarded, no `any`). */
function toProfile(raw: unknown): SteamProfile {
  const r = raw as Record<string, unknown>;
  return {
    steamid: String(r.steamid ?? ""),
    personaname: String(r.personaname ?? ""),
    profileurl: String(r.profileurl ?? ""),
    avatar: String(r.avatar ?? ""),
    avatarfull: String(r.avatarfull ?? ""),
    steamID64: r.steamID64 ? String(r.steamID64) : undefined,
    communityvisibilitystate:
      typeof r.communityvisibilitystate === "number" ? r.communityvisibilitystate : undefined,
    personastate: typeof r.personastate === "number" ? r.personastate : undefined,
    lastlogoff: typeof r.lastlogoff === "number" ? r.lastlogoff : undefined,
    timecreated: typeof r.timecreated === "number" ? r.timecreated : undefined,
    realname: typeof r.realname === "string" ? r.realname : undefined,
    countrycode: typeof r.countrycode === "string" ? r.countrycode : undefined,
    loccityid: typeof r.loccityid === "number" ? r.loccityid : undefined,
  };
}

/** SteamID32 parts: STEAM_X:Y:Z (X is the universe, typically 0/1). */
function steam32To64(accountNumber: bigint, universeDefault = 1): string {
  return (STEAM64_OFFSET + accountNumber).toString();
}

/**
 * Resolve any user-facing handle into a Steam64 ID.
 * Accepts: raw Steam64 ("7656119..."), SteamID3 ("[U:1:12345]"/"U:1:12345"),
 * SteamID2 ("STEAM_0:1:1234"), or a vanity alias ("s1mple").
 */
export async function resolveSteamId(input: string): Promise<{
  kind: SteamInputKind;
  steam64: string;
}> {
  const handle = input.trim();

  // Steam64 — already the numeric ID
  if (/^\d{17}$/.test(handle)) {
    return { kind: "steam64", steam64: handle };
  }
  if (/^\d{15,16}$/.test(handle)) {
    // historic 32-bit steam numeric id — should rarely appear, reject clearly
    throw new Error(`"${handle}" looks like a SteamID32; use a vanity name or profile URL instead.`);
  }

  // SteamID3: [U:1:12345] or [U:0:12345] or bare "U:1:12345"
  const steam3 = handle.match(/^\[?\s*U:(\d):(\d+)\s*\]?$/i);
  if (steam3) {
    const account = BigInt(steam3[2]);
    const universe = Number(steam3[1]);
    return { kind: "steam3", steam64: steam32To64(account, universe) };
  }

  // SteamID2: STEAM_0:1:123  or STEAM_1:0:123
  const steam2 = handle.match(/^STEAM_[0-1]:([01]):(\d+)$/i);
  if (steam2) {
    const parity = BigInt(steam2[1]); // Y
    const y = BigInt(steam2[2]); // Z
    return { kind: "steam2", steam64: steam32To64(y * 2n + parity) };
  }

  // Profile URL: https://steamcommunity.com/id/<vanity>/ or /profiles/<64>/
  const profiles = handle.match(/steamcommunity\.com\/profiles\/(\d+)/i);
  if (profiles) return { kind: "steam64", steam64: profiles[1] };

  const vanity = handle.match(/steamcommunity\.com\/id\/([A-Za-z0-9_\-]+)/i);
  if (vanity) {
    const steam64 = await resolveVanity(vanity[1]);
    return { kind: "vanity", steam64 };
  }

  // Bare vanity alias
  if (/^[A-Za-z0-9_\-]{2,32}$/.test(handle)) {
    const steam64 = await resolveVanity(handle);
    return { kind: "vanity", steam64 };
  }

  throw new Error(
    `Could not parse "${handle}" as a Steam ID. Try a Steam64, a profile URL, or a vanity name.`,
  );
}

/** Resolve a vanity alias to Steam64 via the Steam Web API. */
export async function resolveVanity(vanity: string): Promise<string> {
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/ISteamUser/ResolveVanityURL/v0001/`);
  url.searchParams.set("key", key);
  url.searchParams.set("vanityurl", vanity);
  url.searchParams.set("url_type", "1");

  const data = (await assertOk(await fetch(url), "ResolveVanityURL")) as {
    response?: { success?: number; message?: string; steamid?: string };
  };

  if (!data.response || data.response.success !== 1 || !data.response.steamid) {
    throw new Error(data.response?.message ?? `Vanity "${vanity}" not found.`);
  }
  return data.response.steamid;
}

/** Fetch one or many player summaries. Preserves input order (missing = null). */
export async function getPlayerSummaries(steamids: string[]): Promise<(SteamProfile | null)[]> {
  if (steamids.length === 0) return [];
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/ISteamUser/GetPlayerSummaries/v0002/`);
  url.searchParams.set("key", key);
  url.searchParams.set("steamids", steamids.join(","));

  const data = (await assertOk(await fetch(url), "GetPlayerSummaries")) as {
    response?: { players?: unknown[] };
  };
  const players = (data.response?.players ?? []).map(toProfile);

  const byId = new Map(players.map((p) => [p.steamid, p]));
  return steamids.map((id) => byId.get(id) ?? null);
}

/** Recently played games (includes count and total playtime; filtered to CS2 on the caller). */
export async function getRecentlyPlayedGames(steamid: string, count = 30): Promise<SteamGame[]> {
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/IPlayerService/GetRecentlyPlayedGames/v0001/`);
  url.searchParams.set("key", key);
  url.searchParams.set("steamid", steamid);
  url.searchParams.set("count", String(count));

  const data = (await assertOk(await fetch(url), "GetRecentlyPlayedGames")) as {
    response?: { total_count?: number; games?: unknown[] };
  };
  const games = (data.response?.games ?? []) as Record<string, unknown>[];
  return games.map((g) => ({
    appid: Number(g.appid ?? 0),
    name: String(g.name ?? ""),
    playtime_forever: Number(g.playtime_forever ?? 0),
    playtime_2weeks: Number(g.playtime_2weeks ?? 0),
  }));
}

/** CS2 is appid 730. */
export const CS2_APP_ID = 730;

/** Steam account level (XP-based). Returns null if unavailable (e.g. private). */
export async function getPlayerLevel(steamid: string): Promise<number | null> {
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/IPlayerService/GetSteamLevel/v0001/`);
  url.searchParams.set("key", key);
  url.searchParams.set("steamid", steamid);

  const data = (await assertOk(await fetch(url), "GetSteamLevel")) as {
    response?: { player_level?: number };
  };
  return data.response?.player_level ?? null;
}

/** VAC / game / community ban status. Returns null when the lookup fails. */
export async function getPlayerBans(steamids: string[]): Promise<SteamBan | null> {
  if (steamids.length === 0) return null;
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/ISteamUser/GetPlayerBans/v0001/`);
  url.searchParams.set("key", key);
  url.searchParams.set("steamids", steamids.join(","));

  const data = (await assertOk(await fetch(url), "GetPlayerBans")) as {
    players?: SteamBan[];
  };
  return data.players?.[0] ?? null;
}

/**
 * VAC / game / community ban status for MANY players at once (up to 100 per
 * call). Returns a map keyed by Steam64; players missing from the response are
 * simply absent from the map.
 */
export async function getPlayerBansBatch(steamids: string[]): Promise<Map<string, SteamBan>> {
  const out = new Map<string, SteamBan>();
  if (steamids.length === 0) return out;
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/ISteamUser/GetPlayerBans/v0001/`);
  url.searchParams.set("key", key);
  url.searchParams.set("steamids", steamids.join(","));

  const data = (await assertOk(await fetch(url), "GetPlayerBans")) as {
    players?: SteamBan[];
  };
  for (const b of data.players ?? []) {
    if (b?.SteamId) out.set(b.SteamId, b);
  }
  return out;
}

/** Owned-game record filtered to specific appids (default: CS2). Respects games privacy —
 *  returns null when the requested title isn't exposed (e.g. locked games or private profile). */
export async function getOwnedGame(
  steamid: string,
  appids = [CS2_APP_ID],
): Promise<OwnedGame | null> {
  const key = requireSteamKey();
  const url = new URL(`${env.steamApiBase}/IPlayerService/GetOwnedGames/v0001/`);
  url.searchParams.set("key", key);
  url.searchParams.set("steamid", steamid);
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("include_appinfo", "1");
  url.searchParams.set("appids_filter", appids.join(","));

  const data = (await assertOk(await fetch(url), "GetOwnedGames")) as {
    response?: { game_count?: number; games?: unknown[] };
  };
  const game = (data.response?.games?.[0] ?? null) as Record<string, unknown> | null;
  if (!game) return null;
  return {
    appid: Number(game.appid ?? 0),
    name: typeof game.name === "string" ? game.name : undefined,
    playtime_forever: Number(game.playtime_forever ?? 0),
    playtime_2weeks: Number(game.playtime_2weeks ?? 0),
  };
}