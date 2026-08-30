import { PrismaClient } from "@prisma/client";

/**
 * Single PrismaClient across the app/worker. Works on both Next.js and the
 * standalone BullMQ worker (which imports the same module graph).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}