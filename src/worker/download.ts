import { createWriteStream, createReadStream, mkdirSync, rmSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";
import unbzip2Stream from "unbzip2-stream";
import { env } from "@/lib/env";

export interface DownloadResult {
  /** Absolute path to the decompressed .dem file. */
  demPath: string;
  /** Size in bytes of the compressed file that was fetched. */
  compressedBytes: number;
}

function ensureDemosDir(): string {
  mkdirSync(env.demosDir, { recursive: true });
  return env.demosDir;
}

async function streamToFile(readable: Readable, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    readable.on("error", reject);
    const write = createWriteStream(dest);
    write.on("error", reject);
    write.on("finish", resolve);
    readable.pipe(write);
  });
}

/**
 * Download a demo from `url`, decompressing `.bz2`/`.gz`/`.dem` streams into a
 * plain `.dem` file on disk. Follows redirects (Valve rotates replay hosts);
 * validates non-empty output so silent CDN failures fail loudly.
 */
export async function downloadDemo(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<DownloadResult> {
  const dir = ensureDemosDir();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Clutchly/0.1" },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok || !resp.body) {
    throw new Error(`Demo download failed: ${resp.status} ${resp.statusText} for ${url}`);
  }

  const suffix = (resp.url.split("?")[0].split("/").pop() ?? "").toLowerCase();
  const compressedExt = suffix.endsWith(".dem.bz2")
    ? ".dem.bz2"
    : suffix.endsWith(".dem.gz")
      ? ".dem.gz"
      : suffix.endsWith(".dem")
        ? ".dem"
        : ".dem.bz2";

  const token = randomUUID().slice(0, 8);
  const rawPath = path.join(dir, `${token}${compressedExt}`);
  const demPath = path.join(dir, `${token}.dem`);

  // Write the raw (possibly compressed) body to disk first.
  const webStream = Readable.fromWeb(resp.body as unknown as import("node:stream/web").ReadableStream);
  await streamToFile(webStream, rawPath);
  const compressedBytes = statSync(rawPath).size;

  switch (compressedExt) {
    case ".dem":
      // Already uncompressed — move into place.
      rmSync(demPath, { force: true });
      await import("node:fs/promises").then((m) => m.rename(rawPath, demPath));
      break;
    case ".dem.bz2":
      await pipeline(createReadStream(rawPath), unbzip2Stream(), createWriteStream(demPath));
      rmSync(rawPath, { force: true });
      break;
    case ".dem.gz":
      await pipeline(createReadStream(rawPath), createGunzip(), createWriteStream(demPath));
      rmSync(rawPath, { force: true });
      break;
    default:
      rmSync(rawPath, { force: true });
      throw new Error(`Unexpected demo extension: ${compressedExt}`);
  }

  if (statSync(demPath).size === 0) {
    rmSync(demPath, { force: true });
    throw new Error(`Downloaded demo was empty: ${url}`);
  }

  return { demPath, compressedBytes };
}