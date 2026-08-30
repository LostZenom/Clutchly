import { prisma } from "../lib/prisma";
import { cstrackerProvider } from "../lib/stats/cstracker";
import { persistCstracker } from "../lib/stats/persistCstracker";

const steam64 = process.argv[2] ?? "76561198930466369";

async function main() {
  console.log("scraping", steam64, "…");
  const t0 = Date.now();
  const { data, empty } = await cstrackerProvider(steam64, { force: true });
  console.log(`scrape done in ${Date.now() - t0}ms (empty=${empty})`);

  if (empty || !data.cstracker) {
    console.error("nothing scraped — aborting");
    process.exit(1);
  }
  console.log("chat:", JSON.stringify(data.cstracker.chat && {
    messageCount: data.cstracker.chat.messageCount,
    matchCount: data.cstracker.chat.matchCount,
    messages: data.cstracker.chat.messages.length,
  }));

  console.log("persisting …");
  const summary = await persistCstracker(steam64, data.cstracker);
  console.log("persisted:", JSON.stringify(summary));

  const [user, matches, stats, weapons, chats, career] = await Promise.all([
    prisma.user.findUnique({ where: { steam64 }, select: { username: true } }),
    prisma.match.count({ where: { shareCode: { startsWith: "CST-" }, NOT: { shareCode: { startsWith: "CST-CAREER-" } } } }),
    prisma.playerMatchStat.count({ where: { userSteam64: steam64 } }),
    prisma.weaponMatchStat.count({ where: { userSteam64: steam64 } }),
    prisma.chatLog.count({ where: { userSteam64: steam64 } }),
    prisma.match.findUnique({ where: { shareCode: `CST-CAREER-${steam64}` }, select: { id: true } }),
  ]);
  console.log("DB rows → user:", user?.username, "| matches:", matches, "| playerStats:", stats, "| weapons:", weapons, "| chats:", chats, "| careerMatch:", !!career);

  const careerStat = career
    ? await prisma.playerMatchStat.findUnique({ where: { matchId_userSteam64: { matchId: career.id, userSteam64: steam64 } } })
    : null;
  console.log("career totals:", careerStat && {
    kills: careerStat.kills, deaths: careerStat.deaths, assists: careerStat.assists,
    headshots: careerStat.headshots, hsPercent: careerStat.hsPercent, kdRatio: careerStat.kdRatio,
  });

  const sampleWeapon = await prisma.weaponMatchStat.findFirst({ where: { userSteam64: steam64 }, orderBy: { kills: "desc" } });
  console.log("top weapon:", sampleWeapon && { weapon: sampleWeapon.weapon, kills: sampleWeapon.kills });

  const sampleChat = await prisma.chatLog.findFirst({ where: { userSteam64: steam64 }, orderBy: { sentAt: "desc" } });
  console.log("sample chat:", sampleChat && { message: sampleChat.message.slice(0, 40), round: sampleChat.round, matchId: sampleChat.matchId });
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());