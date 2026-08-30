import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { mapIconPath, prettyMapName } from "@/lib/cs-assets";
import RatingBadge from "@/components/RatingBadge";
import { fetchMatchReport, fetchLocalMatchReport } from "@/lib/stats/matchReport";
import type { LocalMatchChatMessage, MatchReport, MatchReportPlayer } from "@/lib/stats/matchReport";
import { loadPlayerExtras, type PlayerExtras } from "@/lib/overlay";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ID_RE = /^\d{1,12}$/;
/** Locally parsed (.dem) matches use Prisma cuid ids (lowercase alphanumeric). */
const CUID_RE = /^[a-z0-9]{20,32}$/;

const fmt = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 1 });

const relTime = (ts: number | null): string => {
  if (!ts) return "—";
  const diff = Date.now() - ts * 1000;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
};

export default async function MatchReportPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string };
}) {
  const matchId = params.id;
  const from = searchParams.from && /^\d{17}$/.test(searchParams.from) ? searchParams.from : undefined;
  const isCstracker = ID_RE.test(matchId);
  const isLocal = CUID_RE.test(matchId);
  if (!isCstracker && !isLocal) notFound();

  interface ChatMsg extends LocalMatchChatMessage {}
  let report: MatchReport | null = null;
  let chat: ChatMsg[] = [];
  let trackedSet = new Set<string>();
  let backPlayer: string | undefined;

  if (isCstracker) {
    try {
      report = await fetchMatchReport(matchId);
    } catch (err) {
      report = null;
      console.error(`[match-report] ${matchId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (report) {
      // Which players do we already track in the DB? (For the highlight + profile chips.)
      const tracked = await prisma.playerMatchStat
        .findMany({
          where: { match: { shareCode: `CST-${matchId}` } },
          select: { steam64: true, username: true },
        })
        .catch(() => []);
      trackedSet = new Set(tracked.map((t) => t.steam64));
      backPlayer = tracked[0]?.steam64;
      // Chat messages for this match (we scraped them into ChatLog).
      chat = await prisma.chatLog
        .findMany({
          where: { match: { shareCode: `CST-${matchId}` } },
          orderBy: [{ round: "asc" }, { tick: "asc" }],
        })
        .catch(() => []);
    }
  } else {
    // Locally parsed (.dem) match — render straight from the DB.
    const local = await fetchLocalMatchReport(matchId);
    if (local) {
      report = local.report;
      chat = local.chat;
      trackedSet = new Set(
        local.report.teams.flatMap((t) => t.players.map((p) => p.steam64).filter((s): s is string => !!s)),
      );
      backPlayer = from ?? [...trackedSet][0];
    }
  }

  if (!report) {
    return (
      <Shell matchId={matchId} from={from}>
        <div className="shimmer-card">
          <div className="shimmer-card__inner py-16 text-center">
            <p className="text-sm font-medium text-zinc-300">Match report unavailable</p>
            <p className="mt-1 text-xs text-zinc-500">
              {isLocal
                ? "This local match couldn&apos;t be loaded from the database."
                : "cstracker.gg couldn&apos;t be reached right now — try again in a moment."}
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  // Trust + ban extras (same cached source as the overlay cards).
  const extras = await loadPlayerExtras(
    report.teams.flatMap((t) => t.players.map((p) => p.steam64)).filter((s): s is string => !!s),
  );

  // Speaker lookup for the chat: steam64 → name/avatar/side (from the report).
  const speakerBy64 = new Map<string, { name: string; avatarUrl: string | null; team: "CT" | "T" }>();
  for (const t of report.teams) {
    for (const p of t.players) {
      if (p.steam64) speakerBy64.set(p.steam64, { name: p.name ?? p.steam64, avatarUrl: p.avatarUrl, team: t.side });
    }
  }

  const map = report.map;
  const mapKey = map ? `de_${map.toLowerCase()}` : null;
  const mapIcon = mapKey ? mapIconPath(mapKey) : null;
  const mapShot = mapKey
    ? `https://cstracker.gg/static/map_icons/screenshots/360p/${mapKey.replace(/\./g, "")}_png.webp`
    : null;

  return (
    <Shell matchId={matchId} from={from} backPlayer={backPlayer}>
      {/* Report frame — amber corner brackets + tactical grid backdrop */}
      <section className="tactical-grid relative overflow-hidden rounded-lg border border-white/10 bg-ink-2">
        {/* amber corner brackets */}
        <span aria-hidden className="pointer-events-none absolute left-2 top-2 z-10 h-4 w-4 border-l-2 border-t-2 border-amber-400/80" />
        <span aria-hidden className="pointer-events-none absolute right-2 top-2 z-10 h-4 w-4 border-r-2 border-t-2 border-amber-400/80" />
        <span aria-hidden className="pointer-events-none absolute bottom-2 left-2 z-10 h-4 w-4 border-b-2 border-l-2 border-amber-400/80" />
        <span aria-hidden className="pointer-events-none absolute bottom-2 right-2 z-10 h-4 w-4 border-b-2 border-r-2 border-amber-400/80" />

        {/* header strip */}
        <div className="relative border-b border-white/5 bg-black/30 px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.2em]">
            <span className="inline-flex items-center gap-2 text-amber-300/90">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
              match report
            </span>
            <span className="text-zinc-700">//</span>
            <span className="text-zinc-400">
              match · <span className="text-amber-200">#{matchId}</span>
            </span>
            <span className="hidden text-zinc-700 sm:inline">//</span>
            <span className="hidden text-zinc-400 sm:inline">mode · premier</span>
            <span className="ml-auto hidden text-zinc-500 sm:inline">
              status · <span className="text-amber-300">processed</span>
            </span>
          </div>
        </div>

        {/* map backdrop (desaturated screenshot) */}
        {mapShot && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `url('${mapShot}')`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "saturate(0.55) brightness(0.42)",
            }}
          />
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "linear-gradient(180deg, rgba(10,11,16,0.45) 0%, rgba(10,11,16,0.55) 60%, rgba(10,11,16,0.82) 100%)" }}
        />

        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-5 px-5 py-6 sm:px-8 sm:py-9">
          {/* Map icon in an amber-bracketed frame */}
          <div className="relative flex h-16 w-16 shrink-0 items-center justify-center border border-amber-400/30 bg-black/50 p-2 shadow-[inset_0_0_18px_rgba(250,204,21,0.07)] sm:h-24 sm:w-24">
            <span className="absolute left-0 top-0 h-2.5 w-2.5 border-l-2 border-t-2 border-amber-400/80" />
            <span className="absolute right-0 top-0 h-2.5 w-2.5 border-r-2 border-t-2 border-amber-400/80" />
            <span className="absolute bottom-0 left-0 h-2.5 w-2.5 border-b-2 border-l-2 border-amber-400/80" />
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 border-b-2 border-r-2 border-amber-400/80" />
            {mapIcon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mapIcon} alt={prettyMapName(mapKey ?? "")} className="h-11 w-11 object-contain drop-shadow-[0_0_14px_rgba(250,204,21,0.2)] sm:h-16 sm:w-16" loading="lazy" />
            ) : (
              <span className="font-mono text-xl text-zinc-400">{prettyMapName(mapKey ?? "")[0]}</span>
            )}
          </div>

          {/* Map + meta */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.28em] text-amber-300/70">
              <span>// map · overview</span>
              <span className="h-px flex-1 bg-gradient-to-r from-amber-400/30 via-amber-400/10 to-transparent" />
            </div>
            <h1 className="mt-1 text-3xl font-semibold uppercase tracking-tight text-white sm:text-5xl">
              {prettyMapName(mapKey ?? "")}
            </h1>

            {/* tick-rule */}
            <div className="mt-2.5 flex h-4 items-end gap-[3px]">
              {[4, 9, 6, 12, 7, 15, 5, 10, 8, 13, 5, 9, 6, 12, 7, 14, 4, 9, 6, 11, 5, 8, 6, 10, 5, 9, 6, 12, 7, 13].map((h, i) => (
                <span
                  key={i}
                  className={`w-[3px] rounded-full ${i % 5 === 3 ? "bg-amber-400/80" : "bg-slate-500/70"}`}
                  style={{ height: `${h}px` }}
                />
              ))}
            </div>

            {/* meta row 1 */}
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]">
              <span>
                <span className="text-zinc-500">t+ </span>
                <span className="whitespace-nowrap text-zinc-200">{relTime(report.playedTs)}</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span>
                <span className="text-zinc-500">dur </span>
                <span className="text-zinc-200">{report.duration ?? "—"}</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span>
                <span className="text-zinc-500">server </span>
                <span className="cursor-help text-zinc-200 decoration-dotted underline underline-offset-4">
                  {report.server ?? "—"}
                </span>
              </span>
            </div>
            {/* meta row 2 — divider keeps the slanted badge clear of the label */}
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5 font-mono text-[11px]">
              <span className="text-zinc-500">avg·rank</span>
              <span aria-hidden className="h-3.5 w-px shrink-0 bg-white/10" />
              <RatingBadge rating={report.avgRank} compact />
            </div>
          </div>

          {/* Absolute score — CT (blue) : T (orange) */}
          <div className="flex shrink-0 items-stretch gap-0 border border-white/10 bg-black/45 px-1 py-1">
            <div className="flex flex-1 flex-col items-center justify-center px-3 py-1.5 sm:px-6 sm:py-3">
              <span className="rounded-full bg-sky-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-sky-300">ct</span>
              <span className="mt-1.5 text-2xl font-semibold tabular-nums text-sky-200 sm:text-5xl">
                {report.score.ct ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-center px-1 text-zinc-600 sm:px-2">
              <span className="font-mono text-sm">:</span>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center px-3 py-1.5 sm:px-6 sm:py-3">
              <span className="rounded-full bg-orange-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-orange-300">t</span>
              <span className="mt-1.5 text-2xl font-semibold tabular-nums text-orange-200 sm:text-5xl">
                {report.score.t ?? "—"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Scoreboards */}
      <div className="space-y-6">
        {report.teams.map((team) => (
          <section key={team.side} className="border-card overflow-hidden">
            {/* Team band — color-coded side pills (CT blue / T orange) */}
            <div
              className={`flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-4 py-3 sm:px-6 ${
                team.side === "CT" ? "bg-sky-400/[0.05]" : "bg-orange-400/[0.05]"
              }`}
            >
              <div className="flex items-center gap-3.5 pl-1">
                {/* side pill */}
                <span
                  className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-bold tracking-wide ${
                    team.side === "CT" ? "bg-sky-400/15 text-sky-300" : "bg-orange-400/15 text-orange-300"
                  }`}
                >
                  {team.side}
                </span>
                <div>
                  <span
                    className={`font-mono text-[9px] uppercase tracking-[0.25em] ${
                      team.side === "CT" ? "text-sky-300" : "text-orange-300"
                    }`}
                  >
                    // team·{team.side === "CT" ? "01" : "02"} — {team.side === "CT" ? "counter-terrorist" : "terrorist"}
                  </span>
                  <div className="mt-1 flex items-center gap-3">
                    <span className="text-xl font-semibold text-white">
                      {team.side === "CT" ? "Counter-Terrorist" : "Terrorist"}
                    </span>
                    <span
                      className={`rounded-full px-3 py-0.5 text-lg font-bold tabular-nums ${
                        team.side === "CT" ? "bg-sky-400/15 text-sky-200" : "bg-orange-400/15 text-orange-200"
                      }`}
                    >
                      {team.score ?? "—"}
                    </span>
                  </div>
                </div>
                {team.win != null && (
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest ${
                      team.win ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300"
                    }`}
                  >
                    {team.win ? "WIN" : "LOSS"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2.5 pr-1 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                <span>avg·elo</span>
                <span aria-hidden className="h-3.5 w-px shrink-0 bg-white/10" />
                <RatingBadge rating={team.avgElo} compact />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[64rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-[10px] uppercase tracking-widest text-zinc-500">
                    <th className="w-[15rem] min-w-[15rem] px-4 py-2.5 font-medium">Player</th>
                    <th className="w-12 px-2 py-2.5 font-medium">K</th>
                    <th className="w-12 px-2 py-2.5 font-medium">D</th>
                    <th className="w-12 px-2 py-2.5 font-medium">A</th>
                    <th className="w-12 px-2 py-2.5 text-right font-medium">+/-</th>
                    <th className="w-16 px-2 py-2.5 text-right font-medium">ADR</th>
                    <th className="w-16 px-2 py-2.5 text-right font-medium">HS%</th>
                    <th className="w-16 px-2 py-2.5 text-right font-medium">KAST</th>
                    <th className="w-16 px-2 py-2.5 text-right font-medium">HLTV</th>
                    <th className="w-16 px-2 py-2.5 text-right font-medium">Trust</th>
                    <th className="w-20 px-2 py-2.5 text-right font-medium">Bans</th>
                    <th className="w-12 px-2 py-2.5 text-right font-medium">FK</th>
                    <th className="w-14 px-2 py-2.5 text-right font-medium">Trade</th>
                    <th className="w-14 px-2 py-2.5 text-right font-medium">Bhop</th>
                    <th className="w-12 px-2 py-2.5 text-right font-medium">MVP</th>
                  </tr>
                </thead>
                <tbody>
                  {team.players.length === 0 ? (
                    <tr>
                      <td colSpan={15} className="px-4 py-8 text-center text-xs text-zinc-600">
                        No scoreboard rows available for this team.
                      </td>
                    </tr>
                  ) : (
                    team.players.map((p) => (
                      <ScoreboardRow
                        key={`${team.side}-${p.steam64 ?? p.name ?? "?"}`}
                        player={p}
                        extras={p.steam64 ? (extras.get(p.steam64) ?? null) : null}
                        isTracked={p.steam64 ? trackedSet.has(p.steam64) : false}
                        isViewer={from != null && p.steam64 === from}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      {/* Match chat — same clean design as the chat archive */}
      {chat.length > 0 && (
        <section>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Match chat</h2>
            <span className="text-xs text-zinc-600">{chat.length} messages</span>
          </div>
          <div className="border-card overflow-hidden">
            <div className="divide-y divide-white/[0.04]">
              {chat.map((m) => {
                const speaker = speakerBy64.get(m.userSteam64);
                const self = from != null && m.userSteam64 === from;
                const team = speaker?.team ?? null;
                const teamCls = self
                  ? "text-amber-200"
                  : team === "CT"
                    ? "text-sky-300"
                    : team === "T"
                      ? "text-orange-300"
                      : "text-zinc-300";
                const avCls = self
                  ? "from-amber-400/40 to-orange-500/40"
                  : team === "CT"
                    ? "from-sky-500/40 to-cyan-500/40"
                    : team === "T"
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
                            : team === "CT"
                              ? "bg-sky-400/30"
                              : "bg-orange-400/30"
                      }`}
                    />
                    {m.userSteam64 && (
                      <Link
                        href={`/player/${m.userSteam64}`}
                        className="mt-0.5 shrink-0"
                        title={m.username || m.userSteam64}
                      >
                        <ChatAvatar src={speaker?.avatarUrl ?? null} name={m.username || m.userSteam64} fallbackClass={avCls} />
                      </Link>
                    )}
                    <div className="min-w-0 flex-1">
                      {/* Header stays on one spaced line — same as the chat archive */}
                      <div className="flex items-center gap-x-2 whitespace-nowrap">
                        <Link
                          href={`/player/${m.userSteam64}`}
                          className={`flex min-w-0 items-center text-xs font-semibold transition hover:brightness-125 ${teamCls}`}
                        >
                          <span className="truncate">{m.username || m.userSteam64}</span>
                          {self && (
                            <span className="ml-1.5 rounded bg-amber-400/20 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-300">
                              you
                            </span>
                          )}
                          {!self && team && (
                            <span
                              className={`ml-1.5 inline-flex items-center gap-1 rounded px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${
                                team === "CT" ? "bg-sky-400/10 text-sky-300" : "bg-orange-400/10 text-orange-300"
                              }`}
                              title={`${team} side`}
                            >
                              <span
                                className={`h-1 w-1 rounded-full ${team === "CT" ? "bg-sky-400" : "bg-orange-400"}`}
                              />
                              {team}
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
                        <span className="text-[10px] text-zinc-600">
                          {new Date(m.sentAt).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-100">
                        {m.message}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </Shell>
  );
}

function ScoreboardRow({
  player,
  extras,
  isTracked,
  isViewer,
}: {
  player: MatchReportPlayer;
  extras: PlayerExtras | null;
  isTracked: boolean;
  isViewer: boolean;
}) {
  const hltvTone =
    player.hltv == null
      ? "text-zinc-400"
      : player.hltv >= 1.2
        ? "bg-emerald-950 text-emerald-300"
        : player.hltv >= 1
          ? "bg-emerald-950/60 text-emerald-200"
          : player.hltv >= 0.8
            ? "bg-amber-950/60 text-amber-200"
            : "bg-rose-950/60 text-rose-300";

  return (
    <tr className={`border-b border-white/5 transition last:border-b-0 hover:bg-white/[0.02] ${isViewer ? "bg-electric-400/[0.06]" : ""}`}>
      <td className="w-[15rem] min-w-[15rem] px-4 py-2.5">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={player.avatarUrl ?? "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg"}
            alt={player.name ?? ""}
            className="h-9 w-9 shrink-0 rounded-md border border-white/10 object-cover"
            loading="lazy"
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {player.steam64 ? (
                <Link
                  href={`/player/${player.steam64}`}
                  className="truncate font-medium text-white transition hover:text-electric-300"
                >
                  {player.name ?? player.steam64}
                </Link>
              ) : (
                <span className="truncate font-medium text-white">{player.name ?? "Unknown"}</span>
              )}
              {isViewer && (
                <span className="shrink-0 rounded bg-electric-400/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-electric-300">
                  You
                </span>
              )}
              {isTracked && (
                <span className="shrink-0 rounded bg-white/5 px-1 py-px text-[9px] uppercase tracking-wider text-zinc-500">
                  Tracked
                </span>
              )}
            </div>
            {(player.ratingBefore != null || player.ratingAfter != null) && (
              <div className="mt-1 flex items-center gap-1.5 text-xs">
                {player.ratingBefore != null && (
                  <RatingBadge rating={player.ratingBefore} compact />
                )}
                {player.ratingAfter != null && (
                  <>
                    <span className="text-zinc-600">⟶</span>
                    <RatingBadge rating={player.ratingAfter} compact />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="w-12 px-2 py-2.5 font-medium text-white tabular-nums">{player.kills ?? "—"}</td>
      <td className="w-12 px-2 py-2.5 text-zinc-400 tabular-nums">{player.deaths ?? "—"}</td>
      <td className="w-12 px-2 py-2.5 text-zinc-300 tabular-nums">
        {player.assists ?? "—"}
        {player.flashAssists ? (
          <span className="ml-1 text-[10px] text-zinc-500" title="Flash assists">
            +{player.flashAssists}
          </span>
        ) : null}
      </td>
      <td
        className={`w-12 px-2 py-2.5 text-right font-medium tabular-nums ${
          player.kdDiff == null
            ? "text-zinc-500"
            : player.kdDiff > 0
              ? "text-emerald-400"
              : player.kdDiff < 0
                ? "text-rose-400"
                : "text-zinc-400"
        }`}
      >
        {player.kdDiff == null ? "—" : player.kdDiff > 0 ? `+${player.kdDiff}` : String(player.kdDiff)}
      </td>
      <td className="w-16 px-2 py-2.5 text-right tabular-nums text-zinc-200">{fmt(player.adr)}</td>
      <td className="w-16 px-2 py-2.5 text-right tabular-nums text-zinc-300">
        {player.hsPercent != null ? `${Math.round(player.hsPercent)}%` : "—"}
      </td>
      <td className="w-16 px-2 py-2.5 text-right tabular-nums text-zinc-300">
        {player.kast != null ? `${Math.round(player.kast)}%` : "—"}
      </td>
      <td className="w-16 px-2 py-2.5 text-right">
        <span className={`inline-block rounded px-1.5 py-0.5 text-sm font-semibold ${hltvTone}`}>
          {player.hltv != null ? player.hltv.toFixed(2) : "—"}
        </span>
      </td>
      <td className="w-16 px-2 py-2.5 text-right">
        {player.trust != null ? (
          <span
            className={`font-semibold tabular-nums ${
              player.trust >= 90
                ? "text-emerald-300"
                : player.trust >= 80
                  ? "text-amber-200"
                  : "text-rose-300"
            }`}
          >
            {fmt(player.trust)}%
          </span>
        ) : extras?.trust?.value != null ? (
          <span
            className={`font-semibold tabular-nums ${
              extras.trust.value >= 90
                ? "text-emerald-300"
                : extras.trust.value >= 80
                  ? "text-amber-200"
                  : "text-rose-300"
            }`}
          >
            {fmt(extras.trust.value)}%
          </span>
        ) : (
          <span className="text-zinc-500">—</span>
        )}
      </td>
      <td className="w-20 px-2 py-2.5 text-right">
        <BansCell bans={extras?.bans ?? null} />
      </td>
      <td className="w-12 px-2 py-2.5 text-right text-zinc-300 tabular-nums">{player.fk ?? "—"}</td>
      <td className="w-14 px-2 py-2.5 text-right text-zinc-300 tabular-nums">{player.trade ?? "—"}</td>
      <td className="w-14 px-2 py-2.5 text-right text-zinc-300 tabular-nums">{player.bhopPct ?? "—"}</td>
      <td className="w-12 px-2 py-2.5 text-right font-medium text-zinc-300 tabular-nums">{player.mvp ?? "—"}</td>
    </tr>
  );
}

function ChatAvatar({
  src,
  name,
  fallbackClass,
}: {
  src: string | null;
  name: string;
  fallbackClass: string;
}) {
  return (
    <span
      className={`relative block h-8 w-8 shrink-0 overflow-hidden rounded-[8px] border border-white/10 bg-gradient-to-br ${fallbackClass}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-mono text-[9px] font-bold text-zinc-200">
          {(name.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </span>
  );
}

function BansCell({ bans }: { bans: PlayerExtras["bans"] }) {
  if (bans == null) {
    return <span className="text-zinc-500">—</span>;
  }
  const items: { label: string; title: string }[] = [];
  if (bans.vac > 0) items.push({ label: `VAC×${bans.vac}`, title: `${bans.vac} VAC ban${bans.vac === 1 ? "" : "s"}` });
  if (bans.game > 0) items.push({ label: `GAME×${bans.game}`, title: `${bans.game} game ban${bans.game === 1 ? "" : "s"}` });
  if (bans.community) items.push({ label: "COMM", title: "Community banned" });
  if (items.length === 0) {
    return (
      <span
        className="inline-block rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/80"
        title="No bans on record"
      >
        Clean
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {items.map((b) => (
        <span
          key={b.label}
          className="inline-block rounded bg-rose-400/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300"
          title={b.title}
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}

function Shell({
  matchId,
  from,
  backPlayer,
  children,
}: {
  matchId: string;
  from?: string;
  backPlayer?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-void-950 text-zinc-50">
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
          <div className="flex items-center gap-4 text-xs">
            {from && (
              <Link href={`/player/${from}`} className="text-zinc-400 transition hover:text-zinc-200">
                ← Back to profile
              </Link>
            )}
            <Link href="/" className="text-zinc-400 transition hover:text-zinc-200">
              ← Back to search
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <div className="animate-fade-up space-y-6 pt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Match report
            </h2>
            <span className="font-mono text-[11px] text-zinc-600">#{matchId}</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
