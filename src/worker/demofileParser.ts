import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import { DemoFile } from "demofile";
import { parseDemoFileV2 } from "@/src/worker/demoparser2Parser";
import type { ParsedPlayerStat, ParsedChat, ParsedRound, ParsedDemo, Team } from "@/src/worker/types";

/** Current CS2 demos use the PBDEMS2 protobuf container; older ones use HL2DEMO. */
function demoMagic(path: string): string {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(8);
  try {
    readSync(fd, buf, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString("latin1");
}

/** CS round_end `reason` codes → our RoundEndReason enum names. */
const ROUND_END_REASON: Record<number, string> = {
  0: "TARGET_BOMBED",
  1: "VIP_ESCAPED",
  2: "VIP_KILLED",
  3: "TERRORISTS_ESCAPED",
  4: "CT_STOPPED_ESCALATION",
  5: "TERRORISTS_SAFE",
  6: "CT_REACHED_DEFUSE",
  7: "BOMB_DEFUSED",
  8: "CT_WIN",
  9: "TERRORISTS_WIN",
  10: "ROUND_END",
};

function teamOf(num: number): Team {
  if (num === 2) return "CT";
  if (num === 3) return "T";
  return "SPECTATOR";
}

function bombSite(site: number): string | null {
  if (site === 1) return "A";
  if (site === 2) return "B";
  return site ? String(site) : null;
}

/**
 * Transparent in-house approximation of an "HLTV Rating 2.0"-style value built
 * from real per-round primitives. Weights are documented heuristics (bounded,
 * monotone in the inputs) to be tuned against real demos in Step 6.
 */
function computeRating(s: {
  kills: number;
  deaths: number;
  assists: number;
  rounds: number;
  adr: number;
  kast: number;
}): number {
  const r = Math.max(1, s.rounds);
  const kpr = s.kills / r;
  const dpr = s.deaths / r;
  const apd = s.assists / r;
  const impact = 2.13 * kpr + 0.42 * apd;

  const rating =
    0.55 * (s.kast / 100) +
    0.95 * Math.min(2, kpr / 0.75) +
    -0.5 * Math.min(2, dpr / 0.65) +
    0.55 * Math.min(1.8, s.adr / 75) +
    0.4 * Math.min(2, impact / 1.1);

  return Math.min(3, Math.max(0.1, rating));
}

/**
 * Parse a .dem file into our intermediate shape. Routes to the Rust-based
 * demoparser2 for the modern PBDEMS2 format and falls back to demofile for
 * legacy HL2DEMO demos. Synchronous but CPU-heavy; run inside the BullMQ
 * worker (or the in-process path) only.
 */
export function parseDemoFile(demoPath: string): ParsedDemo {
  if (demoMagic(demoPath).startsWith("PBDEMS2")) {
    return parseDemoFileV2(demoPath);
  }
  return parseDemoFileLegacy(demoPath);
}

/** Parse a legacy HL2DEMO .dem file (pre-PBDEMS2 CS2 / CS:GO). */
function parseDemoFileLegacy(demoPath: string): ParsedDemo {
  const buffer = readFileSync(demoPath);
  const demo = new DemoFile();

  // ---- Accumulators ------------------------------------------------------
  const chats: ParsedChat[] = [];
  const rounds: ParsedRound[] = [];
  const damageByPlayer = new Map<string, number>();
  const headshotsByPlayer = new Map<string, number>();
  const goodRounds = new Map<string, number>();
  const roundsPendingBomb = new Set<number>();
  const bombSitesByRound = new Map<number, string | null>();

  let currentRound = -1;
  let currentRoundDamage = new Map<string, boolean>();
  let diedThisRound = new Set<string>();
  let serverAddress: string | null = null;
  let serverPort: number | null = null;

  const isLive = () => demo.gameRules.phase !== "warmup";

  /** Resolve a player's team side (2 CT / 3 T) from the live teams collection. */
  const teamNumberOf = (steam64: string): number => {
    for (const team of demo.teams) {
      for (const member of team.members) {
        if (member.steam64Id === steam64 && member.steam64Id) return team.teamNumber;
      }
    }
    return -1;
  };

  /** Real (non-bot, resolved Steam) players currently in the demo. */
  const realPlayers = () =>
    demo.players.filter((p) => !p.isFakePlayer && !!p.steam64Id && teamNumberOf(p.steam64Id) !== -1);

  demo.gameEvents.on("server_spawn", (e) => {
    if (e.address) serverAddress = e.address;
    if (e.port) serverPort = e.port;
  });

  demo.gameEvents.on("round_start", () => {
    if (!isLive()) return;
    currentRound += 1;
    currentRoundDamage = new Map();
    diedThisRound = new Set();
  });

  demo.gameEvents.on("player_chat", (e) => {
    if (e.text == null) return;
    const steam = e.player?.steam64Id ?? "";
    chats.push({
      steam64: steam,
      name: e.player?.name ?? "Player",
      text: e.text,
      isTeamChat: e.teamonly === true,
      round: Math.max(0, currentRound),
      tick: demo.currentTick,
      sentAt: new Date(demo.currentTime * 1000).toISOString(),
    });
  });

  demo.gameEvents.on("player_hurt", (e) => {
    if (!isLive() || e.attackerEntity?.steam64Id == null) return;
    // ADR convention counts health damage (armor ping adds noise).
    const dmg = Number(e.dmg_health ?? 0);
    if (dmg <= 0) return;
    const id = e.attackerEntity.steam64Id;
    damageByPlayer.set(id, (damageByPlayer.get(id) ?? 0) + dmg);
    currentRoundDamage.set(id, true);
  });

  demo.gameEvents.on("bomb_planted", (e) => {
    roundsPendingBomb.add(currentRound);
    bombSitesByRound.set(currentRound, bombSite(e.site));
  });

  demo.gameEvents.on("player_death", (e) => {
    if (!isLive()) return;
    const attacker = e.attackerEntity;
    if (attacker?.steam64Id) {
      currentRoundDamage.set(attacker.steam64Id, true);
      if (e.headshot) headshotsByPlayer.set(attacker.steam64Id, (headshotsByPlayer.get(attacker.steam64Id) ?? 0) + 1);
    }
    if (e.assisterEntity?.steam64Id) {
      currentRoundDamage.set(e.assisterEntity.steam64Id, true);
    }
    const victim = e.player?.steam64Id;
    if (victim) diedThisRound.add(victim);
  });

  demo.gameEvents.on("round_end", (e) => {
    if (!isLive()) return;
    const winner = teamOf(e.winner) === "SPECTATOR" ? "SPECTATOR" : teamOf(e.winner);

    for (const p of realPlayers()) {
      const sid = p.steam64Id;
      const participated = currentRoundDamage.has(sid) || !diedThisRound.has(sid);
      if (participated) goodRounds.set(sid, (goodRounds.get(sid) ?? 0) + 1);
    }

    rounds.push({
      round: currentRound,
      winner,
      endReason: ROUND_END_REASON[e.reason] ?? null,
      bombPlanted: roundsPendingBomb.has(currentRound),
      bombSite: bombSitesByRound.get(currentRound) ?? null,
      playersCtAlive: realPlayers().filter((p) => teamNumberOf(p.steam64Id) === 2 && p.isAlive)
        .length,
      playersTAlive: realPlayers().filter((p) => teamNumberOf(p.steam64Id) === 3 && p.isAlive)
        .length,
    });
  });

  // Parse the whole demo synchronously; listeners fire during this call.
  demo.parse(buffer);

  // ---- Match metadata -----------------------------------------------------
  const mapName = demo.header?.mapName ?? "";
  const totalRounds = rounds.length;
  const ctScore = demo.teams.find((t) => t.teamNumber === 2)?.score ?? 0;
  const tScore = demo.teams.find((t) => t.teamNumber === 3)?.score ?? 0;
  const winningTeam: Team | null = ctScore > tScore ? "CT" : tScore > ctScore ? "T" : null;

  // ---- Final per-player scoreboard (authoritative from the demo) ----------
  const players: ParsedPlayerStat[] = [];
  for (const p of realPlayers()) {
    const steam64 = p.steam64Id as string;
    const kills = p.kills;
    const deaths = p.deaths;
    const assists = p.assists;
    const hs = headshotsByPlayer.get(steam64) ?? 0;
    const adr = totalRounds ? (damageByPlayer.get(steam64) ?? 0) / totalRounds : 0;
    const kast = totalRounds
      ? Math.round(((goodRounds.get(steam64) ?? 0) / totalRounds) * 100)
      : 0;

    players.push({
      steam64,
      name: p.name,
      team: teamOf(teamNumberOf(steam64)),
      kills,
      deaths,
      assists,
      kdRatio: deaths ? Math.round((kills / deaths) * 100) / 100 : kills,
      headshots: hs,
      hsPercent: kills ? Math.round(((hs / kills) * 100) * 10) / 10 : 0,
      adr: Math.round(adr * 10) / 10,
      kast,
      mvps: p.mvps,
      score: p.score,
      rating: Math.round(computeRating({ kills, deaths, assists, rounds: totalRounds, adr, kast }) * 100) / 100,
      weapons: {},
    });
  }

  return {
    mapName,
    serverName: demo.header?.serverName ?? "",
    tickRate: demo.tickRate,
    durationSecs: Math.round(demo.header?.playbackTime ?? 0),
    playbackTicks: demo.header?.playbackTicks ?? demo.currentTick,
    totalRounds,
    scoreCT: ctScore,
    scoreT: tScore,
    winningTeam,
    serverAddress,
    serverPort,
    players,
    chats,
    rounds,
  };
}