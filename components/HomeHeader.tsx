"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

type LoginState = "idle" | "loading" | "ok" | "guard" | "empty" | "error";

interface MeData {
  ok: boolean;
  steam64?: string;
  accountName?: string | null;
  error?: string;
  profile?: {
    username: string | null;
    avatarUrl: string | null;
    level: number | null;
    cs2Hours: number | null;
    cs2Hours2Weeks: number | null;
    country: string | null;
  } | null;
  record?: { wins: number; losses: number; ties: number };
  premierRating?: number | null;
  trust?: { value: number | null; level: string | null } | null;
  bans?: { vac: number; game: number; community: boolean } | null;
  recent?: {
    outcome: "WIN" | "LOSS" | "TIE";
    scoreCT: number;
    scoreT: number;
    mapName: string | null;
    matchDate: string | null;
    matchId: string | null;
    kills: number | null;
    deaths: number | null;
    kdRatio: number | null;
  }[];
}

const STEAM64_KEY = "clutchly.me.steam64";

function mapName(m: string | null): string {
  return m ? m.replace(/^de_/, "").toUpperCase() : "?";
}

function cleanUsername(v: string | null | undefined): string {
  const s = (v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u007f\u200b-\u200f\u2060-\u2064\ufeff\ue0000-\ue007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || "Steam player";
}

const OutcomePill: Record<"WIN" | "LOSS" | "TIE", string> = {
  WIN: "bg-emerald-400/15 text-emerald-300 border-emerald-400/25",
  LOSS: "bg-rose-400/15 text-rose-300 border-rose-400/25",
  TIE: "bg-zinc-400/10 text-zinc-300 border-zinc-400/20",
};

export default function HomeHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [signedIn, setSignedIn] = useState<string | null>(null); // steam64
  const [me, setMe] = useState<MeData | null>(null);
  const [meLoading, setMeLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadMe = useCallback((steam64: string) => {
    setMeLoading(true);
    fetch(`/api/overlay/me?steam64=${encodeURIComponent(steam64)}`)
      .then((r) => r.json())
      .then((d: MeData) => setMe(d))
      .catch(() => setMe({ ok: false, error: "Could not load your stats." }))
      .finally(() => setMeLoading(false));
  }, []);

  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, []);

  // Each app restart uses the refresh token, so "me" is derivable from env too.
  const refreshFromEnv = useCallback(async () => {
    const d = (await fetch("/api/overlay/me").then((r) => r.json())) as MeData;
    if (d.ok && d.steam64) {
      setSignedIn(d.steam64);
      localStorage.setItem(STEAM64_KEY, d.steam64);
      setMe(d);
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(STEAM64_KEY);
    if (saved) {
      setSignedIn(saved);
      loadMe(saved);
    } else {
      // No local sign-in, but the overlay app may have linked a Steam account
      // (its QR login writes OVERLAY_TRACK_STEAM64 server-side) — mirror it here
      // so the website shows the same signed-in profile as the overlay.
      refreshFromEnv();
    }
  }, [loadMe, refreshFromEnv]);

  const allSteam64 = me?.steam64 ?? signedIn;

  // Render full-viewport overlays through a portal so backdrop-filter ancestors
  // (the header's backdrop-blur) can't trap their `fixed inset-0` box to the
  // header height — keeps them perfectly centered on the actual viewport.
  const overlay = (
    <>
      {loginOpen && (
        <SteamLoginModal
          onClose={() => setLoginOpen(false)}
          onSignedIn={(steam64) => {
            setSignedIn(steam64);
            localStorage.setItem(STEAM64_KEY, steam64);
            loadMe(steam64);
            setStatsOpen(true); // pop your stats open right after a fresh login
            setLoginOpen(false);
          }}
        />
      )}
      {allSteam64 && !loginOpen && statsOpen && (
        <StatsPanel
          me={me}
          loading={meLoading}
          steam64={allSteam64}
          onClose={() => setStatsOpen(false)}
        />
      )}
    </>
  );

  return (
    <>
    <div className="flex items-center gap-2.5">
      {/* Overlay dropdown */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-electric-400/40 hover:text-white"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          Overlay
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" className="text-zinc-500">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.14 }}
              role="menu"
              className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-void-950/95 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl"
            >
              <a
                href="/api/overlay/download"
                role="menuitem"
                className="flex items-center gap-2.5 px-3.5 py-3 text-sm text-zinc-200 transition hover:bg-white/5 hover:text-white"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" className="text-electric-300">
                  <path
                    d="M12 3v10m0 0l-4-4m4 4l4-4M5 19h14"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="flex flex-col">
                  <span className="text-xs font-semibold">Download overlay</span>
                  <span className="text-[10px] text-zinc-500">Windows setup (.exe)</span>
                </span>
              </a>
              <div className="h-px bg-white/5" />
              <Link
                href="/overlay"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="flex items-center gap-2.5 px-3.5 py-3 text-sm text-zinc-200 transition hover:bg-white/5 hover:text-white"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" className="text-electric-300">
                  <rect x="3.5" y="4.5" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M10 20h4M8 16.5V20m8-3.5V20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span className="flex flex-col">
                  <span className="text-xs font-semibold">Open live preview</span>
                  <span className="text-[10px] text-zinc-500">See the overlay in the browser</span>
                </span>
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Steam sign-in / signed-in chip */}
      {allSteam64 ? (
        <button
          onClick={() => setStatsOpen((v) => !v)}
          title="Your Clutchly stats"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 py-1 pl-1 pr-3 transition hover:border-electric-400/40"
        >
          <span className="flex h-6 w-6 overflow-hidden rounded-md">
            {me?.profile?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={me.profile.avatarUrl} alt="" className="h-6 w-6 object-cover" />
            ) : (
              <span className="flex h-6 w-6 items-center justify-center bg-gradient-to-br from-white/15 to-white/5 text-[10px] font-semibold text-white">
                {cleanUsername(me?.profile?.username).charAt(0).toUpperCase()}
              </span>
            )}
          </span>
          <span className="max-w-[120px] truncate text-xs font-medium text-zinc-100">
            {cleanUsername(me?.profile?.username)}
          </span>
        </button>
      ) : (
        <button
          onClick={() => setLoginOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-electric-400/40 hover:text-white"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="https://cdn.reicon.dev/logos/steam/original.svg" alt="Steam" width={16} height={16} />
          Sign in with Steam
        </button>
      )}

    </div>
    {typeof document !== "undefined" ? createPortal(overlay, document.body) : null}
  </>);
}

function StatsPanel({
  me,
  loading,
  steam64,
  onClose,
}: {
  me: MeData | null;
  loading: boolean;
  steam64: string;
  onClose: () => void;
}) {
  if (loading && !me) {
    return (
      <div className="pointer-events-none fixed inset-0 z-40 flex p-4">
        <div className="m-auto flex items-center gap-2 rounded-lg border border-white/10 bg-void-950/80 px-4 py-3 text-xs text-zinc-400 backdrop-blur">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-electric-300" />
          Loading your match history…
        </div>
      </div>
    );
  }
  if (!me || !me.ok) {
    return (
      <div className="pointer-events-none fixed inset-0 z-40 flex p-4">
        <div className="m-auto rounded-lg border border-red-400/20 bg-void-950/80 px-4 py-3 text-xs text-red-300 backdrop-blur">
          {me?.error || "Could not load your stats."}
        </div>
      </div>
    );
  }

  const record = me.record ?? { wins: 0, losses: 0, ties: 0 };
  const r = me.recent ?? [];
  const hasBans = me.bans && (me.bans.vac > 0 || me.bans.game > 0 || me.bans.community);

  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex overflow-y-auto p-4">
      {/* Dismiss when clicking outside the sheet */}
      <div className="pointer-events-auto fixed inset-0" onClick={onClose} />
      <div className="pointer-events-auto m-auto w-full max-w-md">
        <div className="shimmer-card">
          <div className="shimmer-card__inner space-y-4 p-0">
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-white/5 px-4 py-4">
              <span className="relative flex h-12 w-12 shrink-0 overflow-hidden rounded-xl ring-2 ring-white/10">
                {me.profile?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={me.profile.avatarUrl} alt="" className="h-12 w-12 object-cover" />
                ) : (
                  <span className="flex h-12 w-12 items-center justify-center bg-gradient-to-br from-white/20 to-white/5 text-lg font-semibold text-white">
                    {cleanUsername(me.profile?.username || me.accountName || "").charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="https://cdn.reicon.dev/logos/steam/original.svg" alt="Steam" width={16} height={16} />
                  <h3 className="truncate text-sm font-semibold text-zinc-50">
                    {me.profile?.username ? cleanUsername(me.profile.username) : me.accountName || "Steam player"}
                  </h3>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {me.profile?.level != null && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-px text-[10px] font-medium text-zinc-400">
                      Lv {me.profile.level}
                    </span>
                  )}
                  {me.premierRating != null && (
                    <span className="rounded-full border border-electric-400/25 bg-electric-400/10 px-2 py-px text-[10px] font-medium text-electric-300">
                      Premier {me.premierRating}
                    </span>
                  )}
                  {me.trust?.value != null && (
                    <span
                      className={`rounded-full border px-2 py-px text-[10px] font-medium ${
                        me.trust.value >= 90
                          ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                          : me.trust.value >= 80
                            ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
                            : "border-rose-400/25 bg-rose-400/10 text-rose-300"
                      }`}
                    >
                      Trust {me.trust.value}%
                    </span>
                  )}
                  {me.bans && (
                    <span
                      className={`rounded-full border px-2 py-px text-[10px] font-medium ${
                        hasBans
                          ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
                          : "border-emerald-400/15 bg-emerald-400/5 text-emerald-400/80"
                      }`}
                    >
                      {hasBans
                        ? [
                            me.bans!.vac > 0 && `VAC×${me.bans!.vac}`,
                            me.bans!.game > 0 && `GAME×${me.bans!.game}`,
                            me.bans!.community && "COMM",
                          ]
                            .filter(Boolean)
                            .join(" ")
                        : "Clean"}
                    </span>
                  )}
                </div>
              </div>
              <Link
                href={`/player/${steam64}`}
                className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-zinc-200 transition hover:border-electric-400/40 hover:text-white"
              >
                Profile ↗
              </Link>
            </div>

            {/* Record */}
            <div className="flex items-center justify-center gap-6 px-4">
              <div className="text-center">
                <div className="font-mono text-2xl font-semibold tabular-nums text-emerald-300">{record.wins}</div>
                <div className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Wins</div>
              </div>
              <div className="text-center">
                <div className="font-mono text-2xl font-semibold tabular-nums text-rose-300">{record.losses}</div>
                <div className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Losses</div>
              </div>
              <div className="text-center">
                <div className="font-mono text-2xl font-semibold tabular-nums text-zinc-300">{record.ties}</div>
                <div className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Ties</div>
              </div>
              <div className="h-9 w-px bg-white/8" />
              <div className="text-center">
                <div className="font-mono text-2xl font-semibold tabular-nums text-zinc-100">
                  {record.wins + record.losses + record.ties}
                </div>
                <div className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Total</div>
              </div>
            </div>

            {/* Recent matches */}
            {r.length > 0 && (
              <div className="border-t border-white/5 px-4 py-3">
                <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  Recent matches
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {r.map((m, i) => (
                    <Link
                      key={i}
                      href={m.matchId ? `/matches/${m.matchId}?from=${steam64}` : `/player/${steam64}`}
                      className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-2 transition hover:border-white/20 hover:bg-white/[0.06]"
                    >
                      <span
                        className={`rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${OutcomePill[m.outcome]}`}
                      >
                        {m.outcome}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-zinc-100">{mapName(m.mapName)}</span>
                        <span className="block text-[10px] tabular-nums text-zinc-500">
                          {m.scoreCT} : {m.scoreT}
                        </span>
                      </span>
                      {m.kills != null && (
                        <span className="text-right">
                          <span className="block text-xs font-semibold tabular-nums text-zinc-100">{m.kills}</span>
                          <span className="block text-[9px] uppercase text-zinc-500">kills</span>
                        </span>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-white/5 px-4 py-3">
              <span className="text-[11px] text-zinc-500">
                {r.length} recent · {record.wins}-{record.losses}-{record.ties}
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={onClose}
                  className="text-[11px] font-medium text-zinc-400 transition hover:text-white"
                >
                  Close
                </button>
                <button
                  onClick={() => {
                    localStorage.removeItem(STEAM64_KEY);
                    window.location.reload();
                  }}
                  className="text-[11px] font-medium text-zinc-400 transition hover:text-white"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SteamLoginModal({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn: (steam64: string) => void;
}) {
  const [qrId, setQrId] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrMsg, setQrMsg] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-generate the QR the moment the modal opens — no button to click.
  const autoStartedRef = useRef(false);
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

  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    startQr();
  }, [startQr]);

  // Poll the QR login. On expire/error, auto-rotate to a fresh code so a long
  // phone pause never meets a dead QR — it cycles on its own.
  useEffect(() => {
    if (!qrId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/overlay/login-qr/status?id=${encodeURIComponent(qrId)}`);
        const data = await res.json();
        if (data.status === "authenticated") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setQrId(null);
          qrIdRef.current = null;
          onSignedIn(data.steamId);
        } else if (data.status === "expired") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
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
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [qrId, onSignedIn, startQr]);

  // Cancel the active backend session if the user closes the modal.
  useEffect(() => {
    return () => {
      const id = qrIdRef.current;
      if (id) {
        fetch(`/api/overlay/login-qr/status?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
      }
    };
  }, []);

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex overflow-y-auto p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="relative m-auto w-full max-w-md rounded-lg border border-white/10 bg-void-950/95 shadow-2xl ring-1 ring-white/5"
      >
        <header className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="https://cdn.reicon.dev/logos/steam/original.svg" alt="Steam" width={20} height={20} />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300/90">
              // sign in with steam
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:border-white/25 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          {/* QR login — scan with the Steam app, no codes to type */}
          <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] p-3">
            {qrDataUrl ? (
              <div className="flex flex-col items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrDataUrl}
                  alt="Steam login QR code"
                  className="h-40 w-40 rounded-lg bg-white"
                />
                <p className="text-center text-[11px] leading-relaxed text-zinc-400">
                  Open the Steam app → <span className="text-zinc-200">Add a new device</span> → scan this code,
                  then approve on your phone. No codes to type.
                </p>
                {qrMsg && <p className="rounded-lg bg-amber-400/10 px-3 py-1.5 text-[11px] text-amber-200">{qrMsg}</p>}
                <button
                  type="button"
                  onClick={() => startQr(false)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition hover:border-white/25 hover:text-white"
                >
                  Get a fresh QR code
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2.5 py-1">
                {qrLoading ? (
                  <div className="flex flex-col items-center gap-2.5 py-2">
                    <div className="h-16 w-16 animate-pulse rounded-lg border border-white/10 bg-black/40">
                      <span className="flex h-full w-full items-center justify-center animate-spin">
                        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" className="text-electric-300">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400">Generating login code…</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2.5 py-1">
                    <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-white/10 bg-black/40">
                      {/* QR glyph */}
                      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" className="text-electric-300">
                        <path
                          d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM10 17v1M17 10h1"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <button
                      type="button"
                      onClick={() => startQr(false)}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-electric-400/25 bg-electric-400/10 px-3 py-2.5 text-sm font-semibold text-electric-200 transition hover:border-electric-400/50"
                    >
                      Show QR code
                    </button>
                  </div>
                )}
                {qrMsg && <p className="rounded-lg bg-red-400/10 px-3 py-1.5 text-[11px] text-red-300">{qrMsg}</p>}
              </div>
            )}
          </div>


        </div>
      </motion.div>
    </div>
  );
}