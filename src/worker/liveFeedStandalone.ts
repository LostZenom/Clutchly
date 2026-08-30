/**
 * Standalone entry for the live overlay feed — run just this in a terminal to
 * push the current match's players to the overlay, no BullMQ worker needed.
 *
 *   npm run feed
 *
 * Requirements (see .env.example): STEAM_GC_ACCOUNT_NAME + STEAM_GC_PASSWORD,
 * with the account either in a match or (optionally) hooked up to
 * OVERLAY_TRACK_STEAM64. Idles safely until those are configured.
 */
import { ensureLiveFeed } from "@/src/worker/liveFeed";

async function main(): Promise<void> {
  const feed = await ensureLiveFeed();
  console.log("[feed] running — Ctrl+C to stop.");

  const shutdown = async () => {
    await feed.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[feed] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});