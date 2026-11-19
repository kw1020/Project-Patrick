import fs from "node:fs";
import path from "node:path";
import { storageDir } from "./paths";
import { freeGb } from "./guards";

// v1.9.4 Settings → Storage: what the clips take up, where they live, and how much room is left.

export const STORAGE_KINDS = ["raw", "final", "edits", "work"] as const;
export type StorageUsage = { dir: string; hostDir: string | null; byKind: Record<(typeof STORAGE_KINDS)[number] | "other", number>; total: number; freeGb: number | null };

/** Total size (bytes) of the files under `dir` (recursive, symlinks not followed). Missing dir = 0. */
export function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* vanished meanwhile */ }
  }
  return total;
}

/**
 * Where the clips are on Krew's PC, from the compose env (CLIP_STORAGE_DIR passed through as CLIP_STORAGE_HOST_DIR;
 * empty = the default clip-factory/storage folder next to docker-compose.yml). Null outside Docker.
 */
export function hostStorageDir(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CLIP_STORAGE_HOST_DIR == null) return null;
  return env.CLIP_STORAGE_HOST_DIR.trim() || "clip-factory/storage (the default)";
}

export async function storageUsage(): Promise<StorageUsage> {
  const dir = storageDir();
  const byKind = { raw: 0, final: 0, edits: 0, work: 0, other: 0 };
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* not created yet */ }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const size = e.isDirectory() ? dirSize(p) : e.isFile() ? (() => { try { return fs.statSync(p).size; } catch { return 0; } })() : 0;
    if ((STORAGE_KINDS as readonly string[]).includes(e.name)) byKind[e.name as keyof typeof byKind] += size;
    else byKind.other += size;
  }
  const total = Object.values(byKind).reduce((a, x) => a + x, 0);
  return { dir, hostDir: hostStorageDir(), byKind, total, freeGb: await freeGb(dir).catch(() => null) };
}

/** The Settings → Storage form → Settings fields (whole numbers, clamped to sane ranges; missing/bad = the default). */
export function parseRetentionForm(form: { get(k: string): unknown }) {
  const n = (k: string, min: number, max: number, def: number) => {
    const raw = form.get(k);
    const v = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : def;
  };
  return {
    retainRejectedHrs: n("retainRejectedHrs", 1, 24 * 30, 6),
    retainPendingHrs: n("retainPendingHrs", 1, 24 * 30, 48),
    retainApprovedDays: n("retainApprovedDays", 1, 90, 5),
    retainPostedDays: n("retainPostedDays", 1, 90, 3),
    retainRawHrs: n("retainRawHrs", 1, 24 * 7, 6),
    retainRowsDays: n("retainRowsDays", 1, 365, 7),
  };
}

/** 1536 → "1.5 KB", 5.2e9 → "4.8 GB". */
export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? x : x < 10 ? x.toFixed(1) : Math.round(x)} ${u[i]}`;
}
