import fs from "node:fs";
import { prisma } from "./db";

// Launch-day guards (see CLAUDE.md "Launch-day load"): cap the backlog, pause grabbing when the disk fills up.

function envNum(name: string, fallback: number) {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export const maxBacklog = () => envNum("MAX_BACKLOG", 12);
export const minFreeGb = () => envNum("MIN_FREE_GB", 5);

/** How many more clips the line can take right now (MAX_BACKLOG − clips in "processing", never below 0). */
export async function backlogRoom(): Promise<number> {
  const processing = await prisma.clip.count({ where: { status: "processing" } });
  return Math.max(0, maxBacklog() - processing);
}

async function statfsFreeGb(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
}
let freeGbFn: (dir: string) => Promise<number> = statfsFreeGb;
/** Free space (GB) available to us on the disk holding `dir`. */
export function freeGb(dir: string): Promise<number> {
  return freeGbFn(dir);
}
/** Tests: swap the free-space lookup. Call with no argument to restore the real one. */
export function setFreeGbFn(fn?: (dir: string) => Promise<number>) {
  freeGbFn = fn ?? statfsFreeGb;
}
