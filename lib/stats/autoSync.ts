import { cstrackerProvider, invalidateCstrackerCache } from "@/lib/stats/cstracker";
import { persistCstracker } from "@/lib/stats/persistCstracker";

/**
 * Background cstracker.gg auto-sync.
 *
 * The player header layout auto-syncs any player you look up: when the cached
 * cstracker extraction is missing or older than AUTO_SYNC_MIN_AGE_MS, the page
 * renders instantly from Steam + whatever DB data exists and a background sync
 * (scrape → persist) is started here — no blocking, no button press. A client
 * component polls /api/cstracker/status and refreshes the page when the sync
 * lands.
 *
 * In-flight jobs are deduped per Steam64 (one scrape per player at a time), so
 * hammering a profile with refreshes never piles up concurrent scrapes.
 */

/** How old the cached extraction must be before a look-up triggers a resync. */
export const AUTO_SYNC_MIN_AGE_MS =
  (Number(process.env.CSTACKER_AUTO_SYNC_MIN_AGE_MIN ?? 30) || 30) * 60 * 1000;

/** Steam64 → in-flight job, so concurrent look-ups share one scrape. */
const inFlight = new Map<string, Promise<void>>();

export function isCstrackerSyncing(steam64: string): boolean {
  return inFlight.has(steam64);
}

/**
 * Start a background sync for a player (deduped). Resolves immediately — the
 * scrape + persist run detached from the caller. Returns false when a sync is
 * already running for this player.
 */
export function startCstrackerSync(steam64: string): { started: boolean } {
  if (inFlight.has(steam64)) return { started: false };

  const job = (async () => {
    try {
      await invalidateCstrackerCache(steam64);
      const { data, empty } = await cstrackerProvider(steam64, { force: true });
      if (!empty && data.cstracker) {
        await persistCstracker(steam64, data.cstracker);
      }
    } catch (err) {
      console.error(`[cstracker] background sync failed for ${steam64}:`, err);
    } finally {
      inFlight.delete(steam64);
    }
  })();

  inFlight.set(steam64, job);
  return { started: true };
}

/** Diagnostics: how many players are currently syncing. */
export function cstrackerSyncStats(): { inFlight: number } {
  return { inFlight: inFlight.size };
}
