import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PLAN step 4: backlog cap, disk guard, retention.
const GTA = "gta6-id";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-guards-"));
const storage = path.join(dir, "storage");
const realFetch = globalThis.fetch;
const H = 3600_000;

before(async () => {
  // Fake yt-dlp: writes the file named by -o (with %(ext)s → mp4) and prints its path, like --print after_move:filepath.
  const fake = path.join(dir, "fake-ytdlp.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1].replace("%(ext)s", "mp4");
require("fs").writeFileSync(o, "video"); console.log(o);
`);
  fs.chmodSync(fake, 0o755);
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage,
    REDIS_URL: "redis://localhost:6379/7", // own Redis db: don't touch other tests' queues
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: GTA,
    MAX_BACKLOG: "12", MIN_FREE_GB: "5", YTDLP: fake,
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const { ensureStorage } = await import("../src/lib/paths");
  ensureStorage();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  (await import("../src/lib/guards")).setFreeGbFn();
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function streamer(login: string) {
  const { prisma } = await import("../src/lib/db");
  return prisma.streamer.upsert({ where: { twitchId: "t-" + login }, update: {}, create: { twitchId: "t-" + login, login, name: login.toUpperCase(), approved: true } });
}
async function clip(login: string, data: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  const s = await streamer(login);
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", sourceUrl: "https://clips.twitch.tv/x" } });
  return prisma.clip.create({ data: { momentId: m.id, title: "T", caption: "c", ...data } });
}
async function clearClips() {
  const { prisma } = await import("../src/lib/db");
  await prisma.moment.deleteMany({});
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
/** Twitch: token + /clips returning `n` GTA clips for the approved streamer, views n..1. */
function stubTwitch(broadcaster: string, n: number) {
  const clips = Array.from({ length: n }, (_, i) => ({
    id: `clip-${i}`, url: `https://clips.twitch.tv/c${i}`, broadcaster_id: broadcaster, broadcaster_name: "B", creator_name: "x",
    video_id: "", game_id: GTA, title: `clip ${i}`, view_count: 1000 - i, created_at: new Date(Date.now() - (i + 1) * 120_000).toISOString(), // 2 min apart: separate moments
    thumbnail_url: "", duration: 30, vod_offset: null,
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (url.pathname.endsWith("/clips")) return json({ data: clips, pagination: {} });
    return json({ data: [] });
  }) as typeof fetch;
}

test("backlogRoom: MAX_BACKLOG minus processing clips, never below 0", async () => {
  await clearClips();
  const { backlogRoom } = await import("../src/lib/guards");
  assert.equal(await backlogRoom(), 12);
  for (let i = 0; i < 5; i++) await clip("bk", { status: "processing", stage: "cut" });
  await clip("bk", { status: "pending" });
  assert.equal(await backlogRoom(), 7);
  process.env.MAX_BACKLOG = "3";
  assert.equal(await backlogRoom(), 0);
  process.env.MAX_BACKLOG = "12";
});

test("clips poller: line full (12 processing) → adds 0; room for 2 → adds the 2 most-viewed", async () => {
  await clearClips();
  const { prisma } = await import("../src/lib/db");
  const { runClipsPoll } = await import("../src/workers/clips");
  const s = await streamer("polly");
  // Near-equal views: relax the v1.8.0 standout + per-creator rules, this test is about the backlog cap.
  await prisma.settings.upsert({ where: { id: "main" }, update: { standoutMin: 0.5, maxPerCreatorPerRun: 15 }, create: { id: "main", standoutMin: 0.5, maxPerCreatorPerRun: 15 } });
  for (let i = 0; i < 12; i++) await clip("polly", { status: "processing", stage: "grab" });
  stubTwitch(s.twitchId, 5);

  const msg = await runClipsPoll();
  assert.match(msg, /picked 0 standout clips/);
  assert.match(msg, /full/);
  assert.equal(await prisma.moment.count({ where: { source: "twitch_clip", twitchClipId: { not: null } } }), 0);

  // Two clips finish → room for two.
  const two = await prisma.clip.findMany({ where: { status: "processing" }, take: 2 });
  await prisma.clip.updateMany({ where: { id: { in: two.map((c) => c.id) } }, data: { status: "pending", stage: null } });
  assert.match(await runClipsPoll(), /picked 2 standout clips from 1 creator · .*line has room for 2, rest next scan/);
  const added = await prisma.moment.findMany({ where: { twitchClipId: { not: null } }, orderBy: { sourceViews: "desc" } });
  assert.deepEqual(added.map((m) => m.twitchClipId), ["clip-0", "clip-1"]);
});

test("spike detector: line full → skipped without using the cooldown", async () => {
  await clearClips();
  const { prisma } = await import("../src/lib/db");
  const { runSpikeCheck } = await import("../src/workers/spike");
  const s = await streamer("spiky");
  await prisma.streamer.update({ where: { id: s.id }, data: { isLive: true, liveSince: new Date(Date.now() - H) } });
  for (let i = 0; i < 12; i++) await clip("spiky", { status: "processing", stage: "grab" });
  const sp = { kind: "volume", ratio: 4, baseline: 1, chatters: 30, hype: 0 };
  const chat = { spike: () => sp, samples: () => [] } as any;

  const now = Date.now();
  const msg = await runSpikeCheck(chat, now, async () => "vod-1");
  assert.match(msg!, /line is full, skipped/);
  assert.equal(await prisma.moment.count({ where: { source: "chat" } }), 0);

  // Room frees up a few seconds later: the same streamer is not on cooldown.
  await prisma.clip.updateMany({ where: { status: "processing" }, data: { status: "pending", stage: null } });
  const msg2 = await runSpikeCheck(chat, now + 5_000, async () => "vod-1");
  assert.match(msg2!, /chat spike/);
  assert.equal(await prisma.moment.count({ where: { source: "chat" } }), 1);
  await prisma.streamer.update({ where: { id: s.id }, data: { isLive: false } });
});

test("grabber: low disk re-queues the grab in 5 min (clip stays processing); enough disk downloads", async () => {
  await clearClips();
  const { prisma } = await import("../src/lib/db");
  const { setFreeGbFn } = await import("../src/lib/guards");
  const { queue, getStatuses } = await import("../src/lib/queues");
  const { runGrab } = await import("../src/workers/grabber");
  const c = await clip("grabby", { status: "processing", stage: "grab" });

  setFreeGbFn(async () => 2.4);
  const msg = await runGrab(c.id);
  assert.match(msg, /low disk/);
  const job = (await queue("grab").getDelayed()).find((j) => j.data.clipId === c.id);
  assert.ok(job, "a delayed grab job exists");
  assert.equal(job.opts.delay, 5 * 60_000);
  assert.equal(job.data.momentId, c.momentId);
  await job.remove();
  let row = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.status, "processing");
  assert.equal(row.stage, "grab");
  assert.equal(row.rawPath, null);
  let disk = (await getStatuses()).disk;
  assert.equal(disk.ok, false);
  assert.match(disk.msg, /2\.4 GB free — grabbing paused below 5 GB/);

  setFreeGbFn(async () => 50);
  assert.match(await runGrab(c.id), /downloaded raw\//);
  row = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.rawPath, `raw/${c.id}.mp4`);
  assert.equal(row.stage, "transcribe");
  assert.ok(fs.existsSync(path.join(storage, row.rawPath)));
  disk = (await getStatuses()).disk;
  assert.equal(disk.ok, true, "disk status recovers");
});

test("retention deletes the right files only and clears their DB paths", async () => {
  await clearClips();
  const { prisma } = await import("../src/lib/db");
  const { runRetention } = await import("../src/workers/retention");
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * H);
  const MB = 1024 * 1024;

  async function make(name: string, status: string, hoursAgo: number, files: { raw?: boolean; final?: boolean }) {
    const c = await clip("ret-" + name, { status, duration: 30 });
    const data: Record<string, string> = {};
    if (files.raw) { fs.writeFileSync(path.join(storage, `raw/${c.id}.mp4`), Buffer.alloc(MB)); data.rawPath = `raw/${c.id}.mp4`; }
    if (files.final) { fs.writeFileSync(path.join(storage, `final/${c.id}.mp4`), Buffer.alloc(MB)); data.finalPath = `final/${c.id}.mp4`; }
    await prisma.clip.update({ where: { id: c.id }, data });
    // updatedAt is @updatedAt; backdate it with raw SQL.
    await prisma.$executeRaw`UPDATE Clip SET updatedAt = ${ago(hoursAgo)} WHERE id = ${c.id}`;
    return c.id;
  }
  const oldCut = await make("oldcut", "pending", 13, { raw: true, final: true });      // raw yes, final no (pending)
  const freshCut = await make("freshcut", "pending", 2, { raw: true, final: true });   // nothing
  const rejectedOld = await make("rejold", "rejected", 25, { final: true });          // final yes
  const rejectedNew = await make("rejnew", "rejected", 10, { final: true });          // nothing
  const pendingOld = await make("pendold", "pending", 30 * 24, { final: true });      // never
  const approvedOld = await make("approld", "approved", 30 * 24, { final: true });    // never
  const posted3d = await make("p3", "posted", 3 * 24, { final: true });               // no
  const posted8d = await make("p8", "posted", 8 * 24, { final: true });               // yes
  const processing = await make("proc", "processing", 48, { raw: true });             // never

  const orphanOld = path.join(storage, "raw/orphan-old.mp4");
  const orphanNew = path.join(storage, "raw/orphan-new.mp4");
  const workOld = path.join(storage, "work/old.wav");
  for (const f of [orphanOld, orphanNew, workOld]) fs.writeFileSync(f, Buffer.alloc(MB));
  for (const f of [orphanOld, workOld]) fs.utimesSync(f, ago(25), ago(25));

  const msg = await runRetention(now);
  assert.match(msg, /1 raw, 2 final, 2 orphan files · 5\.0 MB freed/);

  const get = (id: string) => prisma.clip.findUniqueOrThrow({ where: { id } });
  const exists = (rel: string) => fs.existsSync(path.join(storage, rel));

  let c = await get(oldCut);
  assert.equal(c.rawPath, null); assert.ok(!exists(`raw/${oldCut}.mp4`));
  assert.equal(c.finalPath, `final/${oldCut}.mp4`); assert.ok(exists(c.finalPath!));
  c = await get(freshCut);
  assert.ok(c.rawPath && exists(c.rawPath)); assert.ok(c.finalPath && exists(c.finalPath));
  c = await get(rejectedOld);
  assert.equal(c.finalPath, null); assert.ok(!exists(`final/${rejectedOld}.mp4`));
  for (const id of [rejectedNew, pendingOld, approvedOld, posted3d]) {
    c = await get(id);
    assert.ok(c.finalPath && exists(c.finalPath), `${c.status} final kept`);
  }
  c = await get(posted8d);
  assert.equal(c.finalPath, null); assert.ok(!exists(`final/${posted8d}.mp4`));
  c = await get(processing);
  assert.ok(c.rawPath && exists(c.rawPath), "processing raw kept");

  assert.ok(!fs.existsSync(orphanOld));
  assert.ok(fs.existsSync(orphanNew));
  assert.ok(!fs.existsSync(workOld));
});

test("sweepStuck: an idle processing clip with no job is failed; one with a delayed job is left alone", async () => {
  const { prisma } = await import("../src/lib/db");
  const { sweepStuck } = await import("../src/workers/retention");
  const { queue } = await import("../src/lib/queues");
  const s = await prisma.streamer.create({ data: { twitchId: "t-sweep", login: "sweeper", name: "Sweeper", approved: true } });
  const mk = async () => {
    const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip" } });
    return prisma.clip.create({ data: { momentId: m.id, status: "processing", stage: "grab" } });
  };
  const lost = await mk(), waiting = await mk();
  await queue("grab").add("grab", { clipId: waiting.id }, { jobId: `sweep-test-${waiting.id}`, delay: 600_000 });
  const later = Date.now() + 11 * 60_000;
  assert.ok((await sweepStuck(later)) >= 1); // other tests in this file may leave stale clips too
  assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: lost.id } })).status, "failed");
  assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: waiting.id } })).status, "processing");
  await (await queue("grab").getJob(`sweep-test-${waiting.id}`))?.remove();
  await prisma.clip.deleteMany({ where: { id: { in: [lost.id, waiting.id] } } });
});
