"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

export interface ChatArchiveMessage {
  id: string;
  steam64: string;
  username: string;
  avatarUrl: string | null;
  message: string;
  isTeamChat: boolean;
  round: number;
  sentAt: string;
}

export interface ChatArchiveParticipant {
  steam64: string;
  username: string;
  avatarUrl: string | null;
  team: "CT" | "T" | "SPECTATOR";
  self: boolean;
}

export interface ChatArchiveGroup {
  id: string;
  mapName: string;
  shareCode: string;
  cstId: string | null;
  matchOutcome: string | null;
  matchDate: string;
  participants: ChatArchiveParticipant[];
  chatLogs: ChatArchiveMessage[];
}

function prettyMap(map: string): string {
  return map
    .replace(/^de_/, "")
    .replace(/^cs_/, "")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toUpperCase();
}

function fmtTime(sentAt: string): string {
  return new Date(sentAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Avatar({
  src,
  name,
  fallbackClass,
  size,
}: {
  src: string | null;
  name: string;
  fallbackClass: string;
  size: "md" | "sm";
}) {
  const px = size === "md" ? "h-8 w-8" : "h-6 w-6";
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-[8px] border border-white/10 bg-gradient-to-br ${fallbackClass} ${px}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-mono text-[9px] font-bold text-zinc-200">
          {(name.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </div>
  );
}

function outcomeChip(outcome: string | null) {
  if (outcome === "WIN") return { label: "WIN", cls: "bg-emerald-400/15 text-emerald-300" };
  if (outcome === "LOSS") return { label: "LOSS", cls: "bg-red-400/15 text-red-300" };
  if (outcome === "TIE") return { label: "TIE", cls: "bg-amber-400/15 text-amber-300" };
  return null;
}

export default function ChatArchive({
  steam64,
  initialGroups,
}: {
  steam64: string;
  initialGroups: ChatArchiveGroup[];
}) {
  const [groups, setGroups] = useState<ChatArchiveGroup[]>(initialGroups);
  const [pending, setPending] = useState(false);
  const startedRef = useRef(false);

  // Lazy-fill match participants (names/avatars of the 10 players) so the page
  // never waits on a cold scrape — cards populate within seconds.
  useEffect(() => {
    if (startedRef.current || initialGroups.length === 0) return;
    startedRef.current = true;

    // Needs fill when the game is missing its other players' chat (and has a
    // scrapeable cstracker id) — participants + the full conversation download.
    const need = initialGroups.filter(
      (g) => g.cstId && !g.chatLogs.some((m) => m.steam64 !== steam64),
    );
    if (need.length === 0) return;
    setPending(true);

    let idx = 0;
    let active = 0;
    const LIMIT = 3;
    async function worker() {
      while (idx < need.length) {
        const g = need[idx++];
        active += 1;
        try {
          const res = await fetch(`/api/cstracker/participants/${g.cstId}?selfSteam64=${steam64}`, {
            method: "POST",
          });
          if (res.ok) {
            const j = await res.json();
            setGroups((prev) =>
              prev.map((card) =>
                card.id === g.id
                  ? {
                      ...card,
                      participants:
                        Array.isArray(j.participants) && j.participants.length > 0
                          ? j.participants
                          : card.participants,
                      chatLogs:
                        Array.isArray(j.chatLogs) && j.chatLogs.length > 0 ? j.chatLogs : card.chatLogs,
                    }
                  : card,
              ),
            );
          }
        } catch {
          /* ignore — card just stays with what it has */
        } finally {
          active -= 1;
          if (active === 0) setPending(false);
        }
      }
    }
    for (let i = 0; i < LIMIT; i++) void worker();
  }, [steam64, initialGroups]);

  if (groups.length === 0 || groups.every((g) => g.chatLogs.length === 0)) {
    return (
      <div className="shimmer-card">
        <div className="shimmer-card__inner py-12 text-center">
          <p className="text-sm font-medium text-zinc-300">No chat messages yet</p>
          <p className="mt-1 text-xs text-zinc-500">Once a profile is synced, its chat history will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {pending && (
        <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-zinc-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          Resolving the other players in each game…
        </div>
      )}

      {groups.map((g) => {
        const outcome = outcomeChip(g.matchOutcome);
        const others = g.participants.filter((p) => p.steam64 !== steam64);

        return (
          <article
            key={g.id}
            className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]"
          >
            {/* Game header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-white/[0.02] px-4 py-3.5 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <h3 className="flex items-center gap-2.5 font-semibold text-zinc-100">
                  <MapMark map={g.mapName} />
                  {g.cstId ? (
                    <Link
                      href={`/matches/${g.cstId}?from=${steam64}`}
                      className="transition hover:text-amber-200"
                    >
                      {prettyMap(g.mapName)}
                    </Link>
                  ) : (
                    prettyMap(g.mapName)
                  )}
                </h3>
                {outcome && (
                  <span
                    className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${outcome.cls}`}
                  >
                    {outcome.label}
                  </span>
                )}
                {g.cstId && (
                  <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                    {g.shareCode}
                  </span>
                )}
              </div>
              <span className="whitespace-nowrap text-xs text-zinc-500">
                {new Date(g.matchDate).toLocaleDateString()} · {g.chatLogs.length} message
                {g.chatLogs.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* Participants — the people in this game */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-white/5 bg-black/20 px-4 py-2.5 sm:px-5">
              <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">
                players
              </span>
              {others.length > 0 ? (
                g.participants.map((p) => (
                  <PlayerChip key={p.steam64} p={p} self={p.steam64 === steam64} />
                ))
              ) : (
                <span className="text-[11px] text-zinc-600">
                  {pending ? (
                    "loading the other players…"
                  ) : (
                    <span className="rounded bg-amber-400/20 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-300">
                      you
                    </span>
                  )}
                </span>
              )}
            </div>

            {/* Messages — full conversation, color-coded per player */}
            <div className="divide-y divide-white/[0.04]">
              {g.chatLogs.map((m) => {
                const speaker = g.participants.find((p) => p.steam64 === m.steam64);
                const self = m.steam64 === steam64;
                const teamCls = self
                  ? "text-amber-200"
                  : speaker?.team === "CT"
                    ? "text-sky-300"
                    : speaker?.team === "T"
                      ? "text-orange-300"
                      : "text-zinc-300";
                const avCls = self
                  ? "from-amber-400/40 to-orange-500/40"
                  : speaker?.team === "CT"
                    ? "from-sky-500/40 to-cyan-500/40"
                    : speaker?.team === "T"
                      ? "from-orange-500/40 to-red-500/40"
                      : "from-zinc-500/40 to-zinc-600/40";
                return (
                  <div
                    key={m.id}
                    className="group relative flex items-start gap-3 px-4 py-3 transition hover:bg-white/[0.03] sm:px-5"
                  >
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 w-0.5 ${
                        m.isTeamChat
                          ? "bg-sky-400/60"
                          : self
                            ? "bg-amber-400/40"
                            : speaker?.team === "CT"
                              ? "bg-sky-400/30"
                              : "bg-orange-400/30"
                      }`}
                    />
                    <Link
                      href={`/player/${m.steam64}`}
                      className="mt-0.5 shrink-0"
                      title={m.username || m.steam64}
                    >
                      <Avatar src={m.avatarUrl ?? null} name={m.username || m.steam64} fallbackClass={avCls} size="md" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link
                          href={`/player/${m.steam64}`}
                          className={`text-xs font-semibold transition hover:brightness-125 ${teamCls}`}
                        >
                          {m.username || m.steam64}
                          {self && (
                            <span className="ml-1.5 rounded bg-amber-400/20 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-300">
                              you
                            </span>
                          )}
                          {!self && speaker && speaker.team !== "SPECTATOR" && (
                            <span
                              className={`ml-1.5 inline-flex items-center gap-1 rounded px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${
                                speaker.team === "CT"
                                  ? "bg-sky-400/10 text-sky-300"
                                  : "bg-orange-400/10 text-orange-300"
                              }`}
                              title={`${speaker.team} side`}
                            >
                              <span
                                className={`h-1 w-1 rounded-full ${speaker.team === "CT" ? "bg-sky-400" : "bg-orange-400"}`}
                              />
                              {speaker.team}
                            </span>
                          )}
                        </Link>
                        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-zinc-500">
                          R{m.round + 1}
                        </span>
                        {m.isTeamChat && (
                          <span className="rounded bg-sky-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-sky-300">
                            team
                          </span>
                        )}
                        <span className="text-[10px] text-zinc-600">{fmtTime(m.sentAt)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-100">
                        {m.message}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PlayerChip({
  p,
  self,
}: {
  p: ChatArchiveParticipant;
  self: boolean;
}) {
  const accent = self
    ? "border-amber-400/30 bg-amber-400/5"
    : p.team === "CT"
      ? "border-sky-400/20 bg-sky-400/5 hover:border-sky-400/40"
      : "border-orange-400/20 bg-orange-400/5 hover:border-orange-400/40";
  const textCls = self ? "text-amber-200" : p.team === "CT" ? "text-sky-200" : "text-orange-200";
  const avCls = self
    ? "from-amber-400/40 to-orange-500/40"
    : p.team === "CT"
      ? "from-sky-500/40 to-cyan-500/40"
      : "from-orange-500/40 to-red-500/40";
  return (
    <Link
      href={`/player/${p.steam64}`}
      className={`group flex items-center gap-1.5 rounded-lg border px-1.5 py-1 transition hover:brightness-125 ${accent}`}
      title={`View ${p.username}'s profile`}
    >
      <Avatar src={p.avatarUrl} name={p.username} fallbackClass={avCls} size="sm" />
      <span className={`max-w-[9rem] truncate text-[11px] font-medium ${textCls}`}>{p.username}</span>
      {self && (
        <span className="rounded bg-amber-400/20 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-300">
          you
        </span>
      )}
      {!self && p.team !== "SPECTATOR" && (
        <span
          className={`ml-1 inline-flex items-center gap-1 rounded px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${
            p.team === "CT" ? "bg-sky-400/10 text-sky-300" : "bg-orange-400/10 text-orange-300"
          }`}
          title={`${p.team} side`}
        >
          <span className={`h-1 w-1 rounded-full ${p.team === "CT" ? "bg-sky-400" : "bg-orange-400"}`} />
          {p.team}
        </span>
      )}
    </Link>
  );
}

function MapMark({ map }: { map: string }) {
  const icon = `/cs/maps/map_icon_${map.replace(/\./g, "")}.svg`;
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-[6px] border border-white/10 bg-white/5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" className="h-full w-full object-contain p-0.5" loading="lazy" />
    </span>
  );
}