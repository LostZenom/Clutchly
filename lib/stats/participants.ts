import * as cheerio from "cheerio";
import { prisma } from "@/lib/prisma";
import { fetchMatchReport, type MatchReport } from "@/lib/stats/matchReport";
import { proxiedFetchText } from "@/lib/stats/proxies";

/**
 * Match participants + conversation persisted from cstracker so the chat
 * archive shows who a player was in a game with AND what everyone in that game
 * actually said — names, avatars and team color-coded like a real group chat.
 *
 * Design notes:
 * - Participant rows ADD identity/team for the other players. To keep the
 *   career-summary aggregation (which sums kills across PlayerMatchStat) from
 *   double-counting, they do NOT overwrite numeric per-match stats.
 * - Each opponent's own cstracker chat page is fetched and its messages for
 *   THIS match are stored as ChatLog rows keyed on the sender, so the archive
 *   can interleave the full conversation.
 * - Everything is upsert-based and idempotent.
 */

export interface MatchParticipant {
  steam64: string;
  username: string;
  avatarUrl: string | null;
  team: "CT" | "T";
  self: boolean;
}

/** Run async work over a list with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Persist the 10 players of a match report → User + PlayerMatchStat. */
export async function persistMatchParticipants(
  cstMatchId: string,
  report: MatchReport,
): Promise<MatchParticipant[]> {
  const shareCode = `CST-${cstMatchId}`;
  let match = await prisma.match.findUnique({ where: { shareCode } }).catch(() => null);
  if (!match) {
    match = await prisma.match
      .create({
        data: {
          shareCode,
          mapName: report.map ?? "de_unknown",
          parseStatus: "PARSED",
          matchOutcome: null,
          matchDate: report.playedTs ? new Date(report.playedTs * 1000) : new Date(),
          scoreCT: report.score.ct ?? 0,
          scoreT: report.score.t ?? 0,
        },
      })
      .catch(() => null);
  }
  if (!match) return [];

  const out: MatchParticipant[] = [];
  for (const team of report.teams) {
    const side: "CT" | "T" = team.side === "CT" ? "CT" : "T";
    for (const p of team.players) {
      if (!p.steam64 || !/^\d{17}$/.test(p.steam64)) continue;
      const username = p.name ?? p.steam64;
      // Existing users keep their stable profile name — never overwrite it with
      // a transient in-game nickname from a scoreboard. Only backfill a missing
      // avatar. (The viewed player's own User is preserved this way too.)
      const existing = await prisma.user.findUnique({ where: { steam64: p.steam64 } }).catch(() => null);
      if (existing) {
        if (!existing.avatarUrl && p.avatarUrl) {
          await prisma.user
            .update({ where: { steam64: p.steam64 }, data: { avatarUrl: p.avatarUrl } })
            .catch(() => {});
        }
      } else {
        await prisma.user
          .create({ data: { steam64: p.steam64, username, avatarUrl: p.avatarUrl ?? null } })
          .catch(() => {});
      }

      const row = await prisma.playerMatchStat
        .upsert({
          where: { matchId_userSteam64: { matchId: match.id, userSteam64: p.steam64 } },
          update: { username, team: side },
          create: {
            matchId: match.id,
            userSteam64: p.steam64,
            steam64: p.steam64,
            username,
            team: side,
            kills: 0,
            deaths: 0,
            assists: 0,
            kdRatio: 0,
            mvp: p.mvp ?? 0,
            hltvRating: p.hltv ?? 0,
            adr: p.adr ?? 0,
          },
        })
        .catch(() => null);
      if (row) out.push({ steam64: p.steam64, username, avatarUrl: p.avatarUrl ?? null, team: side, self: false });
    }
  }
  return out;
}

interface PlayerChatMsg {
  id: string;
  round: number | null;
  tickSeconds: number | null;
  text: string;
}

/** Parse a player's cstracker /sections/chat page, keeping only THIS match's messages. */
function parsePlayerChatForMatch(html: string, targetMatchId: string): PlayerChatMsg[] {
  const $ = cheerio.load(html);
  const out: PlayerChatMsg[] = [];
  $('a[href*="timeline-chat-"]').each((_, raw) => {
    const a = $(raw);
    const href = a.attr("href") ?? "";
    const m = href.match(/\/matches\/(\d+)#timeline-chat-(\d+)/);
    if (!m) return;
    const matchId = m[1];
    const id = m[2];
    if (matchId !== targetMatchId) return;
    const timeText = $(a).find("span").first().text().trim().replace(/\s+/g, " ");
    const text = $(a).find(".whitespace-pre-wrap").first().text().trim();
    if (!text) return;
    const roundMatch = timeText?.match(/R(\d+)/);
    const tickMatch = timeText?.match(/(\d+):(\d{2})(?:\.(\d+))?/);
    out.push({
      id,
      round: roundMatch ? Number(roundMatch[1]) : null,
      tickSeconds: tickMatch ? Number(tickMatch[1]) * 60 + Number(tickMatch[2]) : null,
      text,
    });
  });
  return out;
}

/**
 * Fetch each opponent's cstracker chat and store the messages that belong to
 * THIS match as ChatLog rows (userSteam64 = the sender), so the archive shows
 * the real conversation interleaved. Idempotent; failures are per-player.
 */
export async function importMatchConversation(
  cstMatchId: string,
  participants: MatchParticipant[],
): Promise<number> {
  const shareCode = `CST-${cstMatchId}`;
  const match = await prisma.match.findUnique({ where: { shareCode } }).catch(() => null);
  if (!match || participants.length === 0) return 0;

  const matchDate = match.matchDate;

  // Skip the self player (their chat is already imported) — only opponents.
  const opponents = participants.filter((p) => !p.self);
  let stored = 0;

  await mapLimit(opponents, 3, async (p) => {
    const chatUrl = `https://cstracker.gg/players/${p.steam64}/sections/chat`;
    let messages: PlayerChatMsg[] = [];
    try {
      const html = await proxiedFetchText(chatUrl, { timeoutMs: 15_000 });
      messages = parsePlayerChatForMatch(html, cstMatchId);
    } catch {
      return;
    }
    for (const msg of messages) {
      const round = msg.round != null && msg.round > 0 ? msg.round - 1 : 0;
      const row = await prisma.chatLog
        .upsert({
          where: { id: `cst-${msg.id}` },
          update: { message: msg.text, round, tick: msg.tickSeconds ?? 0 },
          create: {
            id: `cst-${msg.id}`,
            matchId: match.id,
            userSteam64: p.steam64,
            username: p.username,
            message: msg.text,
            isTeamChat: false,
            round,
            tick: msg.tickSeconds ?? 0,
            sentAt: matchDate,
          },
        })
        .catch(() => null);
      if (row) stored += 1;
    }
  });

  return stored;
}

export interface ImportedChatMessage {
  id: string;
  steam64: string;
  username: string;
  avatarUrl: string | null;
  message: string;
  isTeamChat: boolean;
  round: number;
  tick: number;
  sentAt: string;
}

/** Read the current (interleaved) chat for a cstracker match. */
async function readChatLogs(cstMatchId: string): Promise<ImportedChatMessage[]> {
  const match = await prisma.match
    .findUnique({
      where: { shareCode: `CST-${cstMatchId}` },
      include: {
        chatLogs: {
          orderBy: [{ round: "asc" }, { tick: "asc" }, { sentAt: "asc" }],
          include: { user: { select: { username: true, avatarUrl: true } } },
        },
      },
    })
    .catch(() => null);
  if (!match) return [];
  return match.chatLogs.map((m) => ({
    id: m.id,
    steam64: m.userSteam64,
    username: m.user?.username || m.username || m.userSteam64,
    avatarUrl: m.user?.avatarUrl ?? null,
    message: m.message,
    isTeamChat: m.isTeamChat,
    round: m.round,
    tick: m.tick ?? 0,
    sentAt: m.sentAt.toISOString(),
  }));
}

/** Scrape (cached) + persist a match's participants AND their conversation. */
export async function resolveMatchParticipants(
  cstMatchId: string,
  selfSteam64: string,
): Promise<{ participants: MatchParticipant[]; chatAdded: number; chatLogs: ImportedChatMessage[] }> {
  const report = await fetchMatchReport(cstMatchId);
  const participants = await persistMatchParticipants(cstMatchId, report);
  const withSelf = participants.map((p) => ({ ...p, self: p.steam64 === selfSteam64 }));
  let chatAdded = 0;
  try {
    chatAdded = await importMatchConversation(cstMatchId, withSelf);
  } catch {
    chatAdded = 0;
  }
  const chatLogs = await readChatLogs(cstMatchId);
  return { participants: withSelf, chatAdded, chatLogs };
}