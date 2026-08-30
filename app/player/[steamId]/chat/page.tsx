import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import ChatArchive, { type ChatArchiveGroup } from "@/components/ChatArchive";

export const dynamic = "force-dynamic";

const STEAM64_RE = /^\d{17}$/;

export default async function PlayerChatPage({
  params,
}: {
  params: { steamId: string };
}) {
  const steam64 = params.steamId;
  if (!STEAM64_RE.test(steam64)) notFound();

  const groups = await prisma.match
    .findMany({
      where: {
        chatLogs: { some: { userSteam64: steam64 } },
        NOT: { shareCode: { startsWith: "CST-CAREER-" } },
      },
      orderBy: { matchDate: "desc" },
      include: {
        playerStats: {
          include: { user: { select: { username: true, avatarUrl: true } } },
        },
        // All speakers' messages for the game (interleaved in round order).
        chatLogs: {
          orderBy: [{ round: "asc" }, { tick: "asc" }, { sentAt: "asc" }],
          include: { user: { select: { username: true, avatarUrl: true } } },
        },
      },
    })
    .catch(() => []);

  // Total distinct conversations = distinct matches that have any chat.
  const total = groups.reduce((s, g) => s + g.chatLogs.length, 0);

  const rosterDefaults: Record<string, { username: string; avatarUrl: string | null }> = {};
  for (const g of groups) {
    for (const p of g.playerStats) {
      rosterDefaults[p.userSteam64] = {
        username: p.user?.username || p.username || p.userSteam64,
        avatarUrl: p.user?.avatarUrl ?? null,
      };
    }
  }

  const serialized: ChatArchiveGroup[] = groups.map((g) => ({
    id: g.id,
    mapName: g.mapName,
    shareCode: g.shareCode,
    cstId: g.shareCode.match(/^CST-(\d+)$/)?.[1] ?? null,
    matchOutcome: g.matchOutcome,
    matchDate: g.matchDate.toISOString(),
    participants: (g.playerStats.length > 0
      ? g.playerStats.map((p) => ({
          steam64: p.steam64,
          username: p.user?.username || p.username || p.steam64,
          avatarUrl: p.user?.avatarUrl ?? null,
          team: p.team,
          self: p.steam64 === steam64,
        }))
      : g.chatLogs[0]
        ? [
            {
              steam64,
              username: g.chatLogs[0].user?.username || g.chatLogs[0].username || steam64,
              avatarUrl: g.chatLogs[0].user?.avatarUrl ?? null,
              team: "CT" as const,
              self: true,
            },
          ]
        : []
    ) as ChatArchiveGroup["participants"],
    chatLogs: g.chatLogs.map((m) => ({
      id: m.id,
      steam64: m.userSteam64,
      username: m.user?.username || m.username || m.userSteam64,
      avatarUrl: m.user?.avatarUrl ?? rosterDefaults[m.userSteam64]?.avatarUrl ?? null,
      message: m.message,
      isTeamChat: m.isTeamChat,
      round: m.round,
      tick: m.tick ?? 0,
      sentAt: m.sentAt.toISOString(),
    })),
  }));

  return (
    <div className="animate-fade-up pt-8">
      <section>
        <div className="mb-5">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Chat archive
          </h2>
          <p className="mt-1 text-xs text-zinc-600">
            {total} message{total === 1 ? "" : "s"} across {groups.length} game
            {groups.length === 1 ? "" : "s"} — synced from cstracker.gg. Tap any
            player to open their profile.
          </p>
        </div>

        <ChatArchive steam64={steam64} initialGroups={serialized} />
      </section>

      <p className="mt-8 text-[11px] text-zinc-600">
        Chat is pulled from each player&apos;s own match logs on cstracker.gg and
        interleaved by round, so you see the full conversation from every game.
      </p>
    </div>
  );
}