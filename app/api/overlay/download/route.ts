import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DIST_DIR = path.join(process.cwd(), "dist");

/** Find the most recently built overlay installer in `dist/`. */
function findInstaller(): { file: string; name: string } | null {
  if (!fs.existsSync(DIST_DIR)) return null;
  const exes = fs
    .readdirSync(DIST_DIR)
    .filter((f) => f.toLowerCase().endsWith(".exe"))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(DIST_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (exes.length === 0) return null;
  const f = exes[0].file;
  return { file: path.join(DIST_DIR, f), name: f };
}

/**
 * GET /api/overlay/download
 * Streams the Windows overlay installer so the "Download overlay" button works
 * right from the browser (the real file lives in `dist/`, which Next.js won't
 * serve directly). 404s with a clear message if no build exists yet.
 */
export async function GET() {
  const installer = findInstaller();
  if (!installer) {
    return NextResponse.json(
      { ok: false, message: "No overlay installer built yet — run `npm run dist:overlay` first." },
      { status: 404 },
    );
  }
  const stat = fs.statSync(installer.file);
  const buf = fs.readFileSync(installer.file);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.microsoft.portable-executable",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(installer.name)}"`,
      "Cache-Control": "no-store",
    },
  });
}