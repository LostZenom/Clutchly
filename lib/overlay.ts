/**
 * Shared helpers for the desktop overlay: normalising a live GC roster into
 * the same shape the overlay UI consumes (see app/api/overlay/players/route.ts).
 */
import { getPlayerBansBatch, getPlayerLevel } from "@/lib/steam";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { isCstrackerSyncing, startCstrackerSync } from "@/lib/stats/autoSync";

/** GC account id (uint32) → Steam64 (e.g. 76561198...). */
export function accountIdToSteam64(accountId: number | string): string | null {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0 || id > 4_294_967_295) return null;
  return String(id + 76561197960265728);
}

/** Sanitise a player name for a card (trim, cap length, strip control chars). */
function safeName(name: unknown): string | null {
  const s = typeof name === "string" ? name : null;
  if (!s) return null;
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.length > 0 && clean.length <= 32 ? clean : clean.slice(0, 32);
}

export interface OverlayPlayer {
  steam64: string;
  username: string;
  avatarUrl: string | null;
  team: "CT" | "T";
  initial: string;
  /** Teammate-adjusted trust factor (cstracker), when synced. */
  trust: {
    value: number | null;
    level: "good" | "suspicious" | "bad" | null;
    /** Relative freshness, e.g. "20d ago" (as cstracker shows it). */
    updated: string | null;
  } | null;
  /** Ban summary from Steam — null when unknown (lookup failed / no API key). */
  bans: {
    vac: number;
    game: number;
    community: boolean;
    daysSinceLastBan: number | null;
    economy: string | null;
  } | null;
  /** Steam account level (XP-based), when available. */
  level: number | null;
}

export interface OverlayPayload {
  /** Live snapshot from the Game Coordinator when available. */
  live: boolean;
  inGame: boolean;
  map: string | null;
  scoreCT: number;
  scoreT: number;
  round: number;
  matchId: string | null;
  players: OverlayPlayer[];
}

/**
 * Turn an array of {account_id, name, team} GC roster rows into the overlay
 * payload shape. Useless rows are dropped; if fewer than 2 players survive it
 * isn't a real lobby.
 */
export function rosterFromGc(
  rows: { accountId: number | string; name: string; team?: "CT" | "T" }[],
  meta: { map?: string | null; scoreCT?: number; scoreT?: number; round?: number; matchId?: string | null } = {},
): OverlayPayload | null {
  const players: OverlayPlayer[] = [];
  for (const row of rows) {
    const steam64 = accountIdToSteam64(row.accountId);
    if (!steam64) continue;
    const name = safeName(row.name) ?? steam64;
    players.push({
      steam64,
      username: name,
      avatarUrl: null,
      team: row.team === "T" ? "T" : "CT",
      initial: name.charAt(0).toUpperCase(),
      trust: null,
      bans: null,
      level: null,
    });
  }
  if (players.length < 2) return null;
  return {
    live: true,
    inGame: true,
    map: meta.map ?? null,
    scoreCT: meta.scoreCT ?? 0,
    scoreT: meta.scoreT ?? 0,
    round: meta.round ?? 0,
    matchId: meta.matchId ?? null,
    players,
  };
}

// ---------------------------------------------------------------------------
// Per-player enrichment (trust factor + bans) for the overlay cards.
// ---------------------------------------------------------------------------

/** How long a fetched ban summary stays valid in the in-memory cache. */
const BANS_TTL_MS = 30 * 60_000;
const bansCache = new Map<string, { bans: OverlayPlayer["bans"]; at: number }>();

/** Steam levels change rarely — cache far longer than bans. */
const LEVEL_TTL_MS = 6 * 60 * 60_000;
const levelCache = new Map<string, { level: number | null; at: number }>();

/**
 * Keep background cstracker syncs for lobby players gentle: at most a couple of
 * new kicks per overlay poll, once per player per cooldown, skipping any whose
 * sync is already in flight. This fills trust-factor pills in without waiting
 * for someone to open each profile — and without hammering the cstracker proxy
 * pool.
 */
const SYNC_COOLDOWN_MS = 10 * 60_000;
const MAX_KICKS_PER_POLL = 2;
const lastSyncKick = new Map<string, number>();

function kickMissingTrustSyncs(missingTrust: string[]): void {
  const now = Date.now();
  let kicked = 0;
  for (const id of missingTrust) {
    if (kicked >= MAX_KICKS_PER_POLL) break;
    if (isCstrackerSyncing(id)) continue;
    const last = lastSyncKick.get(id) ?? 0;
    if (now - last < SYNC_COOLDOWN_MS) continue;
    lastSyncKick.set(id, now);
    startCstrackerSync(id);
    kicked += 1;
  }
}

/** Per-player trust + bans + level for any surface (overlay cards, scoreboards). */
export interface PlayerExtras {
  trust: OverlayPlayer["trust"] | null;
  bans: OverlayPlayer["bans"] | null;
  level: number | null;
}

/**
 * Load trust-factor (from the cstracker sync cache, local DB), Steam ban status
 * (batched Steam API call) and Steam level for a list of players — all
 * TTL-cached so hot paths (the 6s overlay poll, scoreboard renders) never hammer
 * the APIs. Missing data stays null → the caller just omits the pill/cell.
 */
export async function loadPlayerExtras(steam64sInput: string[]): Promise<Map<string, PlayerExtras>> {
  const steam64s = [...new Set(steam64sInput)].filter((s) => /^\d{17}$/.test(s));
  const out = new Map<string, PlayerExtras>();
  if (steam64s.length === 0) return out;

  // 1) Trust factor — read the cstracker sync rows (one DB query, already cached).
  const trustBySteam64 = new Map<string, OverlayPlayer["trust"]>();
  const cacheRows = await prisma.statCache
    .findMany({ where: { key: { in: steam64s.map((s) => `cstracker:${s}`) } } })
    .catch(() => []);
  for (const row of cacheRows) {
    const steam64 = row.key.replace(/^cstracker:/, "");
    const payload = row.payload as {
      cstracker?: {
        profile?: { trust?: { value?: number | null; level?: string | null; updated?: string | null } | null } | null;
      } | null;
    } | null;
    const trust = payload?.cstracker?.profile?.trust;
    if (trust && typeof trust.value === "number") {
      const level =
        trust.level === "good" || trust.level === "suspicious" || trust.level === "bad" ? trust.level : null;
      trustBySteam64.set(steam64, {
        value: trust.value,
        level,
        updated: typeof trust.updated === "string" ? trust.updated : null,
      });
    }
  }

  // 2) Bans — batched Steam API, in-memory TTL cache.
  const now = Date.now();
  const bansBySteam64 = new Map<string, OverlayPlayer["bans"]>();
  const missing: string[] = [];
  for (const s of steam64s) {
    const hit = bansCache.get(s);
    if (hit && now - hit.at < BANS_TTL_MS) {
      bansBySteam64.set(s, hit.bans);
    } else {
      missing.push(s);
    }
  }
  if (missing.length > 0 && env.steamApiKey) {
    try {
      const batch = await getPlayerBansBatch(missing);
      for (const id of missing) {
        const raw = batch.get(id);
        if (!raw) continue;
        const b: NonNullable<OverlayPlayer["bans"]> = {
          vac: raw.NumberOfVACBans ?? 0,
          game: raw.NumberOfGameBans ?? 0,
          community: !!raw.CommunityBanned,
          daysSinceLastBan: raw.DaysSinceLastBan ?? null,
          economy: raw.EconomyBan && raw.EconomyBan !== "none" ? raw.EconomyBan : null,
        };
        bansCache.set(id, { bans: b, at: now });
        bansBySteam64.set(id, b);
      }
    } catch {
      /* no API key / Steam error → bans stay null (unknown) */
    }
  }

  // 3) Steam level — one call per player, cached for hours.
  const levelBySteam64 = new Map<string, number | null>();
  const levelMissing = steam64s.filter((s) => {
    const hit = levelCache.get(s);
    if (hit && now - hit.at < LEVEL_TTL_MS) {
      levelBySteam64.set(s, hit.level);
      return false;
    }
    return true;
  });
  if (levelMissing.length > 0 && env.steamApiKey) {
    const levels = await Promise.all(levelMissing.map((s) => getPlayerLevel(s).catch(() => null)));
    levelMissing.forEach((s, i) => {
      const level = levels[i] ?? null;
      levelCache.set(s, { level, at: now });
      levelBySteam64.set(s, level);
    });
  }

  for (const s of steam64s) {
    out.set(s, {
      trust: trustBySteam64.get(s) ?? null,
      bans: bansBySteam64.get(s) ?? null,
      level: levelBySteam64.get(s) ?? null,
    });
  }
  return out;
}

/**
 * Attach extras to overlay players. Also quietly kicks background cstracker
 * syncs for players whose trust factor isn't known yet, so the pills fill in
 * on their own without waiting for someone to open each profile.
 */
export async function enrichOverlayPlayers(players: OverlayPlayer[]): Promise<OverlayPlayer[]> {
  if (players.length === 0) return players;
  const extras = await loadPlayerExtras(players.map((p) => p.steam64));
  const missingTrust = players.filter((p) => !extras.get(p.steam64)?.trust).map((p) => p.steam64);
  if (missingTrust.length > 0) kickMissingTrustSyncs(missingTrust);
  return players.map((p) => {
    const e = extras.get(p.steam64);
    return { ...p, trust: e?.trust ?? null, bans: e?.bans ?? null, level: e?.level ?? null };
  });
}