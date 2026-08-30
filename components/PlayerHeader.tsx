import { getPlayer } from "@/lib/profile";
import { getPlayerHeaderData } from "@/lib/player-header";
import RatingBadge from "@/components/RatingBadge";

function fmtRelative(date: Date | null | string): string {
  if (!date) return "—";
  const t = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - t.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

function MetaPill({
  children,
  tabular,
  muted,
  code,
}: {
  children: React.ReactNode;
  tabular?: boolean;
  muted?: boolean;
  code?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 font-medium transition ${
        code
          ? "border-white/5 bg-black/30 font-mono text-[10px] tracking-tight text-zinc-500"
          : muted
            ? "border-white/10 bg-white/[0.04] text-zinc-400"
            : "border-white/10 bg-white/[0.04] text-zinc-300"
      } ${tabular ? "tabular-nums" : ""}`}
    >
      {children}
    </span>
  );
}

function fmtHours(hours: number | null): string | null {
  if (hours == null) return null;
  return hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
}

export default async function PlayerHeader({ steam64 }: { steam64: string }) {
  const [player, header] = await Promise.all([
    getPlayer(steam64).catch(() => null),
    getPlayerHeaderData(steam64).catch(() => null),
  ]);

  const name = player?.username ?? steam64;
  const rating = header?.premierRating ?? null;
  const record = header?.record ?? { wins: 0, losses: 0, ties: 0 };
  const total = record.wins + record.losses + record.ties;
  const winRate = total > 0 ? Math.round((record.wins / total) * 100) : 0;
  const cs2Hours = fmtHours(player?.cs2Hours ?? null);
  const cs2Hours2w = fmtHours(player?.cs2Hours2Weeks ?? null);

  return (
    <section className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      {/* label strip */}
      <div className="flex items-center gap-3 border-b border-white/5 px-5 py-2.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300/90">
          // player · profile
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
      </div>

      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
        {/* Avatar with animated blue/white shimmer border */}
        <div className="shimmer-card shimmer-card--white h-20 w-20 shrink-0 rounded-xl sm:h-24 sm:w-24">
          <div className="shimmer-card__inner !p-[1px] h-full w-full">
            <div className="h-full w-full overflow-hidden rounded-[7px] bg-void-950">
              {player?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={player.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-zinc-500">
                  {(name[0] ?? "?").toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Identity */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
            {rating != null && <RatingBadge rating={rating} />}
            {header?.faceit?.iconSrc && (
              <span
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
                title={`FACEIT level ${header.faceit.level ?? "?"} · ${header.faceit.elo?.toLocaleString() ?? "?"} ELO`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="h-6 w-6 shrink-0"
                  src={`https://cstracker.gg${header.faceit.iconSrc}`}
                  alt={`FACEIT level ${header.faceit.level ?? ""}`}
                  loading="lazy"
                />
                <span className="font-mono text-xs font-medium text-slate-200">
                  {header.faceit.elo?.toLocaleString() ?? "—"}
                </span>
              </span>
            )}
            {player?.level != null && (
              <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-electric-300">
                Level {player.level}
              </span>
            )}
            {player?.isVACBanned && (
              <span className="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                {player.vacBans} VAC ban{player.vacBans === 1 ? "" : "s"}
              </span>
            )}
            {player?.communityBanned && (
              <span className="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                Community banned
              </span>
            )}
          </div>

          {/* Recent W/L strip — hover shows the match score */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-600">
              // recent
            </span>
            <div className="flex gap-1">
              {header && header.recent.length > 0 ? (
                header.recent.map((r, i) => {
                  const oc = r.outcome;
                  const badgeCls =
                    oc === "WIN"
                      ? "bg-emerald-400/15 text-emerald-300"
                      : oc === "LOSS"
                        ? "bg-red-400/15 text-red-300"
                        : "bg-zinc-500/15 text-zinc-400";
                  return (
                    <div key={i} className="group relative">
                      <span
                        className={`flex h-5 w-5 cursor-help items-center justify-center rounded-[4px] text-[10px] font-bold ${badgeCls}`}
                      >
                        {oc === "WIN" ? "W" : oc === "LOSS" ? "L" : "T"}
                      </span>
                      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/95 px-2 py-1 font-mono text-[11px] font-semibold tabular-nums text-zinc-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
                        {r.scoreCT}–{r.scoreT}
                      </span>
                    </div>
                  );
                })
              ) : (
                <span className="text-[11px] text-zinc-600">no matches yet</span>
              )}
            </div>
          </div>

          {/* Meta line — every stat as a clean pill */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            {player?.country && <MetaPill>{player.country}</MetaPill>}
            <MetaPill>Last seen {fmtRelative(player?.lastSeenAt ?? null)}</MetaPill>
            {cs2Hours && <MetaPill tabular>{cs2Hours} CS2</MetaPill>}
            {cs2Hours2w && <MetaPill tabular muted>{cs2Hours2w} / 2w</MetaPill>}
            {player && (
              <a
                href={player.profileUrl ?? `https://steamcommunity.com/profiles/${steam64}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-electric-400/25 bg-electric-400/10 px-2.5 py-1 font-semibold text-electric-300 transition hover:border-electric-300/50 hover:bg-electric-400/20"
              >
                Steam ↗
              </a>
            )}
          </div>

          <p className="mt-2">
            <MetaPill code>{steam64}</MetaPill>
          </p>
        </div>

        {/* Record — cstracker-style divided box: win/loss/tie · win rate · matches */}
        <div className="flex items-stretch divide-x divide-white/10 overflow-hidden rounded-lg border border-white/[0.08] bg-black/25">
          <div className="flex flex-col px-4 py-2.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
              win/loss/tie
            </p>
            <p className="mt-1 flex items-center justify-center gap-2 font-mono text-lg font-semibold tabular-nums">
              <span className="text-emerald-300 tabular-nums">{record.wins}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-rose-300 tabular-nums">{record.losses}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-amber-300 tabular-nums">{record.ties}</span>
            </p>
          </div>
          <div className="flex flex-col px-4 py-2.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
              win rate
            </p>
            <p
              className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
                winRate >= 50 ? "text-emerald-300" : "text-rose-300"
              }`}
            >
              {winRate}%
            </p>
          </div>
          <div className="flex flex-col px-4 py-2.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
              matches
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-white">
              {total}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
