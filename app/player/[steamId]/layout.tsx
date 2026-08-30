import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlayer } from "@/lib/profile";
import { getPlayerHeaderData } from "@/lib/player-header";
import PlayerHeader from "@/components/PlayerHeader";
import PlayerTabs from "@/components/PlayerTabs";
import CstrackerSyncManager from "@/components/CstrackerSyncManager";

export const dynamic = "force-dynamic";

const STEAM64_RE = /^\d{17}$/;

async function load(steamId: string) {
  const valid = STEAM64_RE.test(steamId);
  if (!valid) return null;
  return getPlayer(steamId).catch(() => null);
}

export async function generateMetadata({
  params,
}: {
  params: { steamId: string };
}): Promise<Metadata> {
  const steam64 = params.steamId;
  const player = await load(steam64);
  return {
    title: player ? `${player.username} — Clutchly CS2` : "Player — Clutchly CS2",
    description: `Stats profile for ${player?.username ?? steam64}.`,
  };
}

export default async function PlayerLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { steamId: string };
}) {
  const steam64 = params.steamId;
  if (!STEAM64_RE.test(steam64)) {
    notFound();
  }
  const player = await getPlayer(steam64).catch(() => null);
  const header = await getPlayerHeaderData(steam64).catch(() => null);

  return (
    <div className="min-h-screen bg-void-950 text-zinc-50">
      {/* Top navigation */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-void-950/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/clutchly-logo.png" alt="" className="h-7 w-7 rounded-md" />
            <span className="text-sm font-semibold tracking-tight">Clutchly</span>
            <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-zinc-400">
              CS2
            </span>
          </Link>
          <Link href="/" className="text-xs text-zinc-400 transition hover:text-zinc-200">
            ← Back to search
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 pb-24">
        {/* Profile header */}
        <div className="animate-fade-up pt-10">
          <PlayerHeader steam64={steam64} />
        </div>

        {/* Background cstracker auto-sync: looks up → syncs → refreshes. No UI. */}
        <CstrackerSyncManager
          steam64={steam64}
          initialLastSyncedAt={header?.lastSyncedAt ?? null}
          stale={header?.stale ?? true}
          showButton={false}
        />

        {/* Sub-navigation */}
        <div className="mt-6 border-b border-white/5 pb-3">
          <PlayerTabs steam64={steam64} />
        </div>

        <main>{children}</main>
      </div>
    </div>
  );
}