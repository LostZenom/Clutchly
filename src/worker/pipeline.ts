import { basename } from "node:path";
import { prisma } from "@/lib/prisma";
import { demoUrlFromShareCode } from "@/lib/shareCode";
import { downloadDemo } from "@/src/worker/download";
import { parseDemoFile } from "@/src/worker/demofileParser";
import { persistParsed } from "@/src/worker/persist";

/**
 * Full parse pipeline for a Match row:
 *   1. resolve `.dem` URL (share code → Valve replay, or stored demoUrl)
 *   2. download (+ decompress bz2/gz) the demo
 *   3. parse it with demofile
 *   4. persist everything (scoreboard, chats, rounds, server, teammates)
 *
 * Used by the BullMQ worker and (in "in_process" mode) by the import route.
 * The pipeline owns the download URL resolution + status transitions.
 */
export async function runDemoPipeline(matchId: string, forUser: string): Promise<void> {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });

  const shareCode = match.shareCode;
  let url = match.demoUrl;
  if (!url && shareCode) url = demoUrlFromShareCode(shareCode);
  if (!url) {
    throw new Error(`Match ${matchId} has neither a share code nor a demo URL.`);
  }

  await prisma.match.update({
    where: { id: matchId },
    data: { parseStatus: "DOWNLOADING", parseError: null },
  });

  try {
    const { demPath, compressedBytes } = await downloadDemo(url);
    await prisma.match.update({
      where: { id: matchId },
      data: {
        parseStatus: "DOWNLOADED",
        demoFilePath: demPath,
        demoFileName: basename(demPath),
        demoFileSize: compressedBytes,
      },
    });

    await prisma.match.update({
      where: { id: matchId },
      data: { parseStatus: "PARSING" },
    });

    const parsed = parseDemoFile(demPath);
    await persistParsed(matchId, parsed, forUser);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.match.update({
      where: { id: matchId },
      data: {
        parseStatus: "FAILED",
        parseError: message,
        retryCount: { increment: 1 },
      },
    });
    throw err;
  }
}