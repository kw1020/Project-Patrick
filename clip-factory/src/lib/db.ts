import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

// The web app and the worker are two processes writing the same SQLite file. Without WAL a reader blocks
// writers (and vice versa) → "database is locked" under launch-day load.
// - journal_mode=WAL is stored in the database file, so setting it once covers every connection/process.
// - busy_timeout is per connection: Prisma 6 already sets 5000 ms on every pooled SQLite connection
//   (its `socket_timeout`, default 5s); we set it again here so the intent is explicit.
// - synchronous=NORMAL is the recommended WAL setting (per connection; best effort on pooled ones).
// PRAGMAs that return a row must go through $queryRawUnsafe, not $executeRawUnsafe.
const tuned = new WeakMap<PrismaClient, Promise<void>>();
export function ensureSqliteTuned(db: PrismaClient = prisma): Promise<void> {
  let p = tuned.get(db);
  if (!p) {
    p = (async () => {
      await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
      await db.$queryRawUnsafe("PRAGMA busy_timeout=5000");
      await db.$executeRawUnsafe("PRAGMA synchronous=NORMAL");
    })();
    p.catch(() => tuned.delete(db)); // retry next time if the DB wasn't reachable yet
    tuned.set(db, p);
  }
  return p;
}

export async function getSettings() {
  return prisma.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}
export type AppSettings = Awaited<ReturnType<typeof getSettings>>;
