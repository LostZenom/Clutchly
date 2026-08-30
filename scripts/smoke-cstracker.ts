import { cstrackerProvider } from "../lib/stats/cstracker";
import { proxyPoolStats } from "../lib/stats/proxies";

/**
 * Dev tool: npx tsx scripts/smoke-cstracker.ts [steam64]
 * Scrapes a player's cstracker.gg pages through the rotating free-proxy pool
 * and prints a summary of everything extracted.
 */

const steam64 = process.argv[2] ?? "76561198930466369";
async function main() {
  const t0 = Date.now();
  const { data, empty } = await cstrackerProvider(steam64, { force: true });
  const ms = Date.now() - t0;

  const ex = data.cstracker;
  console.log("--- summary ---");
  console.log("elapsedMs:", ms, "empty:", empty, "proxies:", JSON.stringify(proxyPoolStats()));
  console.log("name:", ex?.profile?.name);
  console.log("premierRating:", data.premierRating);
  console.log("profile.rating:", ex?.profile?.rating);
  console.log("directLookup:", JSON.stringify(ex?.directLookup));
  console.log("totals:", JSON.stringify(data.totals));
  console.log("matches:", data.matches?.length, "maps:", data.maps?.length, "weapons:", data.weapons?.length);
  console.log("telemetryCards:", Object.keys(ex?.telemetryCards ?? {}).length, Object.keys(ex?.telemetryCards ?? {}).slice(0, 10).join(", "));
  console.log("historyTable rows:", ex?.historyTable?.length);
  console.log("weaponDetails:", ex?.weaponDetails?.length);
  console.log("killProfile:", JSON.stringify(ex?.killProfile));
  console.log("detailedStats groups:", Object.keys(ex?.detailedStats ?? {}).join(", "));
  console.log("detailedStats.general:", JSON.stringify(ex?.detailedStats?.general));
  console.log("insights:", JSON.stringify(ex?.insights));
  console.log("sample historic row:", JSON.stringify(ex?.historyTable?.[0]));
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});