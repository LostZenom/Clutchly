import { Queue } from "bullmq";
import { getRedis } from "@/src/worker/redis";

export const DEMO_PARSE_QUEUE = "demo-parse";

export interface DemoParseJobData {
  matchId: string;
  /** The user this match was imported for (drives teammate aggregation + outcome). */
  forUser: string;
  shareCode?: string;
  force?: boolean;
}

let queue: Queue | null = null;

export function getDemoParseQueue(): Queue {
  if (!queue) {
    queue = new Queue(DEMO_PARSE_QUEUE, { connection: getRedis() });
  }
  return queue;
}

/** Enqueue a demo parse for a match that already has a Match row. */
export async function enqueueDemoParse(job: DemoParseJobData): Promise<string> {
  const added = await getDemoParseQueue().add(`parse:${job.matchId}`, job, {
    jobId: `parse:${job.matchId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
  return added.id ?? job.matchId;
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}