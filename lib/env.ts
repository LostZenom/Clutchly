/**
 * Typed environment access with sane defaults. All values resolved once at
 * import and cached so the worker/API don't re-parse on every call.
 */

export const env = {
  get databaseUrl(): string {
    return process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/freebuff?schema=public";
  },

  get redis() {
    return {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
    };
  },

  get steamApiKey(): string {
    return process.env.STEAM_API_KEY ?? "";
  },

  /** Steam64 tracked by the overlay (set on login) — the "me" profile source. */
  get overlayTrackSteam64(): string {
    return process.env.OVERLAY_TRACK_STEAM64 ?? "";
  },

  get steamApiBase(): string {
    return process.env.STEAM_API_BASE ?? "https://api.steampowered.com";
  },

  /** "bullmq" (default, needs Redis) or "in_process" (fires parse inline, no Redis). */
  get parseMode(): "bullmq" | "in_process" {
    return process.env.PARSE_MODE === "in_process" ? "in_process" : "bullmq";
  },

  get defaultRegion(): string {
    return process.env.DEFAULT_REGION ?? "eu-west";
  },

  /** Valve replay CDN base used to assemble a `.dem` URL from a share code. */
  get replayBase(): string {
    return process.env.REPLAY_BASE ?? "http://replay152.valve.net";
  },

  get demosDir(): string {
    return process.env.DEMOS_DIR ?? `${process.cwd()}/demos`;
  },
};

// Steam required their own app secret; fail loudly only when actually used.
export function requireSteamKey(): string {
  const key = env.steamApiKey;
  if (!key) {
    throw new Error(
      "STEAM_API_KEY is not set. Add it to .env (get one at https://steamcommunity.com/dev/apikey).",
    );
  }
  return key;
}