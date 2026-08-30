import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  mapIconPath,
  prettyMapName,
  weaponIconPath,
  prettyWeaponName,
  WEAPON_GROUPS,
} from "@/lib/cs-assets";
import { CST_CAREER_PREFIX } from "@/lib/stats/persistCstracker";
import { getPlayerHeaderData } from "@/lib/player-header";

export const dynamic = "force-dynamic";

const STEAM64_RE = /^\d{17}$/;

const fmt = (n: number, digits = 0) =>
  n.toLocaleString(undefined, { maximumFractionDigits: digits });

const fmtRating = (n: number) => n.toFixed(2);

/** cstracker.gg static map screenshot base (hotlinked, same as the Matches table). */
function mapScreenshotUrl(map: string | null): string | null {
  if (!map) return null;
  return `https://cstracker.gg/static/map_icons/screenshots/360p/${map.replace(/\./g, "")}_png.webp`;
}

type MapRow = {
  map: string;
  matches: number;
  wins: number;
  losses: number;
  ties: number;
  kills: number;
  deaths: number;
  kdSum: number;
  ratingSum: number;
  ratingN: number;
};

export default async function PlayerOverviewPage({
  params,
}: {
  params: { steamId: string };
}) {
  const steam64 = params.steamId;
  if (!STEAM64_RE.test(steam64)) notFound();

  // Career aggregates
  const stats = await prisma.playerMatchStat
    .aggregate({
      where: { userSteam64: steam64 },
      _count: { _all: true },
      _sum: { kills: true, deaths: true, assists: true, headshots: true },
      _avg: { kdRatio: true, hltvRating: true, adr: true, kast: true, hsPercent: true },
    })
    .catch(() => null);

  // W/L/T record + per-map breakdown
  const matchesForPlayer = await prisma.match
    .findMany({
      where: {
        playerStats: { some: { userSteam64: steam64 } },
        // Skip the synthetic cstracker career-summary match (weapons/totals).
        NOT: { shareCode: { startsWith: CST_CAREER_PREFIX } },
      },
      select: {
        mapName: true,
        winningTeam: true,
        matchOutcome: true,
        playerStats: {
          where: { userSteam64: steam64 },
          select: { team: true, kills: true, deaths: true, kdRatio: true, hltvRating: true },
        },
      },
    })
    .catch(() => []);

  const recordTotals = { wins: 0, losses: 0, ties: 0 };
  const byMap = new Map<string, MapRow>();
  for (const m of matchesForPlayer) {
    const self = m.playerStats[0];
    if (!self) continue;
    // cstracker imports carry a player-relative matchOutcome; parsed demos
    // derive W/L from winningTeam vs the player's team.
    const oc = m.matchOutcome;
    if (oc === "WIN") recordTotals.wins += 1;
    else if (oc === "LOSS") recordTotals.losses += 1;
    else if (oc === "TIE") recordTotals.ties += 1;
    else if (m.winningTeam == null) recordTotals.ties += 1;
    else if (m.winningTeam === self.team) recordTotals.wins += 1;
    else recordTotals.losses += 1;

    const row = byMap.get(m.mapName) ?? {
      map: m.mapName,
      matches: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      kills: 0,
      deaths: 0,
      kdSum: 0,
      ratingSum: 0,
      ratingN: 0,
    };
    row.matches += 1;
    if (oc === "WIN") row.wins += 1;
    else if (oc === "LOSS") row.losses += 1;
    else if (oc === "TIE") row.ties += 1;
    else if (m.winningTeam == null) row.ties += 1;
    else if (m.winningTeam === self.team) row.wins += 1;
    else row.losses += 1;
    row.kills += self.kills;
    row.deaths += self.deaths;
    row.kdSum += self.kdRatio;
    row.ratingSum += self.hltvRating;
    row.ratingN += 1;
    byMap.set(m.mapName, row);
  }
  const mapRows = [...byMap.values()].sort((a, b) => b.matches - a.matches);

  const recent = await prisma.match
    .findMany({
      where: {
        playerStats: { some: { userSteam64: steam64 } },
        NOT: { shareCode: { startsWith: CST_CAREER_PREFIX } },
      },
      orderBy: { matchDate: "desc" },
      take: 8,
      include: {
        playerStats: { where: { userSteam64: steam64 } },
        server: true,
      },
    })
    .catch(() => []);

  // Real match count = W+L+T over non-synthetic matches (the career row only
  // carries aggregate totals, so it is excluded from the lists above).
  const matchesCount = recordTotals.wins + recordTotals.losses + recordTotals.ties;
  const kd = stats?._avg.kdRatio ?? 0;
  const hsPercent = stats?._sum.kills
    ? ((stats._sum.headshots ?? 0) / stats._sum.kills) * 100
    : stats?._avg.hsPercent ?? 0;

  const statCards = [
    { label: "Matches", value: fmt(matchesCount), sub: `${recordTotals.wins}W · ${recordTotals.losses}L · ${recordTotals.ties}T` },
    { label: "Kills", value: fmt(stats?._sum.kills ?? 0), sub: `${fmt(stats?._sum.headshots ?? 0)} headshots` },
    { label: "Deaths", value: fmt(stats?._sum.deaths ?? 0), sub: `${fmt(stats?._sum.assists ?? 0)} assists` },
    { label: "K/D", value: fmtRating(kd), sub: "per match" },
    { label: "HLTV Rating", value: fmtRating(stats?._avg.hltvRating ?? 0), sub: "2.0" },
    { label: "ADR", value: fmt(stats?._avg.adr ?? 0, 1), sub: "damage / round" },
    { label: "KAST", value: `${fmt(stats?._avg.kast ?? 0, 1)}%`, sub: "rounds contributed" },
    { label: "Headshot %", value: `${fmt(hsPercent, 1)}%`, sub: "of kills" },
  ];

  // Per-weapon kills across all tracked matches
  const weaponAgg = await prisma.weaponMatchStat
    .groupBy({
      by: ["weapon"],
      where: { userSteam64: steam64 },
      _sum: { kills: true },
    })
    .catch(() => []);
  const weaponKills = new Map(weaponAgg.map((w) => [w.weapon, w._sum.kills ?? 0]));
  const maxWeaponKills = Math.max(1, ...[...weaponKills.values()]);

  const mapsEmpty = mapRows.length === 0;
  const headerData = await getPlayerHeaderData(steam64).catch(() => null);

  return (
    <div className="animate-fade-up space-y-10 pt-8">
      {/* Career summary */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Career summary
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          {/* Trust Factor — full-height left card (green/yellow/red like cstracker) */}
          <TrustCard trust={headerData?.trust ?? null} />
          {statCards.map((s) => (
            <div key={s.label} className="border-card p-4">
              <p className="text-2xl font-semibold tracking-tight text-zinc-50 tabular-nums">
                {s.value}
              </p>
              <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                {s.label}
              </p>
              <p className="mt-1 text-[11px] text-zinc-600">{s.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Map performance */}
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Maps
        </h2>
        <p className="mb-3 text-xs text-zinc-600">
          Per-map win rate and rating across tracked matches.
        </p>

        {mapsEmpty ? (
          <div className="shimmer-card">
            <div className="shimmer-card__inner py-12 text-center">
              <p className="text-sm font-medium text-zinc-300">No map data yet</p>
              <p className="mt-1 text-xs text-zinc-500">
                Parsed .dem files will populate per-map performance here.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mapRows.map((row) => (
              <MapStatCard key={row.map} row={row} />
            ))}
          </div>
        )}
      </section>

      {/* Recent matches */}
      <section>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Recent matches
          </h2>
          <span className="text-xs text-zinc-600">Last {recent.length}</span>
        </div>

        {recent.length === 0 ? (
          <div className="shimmer-card">
            <div className="shimmer-card__inner py-12 text-center">
              <p className="text-sm font-medium text-zinc-300">No matches parsed yet</p>
              <p className="mt-1 text-xs text-zinc-500">
                Once .dem files are downloaded and parsed, matches will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {recent.map((m) => {
              const self = m.playerStats[0];
              const outcome =
                m.matchOutcome === "WIN"
                  ? "win"
                  : m.matchOutcome === "LOSS"
                    ? "loss"
                    : m.matchOutcome === "TIE"
                      ? "tie"
                      : m.winningTeam == null
                        ? "tie"
                        : m.winningTeam === self.team
                          ? "win"
                          : "loss";
              const outcomeStyle =
                outcome === "win"
                  ? "bg-emerald-400/15 text-emerald-300"
                  : outcome === "loss"
                    ? "bg-red-400/15 text-red-300"
                    : "bg-zinc-500/15 text-zinc-400";
              const scoreColor =
                outcome === "win" ? "text-emerald-400" : outcome === "loss" ? "text-rose-400" : "text-zinc-300";
              // cstracker imports (CST-<matchId>) open the match report.
              const cstId = m.shareCode.startsWith("CST-") && /^\d+$/.test(m.shareCode.slice(4))
                ? m.shareCode.slice(4)
                : null;
              const bg = mapScreenshotUrl(m.mapName);

              return (
                <Link
                  key={m.id}
                  href={cstId ? `/matches/${cstId}?from=${steam64}` : `/matches/${m.id}?from=${steam64}`}
                  className="group relative isolate flex min-h-[76px] items-center gap-5 overflow-hidden rounded-xl border border-white/[0.07] bg-ink-2 px-5 py-4 transition hover:brightness-125 hover:border-amber-400/20"
                >
                  {/* map screenshot backdrop + dark gradient */}
                  {bg && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 -z-10"
                      style={{
                        backgroundImage: `url('${bg}')`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }}
                    />
                  )}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 -z-10"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(10,11,16,0.72) 0%, rgba(10,11,16,0.94) 45%, rgba(10,11,16,0.96) 100%)",
                    }}
                  />

                  <MapIcon map={m.mapName} className="h-10 w-10 shrink-0 rounded-lg border border-white/10" />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span
                        className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${outcomeStyle}`}
                      >
                        {outcome.toUpperCase()}
                      </span>
                      <span className="truncate font-medium text-white transition group-hover:text-amber-100">
                        {prettyMapName(m.mapName)}
                      </span>
                      <span className={`font-semibold tabular-nums ${scoreColor}`}>
                        {m.scoreCT} : {m.scoreT}
                      </span>
                    </div>
                    {self && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] tabular-nums text-zinc-400">
                        <span className="text-zinc-500">
                          K/D <span className="text-zinc-100">{fmtRating(self.kdRatio)}</span>
                        </span>
                        <span className="text-zinc-500">
                          Rating <span className="text-zinc-100">{fmtRating(self.hltvRating)}</span>
                        </span>
                        <span className="text-zinc-500">
                          <span className="text-zinc-100">{fmt(self.adr, 1)}</span> ADR
                        </span>
                        <span className="text-zinc-500">
                          <span className="text-zinc-100">{fmt(self.mvp)}</span> MVP
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2 border-l border-white/5 pl-5 text-right text-xs text-zinc-500">
                    {m.server?.country && <span>{m.server.country}</span>}
                    <span className="whitespace-nowrap">{new Date(m.matchDate).toLocaleDateString()}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Weapon usage */}
      <section>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Weapons
          </h2>
          {weaponKills.size > 0 && (
            <span className="text-xs text-zinc-600">{fmt([...weaponKills.values()].reduce((a, b) => a + b, 0))} total kills</span>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {WEAPON_GROUPS.map((group) => (
            <div key={group.label} className="border-card p-4">
              <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                {group.label}
                <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
              </p>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                {group.weapons.map((w) => (
                  <WeaponTile
                    key={w}
                    weapon={w}
                    kills={weaponKills.get(w) ?? 0}
                    maxKills={maxWeaponKills}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TrustCard({
  trust,
}: {
  trust: { value: number | null; level: "good" | "suspicious" | "bad" | null; updated: string | null } | null;
}) {
  const level: "good" | "suspicious" | "bad" = trust?.level ?? (trust?.value == null ? "good" : trust.value >= 90 ? "good" : trust.value >= 80 ? "suspicious" : "bad");
  const palette =
    level === "good"
      ? {
          border: "border-emerald-400/40",
          text: "text-emerald-300",
          glow: "bg-emerald-400/15",
          chip: "bg-emerald-400/10 text-emerald-300",
          ring: "from-emerald-400 to-teal-300",
          label: "Clean",
        }
      : level === "suspicious"
        ? {
            border: "border-amber-400/40",
            text: "text-amber-300",
            glow: "bg-amber-400/15",
            chip: "bg-amber-400/10 text-amber-300",
            ring: "from-amber-400 to-yellow-300",
            label: "Suspicious",
          }
        : {
            border: "border-red-400/40",
            text: "text-red-300",
            glow: "bg-red-400/15",
            chip: "bg-red-400/10 text-red-300",
            ring: "from-red-400 to-rose-300",
            label: "Poor",
          };

  const value = trust?.value ?? null;
  const pct = value == null ? 0 : Math.max(2, Math.min(100, value));

  return (
    <div
      className={`relative col-span-2 overflow-hidden rounded-lg border p-5 sm:col-span-4 lg:col-span-1 lg:row-span-2 ${palette.border} bg-white/[0.02]`}
      title="Teammate-adjusted trust score from cstracker.gg"
    >
      <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-3xl ${palette.glow}`} />
      <div className="relative flex h-full min-h-44 flex-col">
        <p className="text-center font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          // trust factor
        </p>
        <div className="mt-5 flex items-end justify-center gap-1.5">
          <span className={`font-mono text-5xl font-semibold leading-none tabular-nums ${value == null ? "text-zinc-600" : palette.text}`}>
            {value == null ? "—" : fmt(value, 1)}
          </span>
          <span className="pb-1 font-mono text-sm font-semibold text-zinc-500">%</span>
        </div>
        <div className="mt-3 flex min-h-5 items-center justify-center gap-2">
          {value == null ? (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-600">
              not synced
            </span>
          ) : (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${palette.chip}`}>
              {palette.label}
            </span>
          )}
        </div>
        <div className={`mt-auto h-1 w-full overflow-hidden rounded-full bg-white/5 ${value == null ? "" : ""}`}>
          <div
            className={`h-full rounded-full bg-gradient-to-r ${value == null ? "from-zinc-700 to-zinc-600" : palette.ring}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-center text-[10px] text-zinc-600">
          {trust?.updated ? `updated ${trust.updated}` : "from cstracker.gg"}
        </p>
      </div>
    </div>
  );
}

function MapIcon({ map, className }: { map: string; className?: string }) {
  const path = mapIconPath(map);
  if (!path) {
    return (
      <div
        className={`flex items-center justify-center rounded-md border border-white/10 bg-white/5 font-mono text-[10px] text-zinc-500 ${className ?? "h-8 w-8"}`}
      >
        {prettyMapName(map)[0] ?? "?"}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={path} alt={prettyMapName(map)} className={className ?? "h-8 w-8"} loading="lazy" />;
}

function MapStatCard({ row }: { row: MapRow }) {
  const winPct = row.matches ? Math.round((row.wins / row.matches) * 100) : 0;
  // K/D is the average of stored per-match ratios (cstracker imports don't
  // carry per-match kills, and parsed demos do — both paths work).
  const kd = row.ratingN ? row.kdSum / row.ratingN : row.deaths ? row.kills / row.deaths : row.kills;
  const rating = row.ratingN ? row.ratingSum / row.ratingN : 0;

  return (
    <div className="border-card p-4">
      <div className="flex items-center gap-3">
        <MapIcon map={row.map} className="h-10 w-10 rounded-md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-100">
            {prettyMapName(row.map)}
          </p>
          <p className="text-[11px] text-zinc-500">
            {row.matches} matches · {row.wins}-{row.losses}
            {row.ties > 0 ? `-${row.ties}` : ""}
          </p>
        </div>
        <p className="font-mono text-sm font-semibold text-zinc-50 tabular-nums">{winPct}%</p>
      </div>

      {/* win-rate bar */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-electric-400 to-plasma-500"
          style={{ width: `${winPct}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Metric label="Win rate" value={`${winPct}%`} />
        <Metric label="K/D" value={fmtRating(kd)} />
        <Metric label="Rating" value={fmtRating(rating)} />
      </div>
    </div>
  );
}

function WeaponTile({
  weapon,
  kills,
  maxKills,
}: {
  weapon: string;
  kills: number;
  maxKills: number;
}) {
  const hasKills = kills > 0;
  const pct = hasKills ? Math.max(8, Math.round((kills / maxKills) * 100)) : 0;
  return (
    <div
      title={`${prettyWeaponName(weapon)} — ${kills} kill${kills === 1 ? "" : "s"}`}
      className="group relative flex flex-col items-center overflow-hidden rounded-lg border border-white/5 bg-white/[0.02] px-2 py-3 transition hover:border-white/15 hover:bg-white/[0.05]"
    >
      {/* subtle glow behind active gun */}
      {hasKills && (
        <div className="pointer-events-none absolute -top-6 left-1/2 h-14 w-20 -translate-x-1/2 rounded-full bg-electric-400/[0.07] blur-xl" />
      )}
      <div className="relative flex h-11 items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={weaponIconPath(weapon)}
          alt={prettyWeaponName(weapon)}
          className={`h-full w-auto object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)] transition ${
            hasKills ? "" : "opacity-35 grayscale"
          }`}
          loading="lazy"
        />
      </div>
      <span className="mt-2 w-full truncate text-center text-[10px] font-medium text-zinc-400">
        {prettyWeaponName(weapon)}
      </span>
      <span className={`mt-1 font-mono text-sm font-semibold tabular-nums ${hasKills ? "text-zinc-100" : "text-zinc-700"}`}>
        {kills.toLocaleString()}
      </span>
      <div className="mt-1.5 h-0.5 w-[70%] overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full transition-all ${
            hasKills ? "bg-gradient-to-r from-electric-400 to-plasma-500" : ""
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
      <p className="font-mono text-xs font-semibold text-zinc-100 tabular-nums">{value}</p>
      <p className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</p>
    </div>
  );
}