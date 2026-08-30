import { Prisma, TeamSide, RoundEndReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import type { ParsedDemo, Team } from "@/src/worker/types";

export async function persistParsed(
  matchId: string,
  parsed: ParsedDemo,
  forUser: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 1. Ensure every participant has a User row (upsert, preserve profile data).
    const steam64s = new Set<string>([forUser]);
    for (const p of parsed.players) steam64s.add(p.steam64);
    for (const c of parsed.chats) if (c.steam64) steam64s.add(c.steam64);

    await Promise.all(
      [...steam64s].map((sid) =>
        tx.user.upsert({
          where: { steam64: sid },
          update: { lastSeenAt: new Date() },
          create: {
            steam64: sid,
            username:
              parsed.players.find((p) => p.steam64 === sid)?.name ?? "Unknown",
          },
        }),
      ),
    );

    // 2. Upsert the server location (or thread it via region fallback).
    const serverIp = parsed.serverAddress || null;
    let locationId = serverIp;
    if (serverIp) {
      await tx.serverLocation.upsert({
        where: { serverIp },
        update: { lastSeenAt: new Date() },
        create: {
          serverIp,
          provider: "VALVE",
          regionCode: parsed.regionCode ?? env.defaultRegion,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    }

    // 3. Update the Match row with parsed summary metadata.
    const selfTeam = forUserTeam(forUser, parsed);
    const matchOutcome = !parsed.winningTeam
      ? "TIE"
      : selfTeam && selfTeam === parsed.winningTeam
        ? "WIN"
        : "LOSS";

    await tx.match.update({
      where: { id: matchId },
      data: {
        mapName: parsed.mapName,
        tickRate: parsed.tickRate,
        durationSecs: parsed.durationSecs,
        totalRounds: parsed.totalRounds,
        scoreCT: parsed.scoreCT,
        scoreT: parsed.scoreT,
        winningTeam: parsed.winningTeam ? (parsed.winningTeam as TeamSide) : null,
        matchOutcome,
        serverIp: serverIp ?? undefined,
        parseStatus: "PARSED",
        parsedAt: new Date(),
        parseError: null,
      },
    });

    // 4. Idempotent overwrite of derived rows for this match.
    await tx.roundEvent.deleteMany({ where: { matchId } });
    await tx.playerMatchStat.deleteMany({ where: { matchId } });
    await tx.chatLog.deleteMany({ where: { matchId } });
    await tx.weaponMatchStat.deleteMany({ where: { matchId } });

    if (parsed.rounds.length > 0) {
      await tx.roundEvent.createMany({
        data: parsed.rounds.map((r) => ({
          matchId,
          round: r.round,
          winner: r.winner as TeamSide,
          endReason: r.endReason as RoundEndReason | undefined,
          bombPlanted: r.bombPlanted,
          bombSite: r.bombSite,
          playersCtAlive: r.playersCtAlive,
          playersTAlive: r.playersTAlive,
        })),
      });
    }

    if (parsed.players.length > 0) {
      await tx.playerMatchStat.createMany({
        data: parsed.players.map((p) => ({
          matchId,
          userSteam64: p.steam64,
          steam64: p.steam64,
          username: p.name,
          team: p.team as TeamSide,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          kdRatio: p.kdRatio,
          mvp: p.mvps,
          headshots: p.headshots,
          hsPercent: p.hsPercent,
          kast: p.kast,
          adr: p.adr,
          hltvRating: p.rating,
          score: p.score,
        })),
      });
    }

    if (parsed.chats.length > 0) {
      await tx.chatLog.createMany({
        data: parsed.chats.map((c) => ({
          matchId,
          userSteam64: c.steam64,
          username: c.name,
          message: c.text,
          isTeamChat: c.isTeamChat,
          round: c.round,
          tick: c.tick,
          sentAt: new Date(c.sentAt),
        })),
      });
    }

    // Per-player weapon kills (for the Weapons chart).
    const weaponRows: {
      matchId: string;
      userSteam64: string;
      weapon: string;
      kills: number;
    }[] = [];
    for (const p of parsed.players) {
      for (const [weapon, count] of Object.entries(p.weapons ?? {})) {
        weaponRows.push({ matchId, userSteam64: p.steam64, weapon, kills: count });
      }
    }
    if (weaponRows.length > 0) {
      await tx.weaponMatchStat.createMany({ data: weaponRows });
    }

    // 5. Aggregate teammate links relative to the importing user.
    await aggregateTeammates(tx, matchId, parsed, forUser);
  });
}

function forUserTeam(forUser: string, parsed: ParsedDemo): Team | null {
  return parsed.players.find((p) => p.steam64 === forUser)?.team ?? null;
}

/** Increment TeammateLink rows for everyone who queued alongside `forUser`. */
async function aggregateTeammates(
  tx: Prisma.TransactionClient,
  matchId: string,
  parsed: ParsedDemo,
  forUser: string,
): Promise<void> {
  const self = parsed.players.find((p) => p.steam64 === forUser);
  if (!self) return;
  const teammates = parsed.players.filter(
    (p) => p.steam64 !== forUser && p.team === self.team,
  );
  if (teammates.length === 0) return;

  const won = parsed.winningTeam === self.team;
  const lost = parsed.winningTeam !== null && parsed.winningTeam !== self.team;
  const tied = parsed.winningTeam === null;

  for (const mate of teammates) {
    const key = {
      primarySteam64: forUser,
      partnerSteam64: mate.steam64,
    };
    const existing = await tx.teammateLink.findFirst({ where: key });

    const prev = existing ?? {
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      avgKd: 0,
      avgRating: 0,
    };
    const matches = prev.matchesPlayed + 1;
    const wins = prev.wins + (won ? 1 : 0);
    const losses = prev.losses + (lost ? 1 : 0);
    const ties = prev.ties + (tied ? 1 : 0);

    const totalWeight = prev.matchesPlayed + 1;
    const avgKd = Math.round(((prev.avgKd * prev.matchesPlayed + mate.kdRatio) / totalWeight) * 1000) / 1000;
    const avgRating = Math.round(((prev.avgRating * prev.matchesPlayed + mate.rating) / totalWeight) * 1000) / 1000;

    await tx.teammateLink.upsert({
      where: { primarySteam64_partnerSteam64: key },
      update: {
        partnerUsername: mate.name,
        matchesPlayed: matches,
        wins,
        losses,
        ties,
        winRate: Math.round((wins / matches) * 1000) / 10,
        avgKd,
        avgRating,
        lastPlayedAt: new Date(),
      },
      create: {
        ...key,
        partnerUsername: mate.name,
        matchesPlayed: matches,
        wins,
        losses,
        ties,
        winRate: Math.round((wins / matches) * 1000) / 10,
        avgKd,
        avgRating,
        lastPlayedAt: new Date(),
      },
    });
  }
}