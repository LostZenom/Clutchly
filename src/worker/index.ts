import { Worker } from "bullmq";
import { getRedis } from "@/src/worker/redis";
import { DEMO_PARSE_QUEUE, type DemoParseJobData } from "@/src/worker/queue";
import { runDemoPipeline } from "@/src/worker/pipeline";
import { startLiveFeed, type LiveFeed } from "@/src/worker/liveFeed";
import {
  startCstrackerRefreshWorker,
  scheduleCstrackerRefresh,
} from "@/src/worker/cstrackerRefresh";

/**
 * BullMQ worker main. Start with `npm run worker`.
 * Concurrency is deliberately low — demo downloads stress rate limits and
 * parsing is CPU-heavy, so keep instances few and concurrency modest.
 */
async function main(): Promise<void> {
  const worker = new Worker<DemoParseJobData>(
    DEMO_PARSE_QUEUE,
    async (job) => {
      console.log(`[worker] start ${job.id}: match=${job.data.matchId} user=${job.data.forUser}`);
      await runDemoPipeline(job.data.matchId, job.data.forUser);
      console.log(`[worker] done ${job.id}: match=${job.data.matchId}`);
    },
    {
      connection: getRedis(),
      concurrency: 2,
      limiter: { max: 10, duration: 1000 }, // pace demo downloads across instances
      autorun: true,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] FAILED ${job?.id}: ${err.message}`);
  });
  worker.on("error", (err) => {
    if (err.message !== "Connection is closed.") console.error(`[worker] error: ${err.message}`);
  });

  // cstracker.gg prefetch/revalidation worker + periodic schedule.
  const cstrackerWorker = startCstrackerRefreshWorker();
  try {
    await scheduleCstrackerRefresh();
    console.log("[worker] cstracker refresh scheduled (every 6h).");
  } catch (err) {
    console.error("[worker] could not schedule cstracker refresh:", err instanceof Error ? err.message : err);
  }

  // Live overlay feed — watches the app account's current game for /overlay.
  const liveFeed: LiveFeed = startLiveFeed();

  console.log(
    `[worker] listening on queues "${DEMO_PARSE_QUEUE}" + "${cstrackerWorker.name}" (+ "${liveFeed.name}"). Press Ctrl+C to stop.`,
  );

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    await worker.close();
    await cstrackerWorker.close();
    await liveFeed.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});