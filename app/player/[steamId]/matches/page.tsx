import Link from "next/link";
import { notFound } from "next/navigation";
import { cstrackerProvider, invalidateCstrackerCache } from "@/lib/stats/cstracker";
import { persistCstracker } from "@/lib/stats/persistCstracker";
import { mapIconPath, prettyMapName } from "@/lib/cs-assets";
import RatingBadge from "@/components/RatingBadge";
import type { CstrackerHistoryRow, CstrackerMatchTelemetryItem } from "@/lib/stats/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STEAM64_RE = /^\d{17}$/;

/** cstracker.gg static map screenshot base (hotlinked, as shown on the site). */
function mapScreenshotUrl(map: string | null): string | null {
  if (!map) return null;
  const key = map.replace(/\./g, "");
  return `https://cstracker.gg/static/map_icons/screenshots/360p/${key}_png.webp`;
}

const fmt = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function relTime(ts: number | null | undefined): string {
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
}

const toneClass = (tone: "danger" | "warn" | null | undefined): string =>
  tone === "danger" ? "text-red-400" : tone === "warn" ? "text-amber-400" : "text-zinc-200";

export default async function PlayerMatchesPage({
  params,
}: {
  params: { steamId: string };
}) {
  const steam64 = params.steamId;
  if (!STEAM64_RE.test(steam64)) notFound();

  // Serve the cached cstracker extraction; on a cold profile, scrape once.
  let result = await cstrackerProvider(steam64);
  if (result.empty) {
    await invalidateCstrackerCache(steam64);
    result = await cstrackerProvider(steam64, { force: true });
    if (!result.empty && result.data.cstracker) {
      await persistCstracker(steam64, result.data.cstracker);
    }
  }
  const extras = result.data.cstracker;

  // Telemetry by match id (raw map name + ts + outcome) for screenshots/reltime.
  const byId = new Map<string, CstrackerMatchTelemetryItem>();
  for (const m of extras?.matchTelemetry ?? []) byId.set(String(m.id), m);

  const richRows: CstrackerHistoryRow[] = extras?.historyTable ?? [];
  const richIds = new Set(richRows.map((r) => r.matchId).filter(Boolean));
  const earlier = (extras?.matchTelemetry ?? []).filter((m) => !richIds.has(String(m.id)));

  return (
    <div className="animate-fade-up space-y-10 pt-8">
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Match history
            </h2>
          </div>
          {extras?.extractedAt && (
            <span className="text-[11px] text-zinc-600">
              last synced {relTime(Math.floor(new Date(extras.extractedAt).getTime() / 1000))}
            </span>
          )}
        </div>

        {richRows.length === 0 && earlier.length === 0 ? (
          <div className="shimmer-card">
            <div className="shimmer-card__inner py-12 text-center">
              <p className="text-sm font-medium text-zinc-300">No match history yet</p>
              <p className="mt-1 text-xs text-zinc-500">
                Once a profile is synced, its matches will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <div className="min-w-[880px] space-y-2.5">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              <span className="w-10 shrink-0" />
              <span className="flex-1">Match</span>
              <span className="hidden w-48 text-center sm:block">Rank</span>
              <span className="w-24 text-center">K / D / A</span>
              <span className="hidden w-14 text-center md:block">K/D</span>
              <span className="hidden w-16 text-center md:block">ADR</span>
              <span className="hidden w-14 text-center sm:block">Rating</span>
              <span className="hidden w-16 text-center lg:block">KAST</span>
              <span className="hidden w-14 text-center lg:block">ACC</span>
              <span className="hidden w-16 text-center sm:block">Preaim</span>
              <span className="hidden w-16 text-center sm:block">TTD</span>
              <span className="w-20 text-center">When</span>
            </div>

            {richRows.map((row) => {
              const tel = row.matchId ? byId.get(row.matchId) : null;
              const mapKey = tel?.map ?? `de_${(row.map ?? "").toLowerCase()}`;
              const bg = mapScreenshotUrl(mapKey);
              const oc = tel ? tel.outcome : parseScoreWin(row.score) ? "W" : "L";
              const scoreColor =
                oc === "W" ? "text-emerald-400" : oc === "L" ? "text-rose-400" : "text-zinc-300";
              return (
                <MatchRow
                  key={row.matchId ?? `${row.map}-${row.score}`}
                  bg={bg}
                  href={row.matchId ? `/matches/${row.matchId}?from=${steam64}` : undefined}
                  map={mapKey}
                  left={
                    <>
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-white transition group-hover:text-amber-100">
                          {prettyMapName(mapKey)}
                        </span>
                        <span className={`shrink-0 font-semibold ${scoreColor}`}>{row.score}</span>
                      </div>
                      {row.mode && (
                        <div className="mt-0.5 truncate text-[11px] text-slate-400">
                          {row.mode}
                          {row.city ? (
                            <span className="ml-1.5 cursor-help decoration-dotted underline underline-offset-4">
                              {row.city}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </>
                  }
                >
                  {row.rankBefore != null ? (
                    <span className="hidden w-48 items-center justify-center gap-1.5 sm:flex" title={row.rank ?? undefined}>
                      <RatingBadge rating={row.rankBefore} compact />
                      <span className="flex min-w-7 flex-col items-center leading-none">
                        <span className={`whitespace-nowrap ${row.rankDelta != null && row.rankDelta > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {row.rankDelta != null ? `${row.rankDelta > 0 ? "+" : ""}${fmt(row.rankDelta)}` : "—"}
                        </span>
                        <span className="text-slate-600">⟶</span>
                      </span>
                      <RatingBadge rating={row.rankAfter} compact />
                    </span>
                  ) : (
                    <span className="hidden w-48 sm:block" />
                  )}
                  <span className="w-24 text-center tabular-nums text-zinc-100">{row.kda ?? "—"}</span>
                  <span className="hidden w-14 text-center tabular-nums text-zinc-300 md:block">{row.kd ?? "—"}</span>
                  <span className="hidden w-16 text-center tabular-nums text-zinc-300 md:block">{row.adr ?? "—"}</span>
                  <span className="hidden w-14 text-center tabular-nums sm:block">{row.rating ?? "—"}</span>
                  <span className="hidden w-16 text-center tabular-nums lg:block">{row.kast ?? "—"}</span>
                  <span className="hidden w-14 text-center tabular-nums lg:block">{row.acc ?? "—"}</span>
                  <span className={`hidden w-16 text-center tabular-nums sm:block ${toneClass(row.preaimTone)}`}>
                    {row.preaim ?? "—"}
                  </span>
                  <span className={`hidden w-16 text-center tabular-nums sm:block ${toneClass(row.ttdTone)}`}>
                    {row.ttd ?? "—"}
                  </span>
                  <span className="w-20 text-center whitespace-nowrap text-slate-400" title={row.when ?? undefined}>
                    {relTime(tel?.ts)}
                  </span>
                </MatchRow>
              );
            })}

            {earlier.map((m) => {
              const bg = mapScreenshotUrl(m.map);
              const scoreColor =
                m.outcome === "W" ? "text-emerald-400" : m.outcome === "L" ? "text-rose-400" : "text-zinc-300";
              return (
                <MatchRow
                  key={`cst-${m.id}`}
                  bg={bg}
                  href={`/matches/${m.id}?from=${steam64}`}
                  map={m.map}
                  left={
                    <>
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-white transition group-hover:text-amber-100">
                          {prettyMapName(m.map)}
                        </span>
                        <span className={`shrink-0 font-semibold ${scoreColor}`}>{m.score}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-400">Premier</div>
                    </>
                  }
                >
                  <span className="hidden w-48 sm:block" />
                  <span className="w-24 text-center tabular-nums text-zinc-100">—</span>
                  <span className="hidden w-14 text-center tabular-nums text-zinc-300 md:block">{fmt(m.kd)}</span>
                  <span className="hidden w-16 text-center tabular-nums text-zinc-300 md:block">{fmt(m.adr)}</span>
                  <span className="hidden w-14 text-center tabular-nums sm:block">{fmt(m.rating)}</span>
                  <span className="hidden w-16 text-center tabular-nums lg:block">{m.kast != null ? `${m.kast}%` : "—"}</span>
                  <span className="hidden w-14 text-center tabular-nums lg:block">{m.acc != null ? `${m.acc}%` : "—"}</span>
                  <span className="hidden w-16 text-center tabular-nums sm:block">—</span>
                  <span className="hidden w-16 text-center tabular-nums sm:block">{m.ttd != null ? `${Math.round(m.ttd)}ms` : "—"}</span>
                  <span className="w-20 text-center whitespace-nowrap text-slate-400">{relTime(m.ts)}</span>
                </MatchRow>
              );
            })}
          </div>
          </div>
        )}
      </section>
    </div>
  );
}

function parseScoreWin(score: string | null): boolean {
  if (!score) return false;
  const parts = String(score).split(/[–—-]/).map((s) => Number(s.trim()));
  return Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] > parts[1];
}

/**
 * One match row: map icon on the LEFT, match name/score next to it, then a
 * fixed-width centered stats track (rank · K/D/A · K/D · ADR · rating · KAST ·
 * ACC · preaim · TTD · when). Clicking opens the match report.
 */
function MatchRow({
  bg,
  href,
  map,
  left,
  children,
}: {
  bg: string | null;
  href?: string;
  map: string | null;
  left: React.ReactNode;
  children: React.ReactNode;
}) {
  const icon = map ? mapIconPath(map) : null;
  return (
    <div className="group relative isolate flex min-h-[64px] items-center gap-3 overflow-hidden rounded-lg border border-white/[0.07] bg-ink-2 px-3 py-3 transition hover:brightness-125 hover:border-amber-400/20 sm:px-4">
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
          background: "linear-gradient(90deg, rgba(10,11,16,0.45) 0%, rgba(10,11,16,0.92) 35%, rgba(10,11,16,0.92) 100%)",
        }}
      />

      {/* Map icon — left */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/40">
        {icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={icon} alt={prettyMapName(map ?? "")} className="h-8 w-8 object-contain" loading="lazy" />
        ) : (
          <span className="font-mono text-xs text-zinc-500">{prettyMapName(map ?? "?")[0]}</span>
        )}
      </div>

      {/* Match name + score + mode */}
      <div className="min-w-0 flex-1">
        {href ? (
          <Link href={href} className="block min-w-0 truncate">
            {left}
          </Link>
        ) : (
          <div className="min-w-0 truncate">{left}</div>
        )}
      </div>

      {/* Centered stats track */}
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}
