"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

interface OverlayPlayer {
  steam64: string;
  username: string;
  avatarUrl: string | null;
  team: "CT" | "T";
  initial: string;
  /** Teammate-adjusted trust factor (cstracker), when synced. */
  trust?: { value: number | null; level: "good" | "suspicious" | "bad" | null; updated?: string | null } | null;
  /** Ban summary from Steam — null when unknown. */
  bans?: {
    vac: number;
    game: number;
    community: boolean;
    daysSinceLastBan?: number | null;
    economy?: string | null;
  } | null;
  /** Steam account level (XP-based), when available. */
  level?: number | null;
}

interface OverlayPayload {
  inGame: boolean;
  map: string | null;
  scoreCT: number;
  scoreT: number;
  players: OverlayPlayer[];
  live?: boolean;
  status?: "live" | "waiting" | "last-match";
}

/** Minimal, safe type for the Electron preload bridge. */
interface OverlayApi {
  isDesktop?: boolean;
  getSettings: () => Promise<any>;
  saveSettings: (patch: Record<string, unknown>) => Promise<{
    ok: boolean;
    settings?: any;
    needsRestart?: boolean;
    needsPortRestart?: boolean;
  }>;
  setInteractive: (v: boolean) => Promise<{ interactive: boolean }>;
  openSettings: () => Promise<unknown>;
  onModeChange: (cb: (interactive: boolean) => void) => () => void;
  onSettingsChange: (cb: (settings: any) => void) => () => void;
}

const POLL_MS = 6000;

const chevronLeft = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7.05819 10.6145C6.31393 11.3887 6.31394 12.6124 7.05819 13.3866L12.4017 18.9449C13.5249 20.1134 15.4993 19.3183 15.4993 17.6975L15.4993 6.30362C15.4993 4.68283 13.5249 3.88772 12.4017 5.05616L7.05819 10.6145Z"
      fill="currentColor"
    />
  </svg>
);
const chevronRight = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M16.9408 10.6142C17.6851 11.3884 17.6851 12.6122 16.9408 13.3864L11.5974 18.9447C10.4741 20.1131 8.49976 19.318 8.49976 17.6972L8.49976 6.30338C8.49976 4.68259 10.4741 3.88748 11.5974 5.05591L16.9408 10.6142Z"
      fill="currentColor"
    />
  </svg>
);
const chevronDown = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" className="shrink-0">
    <path
      d="M6 9l6 6 6-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const gearIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.2788 2.15224C13.9085 2 13.439 2 12.5 2C11.561 2 11.0915 2 10.7212 2.15224C10.2274 2.35523 9.83509 2.74458 9.63056 3.23463C9.53719 3.45834 9.50065 3.7185 9.48635 4.09799C9.46534 4.65568 9.17716 5.17189 8.69017 5.45093C8.20318 5.72996 7.60864 5.71954 7.11149 5.45876C6.77318 5.2813 6.52789 5.18262 6.28599 5.15102C5.75609 5.08178 5.22018 5.22429 4.79616 5.5472C4.47814 5.78938 4.24339 6.1929 3.7739 6.99993C3.30441 7.80697 3.06967 8.21048 3.01735 8.60491C2.94758 9.1308 3.09118 9.66266 3.41655 10.0835C3.56506 10.2756 3.77377 10.437 4.0977 10.639C4.57391 10.936 4.88032 11.4419 4.88029 12C4.88026 12.5581 4.57386 13.0639 4.0977 13.3608C3.77372 13.5629 3.56497 13.7244 3.41645 13.9165C3.09108 14.3373 2.94749 14.8691 3.01725 15.395C3.06957 15.7894 3.30432 16.193 3.7738 17C4.24329 17.807 4.47804 18.2106 4.79606 18.4527C5.22008 18.7756 5.75599 18.9181 6.28589 18.8489C6.52778 18.8173 6.77305 18.7186 7.11133 18.5412C7.60852 18.2804 8.2031 18.27 8.69012 18.549C9.17714 18.8281 9.46533 19.3443 9.48635 19.9021C9.50065 20.2815 9.53719 20.5417 9.63056 20.7654C9.83509 21.2554 10.2274 21.6448 10.7212 21.8478C11.0915 22 11.561 22 12.5 22C13.439 22 13.9085 22 14.2788 21.8478C14.7726 21.6448 15.1649 21.2554 15.3694 20.7654C15.4628 20.5417 15.4994 20.2815 15.5137 19.902C15.5347 19.3443 15.8228 18.8281 16.3098 18.549C16.7968 18.2699 17.3914 18.2804 17.8886 18.5412C18.2269 18.7186 18.4721 18.8172 18.714 18.8488C19.2439 18.9181 19.7798 18.7756 20.2038 18.4527C20.5219 18.2105 20.7566 17.807 21.2261 16.9999C21.6956 16.1929 21.9303 15.7894 21.9827 15.395C22.0524 14.8691 21.9088 14.3372 21.5835 13.9164C21.4349 13.7243 21.2262 13.5628 20.9022 13.3608C20.4261 13.0639 20.1197 12.558 20.1197 11.9999C20.1197 11.4418 20.4261 10.9361 20.9022 10.6392C21.2263 10.4371 21.435 10.2757 21.5836 10.0835C21.9089 9.66273 22.0525 9.13087 21.9828 8.60497C21.9304 8.21055 21.6957 7.80703 21.2262 7C20.7567 6.19297 20.522 5.78945 20.2039 5.54727C19.7799 5.22436 19.244 5.08185 18.7141 5.15109C18.4722 5.18269 18.2269 5.28136 17.8887 5.4588C17.3915 5.71959 16.7969 5.73002 16.3099 5.45096C15.8229 5.17191 15.5347 4.65566 15.5136 4.09794C15.4993 3.71848 15.4628 3.45833 15.3694 3.23463C15.1649 2.74458 14.7726 2.35523 14.2788 2.15224ZM12.5 15C14.1695 15 15.5228 13.6569 15.5228 12C15.5228 10.3431 14.1695 9 12.5 9C10.8305 9 9.47716 10.3431 9.47716 12C9.47716 13.6569 10.8305 15 12.5 15ZM12.5 13.2C11.8442 13.2 11.38 12.7 11.38 12C11.38 11.3 11.8442 10.8 12.5 10.8C13.1558 10.8 13.62 11.3 13.62 12C13.62 12.7 13.1558 13.2 12.5 13.2ZM12.5 13.2C11.8442 13.2 11.38 12.7 11.38 12C11.38 11.3 11.8442 10.8 12.5 10.8C13.1558 10.8 13.62 11.3 13.62 12C13.62 12.7 13.1558 13.2 12.5 13.2ZM10.8 12C10.8 11.45 11.24 11 11.9 11C12.56 11 13 11.45 13 12C13 12.55 12.56 13 11.9 13C11.24 13 10.8 12.55 10.8 12ZM14.2 12C14.2 11.45 13.76 11 13.1 11C12.44 11 12 11.45 12 12C12 12.55 12.44 13 13.1 13C13.76 13 14.2 12.55 14.2 12Z"
      fill="currentColor"
    />
  </svg>
);

const TEAM_DOT: Record<OverlayPlayer["team"], string> = {
  CT: "bg-sky-400",
  T: "bg-rose-400",
};

function mg(accel: string) {
  return String(accel || "Ctrl+Shift+O")
    .replace(/CommandOrControl/g, "Ctrl")
    .replace(/\+/g, " + ")
    .replace("Super", "Win");
}

function StatusPill({ status, map }: { status: "live" | "waiting" | "last-match"; map: string | null }) {
  const cfg =
    status === "live"
      ? { dot: "bg-emerald-400 animate-pulse", text: "text-emerald-300", label: "LIVE" }
      : status === "waiting"
        ? { dot: "bg-amber-400 animate-pulse", text: "text-amber-200/90", label: "WAITING" }
        : { dot: "bg-zinc-500", text: "text-zinc-400", label: "LAST MATCH" };
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/50 px-3 py-1 backdrop-blur-md">
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      <span className={cfg.text}>
        {cfg.label}
        {map ? ` · ${map.replace(/^de_/, "").toUpperCase()}` : ""}
      </span>
    </span>
  );
}

export default function OverlayPage() {
  const [data, setData] = useState<OverlayPayload | null>(null);
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [index, setIndex] = useState(0);
  const [mounted, setMounted] = useState(false);

  // Desktop bridge — detected only after mount so server + client HTML match
  // (fixes hydration) and the bridge exists solely in the Electron window.
  const [desktop, setDesktop] = useState<OverlayApi | null>(null);
  const [interactive, setInteractive] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotkey, setHotkey] = useState("Ctrl+Shift+O");

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== "undefined") {
      setDesktop((window as unknown as { overlay?: OverlayApi }).overlay ?? null);
    }
  }, []);

  // Standalone settings window: /overlay?settings=1 renders ONLY the popup.
  const settingsOnly =
    mounted && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("settings");

  // Read settings + listen for mode/hotkey changes from Electron.
  useEffect(() => {
    if (!desktop) return;
    desktop
      .getSettings()
      .then((s) => {
        if (s?.hotkey) setHotkey(s.hotkey);
        if (typeof s?.interactiveOnLaunch === "boolean") setInteractive(s.interactiveOnLaunch);
      })
      .catch(() => {});
    const offMode = desktop.onModeChange(setInteractive);
    const offSettings = desktop.onSettingsChange((s) => {
      if (s?.hotkey) setHotkey(s.hotkey);
      if (typeof s?.interactiveOnLaunch === "boolean") setInteractive(s.interactiveOnLaunch);
    });
    return () => {
      offMode();
      offSettings();
    };
  }, [desktop]);

  const fetchRoster = useCallback(async () => {
    try {
      const res = await fetch("/api/overlay/players", { cache: "no-store" });
      if (!res.ok) return;
      const payload = (await res.json()) as OverlayPayload;
      setData(payload);
      setLive(payload.inGame);
    } catch {
      /* keep last known roster */
    }
  }, []);

  useEffect(() => {
    void fetchRoster();
    const t = setInterval(fetchRoster, POLL_MS);
    return () => clearInterval(t);
  }, [fetchRoster]);

  const players = data?.players ?? [];
  const count = players.length;
  const active = Math.min(Math.max(0, index), Math.max(0, count - 1));

  // Risk assessment: anyone with a ban or low trust gets a warning dot; the
  // single most suspicious player in the lobby gets the auto-glow treatment.
  const risks = useMemo(() => players.map(riskOf), [players]);
  const topRiskyIndex = useMemo(() => {
    let top = -1;
    let topScore = 0;
    risks.forEach((r, i) => {
      if (r.risky && r.score > topScore) {
        topScore = r.score;
        top = i;
      }
    });
    return top;
  }, [risks]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (count === 0) return;
      const next = (index + dir + count) % count;
      setIndex(next);
      scrollRef.current?.children[next]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    },
    [count, index],
  );

  const goTo = (i: number) => {
    setIndex(i);
    scrollRef.current?.children[i]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  useEffect(() => setIndex(0), [count]);

  const empty = count === 0;
  const interactiveOff = !!desktop && !interactive;

  // Settings-only window: just the centered, transparent popup.
  if (settingsOnly) {
    return <SettingsModal api={desktop} currentHotkey={hotkey} onClose={() => window.close()} />;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-50 h-screen w-screen overflow-hidden" style={{ background: "transparent" }}>
      {/* Gear (interactive mode only) — opens the standalone centered settings
          window when running in Electron; falls back to the in-window modal in
          a plain browser (no bridge). */}
      {desktop && interactive && !settingsOpen && (
        <div className="pointer-events-auto absolute right-5 top-5 z-30">
          <button
            onClick={() => {
              if (desktop.openSettings) {
                desktop.openSettings().catch(() => setSettingsOpen(true));
              } else {
                setSettingsOpen(true);
              }
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-zinc-300 backdrop-blur-md transition hover:border-white/25 hover:text-white"
            aria-label="Overlay settings"
            title="Settings"
          >
            {gearIcon}
          </button>
        </div>
      )}

      {/* Top-centred overlay */}
      <div className="pointer-events-auto mx-auto flex w-full flex-col items-center gap-2 px-6 pt-5 sm:pt-7">
        <AnimatePresence mode="wait">
          {live && expanded && !empty ? (
            <motion.div
              key="panel"
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="relative w-full"
            >
              {/* Match context bar — native drag handle */}
              <div className="overlay-drag mb-2 flex items-center justify-center gap-2 text-[11px] font-medium tracking-widest uppercase text-zinc-300">
                <StatusPill status={data?.status ?? "last-match"} map={data?.map ?? null} />
                {data?.map && (
                  <span className="rounded-full border border-white/10 bg-black/50 px-3 py-1 tabular-nums backdrop-blur-md">
                    {data.scoreCT} : {data.scoreT}
                  </span>
                )}
              </div>

              {/* Chevron + cards row */}
              <div className="relative flex items-center justify-center">
                <IconButton label="Previous player" onClick={() => step(-1)} disabled={count < 2}>
                  {chevronLeft}
                </IconButton>

                <div
                  ref={scrollRef}
                  className="scrollbar-none flex max-w-full snap-x snap-mandatory items-stretch gap-2.5 overflow-x-auto px-1 py-1"
                >
                  {players.map((p, i) => (
                    <PlayerCard
                      key={p.steam64}
                      player={p}
                      active={i === active}
                      risk={risks[i]}
                      isTopRisky={i === topRiskyIndex}
                      onOpen={() => goTo(i)}
                    />
                  ))}
                </div>

                <IconButton label="Next player" onClick={() => step(1)} disabled={count < 2}>
                  {chevronRight}
                </IconButton>
              </div>

              {/* Dots + collapse */}
              <div className="mt-2 flex items-center justify-center gap-3">
                {count > 1 && (
                  <div className="flex items-center gap-1.5">
                    {players.map((p, i) => (
                      <button
                        key={p.steam64}
                        onClick={() => goTo(i)}
                        aria-label={`Go to ${p.username}`}
                        className={`h-1.5 rounded-full transition-all ${
                          i === active ? "w-4 bg-electric-400" : "w-1.5 bg-white/25 hover:bg-white/50"
                        }`}
                      />
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setExpanded(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/50 text-zinc-400 backdrop-blur-md transition hover:text-white"
                  aria-label="Collapse overlay"
                  title="Collapse"
                >
                  {chevronDown}
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.button
              key="tab"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: "spring", stiffness: 300, damping: 26 }}
              onClick={() => setExpanded(true)}
              className="group flex h-10 items-center gap-2 rounded-full border border-white/10 bg-black/55 px-4 text-xs font-medium text-zinc-300 shadow-xl backdrop-blur-md transition hover:bg-black/70 hover:text-white"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-amber-400"}`} />
                <span className="uppercase tracking-widest">{live ? "Lobby" : "Offline"}</span>
                {!empty && <span className="text-zinc-500">· {count}</span>}
              </span>
              <span className="text-zinc-500 transition group-hover:translate-y-[1px]">{chevronDown}</span>
            </motion.button>
          )}
        </AnimatePresence>

        {/* Mode hint / status */}
        {desktop && !settingsOpen && (
          <div
            className={`mt-1 flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase transition ${
              interactiveOff ? "opacity-90" : "opacity-0 hover:opacity-100"
            } ${interactive ? "bg-emerald-400/10 text-emerald-300" : "bg-black/50 text-zinc-400"}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${interactive ? "bg-emerald-400" : "bg-zinc-400"}`} />
            {interactive ? "Interactive" : `Press ${mg(hotkey)} to interact`}
          </div>
        )}
      </div>

      {/* Settings modal */}
      {desktop && settingsOpen && (
        <SettingsModal api={desktop} currentHotkey={hotkey} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

const chevronSize = { width: 30, height: 30 };

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="z-10 -mx-0.5 shrink-0 cursor-pointer p-2 text-zinc-200 transition hover:scale-110 hover:text-white disabled:cursor-default disabled:opacity-25 disabled:hover:scale-100"
    >
      <span className="block drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" style={chevronSize}>
        {children}
      </span>
    </button>
  );
}

const POPOVER_H_EST = 190;

function PlayerCard({
  player,
  active,
  risk,
  isTopRisky,
  onOpen,
}: {
  player: OverlayPlayer;
  active: boolean;
  risk: { risky: boolean; score: number; kind: "ban" | "low-trust" | null };
  isTopRisky: boolean;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [popover, setPopover] = useState<{ left: number; top: number } | null>(null);

  const showPopover = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = r.bottom + 10;
    const fitsBelow = below + POPOVER_H_EST <= (window.innerHeight || 356);
    const left = Math.min(Math.max(r.left + r.width / 2, 120), (window.innerWidth || 920) - 120);
    setPopover({
      left,
      top: fitsBelow ? below : Math.max(6, r.top - POPOVER_H_EST - 10),
    });
  }, []);

  return (
    <>
      <motion.a
        ref={ref}
        href={`/player/${player.steam64}`}
        target="_blank"
        rel="noopener noreferrer"
        onFocus={onOpen}
        onMouseEnter={showPopover}
        onMouseLeave={() => setPopover(null)}
        onBlur={() => setPopover(null)}
        initial={{ opacity: 0, y: 10, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        onClick={onOpen}
        whileHover={{ y: -4 }}
        whileTap={{ scale: 0.95 }}
        className={`group relative flex w-[92px] shrink-0 snap-center flex-col items-center rounded-2xl border px-2.5 pb-3 pt-3.5 backdrop-blur-xl transition ${
        active
          ? "border-electric-400/60 bg-white/[0.06] shadow-[0_0_0_1px_rgba(56,189,248,0.25),0_18px_40px_-24px_rgba(0,0,0,0.9)]"
          : isTopRisky
            ? "border-rose-400/60 bg-rose-400/[0.06] shadow-[0_0_24px_-6px_rgba(244,63,94,0.7)] hover:border-rose-300/80"
            : "border-white/10 bg-black/55 hover:border-white/25 hover:bg-black/70"
      }`}
    >
      {/* Warning dot — any risky player; pulsing red for the most suspicious */}
      {risk.risky && (
        <span
          className={`absolute right-1.5 top-1.5 z-10 h-2.5 w-2.5 rounded-full ${
            isTopRisky
              ? "animate-pulse bg-rose-400 shadow-[0_0_10px_2px_rgba(251,113,133,0.8)]"
              : risk.kind === "ban"
                ? "bg-rose-400/90 shadow-[0_0_6px_1px_rgba(251,113,133,0.6)]"
                : "bg-amber-400/90 shadow-[0_0_6px_1px_rgba(251,191,36,0.6)]"
          }`}
          title={risk.kind === "ban" ? "Has a Steam ban" : "Low trust factor"}
        />
      )}
      <span className="relative">
        <span
          className={`absolute inset-0 rounded-full blur-md ${player.team === "CT" ? "bg-sky-400/50" : "bg-rose-400/50"} opacity-60 group-hover:opacity-90`}
        />
        {player.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={player.avatarUrl}
            alt=""
            loading="lazy"
            className="relative h-14 w-14 rounded-full object-cover ring-2 ring-white/20"
          />
        ) : (
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-xl font-semibold text-white ring-2 ring-white/20">
            {player.initial}
          </span>
        )}
      </span>
      <span className="mt-2 flex items-center gap-1">
        <span className={`h-1.5 w-1.5 rounded-full ${TEAM_DOT[player.team]}`} />
        <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">{player.team}</span>
      </span>
      <span className="mt-0.5 w-full truncate text-center text-[11px] font-semibold text-zinc-100 group-hover:text-white">
        {player.username}
      </span>

      {(player.trust?.value != null || player.bans) && (
        <span className="mt-1.5 flex w-full flex-col items-center gap-1">
          {player.trust?.value != null && <TrustPill trust={player.trust} />}
          {player.bans && <BansPills bans={player.bans} />}
        </span>
      )}
      </motion.a>

      {/* Hover popover — portal so the scroll container can't clip it. */}
      {popover &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[80] -translate-x-1/2"
            style={{ left: popover.left, top: popover.top }}
          >
            <CardPopover player={player} />
          </div>,
          document.body,
        )}
    </>
  );
}

function CardPopover({ player }: { player: OverlayPlayer }) {
  const trust = player.trust;
  const bans = player.bans;
  const banItems: { label: string; tone: "bad" | "warn" | "info" }[] = [];
  if (bans) {
    if (bans.vac > 0) banItems.push({ label: `VAC ban ×${bans.vac}`, tone: "bad" });
    if (bans.game > 0) banItems.push({ label: `Game ban ×${bans.game}`, tone: "bad" });
    if (bans.community) banItems.push({ label: "Community banned", tone: "bad" });
    if (bans.economy) banItems.push({ label: `Economy: ${bans.economy}`, tone: "warn" });
  }
  const days = bans?.daysSinceLastBan ?? null;
  const banNote = days != null && days > 0 ? ` · ${days}d ago` : "";

  const toneCls: Record<"good" | "suspicious" | "bad", string> = {
    good: "text-emerald-300",
    suspicious: "text-amber-200",
    bad: "text-rose-300",
  };
  const trustTone = trust ? trustLevel(trust) : null;

  return (
    <div className="w-56 rounded-xl border border-white/10 bg-black/90 p-3 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        {player.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={player.avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover ring-1 ring-white/15" />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-[11px] font-semibold text-white ring-1 ring-white/15">
            {player.initial}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-100">{player.username}</span>
        <span className="flex shrink-0 items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${TEAM_DOT[player.team]}`} />
          <span className="text-[8px] font-bold uppercase tracking-widest text-zinc-400">{player.team}</span>
        </span>
      </div>

      <div className="mt-2.5 space-y-1.5 border-t border-white/5 pt-2.5 text-[11px]">
        <PopoverRow label="Trust factor">
          {trust?.value != null ? (
            <span className={`font-semibold tabular-nums ${trustTone ? toneCls[trustTone] : "text-zinc-300"}`}>
              {trust.value}% · {trustTone ? trustTone[0].toUpperCase() + trustTone.slice(1) : "—"}
              {trust.updated ? <span className="text-zinc-500"> · {trust.updated}</span> : null}
            </span>
          ) : (
            <span className="text-zinc-500">Not synced yet</span>
          )}
        </PopoverRow>
        <PopoverRow label="Steam level">
          {player.level != null ? (
            <span className="font-semibold text-electric-300 tabular-nums">{player.level}</span>
          ) : (
            <span className="text-zinc-500">—</span>
          )}
        </PopoverRow>
        <PopoverRow label="Bans">
          {bans == null ? (
            <span className="text-zinc-500">Unknown</span>
          ) : banItems.length === 0 ? (
            <span className="font-semibold text-emerald-300">Clean</span>
          ) : (
            <span className="flex flex-col items-end gap-0.5">
              {banItems.map((b) => (
                <span
                  key={b.label}
                  className={`font-semibold ${
                    b.tone === "bad" ? "text-rose-300" : b.tone === "warn" ? "text-amber-200" : "text-zinc-300"
                  }`}
                >
                  {b.label}
                  {b.tone === "bad" && banNote ? <span className="text-zinc-500">{banNote}</span> : null}
                </span>
              ))}
            </span>
          )}
        </PopoverRow>
      </div>
    </div>
  );
}

function PopoverRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function trustLevel(t: { value: number | null; level: "good" | "suspicious" | "bad" | null }): "good" | "suspicious" | "bad" {
  if (t.level) return t.level;
  const v = t.value ?? 0;
  return v >= 90 ? "good" : v >= 80 ? "suspicious" : "bad";
}

/** Risk model for the lobby highlight: bans are the biggest red flag, then low trust. */
function riskOf(p: OverlayPlayer): { risky: boolean; score: number; kind: "ban" | "low-trust" | null } {
  const b = p.bans;
  const hasBan = !!b && (b.vac > 0 || b.game > 0 || b.community);
  const v = p.trust?.value ?? null;
  const lowTrust = v != null && v < 90;
  let score = 0;
  if (hasBan) score += 100 + (b?.vac ?? 0) * 5 + (b?.game ?? 0) * 5;
  if (lowTrust) score += Math.round(90 - (v ?? 90));
  return { risky: score > 0, score, kind: hasBan ? "ban" : lowTrust ? "low-trust" : null };
}

function TrustPill({ trust }: { trust: NonNullable<OverlayPlayer["trust"]> }) {
  const level = trustLevel(trust);
  const cls =
    level === "good"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
      : level === "suspicious"
        ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
        : "border-rose-400/25 bg-rose-400/10 text-rose-300";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[8px] font-semibold uppercase tracking-wider ${cls}`}
      title={`Trust factor ${trust.value ?? "?"}%`}
    >
      <svg viewBox="0 0 24 24" width="8" height="8" fill="none" aria-hidden="true">
        <path
          d="M12 2l7 3v6c0 4.5-3 8.5-7 11-4-2.5-7-6.5-7-11V5l7-3z"
          fill="currentColor"
          opacity="0.9"
        />
        <path d="M9 12l2 2 4-4" stroke="#0b0f14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {trust.value}%
    </span>
  );
}

function BansPills({ bans }: { bans: NonNullable<OverlayPlayer["bans"]> }) {
  const items: { label: string; title: string }[] = [];
  if (bans.vac > 0) items.push({ label: `VAC×${bans.vac}`, title: `${bans.vac} VAC ban${bans.vac === 1 ? "" : "s"}` });
  if (bans.game > 0) items.push({ label: `GAME×${bans.game}`, title: `${bans.game} game ban${bans.game === 1 ? "" : "s"}` });
  if (bans.community) items.push({ label: "COMM", title: "Community banned" });

  if (items.length === 0) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-emerald-400/15 bg-emerald-400/5 px-2 py-px text-[8px] font-semibold uppercase tracking-wider text-emerald-400/70"
        title="No bans on record"
      >
        Clean
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center justify-center gap-1">
      {items.map((b) => (
        <span
          key={b.label}
          className="inline-flex items-center rounded-full border border-rose-400/30 bg-rose-400/10 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider text-rose-300"
          title={b.title}
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hotkey recording — ANY key works (letters, digits, F-keys, arrows, symbols).
// ---------------------------------------------------------------------------
function practiceToAccel(e: React.KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const k = e.key;
  let main: string | null = null;
  if (k.length === 1 && k !== " ") {
    main = k.toUpperCase();
  } else if (k === " ") {
    main = "Space";
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(k)) {
    main = k.toUpperCase();
  } else if (
    /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Delete|Insert|Escape|Enter|Tab|Backspace|CapsLock|ContextMenu)$/i.test(
      k,
    )
  ) {
    main = k.replace(/^Arrow/, "");
  }
  if (!main) return null;
  return [...mods, main].join("+");
}

// ---------------------------------------------------------------------------
// Settings modal — two tabs (General / Steam) that share one Save.
// ---------------------------------------------------------------------------
type Tab = "general" | "steam";
type LoginState = "idle" | "loading" | "ok" | "guard" | "empty" | "error";

/** Strip the invisible tag/control characters some Steam names carry and fall back gracefully. */
function cleanName(v: string): string {
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u007f\u200b-\u200f\u2060-\u2064\ufeff\ue0000-\ue007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || "Steam player";
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2.5 py-2 text-center">
      <p className="text-xs font-semibold tabular-nums text-zinc-100">{value ?? "—"}</p>
      <p className="mt-0.5 text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
    </div>
  );
}

function SettingsModal({
  api,
  currentHotkey,
  onClose,
}: {
  api: OverlayApi | null;
  currentHotkey: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("general");
  const [hotkey, setHotkey] = useState(currentHotkey);
  const [recording, setRecording] = useState(false);
  const [interactiveLaunch, setInteractiveLaunch] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [gcAccount, setGcAccount] = useState("");
  const [gcPassword, setGcPassword] = useState("");
  const [gcGuard, setGcGuard] = useState("");
  const [gc2fa, setGc2fa] = useState("");
  const [gcRefresh, setGcRefresh] = useState("");
  const [tracked, setTracked] = useState("");
  const guardInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Website port (self-hosted) + first-run onboarding state.
  const [serverPort, setServerPort] = useState(3100);
  const [onboarded, setOnboarded] = useState(false);
  const [portMsg, setPortMsg] = useState<string | null>(null);

  // Signed-in profile — shown in the Steam tab INSTEAD of the QR once linked.
  const [steamMe, setSteamMe] = useState<{
    username: string | null;
    avatarUrl: string | null;
    level: number | null;
    premierRating: number | null;
    trust: { value: number | null; level: string | null } | null;
    bans: { vac: number; game: number; community: boolean } | null;
    record: { wins: number; losses: number; ties: number } | undefined;
  } | null>(null);
  const [steamMeLoading, setSteamMeLoading] = useState(false);

  const loadTrackedMe = useCallback(async (steam64: string) => {
    setSteamMeLoading(true);
    try {
      const res = await fetch(`/api/overlay/me?steam64=${encodeURIComponent(steam64)}`);
      const d = await res.json();
      setSteamMe(
        d?.ok
          ? {
              username: d.profile?.username ?? null,
              avatarUrl: d.profile?.avatarUrl ?? null,
              level: d.profile?.level ?? null,
              premierRating: d.premierRating ?? null,
              trust: d.trust ?? null,
              bans: d.bans ?? null,
              record: d.record ?? undefined,
            }
          : null,
      );
    } catch {
      setSteamMe(null);
    } finally {
      setSteamMeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tracked) void loadTrackedMe(tracked);
    else setSteamMe(null);
  }, [tracked, loadTrackedMe]);

  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [loginMsg, setLoginMsg] = useState("");
  const [clientState, setClientState] = useState<LoginState>("idle");
  const [clientMsg, setClientMsg] = useState("");

  // QR login — mirror of the website flow, scannable from the Steam app.
  const [qrId, setQrId] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrMsg, setQrMsg] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrStartedRef = useRef(false);
  const qrIdRef = useRef<string | null>(null);

  const startQr = useCallback(async (silent = false) => {
    if (!silent) setQrLoading(true);
    setQrMsg(null);
    try {
      const res = await fetch("/api/overlay/login-qr", { method: "POST" });
      const data = await res.json();
      if (data.ok && data.id && data.qrDataUrl) {
        qrIdRef.current = data.id;
        setQrId(data.id);
        setQrDataUrl(data.qrDataUrl);
      } else {
        setQrMsg(data.message || "Could not start QR login.");
      }
    } catch {
      setQrMsg("Could not reach the app server (is it running?).");
    } finally {
      setQrLoading(false);
    }
  }, []);

  // Auto-generate the QR the first time the Steam tab is viewed — no click.
  useEffect(() => {
    if (tab !== "steam" || qrStartedRef.current) return;
    qrStartedRef.current = true;
    startQr();
  }, [tab, startQr]);

  // Poll the QR login; auto-rotate to a fresh code when it expires.
  useEffect(() => {
    if (!qrId) return;
    qrPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/overlay/login-qr/status?id=${encodeURIComponent(qrId)}`);
        const data = await res.json();
        if (data.status === "authenticated") {
          clearInterval(qrPollRef.current!);
          qrPollRef.current = null;
          setQrId(null);
          qrIdRef.current = null;
          qrSignedIn(data.steamId, data.accountName);
        } else if (data.status === "expired") {
          clearInterval(qrPollRef.current!);
          qrPollRef.current = null;
          setQrId(null);
          setQrDataUrl(null);
          setQrMsg("Previous code expired — generating a fresh one…");
          startQr(true);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => {
      if (qrPollRef.current) {
        clearInterval(qrPollRef.current);
        qrPollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrId]);

  // Cancel the active backend session if the settings window closes.
  useEffect(() => {
    return () => {
      const id = qrIdRef.current;
      if (id) {
        fetch(`/api/overlay/login-qr/status?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
      }
    };
  }, []);

  const qrSignedIn = async (steamId: string, accountName?: string) => {
    if (accountName) setGcAccount(accountName);
    setTracked(steamId);
    setLoginState("ok");
    setLoginMsg("Connected to Steam via QR ✓ — Steam64 filled in and the live feed is running. The overlay updates while you play.");
    if (api) {
      try {
        await api.saveSettings({ steam: { trackedSteam64: steamId } });
      } catch {
        /* best-effort */
      }
    }
  };

  useEffect(() => {
    if (!api) return;
    api
      .getSettings()
      .then((s) => {
        if (s?.hotkey) setHotkey(s.hotkey);
        if (typeof s?.interactiveOnLaunch === "boolean") setInteractiveLaunch(s.interactiveOnLaunch);
        if (s?.serverPort != null) setServerPort(Number(s.serverPort) || 3100);
        setOnboarded(s?.onboarded === true);
        const st = s?.steam || {};
        setApiKey(st.apiKey || "");
        setGcAccount(st.gcAccount || "");
        setGcPassword(st.gcPassword || "");
        setGcGuard(st.gcGuardCode || "");
        setGc2fa(st.gc2faCode || "");
        setGcRefresh(st.refreshToken || "");
        setTracked(st.trackedSteam64 || "");
      })
      .catch(() => {});
  }, [api]);

  // When Steam Guard asks for a code, surface the field immediately (autofocus).
  useEffect(() => {
    if (loginState === "guard") guardInputRef.current?.focus();
  }, [loginState]);

  const save = async () => {
    setSaving(true);
    setSavedNote(null);
    if (!api) {
      setSaving(false);
      setSavedNote("Browser preview — use the desktop app to persist settings.");
      return;
    }
    const res = await api.saveSettings({
      hotkey,
      interactiveOnLaunch: interactiveLaunch,
      serverPort: Number(serverPort) || 3100,
      onboarded: true,
      steam: {
        apiKey: apiKey.trim(),
        gcAccount: gcAccount.trim(),
        gcPassword: gcPassword.trim(),
        gcGuardCode: gcGuard.trim(),
        gc2faCode: gc2fa.trim(),
        refreshToken: gcRefresh.trim(),
        trackedSteam64: tracked.trim(),
      },
    });
    setSaving(false);
    setSavedNote(
      res.needsRestart
        ? "Saved to .env — restart the app server (npm run dev / feed) to apply Steam keys."
        : "Saved ✓",
    );
  };

  // First-run: the app asks which local port to host the website on.
  const completeFirstRun = async () => {
    if (!api) {
      setPortMsg("Browser preview — open the desktop app to pick a port.");
      return;
    }
    const port = Number(serverPort) || 3100;
    setSaving(true);
    setPortMsg(`Restarting the website on port ${port}…`);
    try {
      const res = await api.saveSettings({ serverPort: port, onboarded: true });
      setOnboarded(true);
      setPortMsg(res.needsPortRestart ? `Website restarted on port ${port} ✓` : `Saved ✓ — the site runs on port ${port}`);
    } catch {
      setPortMsg("Could not save the port — try again.");
    } finally {
      setSaving(false);
    }
  };

  const loginSteam = async () => {
    if (!gcAccount.trim() || !gcPassword.trim()) {
      setLoginState("empty");
      setLoginMsg("Enter the GC account name and password first.");
      return;
    }
    setLoginState("loading");
    setLoginMsg("");
    try {
      const res = await fetch("/api/overlay/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: gcAccount.trim(),
          password: gcPassword.trim(),
          guardCode: gcGuard.trim() || undefined,
          twoFactorCode: gc2fa.trim() || undefined,
          trackedSteam64: tracked.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.needsGuard) {
        setLoginState("guard");
        setLoginMsg(data.message || "Steam Guard code required — add it above and try again.");
      } else if (data.ok) {
        // Persist the credentials + refresh token so the live feed can use them
        // right away (and future logins skip Steam Guard entirely).
        if (data.refreshToken) setGcRefresh(data.refreshToken);
        if (api) {
          try {
            await api.saveSettings({
              steam: {
                apiKey: apiKey.trim(),
                gcAccount: gcAccount.trim(),
                gcPassword: gcPassword.trim(),
                gcGuardCode: gcGuard.trim(),
                gc2faCode: gc2fa.trim(),
                refreshToken: data.refreshToken || gcRefresh.trim(),
                trackedSteam64: tracked.trim(),
              },
            });
          } catch {
            /* settings mirroring is best-effort */
          }
        }
        if (data.steamId) setTracked(data.steamId); // auto-fill the tracked account
        setLoginState("ok");
        setLoginMsg(
          data.feedStarted
            ? "Connected to Steam ✓ — Steam64 filled in and live feed started. The overlay updates while you play."
            : "Connected to Steam ✓ — Steam64 filled in. Start “npm run feed” to watch live games.",
        );
      } else {
        setLoginState("error");
        setLoginMsg(data.message || "Could not log in to Steam.");
      }
    } catch {
      setLoginState("error");
      setLoginMsg("Could not reach the app server (is it running?).");
    }
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      className={`rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-widest transition ${
        tab === t ? "bg-electric-400/15 text-electric-300" : "text-zinc-500 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );

  const loginViaClient = async () => {
    setClientState("loading");
    setClientMsg("");
    try {
      const res = await fetch("/api/overlay/login-client", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        if (data.accountName) setGcAccount(data.accountName);
        if (data.steamId) setTracked(data.steamId);
        setClientState("ok");
        setClientMsg(data.message || "Connected via Steam client ✓ — live feed started.");
      } else if (data.needsPassword && data.accountName) {
        // Detected the logged-in Steam account — prefill so only the password is needed.
        setGcAccount(data.accountName);
        if (data.steamId) setTracked(data.steamId);
        setClientState("empty");
        setClientMsg(data.message || `Steam is logged in as ${data.accountName} — enter your password below to finish.`);
      } else {
        setClientState("error");
        setClientMsg(data.message || "Could not auto-login via the Steam client.");
      }
    } catch {
      setClientState("error");
      setClientMsg("Could not reach the app server (is it running?).");
    }
  };

  const loginStyles: Record<LoginState, string> = {
    idle: "border-white/10 bg-white/[0.03] text-zinc-100 hover:border-white/25",
    loading: "border-white/10 bg-white/[0.03] text-zinc-400",
    ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
    guard: "border-amber-400/40 bg-amber-400/10 text-amber-200",
    empty: "border-amber-400/40 bg-amber-400/10 text-amber-200",
    error: "border-red-400/40 bg-red-400/10 text-red-300",
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-[70] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="relative flex w-full max-w-md max-h-[calc(100dvh-1.5rem)] flex-col rounded-lg border border-white/10 bg-void-950/95 shadow-2xl ring-1 ring-white/5"
      >
        <header className="overlay-drag flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300/90">
            // overlay · settings
          </span>
          <div className="flex items-center gap-1.5">
            <div className="flex rounded-lg border border-white/10 p-0.5">
              {tabBtn("general", "General")}
              {tabBtn("steam", "Steam")}
            </div>
            <button
              onClick={onClose}
              disabled={recording || saving}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:border-white/25 hover:text-white disabled:opacity-40"
              aria-label="Close settings"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {tab === "general" ? (
            <>
              {/* First-run — pitch the port choice cleanly before anything else. */}
              {!onboarded && (
                <section className="space-y-2.5 overflow-hidden rounded-lg border border-electric-400/30 bg-electric-400/[0.06] p-3.5">
                  <p className="text-sm font-semibold text-zinc-100">Welcome to Clutchly ✦</p>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    Clutchly hosts the website on this PC, so everything works out of the box.
                    Pick which local port to serve it on (or keep the default). Nothing is exposed to the internet.
                  </p>
                  <div>
                    <Label>Port</Label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={serverPort}
                      onChange={(e) => setServerPort(Number(e.target.value) || 3100)}
                      spellCheck={false}
                      className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-sm tabular-nums text-zinc-100 outline-none transition focus:border-electric-400/60"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setServerPort(3100)}
                      disabled={saving}
                      className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-white/25 disabled:opacity-50"
                    >
                      Use default (3100)
                    </button>
                    <button
                      type="button"
                      onClick={completeFirstRun}
                      disabled={saving}
                      className="shimmer-btn flex-1 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {saving ? "Restarting…" : "Start on this port"}
                    </button>
                  </div>
                  {portMsg && <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-[11px] text-zinc-300">{portMsg}</p>}
                </section>
              )}

              <section className="space-y-1.5">
                <Label>Toggle interactivity</Label>
                <button
                  type="button"
                  onClick={() => {
                    setRecording(true);
                    setSavedNote(null);
                  }}
                  onKeyDown={(e) => {
                    if (!recording) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      setRecording(false);
                      return;
                    }
                    const accel = practiceToAccel(e);
                    if (accel) {
                      setHotkey(accel);
                      setRecording(false);
                    }
                  }}
                  className={`w-full rounded-lg border px-3 py-2.5 text-center font-mono text-sm transition ${
                    recording
                      ? "border-electric-400/70 bg-electric-400/10 text-electric-200"
                      : "border-white/10 bg-black/50 text-zinc-100 hover:border-white/25"
                  }`}
                >
                  {recording ? "Press keys… (Esc cancels)" : mg(hotkey)}
                </button>
                <p className="text-[11px] text-zinc-600">
                  Click it, then press any key or combo — letters, digits, F-keys, arrows all work.
                </p>
              </section>

              <ToggleRow
                label="Interactive on launch"
                hint="When on, the overlay is clickable immediately. Toggle to click-through with the hotkey."
                checked={interactiveLaunch}
                onChange={setInteractiveLaunch}
              />

              {/* Website port — changing it restarts the local site automatically. */}
              <section className="space-y-1.5">
                <Label>Website port</Label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={serverPort}
                  onChange={(e) => setServerPort(Number(e.target.value) || 3100)}
                  spellCheck={false}
                  className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-sm tabular-nums text-zinc-100 outline-none transition focus:border-electric-400/60"
                />
                <p className="text-[11px] text-zinc-600">
                  The website (and overlay) run on this local port. Changing it restarts the site automatically.
                </p>
              </section>
            </>
          ) : (
            <section className="space-y-2.5">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
                Steam / live feed
              </p>

              {tracked ? (
                /* Signed in — show ONLY the profile card, everything else hidden. */
                <div className="space-y-2.5">
                  <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-void-950">
                        {steamMe?.avatarUrl ? (
                          <img src={steamMe.avatarUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-base font-bold text-electric-300">
                            {cleanName((steamMe?.username as string) || tracked).charAt(0).toUpperCase() || "?"}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-100">{cleanName((steamMe?.username as string) || tracked)}</p>
                        <p className="font-mono text-[10px] tabular-nums text-zinc-500">{tracked}</p>
                      </div>
                      <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                        Linked
                      </span>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <Stat label="Level" value={steamMe?.level != null ? String(steamMe.level) : null} />
                      <Stat label="Premier" value={steamMe?.premierRating != null ? String(steamMe.premierRating) : null} />
                      <Stat
                        label="Record"
                        value={
                          steamMe?.record
                            ? `${steamMe.record.wins}-${steamMe.record.losses}-${steamMe.record.ties}`
                            : null
                        }
                      />
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {steamMe?.trust?.value != null && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] font-medium text-zinc-300">
                          Trust {steamMe.trust.value}%
                        </span>
                      )}
                      {steamMe?.bans?.vac ? (
                        <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2.5 py-0.5 text-[10px] font-medium text-red-300">
                          VAC ×{steamMe.bans.vac}
                        </span>
                      ) : null}
                      {steamMe?.bans?.game ? (
                        <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2.5 py-0.5 text-[10px] font-medium text-red-300">
                          GAME ×{steamMe.bans.game}
                        </span>
                      ) : null}
                      {steamMe && !steamMe.bans?.vac && !steamMe.bans?.game && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] font-medium text-zinc-400">
                          No bans
                        </span>
                      )}
                    </div>

                    {steamMeLoading && (
                      <p className="mt-2.5 text-[11px] text-zinc-500">Loading your match data…</p>
                    )}
                    <p className="mt-2.5 text-[11px] leading-relaxed text-zinc-500">
                      Your Steam account is linked. The live feed is running and your profile stays synced with the
                      website while you play.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setTracked("");
                      setSteamMe(null);
                      setGcAccount("");
                      setGcRefresh("");
                      if (api) api.saveSettings({ steam: { trackedSteam64: "" } }).catch(() => {});
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-zinc-400 transition hover:border-red-400/40 hover:text-red-300"
                  >
                    Disconnect Steam account
                  </button>
                </div>
              ) : (
                /* Not linked — QR is the only option. */
                <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  {qrDataUrl ? (
                    <div className="flex flex-col items-center gap-2.5">
                      <img src={qrDataUrl} alt="Steam login QR code" className="h-40 w-40 rounded-lg bg-white" />
                      <p className="text-center text-[11px] leading-relaxed text-zinc-400">
                        Open the Steam app → <span className="text-zinc-200">Add a new device</span> → scan this code,
                        then approve on your phone. No codes to type — everything is filled in automatically and the live feed starts on its own.
                      </p>
                      <button
                        type="button"
                        onClick={() => startQr(false)}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition hover:border-white/25 hover:text-white"
                      >
                        Get a fresh QR code
                      </button>
                    </div>
                  ) : qrLoading ? (
                    <div className="flex flex-col items-center gap-2.5 py-2">
                      <span className="flex h-16 w-16 animate-spin items-center justify-center">
                        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" className="text-electric-300">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </span>
                      <p className="text-[11px] text-zinc-400">Generating login code…</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2.5 py-1">
                      <button
                        type="button"
                        onClick={() => startQr(false)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-electric-400/25 bg-electric-400/10 px-3 py-2.5 text-sm font-semibold text-electric-200 transition hover:border-electric-400/50"
                      >
                        Show QR code
                      </button>
                      <p className="text-center text-[11px] leading-relaxed text-zinc-400">
                        Scan it in the Steam app to link this account — no codes to type.
                      </p>
                    </div>
                  )}
                  {qrMsg && <p className="mt-2 rounded-lg bg-red-400/10 px-3 py-1.5 text-[11px] text-red-300">{qrMsg}</p>}
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-white/5 px-5 py-3.5">
          <p className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" aria-live="polite">
            {savedNote ?? (recording ? "Recording hotkey…" : "")}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-white/10 px-4 py-2 text-xs font-medium text-zinc-300 transition hover:border-white/25 hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || recording}
              className="shimmer-btn rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </motion.div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">{children}</p>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition focus:border-electric-400/60"
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition hover:border-white/20"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-100">{label}</span>
        <span className="mt-0.5 block text-[11px] text-zinc-600">{hint}</span>
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-electric-400/80" : "bg-white/10"}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}