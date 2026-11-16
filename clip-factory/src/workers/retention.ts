import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/db";
import { resolveStored, storagePath } from "../lib/paths";
import { queue, setStatus } from "../lib/queues";

// Retention (CLAUDE.md "Launch-day load" → Disk): keeps a launch-day firehose from filling the disk.
const H = 3600_000;
const RAW_AFTER_CUT_MS = 12 * H;   // raw files once the clip has been cut
const DEAD_FINAL_MS = 24 * H;      // finals of rejected / failed clips
const POSTED_FINAL_MS = 7 * 24 * H; // finals of posted clips
const ORPHAN_MS = 24 * H;          // files in raw/ and work/ that no clip points at

/** Delete a stored file; returns its size in bytes (0 if it was already gone or the path is bad). */
function remove(rel: string): number {
  try {
    const abs = resolveStored(rel);
    const size = fs.statSync(abs).size;
    fs.rmSync(abs, { force: true });
    return size;
  } catch { return 0; }
}

/** One retention pass. Deletes old files, clears the DB paths that pointed at them, returns a status line. */
export async function runRetention(now = Date.now()): Promise<string> {
  let raws = 0, finals = 0, orphans = 0, bytes = 0;

  // 1) Raw files: 12h after the clip was cut (or 24h after it failed — retry re-grabs).
  const oldRaw = await prisma.clip.findMany({
    where: {
      rawPath: { not: null },
      OR: [
        // stage null = no re-cut / upload in flight that still needs the raw
        { finalPath: { not: null }, stage: null, status: { not: "processing" }, updatedAt: { lt: new Date(now - RAW_AFTER_CUT_MS) } },
        { status: "failed", updatedAt: { lt: new Date(now - DEAD_FINAL_MS) } },
      ],
    },
    select: { id: true, rawPath: true },
  });
  for (const c of oldRaw) {
    bytes += remove(c.rawPath!);
    await prisma.clip.update({ where: { id: c.id }, data: { rawPath: null } });
    raws++;
  }

  // 2) Finals: rejected/failed after 24h, posted after 7 days. Never pending / approved / processing.
  const oldFinal = await prisma.clip.findMany({
    where: {
      finalPath: { not: null },
      OR: [
        { status: { in: ["rejected", "failed"] }, updatedAt: { lt: new Date(now - DEAD_FINAL_MS) } },
        { status: "posted", updatedAt: { lt: new Date(now - POSTED_FINAL_MS) } },
      ],
    },
    select: { id: true, finalPath: true },
  });
  for (const c of oldFinal) {
    bytes += remove(c.finalPath!);
    await prisma.clip.update({ where: { id: c.id }, data: { finalPath: null } });
    finals++;
  }

  // 3) Orphans: files in raw/ and work/ older than 24h that no clip references.
  const referenced = new Set(
    (await prisma.clip.findMany({ where: { rawPath: { not: null } }, select: { rawPath: true } })).map((c) => path.basename(c.rawPath!)),
  );
  for (const dir of ["raw", "work"]) {
    let names: string[] = [];
    try { names = fs.readdirSync(storagePath(dir)); } catch { continue; }
    for (const name of names) {
      if (dir === "raw" && referenced.has(name)) continue;
      const abs = storagePath(dir, name);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || now - st.mtimeMs < ORPHAN_MS) continue;
        fs.rmSync(abs, { force: true });
        bytes += st.size; orphans++;
      } catch { /* vanished meanwhile */ }
    }
  }

  const mb = bytes / 1024 ** 2;
  return `deleted ${raws} raw, ${finals} final, ${orphans} orphan file${orphans === 1 ? "" : "s"} · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB freed`;
}

/**
 * Stuck-clip sweeper. A clip counts against MAX_BACKLOG while "processing"; if its job is lost
 * (Redis wiped, worker killed mid-job beyond BullMQ's stall recovery) it would block the line forever.
 * Any processing clip idle for 10+ min with no waiting/active/delayed job is marked failed (Retry button).
 */
export async function sweepStuck(now = Date.now(), idleMs = 10 * 60_000) {
  const stale = await prisma.clip.findMany({ where: { status: "processing", updatedAt: { lt: new Date(now - idleMs) } }, select: { id: true, stage: true } });
  if (!stale.length) return 0;
  const live = new Set<string>();
  for (const name of ["grab", "transcribe", "judge", "cut"] as const) {
    const jobs = await queue(name).getJobs(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
    for (const j of jobs) if (j?.data?.clipId) live.add(j.data.clipId);
  }
  let n = 0;
  for (const c of stale) {
    if (live.has(c.id)) continue;
    await prisma.clip.update({ where: { id: c.id }, data: { status: "failed", error: `Lost in the line at the ${c.stage ?? "?"} step (worker restarted?). Press Retry.` } });
    n++;
  }
  return n;
}

/** Worker: run retention now and then every hour. Returns a stop function for shutdown. */
export function startRetention(everyMs = H): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const msg = await runRetention();
      console.log(`[retention] ${msg}`);
      await setStatus("retention", true, msg);
    } catch (e) {
      console.error("[retention]", (e as Error).message);
      await setStatus("retention", false, (e as Error).message).catch(() => {});
    } finally { running = false; }
  };
  void tick();
  const t = setInterval(tick, everyMs);
  const sweep = setInterval(() => {
    sweepStuck().then((n) => { if (n) console.warn(`[sweep] ${n} stuck clip(s) marked failed`); }).catch((e) => console.error("[sweep]", (e as Error).message));
  }, 5 * 60_000);
  return () => { clearInterval(t); clearInterval(sweep); };
}
