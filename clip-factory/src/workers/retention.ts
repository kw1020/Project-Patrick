import fs from "node:fs";
import path from "node:path";
import { getSettings, prisma } from "../lib/db";
import { resolveStored, storageDir, storagePath } from "../lib/paths";
import { queue, setStatus } from "../lib/queues";
import { freeGb, minFreeGb } from "../lib/guards";

// Retention (CLAUDE.md "Launch-day load" → Disk): keeps a launch-day firehose from filling the disk.
// v1.9.4 (Krew: "If the clips aren't good or aren't getting used, have them auto-delete"): every window is a Settings field
// (Settings → Storage); disk-pressure mode halves them all and also deletes the oldest unreviewed videos until there's room.
const H = 3600_000;
const D = 24 * H;
const FAILED_MS = 24 * H; // raw + final of failed clips (Retry re-grabs anyway)
const ORPHAN_MS = 24 * H; // files in raw/, final/ and work/ that no clip points at

/** The retention windows in milliseconds (from Settings; see `retentionWindows`). */
export type RetentionWindows = { rejected: number; pending: number; approved: number; posted: number; raw: number; rows: number; failed: number; orphan: number };
type RetentionSettings = { retainRejectedHrs: number; retainPendingHrs: number; retainApprovedDays: number; retainPostedDays: number; retainRawHrs: number; retainRowsDays: number };

/** Settings → windows. Pressure mode halves every window. Bad/negative values fall back to the defaults. */
export function retentionWindows(s: Partial<RetentionSettings>, pressure = false): RetentionWindows {
  const v = (x: number | undefined, def: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : def);
  const k = pressure ? 0.5 : 1;
  return {
    rejected: v(s.retainRejectedHrs, 6) * H * k,
    pending: v(s.retainPendingHrs, 48) * H * k,
    approved: v(s.retainApprovedDays, 5) * D * k,
    posted: v(s.retainPostedDays, 3) * D * k,
    raw: v(s.retainRawHrs, 6) * H * k,
    rows: v(s.retainRowsDays, 7) * D * k,
    failed: FAILED_MS * k,
    orphan: ORPHAN_MS * k,
  };
}

/** Delete a stored file; returns its size in bytes (0 if it was already gone or the path is bad). */
function remove(rel: string): number {
  try {
    const abs = resolveStored(rel);
    const size = fs.statSync(abs).size;
    fs.rmSync(abs, { force: true });
    return size;
  } catch { return 0; }
}

// Raw SQL so clearing a path does NOT bump updatedAt (Prisma's @updatedAt would restart every other retention clock).
const clearRaw = (id: string) => prisma.$executeRaw`UPDATE Clip SET rawPath = NULL WHERE id = ${id}`;
const clearFinal = (id: string) => prisma.$executeRaw`UPDATE Clip SET finalPath = NULL WHERE id = ${id}`;

export type RetentionOptions = { pressure?: boolean; windows?: RetentionWindows };
export type RetentionResult = { raws: number; finals: number; orphans: number; expired: number; rows: number; pressureFinals: number; bytes: number; pressure: boolean; freeGb: number | null; msg: string };

/** One retention pass. Deletes old files, clears the DB paths that pointed at them, returns a status line. */
export async function runRetention(now = Date.now(), opts: RetentionOptions = {}): Promise<string> {
  return (await retentionPass(now, opts)).msg;
}

export async function retentionPass(now = Date.now(), opts: RetentionOptions = {}): Promise<RetentionResult> {
  const pressure = Boolean(opts.pressure);
  const w = opts.windows ?? retentionWindows(await getSettings(), pressure);
  const before = (ms: number) => new Date(now - ms);
  let raws = 0, finals = 0, orphans = 0, expired = 0, rows = 0, pressureFinals = 0, bytes = 0;

  // 1) Raw files. stage null = no re-cut / upload in flight that still needs the raw.
  //    - cut AND reviewed (approved / rejected / posted / expired): right away (a re-cut needs the raw; the card then says so)
  //    - cut, not reviewed yet: retainRawHrs after the cut (stageAt is set when the cut finishes)
  //    - failed: after 24h (Retry re-grabs)
  const oldRaw = await prisma.clip.findMany({
    where: {
      rawPath: { not: null },
      OR: [
        { finalPath: { not: null }, stage: null, status: { in: ["approved", "rejected", "posted", "expired"] } },
        { finalPath: { not: null }, stage: null, status: { not: "processing" }, OR: [{ stageAt: { lt: before(w.raw) } }, { stageAt: null, updatedAt: { lt: before(w.raw) } }] },
        { status: { in: ["rejected", "expired"] }, stage: null }, // set aside before it was ever cut (e.g. streamer not approved)
        { status: "failed", updatedAt: { lt: before(w.failed) } },
      ],
    },
    select: { id: true, rawPath: true },
  });
  for (const c of oldRaw) {
    bytes += remove(c.rawPath!);
    await clearRaw(c.id);
    raws++;
  }

  // 2) Finals.
  //    rejected (incl. auto-rejected below the min score): retainRejectedHrs · failed: 24h · posted: retainPostedDays
  //    approved but never posted: retainApprovedDays (row stays, card says "video expired")
  const oldFinal = await prisma.clip.findMany({
    where: {
      finalPath: { not: null }, stage: null,
      OR: [
        { status: "rejected", updatedAt: { lt: before(w.rejected) } },
        { status: "failed", updatedAt: { lt: before(w.failed) } },
        { status: "posted", updatedAt: { lt: before(w.posted) } },
        { status: "approved", updatedAt: { lt: before(w.approved) } },
      ],
    },
    select: { id: true, finalPath: true },
  });
  for (const c of oldFinal) {
    bytes += remove(c.finalPath!);
    await clearFinal(c.id);
    finals++;
  }

  // 3) Pending clips nobody reviewed within retainPendingHrs: video (and raw) deleted, status "expired" (Queue → Expired tab).
  const stale = await prisma.clip.findMany({ where: { status: "pending", stage: null, updatedAt: { lt: before(w.pending) } }, select: { id: true, rawPath: true, finalPath: true } });
  for (const c of stale) {
    if (c.finalPath) { bytes += remove(c.finalPath); finals++; }
    if (c.rawPath) { bytes += remove(c.rawPath); raws++; }
    await prisma.clip.update({ where: { id: c.id }, data: { status: "expired", finalPath: null, rawPath: null } });
    expired++;
  }

  // 4) Rows: rejected / expired clips are deleted entirely after retainRowsDays. A clip with a Post is kept (Posts cascade);
  //    its Moment stays too: it's tiny and is what stops the same Twitch clip / moment being clipped again.
  const dead = await prisma.clip.findMany({
    where: { status: { in: ["rejected", "expired"] }, stage: null, updatedAt: { lt: before(w.rows) }, posts: { none: {} } },
    select: { id: true, rawPath: true, finalPath: true },
  });
  for (const c of dead) {
    if (c.finalPath) { bytes += remove(c.finalPath); finals++; }
    if (c.rawPath) { bytes += remove(c.rawPath); raws++; }
  }
  if (dead.length) rows = (await prisma.clip.deleteMany({ where: { id: { in: dead.map((c) => c.id) } } })).count;

  // 5) Orphans: files in raw/, final/ and work/ older than 24h that no clip references.
  const refs = await prisma.clip.findMany({ where: { OR: [{ rawPath: { not: null } }, { finalPath: { not: null } }] }, select: { rawPath: true, finalPath: true } });
  const referenced: Record<string, Set<string>> = {
    raw: new Set(refs.filter((c) => c.rawPath).map((c) => path.basename(c.rawPath!))),
    final: new Set(refs.filter((c) => c.finalPath).map((c) => path.basename(c.finalPath!))),
    work: new Set(),
  };
  for (const dir of ["raw", "final", "work"]) {
    let names: string[] = [];
    try { names = fs.readdirSync(storagePath(dir)); } catch { continue; }
    for (const name of names) {
      if (referenced[dir].has(name)) continue;
      const abs = storagePath(dir, name);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || now - st.mtimeMs < w.orphan) continue;
        fs.rmSync(abs, { force: true });
        bytes += st.size; orphans++;
      } catch { /* vanished meanwhile */ }
    }
  }

  // 6) Disk pressure: still under 2 x MIN_FREE_GB? Delete the oldest unreviewed videos (they expire) until there's room.
  let free: number | null = await freeGb(storageDir()).catch(() => null);
  if (pressure && free != null) {
    const target = 2 * minFreeGb();
    while (free != null && free < target) {
      const c = await prisma.clip.findFirst({ where: { status: "pending", stage: null, finalPath: { not: null } }, orderBy: { updatedAt: "asc" }, select: { id: true, rawPath: true, finalPath: true } });
      if (!c) break;
      bytes += remove(c.finalPath!);
      if (c.rawPath) bytes += remove(c.rawPath);
      await prisma.clip.update({ where: { id: c.id }, data: { status: "expired", finalPath: null, rawPath: null } });
      pressureFinals++; expired++;
      free = await freeGb(storageDir()).catch(() => null);
    }
  }

  const mb = bytes / 1024 ** 2;
  const extra = [expired ? `${expired} unreviewed expired` : "", rows ? `${rows} old clip${rows === 1 ? "" : "s"} removed` : "", pressureFinals ? `${pressureFinals} oldest unreviewed deleted for space` : ""].filter(Boolean);
  const msg = `${pressure ? "disk-pressure mode: " : ""}deleted ${raws} raw, ${finals} final, ${orphans} orphan file${orphans === 1 ? "" : "s"} · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB freed${extra.length ? ` · ${extra.join(" · ")}` : ""}${free != null ? ` · ${free.toFixed(1)} GB free` : ""}`;
  return { raws, finals, orphans, expired, rows, pressureFinals, bytes, pressure, freeGb: free, msg };
}

/** True when free space on the storage disk is under 2 x MIN_FREE_GB (retention then runs at once, windows halved). */
export async function diskPressure(): Promise<{ pressure: boolean; free: number | null }> {
  const free = await freeGb(storageDir()).catch(() => null);
  return { pressure: free != null && free < 2 * minFreeGb(), free };
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

/**
 * Worker: run retention now and then every hour; every 10 min check the disk, and when free space is under 2 x MIN_FREE_GB
 * run it at once in disk-pressure mode. Returns a stop function for shutdown.
 */
export function startRetention(everyMs = H, checkMs = 10 * 60_000): () => void {
  let running = false, lastFull = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { pressure, free } = await diskPressure();
      if (!pressure && Date.now() - lastFull < everyMs) return;
      if (pressure) console.warn(`[retention] only ${free?.toFixed(1)} GB free (under ${2 * minFreeGb()} GB): disk-pressure mode`);
      const msg = await runRetention(Date.now(), { pressure });
      lastFull = Date.now();
      console.log(`[retention] ${msg}`);
      await setStatus("retention", true, msg);
    } catch (e) {
      console.error("[retention]", (e as Error).message);
      await setStatus("retention", false, (e as Error).message).catch(() => {});
    } finally { running = false; }
  };
  void tick();
  const t = setInterval(tick, Math.min(everyMs, checkMs));
  const sweep = setInterval(() => {
    sweepStuck().then((n) => { if (n) console.warn(`[sweep] ${n} stuck clip(s) marked failed`); }).catch((e) => console.error("[sweep]", (e as Error).message));
  }, 5 * 60_000);
  return () => { clearInterval(t); clearInterval(sweep); };
}
