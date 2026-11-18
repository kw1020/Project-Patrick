import { prisma } from "../lib/db";

/**
 * v1.8.0 one-time move of existing installs to the new defaults (Krew: "too focused on GTA 6, it needs to be any game"):
 * gameMode gta6 -> any, lookback 24h -> 7 days, max clip length 45s -> 35s. Only values still on the OLD default are
 * changed, and `migratedAnyGame` makes it run once, so a later manual change in Settings (e.g. back to GTA 6) sticks.
 */
export async function migrateV180Settings(): Promise<string | null> {
  const s = await prisma.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
  if (s.migratedAnyGame) return null;
  const changes: Record<string, string | number> = {};
  if (s.gameMode === "gta6") changes.gameMode = "any";
  if (s.clipLookbackHrs === 24) changes.clipLookbackHrs = 168;
  if (s.clipMaxSec === 45) changes.clipMaxSec = Math.max(35, s.clipMinSec);
  await prisma.settings.update({ where: { id: "main" }, data: { ...changes, migratedAnyGame: true } });
  return Object.keys(changes).length ? `settings moved to v1.8.0 defaults: ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")}` : "settings already on v1.8.0 defaults";
}

/**
 * v1.9.0 one-time move to the new Auto layout (Krew: "streamer's camera up and game down, or full streamer cam if it's funny").
 * Only an install still on the old default "blur" moves to "auto"; "facecam" (= split) etc. are left alone. `migratedAutoLayout`
 * makes it run once, so choosing Blur again in Settings afterwards sticks.
 */
export async function migrateV190Settings(): Promise<string | null> {
  const s = await prisma.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
  if (s.migratedAutoLayout) return null;
  const moved = s.layout === "blur";
  await prisma.settings.update({ where: { id: "main" }, data: { ...(moved ? { layout: "auto" } : {}), migratedAutoLayout: true } });
  return moved ? "layout moved to auto (v1.9.0)" : `layout kept (${s.layout})`;
}
