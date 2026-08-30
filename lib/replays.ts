import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { parseDemoFile } from "@/src/worker/demofileParser";
import { persistParsed } from "@/src/worker/persist";

const DEFAULT_CANDIDATES = [
  "C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/replays",
  "C:/Program Files/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/replays",
  "D:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/replays",
  `${process.env.HOME ?? ""}/.steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/replays`,
];

/** Replays folder: REPLAYS_DIR env override, else the first existing Steam path. */
export function defaultReplaysDir(): string {
  if (process.env.REPLAYS_DIR && existsSync(process.env.REPLAYS_DIR)) {
    return process.env.REPLAYS_DIR;
  }
  for (const c of DEFAULT_CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  return DEFAULT_CANDIDATES[0];
}

export interface ReplayFile {
  path: string;
  name: string;
  mtime: Date;
}

/** List .dem replays (oldest first) in the given folder. */
export function discoverReplays(dir = defaultReplaysDir()): ReplayFile[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".dem"))
      .map((f) => {
        const path = join(dir, f);
        const st = statSync(path);
        return { path, name: f, mtime: st.mtime };
      })
      .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  } catch {
    return [];
  }
}

/**
 * Stable dedupe key for a local replay filename, e.g.
 * match730_003838712447699517587_0093323781_392.dem → LOCAL-003838712447699517587_0093323781_392.
 * Fits the unique Match.shareCode column so replays are imported exactly once.
 */
export function replayKey(name: string): string {
  const m = name.match(/^match\d+_(\d+)_(\d+)_(\d+)\.dem$/i);
  if (m) return `LOCAL-${m[1]}_${m[2]}_${m[3]}`;
  return `LOCAL-${name.replace(/\.dem$/i, "")}`;
}

export interface SyncResult {
  dir: string;
  found: number;
  parsed: number;
  skipped: number;
  failed: { file: string; error: string }[];
}

/**
 * Scan the replays folder and parse every new .dem into the database.
 * Parses once per demo and persists for every real player so each of the 10
 * participants' profiles lights up (matches, maps, weapons, teammates).
 */
export async function syncReplays(dir = defaultReplaysDir()): Promise<SyncResult> {
  const replays = discoverReplays(dir);
  const result: SyncResult = { dir, found: replays.length, parsed: 0, skipped: 0, failed: [] };

  for (const r of replays) {
    const key = replayKey(r.name);
    const existing = await prisma.match
      .findUnique({ where: { shareCode: key }, select: { id: true, parseStatus: true } })
      .catch(() => null);
    if (existing && existing.parseStatus === "PARSED") {
      result.skipped += 1;
      continue;
    }

    try {
      const match =
        existing ??
        (await prisma.match.create({
          data: { shareCode: key, mapName: "de_unknown", parseStatus: "QUEUED" },
        }));

      const parsed = parseDemoFile(r.path);
      const forUsers = [...new Set(parsed.players.map((p) => p.steam64))];
      if (forUsers.length === 0) {
        throw new Error("Demo parsed but contained no real players.");
      }
      for (const u of forUsers) {
        await persistParsed(match.id, parsed, u);
      }
      result.parsed += 1;
    } catch (err) {
      result.failed.push({
        file: r.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}