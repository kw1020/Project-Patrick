import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { parseEnvFile, ytDlpAgeDays } from "../scripts/doctor";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfdoc-"));
let mock: Mock;
let env: NodeJS.ProcessEnv;

before(async () => {
  mock = await startMocks();
  env = { ...process.env, ...mockEnv(mock.url), DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage") };
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env, stdio: "ignore" });
  // One expired YouTube channel + one TikTok account, so the doctor has tokens to refresh.
  process.env.DATABASE_URL = env.DATABASE_URL;
  const { prisma } = await import("../src/lib/db");
  await prisma.account.create({ data: { platform: "youtube", channelId: "UCmock", channelTitle: "Krew Clips", refreshToken: "1//old", accessToken: "old", expiresAt: new Date(0) } });
  await prisma.account.create({ data: { platform: "tiktok", channelId: "open-123", channelTitle: "@krewclips", refreshToken: "rft.old", accessToken: "act.valid", expiresAt: new Date(Date.now() + 3600_000) } });
  await prisma.$disconnect();
});
after(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor: yt-dlp version age", () => {
  const now = new Date("2026-11-16T15:00:00Z");
  assert.equal(ytDlpAgeDays("2026.11.16", now), 0);
  assert.equal(ytDlpAgeDays("2026.11.03\n", now), 13);
  assert.equal(ytDlpAgeDays("2026.10.26", now), 21);
  assert.equal(ytDlpAgeDays("2026.11.01.1", now), 15);
  assert.equal(ytDlpAgeDays("2026.11.10.232215", now), 6); // nightly
  assert.equal(ytDlpAgeDays("2025.12.31", now), 320);
  assert.equal(ytDlpAgeDays("unknown", now), null);
});

test("doctor: .env parser handles comments, quotes and blanks", () => {
  const e = parseEnvFile([
    "# comment", "", "TWITCH_CLIENT_ID=abc123", "ANTHROPIC_API_KEY=        # Judge (scores clips)",
    'QUOTED="has # hash"', "SINGLE='x y'", "export EXPORTED=1", "URL=file:./dev.db", "not a line",
  ].join("\n"));
  assert.deepEqual(e, { TWITCH_CLIENT_ID: "abc123", ANTHROPIC_API_KEY: "", QUOTED: "has # hash", SINGLE: "x y", EXPORTED: "1", URL: "file:./dev.db" });
});

test("doctor: full run against the stand-ins (--no-download)", { timeout: 120_000 }, async () => {
  const child = spawn("npx", ["tsx", "scripts/doctor.ts", "--no-download"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  const fails = out.split("\n").filter((l) => l.startsWith("❌"));
  assert.deepEqual(fails, [], out);
  assert.equal(code, 0, out);
  for (const re of [/^✅ Twitch keys/m, /^✅ Twitch login \+ GTA 6 category — token OK, GTA 6 category id 1234567/m,
    /^✅ Live GTA 6 streams — 2 live/m, /^✅ Redis/m, /^✅ Database/m, /^✅ Judge — .*8\.4\/10/m, /^✅ ffmpeg/m]) assert.match(out, re, out);
  assert.match(out, /^⚠️ +Approved streamers — 0 approved/m);
  assert.match(out, /Streamers page/);
  assert.match(out, /^⚠️ +Download \+ render — skipped/m);
  assert.match(out, /^✅ YouTube API key — key works \(trending #1 in US: "I survived 100 days in GTA 6"\)/m);
  assert.ok(mock.requests.some((r) => r.path.includes("chart=mostPopular") && r.path.includes("key=mock-yt-key")), "one mostPopular call with the key");
  assert.match(out, /^✅ YouTube: Krew Clips — sign-in refreshed/m);
  assert.match(out, /^✅ TikTok: @krewclips — sign-in refreshed/m);
  assert.ok(mock.requests.some((r) => r.path.startsWith("/oauth2/token")), "used the Twitch token endpoint");
  assert.equal(mock.refreshCount, 1, "TikTok token was refreshed even though the saved one hadn't expired");
  const { prisma } = await import("../src/lib/db");
  assert.equal((await prisma.account.findFirstOrThrow({ where: { platform: "tiktok" } })).refreshToken, "rft.mock1", "rotated refresh token saved");
  await prisma.$disconnect();
});
