import path from "node:path";
import fs from "node:fs";

// All clip files live under STORAGE_DIR. The DB stores paths RELATIVE to it
// (e.g. "final/abc.mp4") so the web and worker containers agree.
export function storageDir() {
  return path.resolve(process.env.STORAGE_DIR || "./storage");
}
export function storagePath(...parts: string[]) {
  return path.join(storageDir(), ...parts);
}
export function ensureStorage() {
  for (const d of ["raw", "final", "work", "edits"]) fs.mkdirSync(storagePath(d), { recursive: true });
}
/** Resolve a DB-stored relative path, refusing anything that escapes STORAGE_DIR. */
export function resolveStored(rel: string) {
  const root = storageDir();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error("path escapes storage dir");
  return abs;
}
