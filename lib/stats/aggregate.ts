import { steamProvider, replaysProvider, gcProvider, type ProviderResult } from "@/lib/stats/providers";
import { scrapeProvider } from "@/lib/stats/scrape";
import { cstrackerProvider } from "@/lib/stats/cstracker";
import type { PlayerStatsDto, ProviderName, CstrackerExtras } from "@/lib/stats/types";

/**
 * Run every configured provider and merge their contributions into ONE clean
 * document:
 * - identity fields prefer Steam (first non-null wins)
 * - parsed-demo data (replays) is the authority for matches/maps/weapons/totals
 * - gc/scrape only fill gaps when replays has nothing
 */
export async function aggregateStats(
  steam64: string,
  providers: ProviderName[] = ["steam", "cstracker", "gc", "replays", "scrape"],
): Promise<PlayerStatsDto> {
  const settled = await Promise.allSettled([
    providers.includes("steam") ? steamProvider(steam64) : null,
    providers.includes("cstracker") ? cstrackerProvider(steam64) : null,
    providers.includes("replays") ? replaysProvider(steam64) : null,
    providers.includes("gc") ? gcProvider(steam64) : null,
    providers.includes("scrape") ? scrapeProvider(steam64) : null,
  ]);

  const results: ProviderResult[] = settled.flatMap((s) =>
    s.status === "fulfilled" && s.value ? [s.value] : [],
  );

  const dto: PlayerStatsDto = {
    steam64,
    username: null,
    avatarUrl: null,
    level: null,
    country: null,
    profileUrl: null,
    vacBans: 0,
    gameBans: 0,
    cs2Hours: null,
    cs2Hours2Weeks: null,
    totals: {
      matches: 0, wins: 0, losses: 0, ties: 0,
      kills: 0, deaths: 0, assists: 0, headshots: 0,
      kdRatio: 0, hltvRating: 0, adr: 0, kast: 0, hsPercent: 0,
    },
    matches: [],
    maps: [],
    weapons: [],
    premierRating: null,
    cstracker: null,
    sources: [],
    generatedAt: new Date().toISOString(),
  };

  const seenMatches = new Set<string>();
  const seenMaps = new Set<string>();
  const seenWeapons = new Map<string, number>();

  for (const r of results) {
    if (r.empty) continue;
    dto.sources.push(r.name);
    const d = r.data;

    // Identity — first non-null wins (providers run in priority order).
    dto.username = dto.username ?? d.username ?? null;
    dto.avatarUrl = dto.avatarUrl ?? d.avatarUrl ?? null;
    dto.level = dto.level ?? d.level ?? null;
    dto.country = dto.country ?? d.country ?? null;
    dto.profileUrl = dto.profileUrl ?? d.profileUrl ?? null;
    dto.vacBans = dto.vacBans || d.vacBans || 0;
    dto.gameBans = dto.gameBans || d.gameBans || 0;
    dto.cs2Hours = dto.cs2Hours ?? d.cs2Hours ?? null;
    dto.cs2Hours2Weeks = dto.cs2Hours2Weeks ?? d.cs2Hours2Weeks ?? null;

    // cstracker-only rich payload (premier rating + full extraction)
    if (d.cstracker) dto.cstracker = d.cstracker as CstrackerExtras;
    if (d.premierRating != null) dto.premierRating = d.premierRating;

    // Matches
    for (const m of d.matches ?? []) {
      const key = m.shareCode || m.id;
      if (seenMatches.has(key)) continue;
      seenMatches.add(key);
      dto.matches.push(m);
    }

    // Maps
    for (const m of d.maps ?? []) {
      if (seenMaps.has(m.map)) continue;
      seenMaps.add(m.map);
      dto.maps.push(m);
    }

    // Weapons — sum kills across sources
    for (const w of d.weapons ?? []) {
      seenWeapons.set(w.weapon, (seenWeapons.get(w.weapon) ?? 0) + w.kills);
    }

    // Totals — replays is authoritative; otherwise fill gaps
    if (d.totals && (dto.totals.matches === 0 || dto.sources.includes("replays"))) {
      if (d.totals.matches > 0) {
        dto.totals = { ...d.totals };
      } else if (dto.totals.matches === 0) {
        dto.totals = { ...dto.totals, ...d.totals };
      }
    }
  }

  dto.weapons = [...seenWeapons.entries()]
    .map(([weapon, kills]) => ({ weapon, kills }))
    .sort((a, b) => b.kills - a.kills);

  dto.matches.sort((a, b) => (a.date < b.date ? 1 : -1));

  return dto;
}
