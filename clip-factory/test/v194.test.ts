import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickFrameTimes } from "../src/lib/frames";
import { calibrationNudge, scoreHistogram, scoreSummary, stdDev } from "../src/lib/judge-stats";
import { avgCostCents, costCents } from "../src/lib/pricing";
import { judgeContent } from "../src/lib/judge";
import { parseQueueParams, queueWhere, QUEUE_TABS } from "../src/lib/queue-filter";
import { fmtBytes, hostStorageDir, parseRetentionForm } from "../src/lib/storage";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV191Schema } from "./schema-v173";

// v1.9.4: the Judge looks at frames + uses the full range; auto-delete of clips nobody uses; storage on another drive.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v194-"));
const storage = path.join(dir, "storage");
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const H = 3600_000, D = 24 * H;
let mock: Mock;

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, WHISPER_ENGINE: "off", FINDER_GATE: "off", // v1.9.8 gate tested in v198
    REDIS_URL: "redis://localhost:6379/5", // own Redis db: don't touch other tests' queues
    MIN_FREE_GB: "5", MAX_BACKLOG: "12",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  await (await import("../src/lib/queues")).redis().flushdb();
});
afterEach(async () => {
  (await import("../src/lib/guards")).setFreeGbFn(async () => 500); // plenty of room unless a test says otherwise
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- A. frames ----------
test("pickFrameTimes: 8 distinct times inside the window, 2 in the first 3s, 3 around the payoff, the rest spread", () => {
  const t = pickFrameTimes({ start: 20, end: 48, payoffAt: 40 });
  assert.equal(t.length, 8);
  assert.deepEqual(t, [...t].sort((a, b) => a - b));
  assert.ok(t.every((x) => x >= 20 && x <= 47.9), JSON.stringify(t));
  assert.equal(t.filter((x) => x < 23).length, 2, `two in the first 3s: ${t}`);
  for (const p of [38, 40, 42]) assert.ok(t.includes(p), `payoff frame ${p}: ${t}`);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 0.4, `distinct: ${t}`);
  // the spread fills the long gap between the hook and the payoff
  assert.ok(t.some((x) => x > 26 && x < 34), `${t}`);
  assert.ok(t.some((x) => x > 43), `after the reaction too: ${t}`);
  // no payoff (or one outside the window) → 60% of the way in
  const n = pickFrameTimes({ start: 0, end: 30, payoffAt: null });
  for (const p of [16, 18, 20]) assert.ok(n.includes(p), `${n}`);
  assert.deepEqual(pickFrameTimes({ start: 0, end: 30, payoffAt: 99 }), n);
  // the source may end before the window's end
  assert.ok(pickFrameTimes({ start: 0, end: 30, payoffAt: 10, sourceLength: 20 }).every((x) => x <= 19.9));
  // a tiny window still gives distinct frames, never more than fit
  const tiny = pickFrameTimes({ start: 5, end: 7, payoffAt: 6 });
  assert.ok(tiny.length >= 4 && tiny.length <= 8, `${tiny}`);
  assert.equal(new Set(tiny).size, tiny.length);
});

test("judgeContent: text only = a plain string; with frames = '[frame at Xs]' + jpeg image per frame, then the text", () => {
  const base = { streamer: "Kai", durationSec: 20, source: "twitch_clip" as const, transcript: "x", minScore: 6 };
  assert.equal(typeof judgeContent(base), "string");
  const failed = judgeContent({ ...base, framesFailed: true }) as string;
  assert.match(failed, /No frames could be taken from this clip/);
  const blocks = judgeContent({ ...base, frames: [{ at: 3.25, data: "AAAA" }, { at: 31.2, data: "BBBB" }], calibration: "Your recent scores have been very similar (mostly 6). Use the full range." }) as { type: string; text?: string; source?: unknown }[];
  assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text", "image", "text"]);
  assert.equal(blocks[0].text, "[frame at 3.3s]");
  assert.equal(blocks[2].text, "[frame at 31.2s]");
  assert.deepEqual(blocks[1].source, { type: "base64", media_type: "image/jpeg", data: "AAAA" });
  assert.match(blocks[4].text!, /The 2 images above are stills from the source/);
  assert.match(blocks[4].text!, /Use the full range\.$/);
});

test("Judge schema: observations comes before score; the prompt has the anchored rubric and no '6 when thin'", async () => {
  const { VerdictSchema, JUDGE_SYSTEM } = await import("../src/lib/judge");
  const keys = Object.keys(VerdictSchema.shape);
  assert.equal(keys[0], "observations");
  assert.ok(keys.indexOf("observations") < keys.indexOf("score"));
  assert.ok(JUDGE_SYSTEM.startsWith("You score short clips from streamers and YouTubers"));
  for (const re of [/1–3: nothing happens/, /4–5: mildly interesting but no payoff/, /6: decent but forgettable/, /7: a clear moment a fan would enjoy/,
    /8: a strong moment a stranger would watch to the end/, /9–10: rare, instantly shareable/, /6 is not a safe default/, /Most raw clips are NOT good/,
    /frames/, /observations/]) assert.match(JUDGE_SYSTEM, re);
  assert.doesNotMatch(JUDGE_SYSTEM, /Thin evidence either way: 5–6/);
  assert.doesNotMatch(JUDGE_SYSTEM, /You can't see or hear the clip/);
});

async function makeSource(file: string, secs = 20) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${secs}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
}

async function judgedClip(rawRel: string, extra: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  const s = await prisma.streamer.upsert({ where: { twitchId: "t-kai" }, update: {}, create: { twitchId: "t-kai", login: "kai", name: "Kai", approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", sourceViews: 900 } });
  return prisma.clip.create({ data: {
    momentId: m.id, rawPath: rawRel, status: "processing", stage: "judge", title: "t", caption: "c",
    winStart: 2, winLength: 15, duration: 15, payoffAt: 12, wordsFull: true, words: "[]", ...extra,
  } });
}
const lastJudgeRequest = () => JSON.parse([...mock.requests].reverse().find((r) => r.path.startsWith("/v1/messages"))!.body.toString());

test("runJudge: 8 frames from the raw source go to Claude before the text; observations + tokens saved; effort medium", { timeout: 120_000 }, async () => {
  const { prisma } = await import("../src/lib/db");
  const { runJudge } = await import("../src/workers/judge");
  await makeSource(path.join(storage, "raw", "j1.mp4"));
  const c = await judgedClip("raw/j1.mp4");
  const msg = await runJudge(c.id);
  assert.match(msg, /8\.4\/10 .*saw 8 frames/);
  const req = lastJudgeRequest();
  assert.equal(req.output_config.effort, "medium");
  assert.equal(req.fallbacks, "default"); // server-side fallback kept
  const blocks = req.messages[0].content as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
  assert.equal(blocks.length, 17);
  const labels = blocks.filter((_, i) => i % 2 === 0 && i < 16).map((b) => b.text);
  assert.ok(labels.every((l) => /^\[frame at \d+\.\ds\]$/.test(l!)), JSON.stringify(labels));
  const times = labels.map((l) => Number(l!.match(/[\d.]+/)![0]));
  assert.deepEqual(times, pickFrameTimes({ start: 2, end: 17, payoffAt: 12, sourceLength: 20 }));
  for (const img of blocks.filter((b) => b.type === "image")) {
    assert.equal(img.source!.media_type, "image/jpeg");
    const buf = Buffer.from(img.source!.data, "base64");
    assert.equal(buf.subarray(0, 2).toString("hex"), "ffd8", "a JPEG");
    assert.ok(buf.length < 80_000, `small (${buf.length} bytes)`);
  }
  // 640 wide
  const first = Buffer.from(blocks[1].source!.data, "base64");
  const probe = path.join(dir, "f.jpg");
  fs.writeFileSync(probe, first);
  assert.equal(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", probe], { encoding: "utf8" }).trim(), "640");
  assert.equal(blocks.at(-1)!.type, "text");
  assert.match(blocks.at(-1)!.text!, /The 8 images above are stills/);
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(clip.judgeObservations, "He drives off the bridge and lands on a moving truck; he screams and chat explodes.");
  assert.equal(clip.judgeFrames, 8);
  assert.equal(clip.judgeTokensIn, 1200 + 8 * 330 + 1500);
  assert.equal(clip.judgeTokensOut, 400);
  assert.equal(fs.readdirSync(path.join(storage, "work")).filter((f) => f.includes("-judge-")).length, 0, "frame files cleaned up");
});

test("runJudge: when ffmpeg can't take frames the clip is still judged, text only", { timeout: 60_000 }, async () => {
  const { prisma } = await import("../src/lib/db");
  const { runJudge } = await import("../src/workers/judge");
  fs.writeFileSync(path.join(storage, "raw", "broken.mp4"), "this is not a video");
  const c = await judgedClip("raw/broken.mp4");
  const msg = await runJudge(c.id);
  assert.match(msg, /8\.4\/10 .*text only: no frames/);
  const req = lastJudgeRequest();
  assert.equal(typeof req.messages[0].content, "string");
  assert.match(req.messages[0].content, /No frames could be taken from this clip/);
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(clip.score, 8.4);
  assert.equal(clip.stage, "cut");
  assert.equal(clip.judgeFrames, 0);
});

// ---------- A4. calibration ----------
test("calibration: the nudge only fires when 10+ recent scores barely vary", () => {
  assert.equal(calibrationNudge([6, 6, 6]), null, "too few");
  assert.equal(calibrationNudge(Array(12).fill(6)), "Your recent scores have been very similar (mostly 6). Use the full range.");
  assert.equal(calibrationNudge([6, 6.5, 5.5, 6, 6, 6, 5.5, 6.5, 6, 6, 6]), "Your recent scores have been very similar (mostly 6). Use the full range.");
  assert.equal(calibrationNudge([2, 9, 4, 7, 3, 8, 5, 6, 2, 9]), null);
  assert.ok(stdDev([6, 6, 6]) === 0 && Math.abs(stdDev([2, 4]) - 1) < 1e-9);
  // only the last 30 count
  assert.equal(calibrationNudge([...Array(30).fill(5), 1, 10, 1, 10]), "Your recent scores have been very similar (mostly 5). Use the full range.");
});

test("calibration: runJudge adds the nudge line when the last scores in Redis are all ~6, and records each score", { timeout: 60_000 }, async () => {
  const { redis } = await import("../src/lib/queues");
  const { runJudge, RECENT_SCORES_KEY, recentScores } = await import("../src/workers/judge");
  await redis().del(RECENT_SCORES_KEY);
  for (let i = 0; i < 15; i++) await redis().lpush(RECENT_SCORES_KEY, "6");
  process.env.JUDGE_FRAMES = "off";
  try {
    const a = await judgedClip(null as unknown as string, { rawPath: null });
    assert.match(await runJudge(a.id), /nudged/);
    assert.match(lastJudgeRequest().messages[0].content, /Your recent scores have been very similar \(mostly 6\)\. Use the full range\./);
    assert.equal((await recentScores())[0], 8.4, "newest first");
    await redis().del(RECENT_SCORES_KEY);
    for (const x of [2, 9, 4, 7, 3, 8, 5, 6, 2, 9]) await redis().lpush(RECENT_SCORES_KEY, String(x));
    const b = await judgedClip(null as unknown as string, { rawPath: null });
    assert.doesNotMatch(await runJudge(b.id), /nudged/);
    assert.doesNotMatch(lastJudgeRequest().messages[0].content, /very similar/);
  } finally { delete process.env.JUDGE_FRAMES; }
});

test("score histogram + summary (Analytics / Live page) and cost per clip (Settings)", () => {
  assert.deepEqual(scoreHistogram([1, 2.4, 2.6, 6, 6.2, 10, 11, 0]), [2, 1, 1, 0, 0, 2, 0, 0, 0, 2]);
  assert.equal(scoreSummary([2, 9, 5.2])!.text, "last 3 clips scored avg 5.4, range 2–9");
  assert.equal(scoreSummary([]), null);
  assert.equal(costCents(1_000_000, 0), 200);
  assert.equal(costCents(0, 1_000_000), 1000);
  assert.ok(Math.abs(costCents(5340, 400) - 1.468) < 1e-9);
  assert.equal(avgCostCents([{ judgeTokensIn: 1_000_000, judgeTokensOut: 0 }, { judgeTokensIn: null, judgeTokensOut: null }, { judgeTokensIn: 0, judgeTokensOut: 100_000 }]), 150);
  assert.equal(avgCostCents([]), null);
});

// ---------- B. retention ----------
const MB = 1024 * 1024;
async function resetClips() {
  const { prisma } = await import("../src/lib/db");
  await prisma.post.deleteMany({});
  await prisma.clip.deleteMany({});
  await prisma.moment.deleteMany({});
  await prisma.settings.deleteMany({});
  for (const d of ["raw", "final", "work"]) { fs.rmSync(path.join(storage, d), { recursive: true, force: true }); fs.mkdirSync(path.join(storage, d), { recursive: true }); }
}
async function make(name: string, status: string, hoursAgo: number, files: { raw?: boolean; final?: boolean }, o: { stage?: string; cutHoursAgo?: number } = {}) {
  const { prisma } = await import("../src/lib/db");
  const s = await prisma.streamer.upsert({ where: { twitchId: "t-ret" }, update: {}, create: { twitchId: "t-ret", login: "ret", name: "Ret", approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", twitchClipId: `tc-${name}-${Math.random()}` } });
  const c = await prisma.clip.create({ data: { momentId: m.id, status, duration: 20, title: name, stage: o.stage ?? null } });
  const data: Record<string, string> = {};
  if (files.raw) { fs.writeFileSync(path.join(storage, `raw/${c.id}.mp4`), Buffer.alloc(MB)); data.rawPath = `raw/${c.id}.mp4`; }
  if (files.final) { fs.writeFileSync(path.join(storage, `final/${c.id}.mp4`), Buffer.alloc(MB)); data.finalPath = `final/${c.id}.mp4`; }
  await prisma.clip.update({ where: { id: c.id }, data });
  const at = new Date(Date.now() - hoursAgo * H), cut = new Date(Date.now() - (o.cutHoursAgo ?? hoursAgo) * H);
  await prisma.$executeRaw`UPDATE Clip SET updatedAt = ${at}, stageAt = ${cut} WHERE id = ${c.id}`;
  return c.id;
}
const get = async (id: string) => (await import("../src/lib/db")).prisma.clip.findUnique({ where: { id } });
const exists = (rel: string) => fs.existsSync(path.join(storage, rel));

test("retention: raw goes once the clip is cut AND reviewed, else retainRawHrs after the cut; never while processing or re-cutting", async () => {
  await resetClips();
  const { runRetention } = await import("../src/workers/retention");
  const approvedFresh = await make("a", "approved", 0.1, { raw: true, final: true });
  const rejectedFresh = await make("r", "rejected", 0.1, { raw: true, final: true });
  const postedFresh = await make("p", "posted", 0.1, { raw: true, final: true });
  const pendingFresh = await make("pf", "pending", 1, { raw: true, final: true });
  const pendingCut7h = await make("p7", "pending", 1, { raw: true, final: true }, { cutHoursAgo: 7 }); // edited 1h ago, cut 7h ago
  const processing = await make("pr", "processing", 30, { raw: true });
  const recutting = await make("rc", "approved", 30, { raw: true, final: true }, { stage: "cut" });
  await runRetention();
  for (const id of [approvedFresh, rejectedFresh, postedFresh]) {
    const c = (await get(id))!;
    assert.equal(c.rawPath, null, `${c.status}: raw gone`); assert.ok(!exists(`raw/${id}.mp4`));
    if (c.status !== "rejected") assert.ok(c.finalPath && exists(c.finalPath), `${c.status}: final kept`);
  }
  assert.ok((await get(pendingFresh))!.rawPath, "unreviewed raw kept (re-cut)");
  assert.equal((await get(pendingCut7h))!.rawPath, null, "> 6h after the cut: gone");
  assert.ok((await get(processing))!.rawPath && exists(`raw/${processing}.mp4`), "processing raw kept");
  assert.ok((await get(recutting))!.rawPath && exists(`raw/${recutting}.mp4`), "re-cut in flight: raw kept");
  // clearing a path doesn't restart the clip's other clocks
  const { prisma } = await import("../src/lib/db");
  assert.ok(Date.now() - (await prisma.clip.findUniqueOrThrow({ where: { id: pendingCut7h } })).updatedAt.getTime() > 0.9 * H, "updatedAt untouched");
});

test("retention: rejected after 6h, unreviewed after 48h (→ expired), approved after 5d, posted after 3d; rows after 7d (posts kept)", async () => {
  await resetClips();
  const { prisma } = await import("../src/lib/db");
  const { runRetention } = await import("../src/workers/retention");
  const rej5 = await make("rej5", "rejected", 5, { final: true });
  const rej7 = await make("rej7", "rejected", 7, { final: true });
  const pend47 = await make("pend47", "pending", 47, { final: true });
  const pend49 = await make("pend49", "pending", 49, { raw: true, final: true });
  const appr4 = await make("appr4", "approved", 4 * 24, { final: true });
  const appr6 = await make("appr6", "approved", 6 * 24, { final: true });
  const post2 = await make("post2", "posted", 2 * 24, { final: true });
  const post4 = await make("post4", "posted", 4 * 24, { final: true });
  const rejOld = await make("rejOld", "rejected", 8 * 24, { final: true });
  const rejOldPosted = await make("rejOldPosted", "rejected", 8 * 24, {});
  await prisma.post.create({ data: { clipId: rejOldPosted, platform: "tiktok" } });
  await prisma.$executeRaw`UPDATE Clip SET updatedAt = ${new Date(Date.now() - 8 * D)} WHERE id = ${rejOldPosted}`;
  const expOld = await make("expOld", "expired", 8 * 24, {});
  const exp6d = await make("exp6d", "expired", 6 * 24, {});
  const momentOfRejOld = (await prisma.clip.findUniqueOrThrow({ where: { id: rejOld } })).momentId;

  const msg = await runRetention();
  assert.match(msg, /2 old clips removed/);
  assert.ok((await get(rej5))!.finalPath && exists(`final/${rej5}.mp4`), "rejected 5h: kept");
  assert.equal((await get(rej7))!.finalPath, null); assert.ok(!exists(`final/${rej7}.mp4`));
  assert.equal((await get(pend47))!.status, "pending");
  const p49 = (await get(pend49))!;
  assert.deepEqual([p49.status, p49.finalPath, p49.rawPath], ["expired", null, null]);
  assert.ok(!exists(`final/${pend49}.mp4`) && !exists(`raw/${pend49}.mp4`));
  assert.ok((await get(appr4))!.finalPath);
  const a6 = (await get(appr6))!;
  assert.deepEqual([a6.status, a6.finalPath], ["approved", null], "approved never posted: video gone, row stays");
  assert.ok((await get(post2))!.finalPath);
  assert.equal((await get(post4))!.finalPath, null);
  assert.equal(await get(rejOld), null, "old rejected row deleted");
  assert.ok(await prisma.moment.findUnique({ where: { id: momentOfRejOld } }), "its moment stays (stops the same clip being made again)");
  assert.ok(await get(rejOldPosted), "a clip with a post is never deleted");
  assert.equal(await prisma.post.count({ where: { clipId: rejOldPosted } }), 1);
  assert.equal(await get(expOld), null, "old expired row deleted");
  assert.ok(await get(exp6d), "expired 6 days: kept");
  // the clip that just expired starts its 7-day clock now
  assert.ok(Date.now() - p49.updatedAt.getTime() < 60_000);
});

test("retention: the windows come from Settings (Storage card fields)", async () => {
  await resetClips();
  const { prisma } = await import("../src/lib/db");
  const { runRetention, retentionWindows } = await import("../src/workers/retention");
  await prisma.settings.create({ data: { id: "main", retainPostedDays: 10, retainRejectedHrs: 1 } });
  const post4 = await make("post4", "posted", 4 * 24, { final: true });
  const rej2 = await make("rej2", "rejected", 2, { final: true });
  await runRetention();
  assert.ok((await get(post4))!.finalPath, "posted kept 10 days now");
  assert.equal((await get(rej2))!.finalPath, null, "rejected after 1h now");
  const w = retentionWindows({ retainRejectedHrs: 6, retainPendingHrs: 48, retainApprovedDays: 5, retainPostedDays: 3, retainRawHrs: 6, retainRowsDays: 7 });
  assert.deepEqual(w, { rejected: 6 * H, pending: 48 * H, approved: 5 * D, posted: 3 * D, raw: 6 * H, rows: 7 * D, failed: 24 * H, orphan: 24 * H });
  const half = retentionWindows({}, true);
  assert.deepEqual(half, { rejected: 3 * H, pending: 24 * H, approved: 2.5 * D, posted: 1.5 * D, raw: 3 * H, rows: 3.5 * D, failed: 12 * H, orphan: 12 * H });
  // the form: whole numbers, clamped, blanks = defaults
  const fd = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.deepEqual(parseRetentionForm(fd({ retainRejectedHrs: "3", retainPendingHrs: "0", retainApprovedDays: "", retainPostedDays: "2.6", retainRawHrs: "abc", retainRowsDays: "9999" })),
    { retainRejectedHrs: 3, retainPendingHrs: 1, retainApprovedDays: 5, retainPostedDays: 3, retainRawHrs: 6, retainRowsDays: 365 });
});

test("retention: disk-pressure mode halves every window and deletes the oldest unreviewed videos until 2 x MIN_FREE_GB is free", async () => {
  await resetClips();
  const { setFreeGbFn } = await import("../src/lib/guards");
  const { runRetention, diskPressure } = await import("../src/workers/retention");
  const rej4 = await make("rej4", "rejected", 4, { final: true });
  const p1 = await make("p1", "pending", 4, { final: true });
  const p2 = await make("p2", "pending", 3, { final: true });
  const p3 = await make("p3", "pending", 2, { final: true });
  const p4 = await make("p4", "pending", 1, { final: true });
  // Pretend each finished clip takes 1 GB on a drive with 12 GB when empty (target = 2 x 5 = 10 GB).
  setFreeGbFn(async () => 12 - fs.readdirSync(path.join(storage, "final")).length);
  assert.deepEqual(await diskPressure(), { pressure: true, free: 7 });
  // Normal mode: nothing is old enough.
  await runRetention();
  assert.ok((await get(rej4))!.finalPath, "4h-old reject kept in normal mode (6h)");
  const msg = await runRetention(Date.now(), { pressure: true });
  assert.match(msg, /^disk-pressure mode: /);
  assert.match(msg, /2 oldest unreviewed deleted for space/);
  assert.match(msg, /10\.0 GB free/);
  assert.equal((await get(rej4))!.finalPath, null, "halved: rejected after 3h");
  assert.deepEqual([(await get(p1))!.status, (await get(p2))!.status], ["expired", "expired"], "the two oldest unreviewed");
  for (const id of [p3, p4]) { const c = (await get(id))!; assert.equal(c.status, "pending"); assert.ok(c.finalPath && exists(c.finalPath)); }
  assert.deepEqual(await diskPressure(), { pressure: false, free: 10 });
});

test("expired clips: own Queue tab, never in 'to review' counts or the backlog", async () => {
  await resetClips();
  const { prisma } = await import("../src/lib/db");
  const { backlogRoom } = await import("../src/lib/guards");
  await make("e1", "expired", 1, {});
  await make("e2", "expired", 1, {});
  await make("pend", "pending", 1, {});
  assert.ok(QUEUE_TABS.some((t) => t.key === "expired"));
  assert.equal(parseQueueParams({ tab: "expired" }).tab, "expired");
  assert.equal(await prisma.clip.count({ where: queueWhere(parseQueueParams({})) }), 1, "To review = pending only");
  assert.equal(await prisma.clip.count({ where: queueWhere(parseQueueParams({ tab: "expired" })) }), 2);
  assert.equal(await backlogRoom(), 12, "expired clips don't take backlog room");
});

// ---------- C. storage on another drive ----------
test("storage usage by kind + host folder from the compose env", async () => {
  await resetClips();
  fs.mkdirSync(path.join(storage, "edits", "x"), { recursive: true });
  fs.writeFileSync(path.join(storage, "raw", "a.mp4"), Buffer.alloc(3 * MB));
  fs.writeFileSync(path.join(storage, "final", "b.mp4"), Buffer.alloc(2 * MB));
  fs.writeFileSync(path.join(storage, "edits", "x", "c.mp4"), Buffer.alloc(MB));
  fs.writeFileSync(path.join(storage, "work", "d.wav"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(storage, "launcher.log"), Buffer.alloc(10));
  const { storageUsage } = await import("../src/lib/storage");
  const u = await storageUsage();
  assert.equal(u.dir, storage);
  assert.deepEqual(u.byKind, { raw: 3 * MB, final: 2 * MB, edits: MB, work: 1024, other: 10 });
  assert.equal(u.total, 6 * MB + 1034);
  assert.equal(u.freeGb, 500);
  assert.equal(fmtBytes(3 * MB), "3.0 MB");
  assert.equal(fmtBytes(5.2e9), "4.8 GB");
  assert.equal(hostStorageDir({}), null, "not in Docker");
  assert.equal(hostStorageDir({ CLIP_STORAGE_HOST_DIR: "" }), "clip-factory/storage (the default)");
  assert.equal(hostStorageDir({ CLIP_STORAGE_HOST_DIR: "D:/ClipFactory/storage" }), "D:/ClipFactory/storage");
});

test("docker-compose: storage bind mount follows CLIP_STORAGE_DIR (empty = ./storage); .env.example has the line, no inline comment", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  assert.match(compose, /^ {4}- \$\{CLIP_STORAGE_DIR:-\.\/storage\}:\/storage$/m);
  assert.doesNotMatch(compose, /- \.\/storage:\/storage/);
  assert.match(compose, /CLIP_STORAGE_HOST_DIR: \$\{CLIP_STORAGE_DIR:-\}/);
  assert.match(compose, /- models:\/models/, "Whisper model cache unchanged");
  const env = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.match(env, /^CLIP_STORAGE_DIR=$/m);
  assert.match(env, /^# Example for a second drive: CLIP_STORAGE_DIR=D:\/ClipFactory\/storage$/m);
  // The real resolution, when the docker CLI is here (it works without a daemon).
  const has = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (has.status !== 0) return;
  const proj = path.join(dir, "compose");
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "docker-compose.yml"), path.join(proj, "docker-compose.yml"));
  const resolve = (envText: string) => {
    fs.writeFileSync(path.join(proj, ".env"), envText);
    const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: proj, encoding: "utf8", env: { ...process.env, CLIP_STORAGE_DIR: undefined } as NodeJS.ProcessEnv });
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    return ["web", "worker"].map((s) => cfg.services[s].volumes.find((v: { target: string }) => v.target === "/storage").source);
  };
  assert.deepEqual(resolve(env), [path.join(proj, "storage"), path.join(proj, "storage")], "empty value = the default");
  assert.deepEqual(resolve("TWITCH_CLIENT_ID=\n"), [path.join(proj, "storage"), path.join(proj, "storage")], "missing = the default");
  assert.deepEqual(resolve(env.replace(/^CLIP_STORAGE_DIR=$/m, "CLIP_STORAGE_DIR=D:/ClipFactory/storage")), ["D:/ClipFactory/storage", "D:/ClipFactory/storage"]);
});

// ---------- db push upgrade ----------
test("db push upgrade from the v1.9.1 schema (1ac085c) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV191Schema(now);
  const git = spawnSync("git", ["show", "1ac085c:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 1ac085c one");
  const uniques = (s: string) => (s.match(/@unique|@@unique/g) ?? []).length;
  assert.equal(uniques(now), uniques(old), "no new unique constraints");
  const up = path.join(dir, "upgrade");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "old.prisma"), old);
  const env = { ...process.env, DATABASE_URL: `file:${path.join(up, "krew.db")}` };
  const push = (schema: string) => spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schema], { env, encoding: "utf8" });
  const first = push(path.join(up, "old.prisma"));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const sql = (q: string) => execFileSync(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(env.DATABASE_URL)} } } });
    p.$queryRawUnsafe(${JSON.stringify(q)}).then((r) => { console.log(JSON.stringify(r, (k, v) => typeof v === "bigint" ? Number(v) : v)); return p.$disconnect(); });
  `], { encoding: "utf8", cwd: ROOT });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, 0, 0)`);
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'twitch_clip', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, score, judgeReason, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 6, 'meh', 0, 0)`);
  sql(`INSERT INTO Post (id, clipId, platform, postedAt) VALUES ('p1', 'c1', 'tiktok', 0)`);
  sql(`INSERT INTO Settings (id, channelName) VALUES ('main', 'MyClips')`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, score, judgeReason, judgeObservations, judgeFrames, judgeTokensIn, judgeTokensOut FROM Clip")),
    [{ id: "c1", score: 6, judgeReason: "meh", judgeObservations: null, judgeFrames: null, judgeTokensIn: null, judgeTokensOut: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT channelName, retainRejectedHrs, retainPendingHrs, retainApprovedDays, retainPostedDays, retainRawHrs, retainRowsDays FROM Settings")),
    [{ channelName: "MyClips", retainRejectedHrs: 6, retainPendingHrs: 48, retainApprovedDays: 5, retainPostedDays: 3, retainRawHrs: 6, retainRowsDays: 7 }]);
  assert.deepEqual(JSON.parse(sql("SELECT COUNT(*) AS n FROM Post")), [{ n: 1 }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
