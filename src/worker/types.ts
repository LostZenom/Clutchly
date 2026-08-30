/** Team side as stored in Prisma (matches the TeamSide enum). */
export type Team = "CT" | "T" | "SPECTATOR";

export interface ParsedPlayerStat {
  steam64: string;
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  assists: number;
  kdRatio: number;
  headshots: number;
  hsPercent: number; // 0 - 100
  adr: number; // total damage dealt / total rounds
  kast: number; // 0 - 100: participated (kill | assist | survived | damage) that round
  mvps: number;
  score: number;
  /**
   * Local approximation of an "HLTV Rating 2.0"-style number, derived from
   * real per-round primitives (KPR, DPR, ADR, KAST, impact). Weights are a
   * documented in-house heuristic to be tuned against real demos in Step 6.
   */
  rating: number;
  /** Kills by weapon name (demoparser weapon keys, e.g. "ak47"). */
  weapons: Record<string, number>;
}

export interface ParsedChat {
  steam64: string;
  name: string;
  text: string;
  isTeamChat: boolean; // false = all chat
  round: number;
  tick: number;
  sentAt: string; // ISO timestamp estimated from match start + tick time
}

export interface ParsedRound {
  round: number;
  winner: Team;
  endReason: string | null;
  bombPlanted: boolean;
  bombSite: string | null;
  playersCtAlive: number;
  playersTAlive: number;
}

export interface ParsedDemo {
  mapName: string;
  serverName: string;
  tickRate: number;
  durationSecs: number;
  playbackTicks: number;
  totalRounds: number;
  scoreCT: number;
  scoreT: number;
  winningTeam: Team | null;
  serverAddress: string | null;
  serverPort: number | null;
  players: ParsedPlayerStat[];
  chats: ParsedChat[];
  rounds: ParsedRound[];
  /** Regional bucket inferred from the Valve server name, e.g. "us_southeast". */
  regionCode?: string;
}