/**
 * electron-builder `afterPack` hook.
 *
 * electron-builder deliberately does NOT copy `node_modules` via extraResources,
 * so the standalone site shipped to <resources>/site arrives without its traced
 * dependencies and can't boot. This hook restores the missing parts (the traced
 * node_modules plus the server/client build and public assets) from the staged
 * `.next/standalone` into the packaged resources after copying.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

export default async function afterPack(context) {
  const { appOutDir } = context;
  const src = join(process.cwd(), ".next", "standalone");
  const dstSite = join(appOutDir, "resources", "site");

  if (!existsSync(join(src, "server.js"))) {
    console.log("[afterPack] no staged standalone found — skipping site restoration.");
    return;
  }

  for (const sub of ["node_modules", ".next", "public"]) {
    const s = join(src, sub);
    if (existsSync(s)) {
      cpSync(s, join(dstSite, sub), { recursive: true, force: true });
      console.log(`[afterPack] restored site/${sub}`);
    }
  }
  for (const file of ["package.json", ".env"]) {
    if (existsSync(join(src, file))) {
      cpSync(join(src, file), join(dstSite, file));
    }
  }
  console.log("[afterPack] standalone site restored successfully.");
}