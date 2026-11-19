import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV195Schema } from "./schema-v173";
import { costCents, dayKey, dollars } from "../src/lib/ai-spend";
import { enforcePicks, renderSupremeInput, type ChannelContext, type ClipSummary } from "../src/lib/supreme";
import { cutTimes, ffmpegIssues, fixPlan, frameTimes, parseFfmpegChecks, planIssues, runFfmpegChecks } from "../src/lib/qa";
import { loadPromptFile } from "../src/lib/prompt-file";

// v1.9.6 Supreme Judge: picks per channel, the video check (free ffmpeg checks + vision), Fix it, the daily budget.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v193-"));
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
let mock: Mock;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
let BAD = "", GOOD = "", RAW = "";

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/4", WHISPER_ENGINE: "off",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  // Real renders: a clip with 1.5s black + a 3s frozen ending + 3.5s of silence, and a clean one.
  BAD = path.join(dir, "bad.mp4"); GOOD = path.join(dir, "good.mp4"); RAW = path.join(dir, "raw.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=3", "-f", "lavfi", "-i", "color=black:s=540x960:r=30:d=1.5", "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=3",
    "-f", "lavfi", "-i", "sine=f=440:d=7.5", "-filter_complex", "[2:v]trim=0:0.04,loop=loop=89:size=1:start=0,setpts=N/30/TB[f];[0:v][1:v][f]concat=n=3:v=1:a=0[v];[3:a]volume=enable='between(t,3,6.5)':volume=0[a]",
    "-map", "[v]", "-map", "[a]", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", BAD]);
  ff(["-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=6", "-f", "lavfi", "-i", "sine=f=330:d=6", "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", GOOD]);
  ff(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12", "-f", "lavfi", "-i", "sine=f=300:d=12", "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", RAW]);
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

async function reset() {
  const { prisma } = await import("../src/lib/db");
  await prisma.aiSpend.deleteMany(); await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany();
  await prisma.streamer.deleteMany(); await prisma.account.deleteMany(); await prisma.channel.deleteMany(); await prisma.settings.deleteMany();
  await prisma.settings.create({ data: { id: "main", migratedChannels: true } });
  const { queue } = await import("../src/lib/queues");
  for (const q of ["qa", "cut", "supreme"] as const) await queue(q).obliterate({ force: true });
  return prisma;
}
function copyFinal(src: string, id: string) {
  fs.copyFileSync(src, path.join(process.env.STORAGE_DIR!, "final", `${id}.mp4`));
  return `final/${id}.mp4`;
}

// ---------- pure ----------
test("prices (src/lib/pricing.ts) + budget helpers: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10 per MTok, cents, local day", () => {
  assert.equal(costCents("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 }), 400);
  assert.equal(costCents("claude-opus-5-5", { input_tokens: 0, output_tokens: 1_000_000 }), 2000);
  assert.equal(costCents("claude-sonnet-5-5", { input_tokens: 100_000, output_tokens: 10_000 }), 30);
  assert.equal(costCents("claude-sonnet-5-5", { input_tokens: 0, cache_read_input_tokens: 1_000_000 }), 200, "v1.9.4 pricing: every input token at the input price");
  assert.equal(dollars(8), "$0.08"); assert.equal(dollars(25), "$0.25");
  assert.match(dayKey(new Date(2026, 10, 19, 23, 59)), /^2026-11-19$/);
  for (const f of ["prompts/supreme.md", "prompts/supreme-qa.md"]) assert.ok(loadPromptFile(f).length > 300, f);
  assert.match(loadPromptFile("prompts/supreme.md"), /never more than 2 clips of the same creator/);
});

const sum = (id: string, creatorId: string, extra: Partial<ClipSummary> = {}): ClipSummary => ({
  id, creator: creatorId.toUpperCase(), creatorId, category: "funny", game: "Grand Theft Auto VI", score: 8, reason: "r", hook: "h", standout: 3, ageHours: 5,
  length: 24, campaign: null, layout: "split", style: "hype", status: "approved", autoChannelId: "vcc", qa: "unchecked", ...extra,
});
const chan = (id: string, extra: Partial<ChannelContext> = {}): ChannelContext => ({ id, name: id.toUpperCase(), focus: "gta", kinds: "gaming,funny,edits", postsToday: 0, want: 5, creatorsToday: {}, performance: [], ...extra });

test("Supreme safety net: max 2 per creator per channel per day (today's posts count), limit, known ids, one channel per clip, no clips with problems", () => {
  const clips = [sum("k1", "kai"), sum("k2", "kai"), sum("k3", "kai"), sum("h1", "hasan"), sum("h2", "hasan", { qa: "issues" }), sum("x1", "xqc"), sum("x2", "xqc")];
  const answer = { channels: [
    { channel_id: "vcc", picks: ["k1", "k2", "k3", "nope", "h2", "h1", "x1"].map((clip_id) => ({ clip_id, reason: `why ${clip_id}` })) },
    { channel_id: "fun", picks: [{ clip_id: "k1", reason: "dup" }, { clip_id: "x2", reason: "ok" }] },
    { channel_id: "ghost", picks: [{ clip_id: "x1", reason: "?" }] },
  ] };
  const { picks, dropped } = enforcePicks(answer, [chan("vcc", { want: 3 }), chan("fun", { creatorsToday: { xqc: 2 } })], clips, 5);
  assert.deepEqual(picks.map((p) => `${p.channelId}:${p.clipId}:${p.rank}`), ["vcc:k1:1", "vcc:k2:2", "vcc:h1:3"]);
  assert.ok(dropped.some((d) => /k3: 3rd KAI clip/.test(d)));
  assert.ok(dropped.some((d) => /unknown clip nope/.test(d)));
  assert.ok(dropped.some((d) => /h2: video check found problems/.test(d)));
  assert.ok(dropped.some((d) => /x1: over VCC's limit/.test(d)));
  assert.ok(dropped.some((d) => /k1: already picked/.test(d)));
  assert.ok(dropped.some((d) => /x2: 3rd XQC clip for FUN today/.test(d)), "2 xQc posts already today on that channel");
  assert.ok(dropped.some((d) => /unknown channel ghost/.test(d)));
  assert.deepEqual(enforcePicks(null, [], clips, 5).picks, []);
  const text = renderSupremeInput([chan("vcc", { creatorsToday: { kai: 1 }, performance: ["By creator: KAI 1200 avg views (3 posts, 1.4x typical)"] })], clips.slice(0, 2));
  assert.match(text, /<channels>\n- id=vcc name="VCC" focus=gta types=gaming,funny,edits posts_today=0 picks_wanted=5\n {2}already posted today by creator: KAI 1\n {2}By creator: KAI 1200 avg views/);
  assert.match(text, /- id=k1 creator="KAI" type=funny game="Grand Theft Auto VI" score=8 standout=3x age=5h length=24s status=approved campaign=none layout=split\/hype auto_channel=vcc video_check=unchecked/);
});

test("cut checks from the edit plan: cut inside a word, tiny segment, ending mid-word; frame times; Fix it plan", () => {
  const plan = { segs: [{ start: 0, end: 5 }, { start: 6.2, end: 6.5 }, { start: 8, end: 20 }], punchStart: 9.1, duration: 17.3 };
  assert.deepEqual(cutTimes(plan), [5, 5.3]);
  const words = [{ start: 4.8, end: 5.4, word: " gonna" }, { start: 8.5, end: 9, word: "no" }, { start: 19.8, end: 20.6, word: "way" }];
  const iss = planIssues(plan, words, 20);
  assert.deepEqual(iss.map((i) => [i.type, i.at_sec, i.fix]), [["bad_cut", 5, "recut_no_jumpcuts"], ["bad_cut", 5, "recut_no_jumpcuts"], ["ending", 17.3, "extend_end"]]);
  assert.match(iss[0].detail, /chops the word "gonna"/);
  assert.match(iss[1].detail, /0.3s piece/);
  assert.deepEqual(planIssues({ segs: [{ start: 0, end: 20 }], punchStart: null, duration: 20 }, [{ start: 3, end: 3.5, word: "ok" }], 20), [], "no cuts, clean end");
  const ft = frameTimes(plan, 17.3);
  assert.ok(ft.length >= 10 && ft.length <= 12, String(ft.length));
  for (const want of [0.6, 5.25, 9.5, 16.9]) assert.ok(ft.some((f) => Math.abs(f.t - want) < 0.01), `frame at ${want}: ${JSON.stringify(ft)}`);
  assert.ok(ft.some((f) => f.why === "right after jump cut 1") && ft.some((f) => f.why === "punch-in") && ft.some((f) => f.why === "hook") && ft.some((f) => f.why === "last second"));
  assert.deepEqual(fixPlan([{ type: "bad_cut", at_sec: 1, detail: "", fix: "recut_no_jumpcuts" }, { type: "caption_over_face", at_sec: 2, detail: "", fix: "recut_layout_blur" }, { type: "ending", at_sec: 3, detail: "", fix: "extend_end" }, { type: "black", at_sec: 0, detail: "", fix: "none" }]),
    { fixes: ["recut_no_jumpcuts", "recut_layout_blur", "extend_end"], jumpCuts: "off", layout: "blur", extendSec: 2 });
  assert.equal(fixPlan([{ type: "black", at_sec: 0, detail: "", fix: "none" }]), null);
  assert.deepEqual(fixPlan([{ type: "other", at_sec: 0, detail: "", fix: "recut_style_clean" }]), { fixes: ["recut_style_clean"], style: "clean" });
});

test("free checks on real ffmpeg renders: injected black + frozen + silence found; a clean render has none", async () => {
  const bad = await runFfmpegChecks(BAD, true, 7.5);
  assert.deepEqual(bad.black.map((b) => [b.start, b.end]), [[3, 4.5]]);
  assert.ok(bad.freeze.some((f) => f.start === 4.5 && f.end === 7.5), JSON.stringify(bad.freeze));
  assert.ok(bad.silence.some((s) => Math.abs(s.start - 3) < 0.1 && Math.abs(s.end - 6.5) < 0.1), JSON.stringify(bad.silence));
  assert.ok(bad.lufs != null && bad.lra != null);
  const iss = ffmpegIssues(bad, { duration: 7.5, planned: 7.5, hasAudio: true });
  assert.deepEqual(iss.map((i) => [i.type, i.at_sec]), [["black", 3], ["frozen", 4.5], ["audio", 3]]);
  assert.match(iss[1].detail, /frozen for 3s/);
  const good = await runFfmpegChecks(GOOD, true, 6);
  assert.deepEqual(ffmpegIssues(good, { duration: 6, planned: 6, hasAudio: true }), []);
  assert.deepEqual(ffmpegIssues(good, { duration: 6, planned: 9, hasAudio: true }).map((i) => i.type), ["other"], "length doesn't match the plan");
  // freeze ranges that close normally are parsed too; black ranges covered by black aren't also "frozen".
  const s = parseFfmpegChecks("black_start:1 black_end:3 black_duration:2\nlavfi.freezedetect.freeze_start: 1\nlavfi.freezedetect.freeze_end: 3\nsilence_start: -0.01\nsilence_end: 4 | silence_duration: 4\n    I:   -33.0 LUFS\n    LRA:  2.0 LU", 10);
  assert.deepEqual(ffmpegIssues(s, { duration: 10, planned: null, hasAudio: true }).map((i) => i.type), ["black", "audio", "audio"]);
});

async function world() {
  const prisma = await reset();
  await prisma.channel.create({ data: { id: "vcc", name: "ViceCityClips", focus: "gta", kinds: "gaming,funny,edits", createdAt: new Date(1) } });
  await prisma.channel.create({ data: { id: "fun", name: "StreamerLaughs", focus: "any", kinds: "funny", createdAt: new Date(2) } });
  const kai = await prisma.streamer.create({ data: { twitchId: "v193-kai", login: "kaicenat", name: "Kai Cenat", approved: true } });
  const hasan = await prisma.streamer.create({ data: { twitchId: "v193-hasan", login: "hasanabi", name: "HasanAbi", approved: true } });
  const mk = async (s: { id: string }, status: string, score: number, extra: Record<string, unknown> = {}) => {
    const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", gameName: "Grand Theft Auto VI", category: "funny", spikeScore: 3 } });
    const c = await prisma.clip.create({ data: { momentId: m.id, status, score, title: "Hook", hookText: "Hook", caption: "Hook\n\n🎥 @x", category: "funny", duration: 6, judgeReason: "Big laugh", ...extra } });
    return prisma.clip.update({ where: { id: c.id }, data: { finalPath: copyFinal(GOOD, c.id) } });
  };
  return { prisma, kai, hasan, mk };
}

test("Supreme run: one Opus request (structured, effort medium, fallback), picks stored with reasons, variety enforced in code, new picks get checked, spend recorded", async () => {
  const w = await world();
  const k1 = await w.mk(w.kai, "approved", 9), k2 = await w.mk(w.kai, "approved", 8.5), k3 = await w.mk(w.kai, "pending", 8);
  const h1 = await w.mk(w.hasan, "approved", 7, { qa: JSON.stringify({ ok: true, at: "", issues: [], checks: [], vision: "done" }) });
  const old = await w.mk(w.hasan, "approved", 9.9);
  await w.prisma.clip.update({ where: { id: old.id }, data: { supremePick: true, supremeRank: 1 } }); // yesterday's pick
  mock.supreme = { channels: [{ channel_id: "vcc", picks: [k1, k2, k3, h1].map((c) => ({ clip_id: c.id, reason: `good ${c.score}` })) }] };
  mock.usage = { input_tokens: 10_000, output_tokens: 1000 };
  mock.requests.length = 0;
  const { runSupreme } = await import("../src/workers/supreme");
  const msg = await runSupreme();
  assert.match(msg, /picked 3 clips \(ViceCityClips 3, StreamerLaughs 0\) from 5 · 1 dropped by the rules · checking 2 videos · \$0\.06/);
  const req = mock.requests.find((r) => r.path.startsWith("/v1/messages"))!;
  const body = JSON.parse(req.body.toString());
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.output_config.effort, "medium");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.match(JSON.stringify(body.output_config.format.schema), /channel_id/);
  assert.equal(body.fallbacks, "default");
  assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.match(body.messages[0].content, new RegExp(`id=${k3.id} creator="Kai Cenat".*status=pending`));
  assert.match(body.system[0].text, /editor-in-chief/);
  const got = await w.prisma.clip.findMany({ where: { supremePick: true }, orderBy: { supremeRank: "asc" } });
  assert.deepEqual(got.map((c) => [c.id, c.supremeRank, c.supremeChannelId, c.supremeReason]), [[k1.id, 1, "vcc", "good 9"], [k2.id, 2, "vcc", "good 8.5"], [h1.id, 3, "vcc", "good 7"]]);
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: old.id } })).supremePick, false, "yesterday's line-up replaced");
  const { queue } = await import("../src/lib/queues");
  const qa = await queue("qa").getJobs(["waiting", "prioritized"]);
  assert.deepEqual(qa.map((j) => j.data.clipId).sort(), [k1.id, k2.id].sort(), "unchecked picks are watched; h1 was already checked");
  const spend = await w.prisma.aiSpend.findMany();
  assert.deepEqual(spend.map((s) => [s.model, s.purpose, s.cents]), [["claude-opus-5-5", "supreme", 6]]);
  // To post order: picks first.
  const { toPostItems } = await import("../src/lib/to-post");
  assert.deepEqual((await toPostItems()).items.slice(0, 3).map((x) => x.clip.id), [k1.id, k2.id, h1.id]);

  // Refusal → no picks, the old ones stay, status says so.
  mock.supremeStop = "refusal";
  assert.match(await runSupreme(), /declined this time \(no picks\)/);
  mock.supremeStop = "end_turn";
  assert.equal(await w.prisma.clip.count({ where: { supremePick: true } }), 3);

  // Budget: once today's Supreme + QA spend reaches the cap, no more runs today.
  await w.prisma.settings.update({ where: { id: "main" }, data: { supremeDailyCents: 15 } });
  mock.usage = { input_tokens: 10_000, output_tokens: 1000 };
  assert.match(await runSupreme(), /picked/); // 6 (run) + 6 (refused run) + 6 = 18 cents ≥ 15 after this
  const n = mock.requests.filter((r) => r.path.startsWith("/v1/messages")).length;
  assert.match(await runSupreme(), /skipped: today's budget is used \(\$0\.18 of \$0\.15\)/);
  assert.equal(mock.requests.filter((r) => r.path.startsWith("/v1/messages")).length, n, "no request when over budget");
  const { budgetLine } = await import("../src/lib/ai-spend");
  assert.deepEqual(await budgetLine(), { spent: 18, cap: 15, text: "Supreme Judge today: $0.18 of $0.15", over: true });
  mock.usage = { input_tokens: 10, output_tokens: 10 };
});

test("video check: free checks + vision request (labelled base64 JPEG frames, cut list, transcript) on Sonnet effort low; issues stored", async () => {
  const w = await world();
  const c = await w.mk(w.kai, "approved", 8, {
    duration: 7.5, winStart: 0, winLength: 8.7, wordsFull: true, layout: "split",
    words: JSON.stringify([{ start: 2.8, end: 3.4, word: "gonna" }, { start: 8.4, end: 9.0, word: "end" }]),
    cutPlan: JSON.stringify({ segs: [{ start: 0, end: 3 }, { start: 4.2, end: 8.7 }], punchStart: 5, duration: 7.5 }),
  });
  await w.prisma.clip.update({ where: { id: c.id }, data: { finalPath: copyFinal(BAD, c.id) } });
  mock.qa = { ok: false, issues: [{ type: "caption_over_face", at_sec: 1.2, detail: "Captions cover his face", fix: "recut_layout_blur" }, { type: "black", at_sec: 3, detail: "black", fix: "none" }] };
  mock.requests.length = 0;
  const { runQa } = await import("../src/workers/supreme");
  const msg = await runQa(c.id);
  assert.match(msg, /issues \(black, frozen, audio, bad_cut, ending, caption_over_face\) · \d+ frames watched/);
  const req = JSON.parse(mock.requests.find((r) => r.path.startsWith("/v1/messages"))!.body.toString());
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.fallbacks, "default");
  assert.match(req.system[0].text, /You check finished vertical clips/);
  const blocks = req.messages[0].content as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
  const images = blocks.filter((b) => b.type === "image");
  assert.ok(images.length >= 8 && images.length <= 12, String(images.length));
  for (const im of images) {
    assert.equal(im.source!.type, "base64"); assert.equal(im.source!.media_type, "image/jpeg");
    assert.equal(Buffer.from(im.source!.data, "base64").subarray(0, 3).toString("hex"), "ffd8ff", "a real JPEG");
  }
  assert.match(blocks[0].text!, /Jump cuts at: 3s\. Punch-in at 5\.0s\./);
  assert.match(blocks[0].text!, /<transcript_around_cuts>\n\[2\.8s\] gonna/);
  assert.match(blocks[0].text!, /Free checks found: black at 3s/);
  assert.ok(blocks.some((b) => b.text === "Frame 1 at 0.60s (hook):"));
  assert.ok(blocks.some((b) => /\(right after jump cut 1\):$/.test(b.text ?? "")));
  // 540x960 frames
  const qa = JSON.parse((await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } })).qa!);
  assert.equal(qa.ok, false); assert.equal(qa.vision, "done");
  assert.deepEqual(qa.issues.map((i: { type: string; source: string }) => `${i.type}/${i.source}`), ["black/ffmpeg", "frozen/ffmpeg", "audio/ffmpeg", "bad_cut/plan", "ending/plan", "caption_over_face/vision"], "the model's black duplicate is dropped");
  assert.ok((await w.prisma.aiSpend.findMany()).some((s) => s.purpose === "qa" && s.model === "claude-sonnet-5-5"));
  assert.ok(!fs.existsSync(path.join(process.env.STORAGE_DIR!, "work", `qa-${c.id}`)), "frames cleaned up");

  // Over budget: only the free checks run (no request), and it says so.
  await w.prisma.settings.update({ where: { id: "main" }, data: { supremeDailyCents: 0 } });
  const before = mock.requests.length;
  assert.match(await runQa(c.id), /budget is used/);
  assert.equal(mock.requests.length, before);
  await w.prisma.settings.update({ where: { id: "main" }, data: { supremeDailyCents: 25 } });
  // A clean clip passes.
  mock.qa = { ok: true, issues: [] };
  const ok = await w.mk(w.hasan, "approved", 7);
  assert.match(await runQa(ok.id), /checked ✓/);
});

test("Fix it: re-cut with the suggested options through the normal re-cut path (+2s at the end), then the check runs again", async () => {
  const w = await world();
  fs.copyFileSync(RAW, path.join(process.env.STORAGE_DIR!, "raw", "fixme.mp4"));
  const c = await w.mk(w.kai, "approved", 8, {
    rawPath: "raw/fixme.mp4", winStart: 1, winLength: 6, duration: 6, wordsFull: true, words: "[]", editStyle: "hype", layout: "split",
    qa: JSON.stringify({ ok: false, at: "", checks: [], vision: "done", issues: [
      { type: "caption_over_face", at_sec: 1, detail: "x", fix: "recut_layout_blur" }, { type: "bad_cut", at_sec: 2, detail: "y", fix: "recut_no_jumpcuts" }, { type: "ending", at_sec: 5, detail: "z", fix: "extend_end" }] }),
  });
  const actions = await import("../app/actions");
  assert.deepEqual(await actions.fixClip(c.id), ["recut_layout_blur", "recut_no_jumpcuts", "extend_end"]);
  const { queue } = await import("../src/lib/queues");
  const [job] = await queue("cut").getJobs(["waiting", "prioritized"]);
  assert.deepEqual(job.data, { clipId: c.id, style: "hype", jumpCuts: "off", layout: "blur", qaAfter: true });
  const after = await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.winLength, 8, "2s longer");
  assert.equal(after.status, "approved", "review status kept");
  assert.equal(after.stage, "cut");
  // The worker's cut with those options: a real render, the old check cleared, the edit plan stored, the check queued again.
  const { runCut } = await import("../src/workers/cutter");
  const msg = await runCut(c.id, job.data.style, job.data.jumpCuts, job.data.layout, job.data.qaAfter);
  assert.match(msg, /cut [\d.]+s hype blur/);
  const cut = await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(cut.qa, null);
  assert.equal(cut.layout, "blur");
  assert.deepEqual(JSON.parse(cut.cutPlan!).segs, [{ start: 0, end: 8 }]);
  const qa = await queue("qa").getJobs(["waiting", "prioritized"]);
  assert.deepEqual(qa.map((j) => j.data), [{ clipId: c.id }]);
  mock.qa = { ok: true, issues: [] };
  const { runQa } = await import("../src/workers/supreme");
  assert.match(await runQa(c.id), /checked ✓/);
  // Nothing automatic to do → a clear message.
  await w.prisma.clip.update({ where: { id: c.id }, data: { qa: JSON.stringify({ ok: false, at: "", checks: [], vision: "done", issues: [{ type: "black", at_sec: 0, detail: "b", fix: "none" }] }) } });
  await assert.rejects(actions.fixClip(c.id), /Nothing here can be fixed automatically/);
  // Check video: queues the check.
  await queue("qa").obliterate({ force: true });
  await actions.checkVideo(c.id);
  assert.equal((await queue("qa").getJobs(["waiting", "prioritized"])).length, 1);
  // Pick now: pokes the Supreme queue.
  await actions.pickNow();
  assert.equal((await queue("supreme").getJobs(["waiting", "prioritized"])).length, 1);
});

test("db push upgrade from the v1.9.5 schema (d757285) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV195Schema(now);
  const git = spawnSync("git", ["show", "d757285:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the v1.9.5 one");
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
  sql(`INSERT INTO Clip (id, momentId, status, caption, channelId, createdAt, updatedAt) VALUES ('c1', 'm1', 'approved', 'cap', 'vcc', 0, 0)`);
  sql(`INSERT INTO Channel (id, name, createdAt) VALUES ('vcc', 'ViceCityClips', 0)`);
  sql(`INSERT INTO Settings (id, migratedChannels) VALUES ('main', 1)`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, channelId, supremePick, supremeRank, qa, cutPlan FROM Clip")), [{ id: "c1", channelId: "vcc", supremePick: false, supremeRank: null, qa: null, cutPlan: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT supremePerChannel, supremeDailyCents, migratedChannels FROM Settings")), [{ supremePerChannel: 5, supremeDailyCents: 25, migratedChannels: true }]);
  assert.deepEqual(JSON.parse(sql("SELECT COUNT(*) AS n FROM AiSpend")), [{ n: 0 }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
