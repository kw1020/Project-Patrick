import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One entry of CHANGELOG.md: `## 1.6.0 — 2026-11-17` followed by `- note` bullets. */
export type ChangelogEntry = { version: string; date: string; notes: string[] };

const CHANGELOG_FILE = "CHANGELOG.md";
const HEADING = /^##\s+(\d+\.\d+\.\d+)\s*(?:[—–-]+\s*(\S.*?))?\s*$/;

/** Parse CHANGELOG.md text into entries, in file order (newest first). Bullet lines may wrap onto indented lines. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = HEADING.exec(line);
    if (h) {
      cur = { version: h[1], date: h[2] ?? "", notes: [] };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^#/.test(line)) { cur = null; continue; }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) { cur.notes.push(b[1].trim()); continue; }
    if (line.trim() && /^\s+/.test(line) && cur.notes.length) {
      cur.notes[cur.notes.length - 1] += " " + line.trim();
    }
  }
  return entries;
}

function readChangelogFile(): string | null {
  const candidates = [path.join(process.cwd(), CHANGELOG_FILE)];
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", CHANGELOG_FILE));
  } catch {
    /* import.meta.url unavailable */
  }
  if (typeof __dirname === "string") candidates.push(path.resolve(__dirname, "../..", CHANGELOG_FILE));
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      /* try the next location */
    }
  }
  return null;
}

let cached: ChangelogEntry[] | null = null;

/** All patch notes, newest first. Empty when CHANGELOG.md can't be found (never throws). */
export function getChangelog(): ChangelogEntry[] {
  if (cached) return cached;
  const text = readChangelogFile();
  const entries = text ? parseChangelog(text) : [];
  if (entries.length) cached = entries;
  return entries;
}

/** The current version, e.g. "1.6.0" (the first entry of CHANGELOG.md), or "0.0.0" if it can't be read. */
export function getVersion(): string {
  return getChangelog()[0]?.version ?? "0.0.0";
}
