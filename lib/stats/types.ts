/**
 * Unified player-stats DTO. Every provider (Steam API, GC, local replays,
 * scraper adapters) emits a partial of this shape; `aggregateStats` merges
 * them into one clean JSON document for the frontend.
 */

export interface MatchDto {
  id: string;
  shareCode: string;
  map: string;
  scoreCT: number;
  scoreT: number;
  winningTeam: "CT" | "T" | null;
  outcome: "WIN" | "LOSS" | "TIE";
  date: string; // ISO
  kills: number;
  deaths: number;
  assists: number;
  kdRatio: number;
  rating: number;
  adr: number;
  mvp: number;
}

export interface MapStatDto {
  map: string;
  matches: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number; // 0 - 100
  kdRatio: number;
  rating: number;
}

export interface WeaponStatDto {
  weapon: string;
  kills: number;
}

export interface PlayerStatsDto {
  steam64: string;
  username: string | null;
  avatarUrl: string | null;
  level: number | null;
  country: string | null;
  profileUrl: string | null;
  vacBans: number;
  gameBans: number;
  cs2Hours: number | null;
  cs2Hours2Weeks: number | null;

  totals: {
    matches: number;
    wins: number;
    losses: number;
    ties: number;
    kills: number;
    deaths: number;
    assists: number;
    headshots: number;
    kdRatio: number;
    hltvRating: number;
    adr: number;
    kast: number;
    hsPercent: number;
  };

  matches: MatchDto[];
  maps: MapStatDto[];
  weapons: WeaponStatDto[];

  /** CS2 Premier rating when cstracker provided one. */
  premierRating: number | null;

  /** Rich cstracker.gg extraction (assistant data not mappable to the DTO). */
  cstracker?: CstrackerExtras | null;

  /** Which providers contributed data (e.g. ["steam", "replays", "gc"]). */
  sources: string[];
  generatedAt: string;
}

export type PartialStats = Partial<Omit<PlayerStatsDto, "sources" | "generatedAt" | "steam64">>;

export type ProviderName = "steam" | "replays" | "gc" | "scrape" | "cstracker";

// ---------------------------------------------------------------------------
// cstracker.gg rich payload (everything the userscript surfaced, server-side).
// ---------------------------------------------------------------------------

export interface CstrackerMatchTelemetryItem {
  id: number;
  map: string;
  ts: number; // unix seconds
  score: string; // e.g. "13–9"
  outcome: "W" | "L" | "T";
  ttd?: number;
  xhair?: number;
  aim?: number;
  kd?: number;
  rating?: number;
  kast?: number;
  adr?: number;
  acc?: number;
}

export interface CstrackerTelemetryCard {
  label: string;
  valueKey: string;
  percentile: string | null;
  value: string | null;
  lowerIsSuspicious: boolean;
  suspiciousCutoff: number | null;
  verySuspiciousCutoff: number | null;
}

export interface CstrackerHistoryRow {
  matchId: string | null;
  map: string | null;
  score: string | null;
  /** Raw rank cell text, e.g. "6,194+365⟶6,559". */
  rank: string | null;
  mode: string | null; // "Premier" | "Wingman" | …
  city: string | null; // server location, e.g. "Chicago"
  rankBefore: number | null;
  rankAfter: number | null;
  rankDelta: number | null;
  kda: string | null;
  kd: string | null;
  adr: string | null;
  rating: string | null;
  kast: string | null;
  acc: string | null;
  preaim: string | null;
  preaimTone: "danger" | "warn" | null;
  ttd: string | null;
  ttdTone: "danger" | "warn" | null;
  when: string | null;
}

export interface CstrackerWeaponDetail {
  weapon: string;
  killsText: string | null;
  kills: number;
  headshotsFraction: string | null;
  headshotPct: string | null;
  shots: string | null;
  accuracyPct: string | null;
  damage: string | null;
  hitgroups: string | null;
}

export interface CstrackerChatMessage {
  /** cstracker message id (stable across scrapes). */
  id: string;
  /** cstracker match id the message belongs to. */
  matchId: string;
  map: string | null;
  /** Round as displayed, e.g. 20 for "R20". */
  round: number | null;
  timeText: string | null; // "29:48.12"
  tickSeconds: number | null;
  text: string;
  /** Match timestamp (unix seconds) from the match-group header. */
  matchTs: number | null;
}

export interface CstrackerChat {
  messageCount: number;
  matchCount: number;
  messages: CstrackerChatMessage[];
}

export interface CstrackerInsightMode {
  mode: string; // "Premier" | "Wingman"
  /** Numeric rating for the mode (e.g. "6559"), or the raw cell text. */
  rankRating: string | null;
  rankPlayed: string | null; // full raw "Rank" cell (rating + played-suffix)
  bestRating: string | null;
  bestPlayed: string | null;
  /** Matches played in this mode (the site labels this column "Wins"). */
  matches: number;
  winRatePct: number;
}

export interface CstrackerExtras {
  sourceUrl: string;
  extractedAt: string;
  profile: {
    name: string | null;
    rating: number | null;
    ratingText: string | null;
    record: { wins: number | null; losses: number | null; ties: number | null };
    /** Teammate-adjusted trust score from the cstracker trust card. */
    trust: {
      value: number | null; // 0 - 100
      level: "good" | "suspicious" | "bad" | null;
      updated: string | null;
    } | null;
    /** FACEIT badge (level icon + ELO) from the profile header; null when absent/not connected. */
    faceit: {
      level: number | null;
      elo: number | null;
      connected: boolean;
      /** Relative icon path from cstracker, e.g. /static/faceit_levels/2.svg. */
      iconSrc: string | null;
    } | null;
  };
  directLookup: {
    name: string | null;
    rating: number | null;
    matches: number | null;
    steam64: string | null;
  } | null;
  telemetryCards: Record<string, CstrackerTelemetryCard>;
  matchTelemetry: CstrackerMatchTelemetryItem[];
  historyTable: CstrackerHistoryRow[];
  weaponDetails: CstrackerWeaponDetail[];
  insights: CstrackerInsightMode[];
  /** e.g. { wallbangs: { fraction: "31 / 1,020 kills", percent: "3%", … } } */
  killProfile: Record<
    string,
    { fraction: string | null; percent: string | null; description: string | null }
  >;
  /** e.g. { general: { "K/D/A": "1,006 / 1,276 / 297", "Win rate": "35.0%" } } */
  detailedStats: Record<string, Record<string, string>>;
  /** Chat archive from the HTMX /sections/chat fragment (null when skipped). */
  chat: CstrackerChat | null;
}
