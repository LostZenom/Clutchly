import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decodeShareCode, normalizeShareCode } from "@/lib/shareCode";
import { enqueueDemoParse } from "@/src/worker/queue";
import { runDemoPipeline } from "@/src/worker/pipeline";
import { env } from "@/lib/env";

const ImportBody = z.object({
  shareCodes: z.array(z.string().min(5).max(64)).min(1).max(25),
});
const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

type Ctx = { params: { steamid: string } };

/** GET — paginated parsed matches for a player, each with their own scoreboard row. */
export async function GET(_req: Request, { params }: Ctx) {
  const steamid = params.steamid;
  const { page, pageSize } = ListQuery.parse(Object.fromEntries(new URL(_req.url).searchParams));

  const [total, rows] = await Promise.all([
    prisma.playerMatchStat.count({ where: { userSteam64: steamid } }),
    prisma.playerMatchStat.findMany({
      where: { userSteam64: steamid },
      include: { match: true },
      orderBy: { match: { matchDate: "desc" } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    steam64: steamid,
    page,
    pageSize,
    total,
    matches: rows.map((row) => ({
      matchId: row.matchId,
      mapName: row.match.mapName,
      matchDate: row.match.matchDate,
      parseStatus: row.match.parseStatus,
      scoreCT: row.match.scoreCT,
      scoreT: row.match.scoreT,
      winningTeam: row.match.winningTeam,
      matchOutcome: row.match.matchOutcome,
      team: row.team,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      kdRatio: row.kdRatio,
      hltvRating: row.hltvRating,
      adr: row.adr,
      mvp: row.mvp,
    })),
  });
}

/**
 * POST — import match share code(s) for this player.
 * Decodes each code, idempotently creates a Match row, ensures the User exists,
 * then hands the demo off to the parse pipeline (BullMQ, or inline in dev).
 */
export async function POST(req: Request, { params }: Ctx) {
  const forUser = params.steamid;

  let body: z.infer<typeof ImportBody>;
  try {
    body = ImportBody.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Provide `shareCodes` as an array of 1–25 CS2 share codes." },
      { status: 400 },
    );
  }

  const results: { shareCode: string; status: "imported" | "already_exists" | "invalid" }[] = [];
  let enqueued = 0;

  for (const raw of body.shareCodes) {
    const normalized = normalizeShareCode(raw);
    if (!normalized) {
      results.push({ shareCode: raw, status: "invalid" });
      continue;
    }

    const decoded = decodeShareCode(raw); // validate + extract metadata

    const existing = await prisma.match.findUnique({
      where: { shareCode: raw.trim() },
    });
    if (existing) {
      results.push({ shareCode: raw.trim(), status: "already_exists" });
      continue;
    }

    const created = await prisma.match.create({
      data: {
        shareCode: raw.trim(),
        mapName: "de_unknown",
        matchOutcome: null,
        // server region token is resolved at parse time; store decoded ids too
        demoFileName: `${decoded.matchId}_${decoded.outcomeId}_${decoded.token}.dem.bz2`,
        parseStatus: "QUEUED",
      },
    });

    await prisma.user.upsert({
      where: { steam64: forUser },
      update: {},
      create: {
        steam64: forUser,
        username: "Player",
      },
    });

    if (env.parseMode === "in_process") {
      // Dev-friendly: parse inline without Redis.
      runDemoPipeline(created.id, forUser).catch((err) =>
        console.error(`[in_process] parse failed for ${created.id}:`, err),
      );
    } else {
      await enqueueDemoParse({ matchId: created.id, forUser });
    }
    enqueued += 1;
    results.push({ shareCode: raw.trim(), status: "imported" });
  }

  return NextResponse.json(
    { ok: true, enqueued, results },
    { status: enqueued > 0 ? 201 : 200 },
  );
}