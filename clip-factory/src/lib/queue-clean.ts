// v2.0.6 (Krew: "I just have so many queued piled up, it's just a bunch of random clips"): clear the review pile.
import { getSettings, prisma } from "./db";

export const CLEANUP_REASON = "Cleaned up: below the new bar";

/**
 * Pending clips (To review) scored below the current min score, or never scored, become "rejected" with CLEANUP_REASON.
 * The v1.9.4 retention then deletes their files after retainRejectedHrs (6h). Approved / posted clips are never touched,
 * nor clips still in the line. Returns how many were cleared. Used by the one-time worker migration and the Queue's
 * "Clean up queue" button.
 */
export async function cleanUpQueue(): Promise<number> {
  const s = await getSettings();
  const r = await prisma.clip.updateMany({
    where: { status: "pending", OR: [{ score: null }, { score: { lt: s.minScore } }] },
    data: { status: "rejected", judgeReason: CLEANUP_REASON },
  });
  return r.count;
}

/**
 * v2.0.6 one-time moves (flags, so they run once and later manual changes stick): (a) the pile of pending clips scored under
 * the old rules is cleaned up (`cleanUpQueue`); (c) "Clips nobody reviewed" goes 48h -> 24h, only if still the old default.
 */
export async function migrateV206Settings(): Promise<string | null> {
  const s = await prisma.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
  const out: string[] = [];
  if (!s.migratedQueueCleanup) {
    const n = await cleanUpQueue();
    await prisma.settings.update({ where: { id: "main" }, data: { migratedQueueCleanup: true } });
    out.push(`queue cleaned up: ${n} pending clip${n === 1 ? "" : "s"} below ${s.minScore} or unscored rejected`);
  }
  if (!s.migratedPending24) {
    const moved = s.retainPendingHrs === 48;
    await prisma.settings.update({ where: { id: "main" }, data: { ...(moved ? { retainPendingHrs: 24 } : {}), migratedPending24: true } });
    out.push(moved ? "clips nobody reviewed: 48h -> 24h" : `clips nobody reviewed kept at ${s.retainPendingHrs}h`);
  }
  return out.length ? out.join("; ") : null;
}
