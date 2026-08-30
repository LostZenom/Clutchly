import { cstrackerProvider, invalidateCstrackerCache } from "../lib/stats/cstracker";
import { persistCstracker } from "../lib/stats/persistCstracker";
import { proxyPoolStats } from "../lib/stats/proxies";

const steam64 = process.argv[2] ?? "76561198930466369";

async function main() {
  await invalidateCstrackerCache(steam64);
  console.log("cache invalidated, scraping", steam64, "…");
  const t0 = Date.now();
  const { data, empty } = await cstrackerProvider(steam64, { force: true });
  console.log(
    `scrape done in ${Date.now() - t0}ms empty=${empty} proxies=${JSON.stringify(proxyPoolStats())}`,
  );
  if (!empty && data.cstracker) {
    await persistCstracker(steam64, data.cstracker);
    const rows = data.cstracker.historyTable;
    console.log("history rows:", rows.length);
    for (const r of rows.slice(0, 3)) {
      console.log(
        "row:", JSON.stringify({
          map: r.map, score: r.score, mode: r.mode, city: r.city,
          rankBefore: r.rankBefore, rankAfter: r.rankAfter, rankDelta: r.rankDelta,
          kda: r.kda, kd: r.kd, adr: r.adr, rating: r.rating, kast: r.kast, acc: r.acc,
          preaim: r.preaim, preaimTone: r.preaimTone, ttd: r.ttd, ttdTone: r.ttdTone,
        }),
      );
    }
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => process.exit(0));