import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseChangelog, getChangelog, getVersion } from "../src/lib/version";

const file = path.join(__dirname, "..", "CHANGELOG.md");

test("parseChangelog reads headings, dates and bullets in order", () => {
  const text = [
    "# Clip Factory patch notes",
    "",
    "## 2.1.0 — 2026-12-01",
    "- First note.",
    "- Second note",
    "  that wraps.",
    "",
    "## 2.0.0 - 2026-11-30",
    "* Star bullet.",
    "",
    "## 1.9.9",
    "- No date.",
  ].join("\r\n");
  assert.deepEqual(parseChangelog(text), [
    { version: "2.1.0", date: "2026-12-01", notes: ["First note.", "Second note that wraps."] },
    { version: "2.0.0", date: "2026-11-30", notes: ["Star bullet."] },
    { version: "1.9.9", date: "", notes: ["No date."] },
  ]);
  assert.deepEqual(parseChangelog("no entries here"), []);
});

test("getVersion is the first entry of CHANGELOG.md", () => {
  const entries = getChangelog();
  assert.ok(entries.length >= 7);
  assert.equal(getVersion(), entries[0].version);
  // Same rule the tray, start.ps1 and the setup file use: the first line starting with "## " plus x.y.z.
  const firstHeading = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("## "));
  assert.equal(/^## (\d+\.\d+\.\d+)/.exec(firstHeading ?? "")?.[1], getVersion());
});

test("CHANGELOG.md: newest first, dated, 3-6 plain-ASCII bullets per entry", () => {
  const entries = getChangelog();
  const num = (v: string) => v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `${e.version}: date`);
    assert.ok(e.notes.length >= 3 && e.notes.length <= 6, `${e.version}: ${e.notes.length} notes`);
    // start.ps1 prints the notes in a Windows console; keep them ASCII so they never show as garbage.
    for (const n of e.notes) assert.ok(/^[\x20-\x7e]+$/.test(n), `${e.version}: non-ASCII note "${n}"`);
    if (i > 0) assert.ok(num(e.version) < num(entries[i - 1].version), `${e.version} must be older than ${entries[i - 1].version}`);
  }
});
