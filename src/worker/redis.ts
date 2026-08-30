import IORedis from "ioredis";
import { env } from "@/lib/env";

let shared: IORedis | null = null;

/**
 * BullMQ/IORedis connection. `maxRetriesPerRequest: null` is required by
 * BullMQ so it can manage its own retries. The worker and queue share a
 * single connection per process.
 */
export function getRedis(): IORedis {
  if (!shared) {
    shared = new IORedis({
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      db: env.redis.db,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
  }
  return shared;
}