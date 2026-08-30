import { prisma } from "@/lib/prisma";

export const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12h — never re-fetch on every page load

export interface CacheEntry {
  payload: unknown;
  fetchedAt: Date;
  expiresAt: Date;
  stale: boolean;
}

/**
 * Serve the cached payload when fresh. When stale/missing, fetch fresh data;
 * if the refresh fails, fall back to the stale copy (stale-while-revalidate)
 * so the UI never breaks because a source is temporarily down.
 */
export async function getOrFetch<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  options: { source?: string; allowStaleOnError?: boolean } = {},
): Promise<{ data: T; fromCache: boolean; stale: boolean }> {
  const cached = await prisma.statCache
    .findUnique({ where: { key } })
    .catch(() => null);

  const fresh =
    cached && cached.expiresAt.getTime() > Date.now()
      ? (cached.payload as T)
      : null;

  if (fresh !== null && fresh !== undefined) {
    return { data: fresh, fromCache: true, stale: false };
  }

  try {
    const data = await fetcher();
    await prisma.statCache.upsert({
      where: { key },
      update: {
        payload: data as object,
        source: options.source ?? "merged",
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
      create: {
        key,
        source: options.source ?? "merged",
        payload: data as object,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    }).catch(() => null);
    return { data, fromCache: false, stale: false };
  } catch (err) {
    if (options.allowStaleOnError && cached) {
      return { data: cached.payload as T, fromCache: true, stale: true };
    }
    throw err;
  }
}

export async function invalidateCache(key: string): Promise<void> {
  await prisma.statCache.deleteMany({ where: { key } }).catch(() => {});
}
