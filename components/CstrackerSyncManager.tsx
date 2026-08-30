"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Cstracker sync manager.
 *
 * Two jobs in one component:
 * 1. AUTO-SYNC — when the player's cached cstracker extraction is missing or
 *    stale (`stale` prop), it silently kicks off a background sync and
 *    refreshes the page the moment it lands, so any player you look up gets
 *    their data without pressing anything.
 * 2. MANUAL — the Sync button in the header. Both paths hit the non-blocking
 *    /api/cstracker/sync route and poll /api/cstracker/status until the
 *    scrape + persist completes, then router.refresh() picks up the fresh
 *    server-rendered data.
 */

interface SyncStatus {
  lastSyncedAt?: string | null;
  inFlight?: boolean;
}

const POLL_MS = 2500;
const MAX_WAIT_MS = 240_000; // give up after 4 minutes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSync(
  steam64: string,
  fromAt: string | null,
  onInFlight: (inFlight: boolean) => void,
): Promise<"done" | "failed" | "timeout"> {
  let sawInFlight = false;
  let polls = 0;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    polls += 1;
    let status: SyncStatus | null = null;
    try {
      const res = await fetch(`/api/cstracker/status/${steam64}`);
      if (res.ok) status = (await res.json()) as SyncStatus;
    } catch {
      // transient — keep polling
    }
    if (!status) continue;
    if (status.inFlight) sawInFlight = true;
    onInFlight(!!status.inFlight);
    if (status.lastSyncedAt && status.lastSyncedAt !== fromAt) return "done";
    // A sync that was running finished without producing a newer cache (scrape
    // failed) → stop quietly.
    if (!status.inFlight && sawInFlight && polls > 2) return "failed";
    // Never even started (route rejected / backend down) → give up quickly.
    if (!status.inFlight && !sawInFlight && polls > 5) return "failed";
  }
  return "timeout";
}

export default function CstrackerSyncManager({
  steam64,
  initialLastSyncedAt,
  stale,
  showButton = true,
}: {
  steam64: string;
  initialLastSyncedAt: string | null;
  stale: boolean;
  /** False to run purely in the background (no visible Sync button). */
  showButton?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [autoSyncing, setAutoSyncing] = useState(false);
  const lastSyncedRef = useRef(initialLastSyncedAt);

  useEffect(() => {
    lastSyncedRef.current = initialLastSyncedAt;
  }, [initialLastSyncedAt]);

  // Auto-sync on look-up when the cached extraction is stale.
  useEffect(() => {
    if (!stale) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/cstracker/sync/${steam64}`, { method: "POST" });
        if (!res.ok) return;
        const j = (await res.json()) as { inFlight?: boolean };
        if (cancelled) return;
        setAutoSyncing(!!j.inFlight);
      } catch {
        return;
      }
      if (cancelled) return;
      const result = await waitForSync(steam64, initialLastSyncedAt, (inFlight) => {
        if (!cancelled) setAutoSyncing(inFlight);
      });
      if (cancelled) return;
      setAutoSyncing(false);
      if (result === "done") router.refresh();
    })();
    return () => {
      cancelled = true;
      setAutoSyncing(false);
    };
  }, [steam64, stale, initialLastSyncedAt, router]);

  async function sync() {
    if (state === "syncing") return;
    setState("syncing");
    try {
      const res = await fetch(`/api/cstracker/sync/${steam64}`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await waitForSync(steam64, lastSyncedRef.current, () => {});
      if (result === "done") {
        setState("done");
        setTimeout(() => {
          router.refresh();
          setState("idle");
        }, 900);
      } else {
        setState("error");
        setTimeout(() => setState("idle"), 4000);
      }
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  if (!showButton) return null;

  return (
    <div className="flex items-center gap-2">
      {autoSyncing && (
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"
          title="cstracker sync in progress"
        />
      )}
      <button
        type="button"
        onClick={sync}
        disabled={state === "syncing"}
        className={`shimmer-btn h-8 shrink-0 rounded-md px-3.5 text-[10px] font-semibold uppercase tracking-widest ${
          state === "error"
            ? "!text-red-300"
            : state === "done"
              ? "!text-emerald-300"
              : "text-white"
        } disabled:cursor-wait disabled:opacity-70`}
      >
        {state === "syncing"
          ? "Syncing…"
          : state === "done"
            ? "✓ Synced"
            : state === "error"
              ? "Failed"
              : "Sync"}
      </button>
    </div>
  );
}
