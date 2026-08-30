"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Overview", key: "overview", ready: true },
  { label: "Matches", key: "matches", ready: true },
  { label: "Chat archive", key: "chat", ready: true },
  { label: "Teammates", key: "teammates", ready: false },
] as const;

/**
 * Centered segmented control (like a radio toggle): equal-width columns, a
 * single active fill that slides between them on a smooth cubic-bezier, and
 * 5px rounding. Clicking a tab swaps the active column.
 */
export default function PlayerTabs({ steam64 }: { steam64: string }) {
  const pathname = usePathname();
  const base = `/player/${steam64}`;

  const activeIndex =
    pathname === base || pathname === `${base}/`
      ? 0
      : pathname.startsWith(`${base}/matches`)
        ? 1
        : pathname.startsWith(`${base}/chat`)
          ? 2
          : 0;

  return (
    <nav className="mx-auto w-full max-w-lg" aria-label="Profile sections">
      <div className="relative grid grid-cols-4 rounded-[5px] border border-white/10 bg-black/25 p-1">
        {/* Sliding active fill — equal columns make index*25% an exact slide */}
        <div
          aria-hidden
          className="absolute inset-y-1 rounded-[3px] bg-white/[0.09] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-[left] duration-300 ease-[cubic-bezier(0.77,0,0.175,1)]"
          style={{ width: "calc(25% - 8px)", left: `calc(${activeIndex * 25}% + 4px)` }}
        />

        {TABS.map((tab, i) => {
          const href = `${base}/${tab.key === "overview" ? "" : tab.key}`;
          const isActive = i === activeIndex;

          if (!tab.ready) {
            return (
              <span
                key={tab.key}
                title="Lands in a later build step"
                className="relative z-10 cursor-not-allowed select-none px-2 py-1.5 text-center text-xs font-medium text-zinc-600"
              >
                {tab.label}
                <span className="ml-1.5 rounded bg-white/5 px-1 py-0.5 text-[9px] uppercase tracking-wider text-zinc-600">
                  soon
                </span>
              </span>
            );
          }

          return (
            <Link
              key={tab.key}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`relative z-10 rounded-[3px] px-2 py-1.5 text-center text-xs font-medium transition-colors duration-200 ${
                isActive ? "text-zinc-50" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
