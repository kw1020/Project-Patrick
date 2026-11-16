// Helper for test/db-load.test.ts: one "process" (web or worker stand-in) hammering the shared SQLite file.
// Usage: tsx test/db-load-child.ts <tag> [--no-tune]
import { PrismaClient } from "@prisma/client";
import { ensureSqliteTuned } from "../src/lib/db";

const tag = process.argv[2] || "p";
const tune = !process.argv.includes("--no-tune");
const N = 300;
const IN_FLIGHT = 4; // several writes at once per process, like the web app + worker do

async function main() {
  const db = new PrismaClient();
  if (tune) await ensureSqliteTuned(db);
  const ids: string[] = [];
  let next = 0;
  const one = async (i: number) => {
    switch (i % 5) {
      case 0: {
        const s = await db.streamer.create({ data: { twitchId: `${tag}-${i}`, login: `${tag}_${i}`, name: `${tag} ${i}` } });
        ids.push(s.id);
        break;
      }
      case 1:
        if (ids.length) await db.streamer.update({ where: { id: ids[i % ids.length] }, data: { viewers: i, chatRate: i / 10 } });
        break;
      case 2:
        await db.settings.upsert({ where: { id: "main" }, update: { spikeMultiplier: 2 + (i % 3) }, create: { id: "main" } });
        break;
      case 3: // batched, like flushChatHeat
        await db.$transaction(ids.slice(-5).map((id, k) => db.streamer.update({ where: { id }, data: { chatRate: k, chatAvg: i } })));
        break;
      case 4: // interactive transaction: read then write
        await db.$transaction(async (tx) => {
          const st = await tx.settings.findUnique({ where: { id: "main" } });
          await tx.settings.upsert({ where: { id: "main" }, update: { minScore: st?.minScore ?? 6 }, create: { id: "main" } });
          await tx.streamer.create({ data: { twitchId: `${tag}-tx-${i}`, login: `${tag}_tx_${i}`, name: "tx" } });
        });
        break;
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, async () => {
    while (next < N) await one(next++);
  }));
  await db.$disconnect();
  console.log(`${tag}: ${N} writes ok`);
}

main().catch((e) => { console.error(`${tag} FAILED:`, e?.message || e); process.exit(1); });
