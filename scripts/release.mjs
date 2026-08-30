/**
 * Release the Clutchly overlay to GitHub Releases.
 *
 *   npm run build                 # stage the standalone site (once)
 *   npm run release -- 0.2.0      # bump version, build, and publish
 *
 * Requires:
 *   - GH_REPO   = "your-user/your-repo"   (owner/repo)
 *   - GH_TOKEN  = a GitHub personal access token with `repo` scope
 *
 * Publishing uploads the installer + the live-update feed (latest.yml), which
 * every installed copy auto-downloads and installs (with a progress popup).
 */
import { execSync } from "node:child_process";
import { build } from "electron-builder";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const bumpArg = process.argv[2];
const dryRun = process.env.DRY_RUN === "1";
if (dryRun) console.log("[release] DRY RUN — building update feed, not uploading.");

function fail(msg) {
  console.error(`\n[release] ${msg}\n`);
  process.exit(1);
}

// 1. The standalone site must already be staged.
if (!existsSync(resolve(root, ".next", "standalone", "server.js"))) {
  fail("Run `npm run build` first (it stages .next/standalone).");
}

// 2. Optional version bump.
if (bumpArg) {
  if (!/^\d+\.\d+\.\d+$/.test(bumpArg)) {
    fail(`"${bumpArg}" isn't a valid semver — use e.g. "0.2.0".`);
  }
  execSync(`npm pkg set version=${bumpArg}`, { stdio: "ignore", cwd: root });
  console.log(`[release] bumped version to v${bumpArg}`);
}

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

// 3. GitHub token + repo are required to publish (skip the token check dry-run).
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token && !dryRun) fail("Set GH_TOKEN (or GITHUB_TOKEN) with `repo` scope.");
const repoEnv = process.env.GH_REPO || "";
const [owner, repoName = ""] = repoEnv.split("/");
if ((!owner || !repoName) && !dryRun) fail("Set GH_REPO=\"your-user/your-repo\"");

console.log(`[release] publishing v${version} · ${owner}/${repoName} → GitHub Releases`);

// Convenience hint about the Windows cert-less signing (ships unsigned).
try {
  const ghUser = execSync("git config user.name").toString().trim();
  if (!ghUser) console.log("[release] tip: set git config user.name/email for commit metadata.");
} catch {
  /* ignore */
}

await build({
  publish: dryRun ? "never" : "always",
  config: {
    publish: { provider: "github", owner, repo: repoName, vPrefixedTagName: true },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      icon: "public/clutchly-logo.png",
    },
    nsis: {
      shortcutName: "Clutchly Overlay",
      artifactName: "Clutchly Overlay-Setup-${version}.${ext}",
    },
  },
});

console.log(`\n[release] done — v${version} is live. Installed copies will update automatically.`);