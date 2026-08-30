import {
  parseEvents,
  parseHeader,
  parseTicks,
} from "@laihoe/demoparser2";
import type { ParsedChat, ParsedDemo, ParsedPlayerStat, ParsedRound, Team } from "@/src/worker/types";

/**
 * CS2 demo parser backed by @laihoe/demoparser2 (Rust core, NAPI bindings).
 *
 * Handles the current CS2 `PBDEMS2` protobuf demo format, which the legacy
 * `demofile` parser cannot read. Extracts a full scoreboard (kills, deaths,
 * assists, headshots, weapons, ADR, KAST, MVPs, score), rounds, and server
 * region directly from game events + tick state.
 */

interface DeathEvent {
  attacker_steamid: string | null;
  assister_steamid: string | null;
  user_steamid: string | null;
  headshot: boolean;
  weapon: string | null;
  tick: number;
}

interface HurtEvent {
  attacker_steamid: string | null;
  dmg_health: number | null;
  tick: number;
}

interface RoundEndEvent {
  winner: "CT" | "T" | string;
  reason: string;
  round: number;
  tick: number;
}

/** Map demoparser round-end reasons onto our RoundEndReason enum values. */
const ROUND_END_REASON: Record<string, string> = {
  bomb_defused: "BOMB_DEFUSED",
  bomb_exploded: "TARGET_BOMBED",
  ct_killed: "TERRORISTS_WIN",
  t_killed: "CT_WIN",
  time_ran_out: "CT_WIN",
};

function teamOf(num: number): Team {
  if (num === 2) return "CT";
  if (num === 3) return "T";
  return "SPECTATOR";
}

/** Same heuristic as the legacy parser, fed with real per-round primitives. */
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

export function parseDemoFileV2(demoPath: string): ParsedDemo {
  const header = parseHeader(demoPath) as {
    map_name?: string;
    server_name?: string;
  };

  const events = parseEvents(
    demoPath,
    ["player_death", "player_hurt", "round_end", "bomb_planted", "bomb_defused"],
    ["total_rounds_played"],
  ) as Record<string, unknown>[];

  const deaths = events.filter((e) => e.event_name === "player_death") as unknown as DeathEvent[];
  const hurts = events.filter((e) => e.event_name === "player_hurt") as unknown as HurtEvent[];
  const roundEnds = events
    .filter((e) => e.event_name === "round_end")
    .sort((a, b) => (a.tick as number) - (b.tick as number)) as unknown as RoundEndEvent[];

  const mapName = header.map_name ?? "";
  const realRounds = roundEnds.filter((r) => r.winner === "CT" || r.winner === "T");
  const scoreCT = realRounds.filter((r) => r.winner === "CT").length;
  const scoreT = realRounds.filter((r) => r.winner === "T").length;
  const totalRounds = scoreCT + scoreT;
  const winningTeam: Team | null = scoreCT > scoreT ? "CT" : scoreT > scoreCT ? "T" : null;

  // Which round does a given tick belong to? Round r spans (prevRoundEnd.tick, roundEnd[r].tick].
  const roundForTick = (tick: number): number => {
    let r = 0;
    for (const re of realRounds) {
      if (tick > re.tick) r = re.round + 1;
      else break;
    }
    return Math.max(0, r);
  };

  // ---- Per-player accumulators -------------------------------------------
  const kills = new Map<string, number>();
  const deathsBy = new Map<string, number>();
  const assists = new Map<string, number>();
  const headshots = new Map<string, number>();
  const weapons = new Map<string, Map<string, number>>();
  const damage = new Map<string, number>();
  const mvps = new Map<string, number>();
  const scores = new Map<string, number>();
  const teams = new Map<string, Team>();

  // per-round participation for KAST: kill / assist / damage / survived
  const roundParticipation = new Map<string, Set<number>>();
  const diedRound = new Map<string, Set<number>>();

  const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

  for (const d of deaths) {
    const round = roundForTick(d.tick);
    const victim = d.user_steamid;
    if (victim) {
      bump(deathsBy, victim);
      const set = diedRound.get(victim) ?? new Set<number>();
      set.add(round);
      diedRound.set(victim, set);
    }
    if (d.attacker_steamid) {
      bump(kills, d.attacker_steamid);
      if (d.headshot) bump(headshots, d.attacker_steamid);
      if (d.weapon) {
        const wm = weapons.get(d.attacker_steamid) ?? new Map<string, number>();
        wm.set(d.weapon, (wm.get(d.weapon) ?? 0) + 1);
        weapons.set(d.attacker_steamid, wm);
      }
      const set = roundParticipation.get(d.attacker_steamid) ?? new Set<number>();
      set.add(round);
      roundParticipation.set(d.attacker_steamid, set);
    }
    if (d.assister_steamid) {
      bump(assists, d.assister_steamid);
      const set = roundParticipation.get(d.assister_steamid) ?? new Set<number>();
      set.add(round);
      roundParticipation.set(d.assister_steamid, set);
    }
  }

  for (const h of hurts) {
    if (!h.attacker_steamid || !h.dmg_health || h.dmg_health <= 0) continue;
    bump(damage, h.attacker_steamid, h.dmg_health);
    const round = roundForTick(h.tick);
    const set = roundParticipation.get(h.attacker_steamid) ?? new Set<number>();
    set.add(round);
    roundParticipation.set(h.attacker_steamid, set);
  }

  // Final state per player from tick data (roster + score + mvps + team).
  const tickRows = parseTicks(demoPath, ["player_steamid", "name", "mvps", "score", "team_num"]) as {
    player_steamid: string | null;
    name: string;
    mvps: number;
    score: number;
    team_num: number;
  }[];
  const finalState = new Map<string, { name: string; mvps: number; score: number; team: number }>();
  for (const t of tickRows) {
    if (!t.player_steamid || t.player_steamid === "0") continue;
    finalState.set(t.player_steamid, {
      name: t.name,
      mvps: t.mvps,
      score: t.score,
      team: t.team_num,
    });
  }

  const roster: { name: string; steamid: string; team_number: number }[] = [];
  for (const [sid, s] of finalState) {
    teams.set(sid, teamOf(s.team));
    mvps.set(sid, s.mvps);
    scores.set(sid, s.score);
    roster.push({ name: s.name, steamid: sid, team_number: s.team });
  }

  // ---- Rounds -------------------------------------------------------------
  const rounds: ParsedRound[] = realRounds.map((re, i) => ({
    round: i,
    winner: (re.winner === "CT" || re.winner === "T" ? re.winner : "SPECTATOR") as Team,
    endReason: ROUND_END_REASON[re.reason] ?? null,
    bombPlanted: false,
    bombSite: null,
    playersCtAlive: 0,
    playersTAlive: 0,
  }));

  // ---- Scoreboard ---------------------------------------------------------
  const players: ParsedPlayerStat[] = roster
    .filter((p) => p.steamid)
    .map((p) => {
      const sid = p.steamid;
      const k = kills.get(sid) ?? 0;
      const d = deathsBy.get(sid) ?? 0;
      const a = assists.get(sid) ?? 0;
      const hs = headshots.get(sid) ?? 0;
      const adr = totalRounds ? (damage.get(sid) ?? 0) / totalRounds : 0;

      const participated = roundParticipation.get(sid) ?? new Set<number>();
      const diedRounds = diedRound.get(sid) ?? new Set<number>();
      let good = 0;
      for (let r = 0; r < totalRounds; r++) {
        if (participated.has(r) || !diedRounds.has(r)) good += 1;
      }
      const kast = totalRounds ? Math.round((good / totalRounds) * 100) : 0;

      const weaponMap = weapons.get(sid);
      const weaponObj: Record<string, number> = {};
      if (weaponMap) for (const [w, n] of weaponMap) weaponObj[w] = n;

      return {
        steam64: sid,
        name: p.name,
        team: teams.get(sid) ?? teamOf(p.team_number),
        kills: k,
        deaths: d,
        assists: a,
        kdRatio: d ? Math.round((k / d) * 100) / 100 : k,
        headshots: hs,
        hsPercent: k ? Math.round((hs / k) * 1000) / 10 : 0,
        adr: Math.round(adr * 10) / 10,
        kast,
        mvps: mvps.get(sid) ?? 0,
        score: scores.get(sid) ?? 0,
        rating: Math.round(computeRating({ kills: k, deaths: d, assists: a, rounds: totalRounds, adr, kast }) * 100) / 100,
        weapons: weaponObj,
      };
    });

  const serverName = header.server_name ?? "";
  const region = serverName.match(/([a-z]+_[a-z]+)/)?.[1] ?? null;

  return {
    mapName,
    serverName,
    tickRate: 0,
    durationSecs: 0,
    playbackTicks: 0,
    totalRounds,
    scoreCT,
    scoreT,
    winningTeam,
    serverAddress: null,
    serverPort: null,
    players,
    chats: [] as ParsedChat[],
    rounds,
    regionCode: region ?? undefined,
  };
}