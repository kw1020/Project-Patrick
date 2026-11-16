import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

export async function getSettings() {
  return prisma.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}
export type AppSettings = Awaited<ReturnType<typeof getSettings>>;
