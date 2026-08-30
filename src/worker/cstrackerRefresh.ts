import { Queue, Worker } from "bullmq";
import { getRedis } from "@/src/worker/redis";
import { prisma } from "@/lib/prisma";
import { cstrackerProvider } from "@/lib/stats/cstracker";
import { persistCstracker } from "@/lib/stats/persistCstracker";

/**
 * Periodic cstracker.gg prefetch/revalidation.
 *
 * A repeatable BullMQ job (default every 6h) scrapes every known player
 * through the free-proxy pool and persists the fresh data, so profile pages
 * always hit the 12h StatCache instead of waiting on a cold scrape. A per-user
 * job (`refresh:<steam64>`) can be enqueued directly for immediate refreshes.
 */

export const CSTACKER_REFRESH_QUEUE = "cstracker-refresh";

export interface CstrackerRefreshJobData {
  steam64?: string; // omit → refresh all known players
  force?: boolean;
}

let queue: Queue | null = null;

export function getCstrackerRefreshQueue(): Queue {
  if (!queue) {
    queue = new Queue(CSTACKER_REFRESH_QUEUE, { connection: getRedis() });
  }
  return queue;
}

export async function enqueueCstrackerRefresh(data: CstrackerRefreshJobData): Promise<string | undefined> {
  const name = data.steam64 ? `refresh:${data.steam64}` : "refresh:all";
  const added = await getCstrackerRefreshQueue().add(name, data, {
    jobId: name,
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
  return added.id ?? name;
}

export interface RefreshResult {
  ok: boolean;
  matches?: number;
  playerStats?: number;
  weapons?: number;
  chat?: number;
  error?: string;
}

/** Scrape one player through the proxy pool and persist it to the DB. */
export async function refreshOnePlayer(steam64: string, force = false): Promise<RefreshResult> {
  try {
    const result = await cstrackerProvider(steam64, { force });
    if (result.empty || !result.data.cstracker) {
      return { ok: false, error: "cstracker returned no data for this player" };
    }
    const summary = await persistCstracker(steam64, result.data.cstracker);
    return { ok: true, ...summary };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Scrape + persist every known player (used by the periodic job). */
export async function refreshAllPlayers(force = false): Promise<{ players: number; ok: number; failed: string[] }> {
  const users = await prisma.user.findMany({ select: { steam64: true }, take: 200 }).catch(() => []);
  const failed: string[] = [];
  let ok = 0;
  for (const u of users) {
    const r = await refreshOnePlayer(u.steam64, force);
    if (r.ok) ok += 1;
    else if (r.error) failed.push(`${u.steam64}: ${r.error}`);
  }
  return { players: users.length, ok, failed };
}

/** Worker that processes cstracker-refresh jobs. */
export function startCstrackerRefreshWorker(): Worker<CstrackerRefreshJobData> {
  const worker = new Worker<CstrackerRefreshJobData>(
    CSTACKER_REFRESH_QUEUE,
    async (job) => {
      const { steam64, force } = job.data;
      console.log(`[cstracker-refresh] start ${job.id}`);
      if (steam64) {
        const r = await refreshOnePlayer(steam64, force ?? false);
        if (!r.ok) throw new Error(r.error ?? "refresh failed");
        console.log(`[cstracker-refresh] done ${job.id}: ${r.matches} matches, ${r.weapons} weapons, ${r.chat} chat`);
      } else {
        const r = await refreshAllPlayers(force ?? false);
        console.log(
          `[cstracker-refresh] all done: ${r.ok}/${r.players} ok${r.failed.length ? `, failed: ${r.failed.slice(0, 5).join("; ")}` : ""}`,
        );
      }
    },
    {
      connection: getRedis(),
      concurrency: 2,
      autorun: true,
    },
  );

  worker.on("failed", (job, err) => console.error(`[cstracker-refresh] FAILED ${job?.id}: ${err.message}`));
  worker.on("error", (err) => {
    if (err.message !== "Connection is closed.") console.error(`[cstracker-refresh] error: ${err.message}`);
  });
  return worker;
}

/** Register the repeatable schedule (default: every 6 hours). */
export async function scheduleCstrackerRefresh(intervalMs = 6 * 60 * 60 * 1000): Promise<void> {
  await getCstrackerRefreshQueue().upsertJobScheduler(
    "cstracker-refresh-schedule",
    { every: intervalMs },
    { name: "refresh:all", data: {} },
  );
}