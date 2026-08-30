import { isCstrackerSyncing, startCstrackerSync } from "../lib/stats/autoSync";
import { flushProxyPool, proxyPoolStats } from "../lib/stats/proxies";

const steam64 = process.argv[2] ?? "76561198930466369";

const t0 = Date.now();
startCstrackerSync(steam64);
console.log(`sync started (inFlight=${isCstrackerSyncing(steam64)}) at +0ms`);

const iv = setInterval(() => {
  if (!isCstrackerSyncing(steam64)) {
    clearInterval(iv);
    console.log(
      `background sync (scrape + persist) completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    console.log(`pool: ${JSON.stringify(proxyPoolStats())}`);
    void flushProxyPool().finally(() => process.exit(0));
  }
}, 1000);

setTimeout(() => {
  console.log("TIMEOUT after 300s — sync still in flight");
  process.exit(1);
}, 300_000);
