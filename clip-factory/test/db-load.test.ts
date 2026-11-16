// PLAN step 5: web + worker write the same SQLite file at once. Two processes x 300 interleaved writes
// (creates, updates, batched and interactive transactions) must finish with no "database is locked".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfdb-"));
const env = { ...process.env, DATABASE_URL: `file:${path.join(dir, "load.db")}` };
const child = path.join(__dirname, "db-load-child.ts");

before(() => {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env, stdio: "ignore" });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function runChild(tag: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", child, tag], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("2 processes x 300 interleaved writes: no 'database is locked', WAL on", { timeout: 120_000 }, async () => {
  const [a, b] = await Promise.all([runChild("web"), runChild("worker")]);
  for (const r of [a, b]) {
    assert.doesNotMatch(r.out, /database is locked|SQLITE_BUSY|Socket timeout/i, r.out);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /300 writes ok/);
  }
  const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const [{ journal_mode }] = await db.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
    assert.equal(journal_mode, "wal"); // persisted in the file, so every later connection gets it
    assert.equal(await db.streamer.count(), 2 * 120); // each child creates 60 plain + 60 in a transaction
  } finally {
    await db.$disconnect();
  }
});
