/**
 * Staging step for shipping the website with the desktop overlay.
 *
 * `next build` with `output: "standalone"` emits `.next/standalone`, but a few
 * runtime pieces Next doesn't copy automatically must be added for the server to
 * fully work: the client build (`.next/static`), the public assets, the `.env`
 * (DB + Steam keys), and — if present — the local SQLite database + Prisma engine.
 *
 * Run AFTER `next build`:  `node scripts/package-site.mjs`
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next", "standalone");

function fail(msg) {
  console.error(`[package-site] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(standalone, "server.js"))) {
  fail("No .next/standalone/server.js — run `npm run build` first.");
}

console.log("[package-site] staging standalone site…");

// 1. Client JS bundles → served from <standalone>/.next/static.
const dstStatic = join(standalone, ".next", "static");
rmSync(dstStatic, { recursive: true, force: true });
cpSync(join(root, ".next", "static"), dstStatic, { recursive: true });
console.log("  ✓ .next/static");

// 2. Public assets (logo, any static files).
const dstPublic = join(standalone, "public");
rmSync(dstPublic, { recursive: true, force: true });
if (existsSync(join(root, "public"))) {
  cpSync(join(root, "public"), dstPublic, { recursive: true });
  console.log("  ✓ public");
}

// 3. .env — the server needs DB + Steam env at runtime.
if (existsSync(join(root, ".env"))) {
  cpSync(join(root, ".env"), join(standalone, ".env"));
  console.log("  ✓ .env");
}

// 4. Local SQLite database, if this project uses one.
for (const db of ["prisma/dev.db", "prisma/clutchly.db", "data.db"]) {
  if (existsSync(join(root, db))) {
    mkdirSync(dirname(join(standalone, db)), { recursive: true });
    cpSync(join(root, db), join(standalone, db));
    console.log(`  ✓ ${db}`);
  }
}

// 5. Prune a known waste: /api/overlay/download reads `dist/`, so Next's
//    standalone trace copies our whole electron-builder output (including a full
//    Electron runtime) into the payload and then re-includes it on every build.
//    Drop it from the staged payload — the packaged app no longer needs it.
const stagedDist = join(standalone, "dist");
rmSync(stagedDist, { recursive: true, force: true });

console.log("[package-site] done.");