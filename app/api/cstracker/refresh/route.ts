import { connect } from "node:net";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { enqueueCstrackerRefresh } from "@/src/worker/cstrackerRefresh";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Fail fast when Redis is down — ioredis would otherwise hang forever. */
function redisReachable(timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: env.redis.host, port: env.redis.port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const Body = z.object({
  /** Optional: refresh a single player; omit to refresh every known player. */
  steamId: z.string().regex(/^\d{17}$/).optional(),
  force: z.boolean().optional(),
});

/**
 * POST /api/cstracker/refresh
 * Body: { steamId?, force? }
 *
 * Enqueues a background BullMQ job that prefetches + revalidates cstracker.gg
 * profiles (single player or all known players) and persists them, so profile
 * pages never wait on a cold scrape. Requires Redis for the queue.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "Provide an optional steamId." }, { status: 400 });
  }

  const reachable = await redisReachable();
  if (!reachable) {
    return NextResponse.json(
      { ok: false, error: "Redis is not reachable — start Redis to use the background refresh queue." },
      { status: 503 },
    );
  }

  try {
    const id = await enqueueCstrackerRefresh({ steam64: body.steamId, force: body.force });
    return NextResponse.json({ ok: true, jobId: id, scope: body.steamId ?? "all players" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Could not enqueue refresh (is Redis running?): ${message}` },
      { status: 503 },
    );
  }
}