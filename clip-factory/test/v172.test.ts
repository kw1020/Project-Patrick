import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatHeat, GAME_HYPE, HYPE, LAUGH, reaction, spikeCategory } from "../src/lib/chat";
import { categoryOff, skippedNote, twitchClipCategory, youtubeCategory } from "../src/lib/category";
import { parseQueueParams, queueHref, queueWhere } from "../src/lib/queue-filter";
import { filterCreators, sortCreators, summarize, summaryLine, type CreatorRow } from "../src/lib/creators";
import { startMocks, mockEnv, type Mock } from "./mocks";

// v1.7.2: funny | gaming moments (chat laughs, Twitch category, YouTube category/title, Judge label, Settings switches),
// Queue type tabs + creator filter, Creators page (stats, pause, remove).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v172-"));
const storage = path.join(dir, "storage");
const fixtures = path.join(dir, "yt.json");
const calls = path.join(dir, "calls.log");
const SCHEMA = path.join(__dirname, "..", "prisma", "schema.prisma");
const realFetch = globalThis.fetch;
const T0 = 2_000_000_000_000;
const at = (s: number) => T0 + s * 1000;
const UC = (s: string) => `UC${s.padEnd(22, "x")}`;
let mock: Mock;

before(async () => {
  mock = await startMocks();
  // Fake yt-dlp: listing + -J from a fixture file the tests rewrite.
  const fake = path.join(dir, "fake-ytdlp.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixtures)}, "utf8"));
const url = a[a.length - 1];
if (a.includes("--flat-playlist")) {
  const key = Object.keys(fx.lists).find((k) => url.includes(k));
  if (!key) { console.error("ERROR: no such channel"); process.exit(1); }
  console.log(JSON.stringify(fx.lists[key]));
} else {
  const id = new URL(url).searchParams.get("v");
  if (!fx.videos[id]) { console.error("ERROR: Video unavailable"); process.exit(1); }
  console.log(JSON.stringify(fx.videos[id]));
}
`);
  fs.chmodSync(fake, 0o755);
  const env = mockEnv(mock.url) as Record<string, string>;
  delete env.TWITCH_API_URL; delete env.TWITCH_AUTH_URL; // Twitch is stubbed per test with globalThis.fetch
  Object.assign(process.env, env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, REDIS_URL: "redis://localhost:6379/14",
    TWITCH_GAME_ID: "gta6-id", MAX_BACKLOG: "100", MIN_FREE_GB: "0", YTDLP: fake,
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  (await import("../src/lib/twitch")).setSleep(async () => {});
});
afterEach(() => { globalThis.fetch = realFetch; });
after(async () => {
  globalThis.fetch = realFetch;
  const { prisma } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await prisma.$disconnect();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function reset(settings: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany();
  await prisma.youTubeVideo.deleteMany(); await prisma.streamer.deleteMany();
  const s = { clipFunny: true, clipGaming: true, gameMode: "any", spikeEnabled: true, scoutPaused: false, judgeEnabled: true, ...settings };
  await prisma.settings.upsert({ where: { id: "main" }, update: s, create: { id: "main", ...s } });
  return prisma;
}

// ---------- Chat: LAUGH vs gameplay hype ----------
test("LAUGH vs GAME_HYPE: laughs and gameplay hype are told apart; HYPE is still the union", () => {
  const laughs = ["LMAOOO", "lmfao", "KEKW", "OMEGALUL", "LUL", "LULW", "ICANT", "I can't", "i cant 😭", "im dead", "hahaha", "hahahhh", "LOL", "LOOOL", "😂😂😂", "💀", "LMAO no way"];
  const games = ["W", "WWW", "Pog", "PogChamp", "POGGERS", "clip it", "CLIP THAT", "no wayyy", "lets gooo", "LET'S GO", "holy", "HOLY SHIT"];
  const none = ["hello chat", "what is this", "wait", "deadline tomorrow", "haha", "would you", "holyland"];
  for (const m of laughs) { assert.ok(LAUGH.test(m), m); assert.equal(reaction(m), "laugh", m); assert.ok(HYPE.test(m), m); }
  for (const m of games) { assert.ok(GAME_HYPE.test(m), m); assert.equal(reaction(m), "game", m); assert.ok(HYPE.test(m), m); }
  for (const m of none) { assert.equal(reaction(m), null, m); assert.ok(!HYPE.test(m), m); }
});

test("spikeCategory: funny needs laughs >= 50% of reactions AND >= 4 laughs", () => {
  assert.deepEqual(spikeCategory(6, 4), { laughShare: 0.6, category: "funny" });
  assert.deepEqual(spikeCategory(5, 5), { laughShare: 0.5, category: "funny" });
  assert.deepEqual(spikeCategory(4, 6), { laughShare: 0.4, category: "gaming" });
  assert.deepEqual(spikeCategory(3, 0), { laughShare: 1, category: "gaming" }, "3 laughs is too few");
  assert.deepEqual(spikeCategory(0, 0), { laughShare: 0, category: "gaming" });
});

function baseline(c: ChatHeat, login: string) {
  for (let s = 0; s < 300; s++) c.record(login, "hello chat", at(s), `reg${s % 30}`);
}
function burst(c: ChatHeat, login: string, msgs: string[], perSec = 4) {
  for (let s = 300; s < 310; s++) for (let k = 0; k < perSec; k++) c.record(login, msgs[k % msgs.length], at(s) + k * 50, `v_${login}_${s}_${k}`);
}

test("spike(): a laughing chat is a funny spike, a W/Pog flood is gaming, a plain volume spike is gaming; thresholds unchanged", () => {
  const funny = new ChatHeat();
  baseline(funny, "s");
  burst(funny, "s", ["LMAOOO", "KEKW", "😂😂", "im dead"]);
  const f = funny.spike("s", 3, at(309.5));
  assert.ok(f, "spike fires (volume or hype: the category is the same either way)");
  assert.equal(f.category, "funny");
  assert.equal(f.laughShare, 1);

  const game = new ChatHeat();
  baseline(game, "s");
  burst(game, "s", ["W", "PogChamp", "clip it", "LMAO"]); // 1 in 4 is a laugh
  const g = game.spike("s", 3, at(309.5));
  assert.ok(g, "spike fires");
  assert.equal(g.category, "gaming");
  assert.equal(g.laughShare, 0.25);

  const vol = new ChatHeat();
  baseline(vol, "s");
  burst(vol, "s", ["what happened", "bro"]);
  const v = vol.spike("s", 3, at(309.5));
  assert.ok(v && v.kind === "volume", JSON.stringify(v));
  assert.deepEqual([v.category, v.laughShare], ["gaming", 0]);

  // Same thresholds as before: a 3-chatter laugh flood is still nothing.
  const small = new ChatHeat();
  for (let s = 0; s < 300; s++) small.record("s", "hello", at(s), `r${s % 30}`);
  for (let s = 300; s < 310; s++) for (let k = 0; k < 4; k++) small.record("s", "KEKW", at(s) + k * 100, `h${k % 3}`);
  assert.equal(small.spike("s", 3, at(309.5)), null);
});

// ---------- Heuristics ----------
test("Twitch clip category: non-game categories and laugh titles are funny; Sports and games are gaming", () => {
  for (const g of ["Just Chatting", "IRL", "Talk Shows & Podcasts", "Pools, Hot Tubs, and Beaches", "Music", "Art", "ASMR", "Special Events"])
    assert.equal(twitchClipCategory(g, "normal title"), "funny", g);
  for (const g of ["Sports", "Grand Theft Auto VI", "Fortnite", null]) assert.equal(twitchClipCategory(g, "insane play"), "gaming", String(g));
  for (const t of ["LMAOOO he fell", "chat is crying", "im DEAD", "funniest moment", "💀💀", "i can't with this guy", "lol"]) assert.equal(twitchClipCategory("Grand Theft Auto VI", t), "funny", t);
});

test("YouTube category: Gaming/Comedy from yt-dlp win; otherwise gaming words in the title; else funny", () => {
  assert.equal(youtubeCategory("We went to the beach", ["Gaming"]), "gaming");
  assert.equal(youtubeCategory("GTA 6 but every crash makes it worse", ["Comedy"]), "funny");
  for (const t of ["GTA 6 Gameplay part 3", "Minecraft Hardcore Day 100", "Fortnite with the boys", "World record SPEEDRUN", "Elden Ring no hit run"])
    assert.equal(youtubeCategory(t, ["Entertainment"]), "gaming", t);
  for (const t of ["I Survived 50 Hours In Antarctica", "Reacting to my old videos", "Podcast ep 12"]) {
    assert.equal(youtubeCategory(t, ["Entertainment"]), "funny", t);
    assert.equal(youtubeCategory(t, ["People & Blogs"]), "funny", t);
    assert.equal(youtubeCategory(t), "funny", t);
  }
});

test("categoryOff / skippedNote", () => {
  const s = { clipFunny: false, clipGaming: true };
  assert.ok(categoryOff(s, "funny") && !categoryOff(s, "gaming") && !categoryOff(s, null));
  assert.equal(skippedNote({ funny: 2, gaming: 0 }), "skipped 2 funny (off in Settings)");
  assert.equal(skippedNote({ funny: 0, gaming: 0 }), null);
});

// ---------- Judge ----------
test("Judge: schema has category (funny|gaming); the user message carries the first guess and the laugh share", async () => {
  const { VerdictSchema, judgeClip } = await import("../src/lib/judge");
  assert.deepEqual(VerdictSchema.shape.category.options, ["funny", "gaming"]);
  assert.ok(!VerdictSchema.safeParse({ score: 7, hook_text: "h", title: "t", hashtags: [], reason: "r", category: "cooking" }).success);
  mock.requests.length = 0;
  mock.verdict = { ...mock.verdict, category: "funny" };
  const v = await judgeClip({ streamer: "Kai", game: "Just Chatting", durationSec: 30, source: "chat", transcript: "bro what", minScore: 6, category: "funny",
    stats: { kind: "hype", rate: 5, baseline: 1, ratio: 5, hypeShare: 0.8, laughShare: 0.75, viewers: 100, chat: ["KEKW"] } });
  assert.equal(v?.category, "funny");
  const req = JSON.parse(mock.requests.find((r) => r.path.includes("messages"))!.body.toString());
  assert.match(req.messages[0].content, /First guess at the type: funny/);
  assert.match(req.messages[0].content, /Laughs .* were 75% of chat's reactions/);
  const schema = JSON.stringify(req.output_config.format);
  assert.match(schema, /"category"/);
  assert.match(schema, /"funny"/);
  mock.verdict = { ...mock.verdict, category: "gaming" };
});

async function sampleRaw(name: string) {
  const rel = `raw/${name}.mp4`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(storage, rel)]);
  return rel;
}
async function clipAtJudge(prisma: Awaited<ReturnType<typeof reset>>, category: string | null, extra: Record<string, unknown> = {}) {
  const s = await prisma.streamer.create({ data: { twitchId: "j-" + Math.random(), login: "kai", name: "Kai", approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", sourceTitle: "x", sourceViews: 900, gameName: "Just Chatting", category } });
  return prisma.clip.create({ data: { momentId: m.id, status: "processing", stage: "judge", transcript: "hi", duration: 2, winStart: 0, words: "[]", category, ...extra } });
}

test("Judge worker: the Judge's category replaces the first guess on the Clip", async () => {
  const prisma = await reset();
  const { runJudge } = await import("../src/workers/judge");
  const clip = await clipAtJudge(prisma, "gaming");
  mock.verdict = { ...mock.verdict, category: "funny" };
  const msg = await runJudge(clip.id);
  mock.verdict = { ...mock.verdict, category: "gaming" };
  assert.match(String(msg), /8\.4\/10 funny/);
  const after = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id }, include: { moment: true } });
  assert.equal(after.category, "funny");
  assert.equal(after.moment.category, "gaming", "the moment keeps the first guess");
  assert.equal(after.judgeReason, "Clear payoff and chat exploded.");
});

test("Settings off: a clip the Judge labels as a switched-off kind is auto-rejected by the Cutter with a plain reason", async () => {
  const prisma = await reset({ clipFunny: false });
  const { runJudge } = await import("../src/workers/judge");
  const { runCut } = await import("../src/workers/cutter");
  const clip = await clipAtJudge(prisma, "gaming", { rawPath: await sampleRaw("off1") });
  mock.verdict = { ...mock.verdict, category: "funny" }; // scored 8.4: would normally go to review
  await runJudge(clip.id);
  mock.verdict = { ...mock.verdict, category: "gaming" };
  let c = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
  assert.match(c.judgeReason ?? "", /^Funny clips are off in Settings/);
  assert.match(String(await runCut(clip.id)), /auto-rejected/);
  c = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
  assert.equal(c.status, "rejected");
  assert.match(c.judgeReason ?? "", /^Funny clips are off in Settings/);

  // Gaming off, Judge switched off: the first guess decides, and the Cutter writes the reason.
  await prisma.settings.update({ where: { id: "main" }, data: { clipFunny: true, clipGaming: false, judgeEnabled: false } });
  const g = await clipAtJudge(prisma, "gaming", { rawPath: await sampleRaw("off2"), stage: "cut" });
  await runCut(g.id);
  const gc = await prisma.clip.findUniqueOrThrow({ where: { id: g.id } });
  assert.deepEqual([gc.status, gc.judgeReason], ["rejected", "Gaming clips are off in Settings"]);
  // A kind that is on goes to review as before.
  const ok = await clipAtJudge(prisma, "funny", { rawPath: await sampleRaw("on1"), stage: "cut" });
  await runCut(ok.id);
  assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: ok.id } })).status, "pending");
});

// ---------- Moment creation: categories, Settings switches, paused creators ----------
async function liveStreamer(prisma: Awaited<ReturnType<typeof reset>>, login: string, extra: Record<string, unknown> = {}) {
  return prisma.streamer.create({ data: { twitchId: "t-" + login, login, name: login, approved: true, isLive: true, streamId: "st", liveSince: new Date(at(309.5) - 3600_000), viewers: 500, gameName: "Just Chatting", ...extra } });
}

test("spike worker: funny spike → funny moment + clip; funny off → skipped and counted; paused creator → nothing", async () => {
  const prisma = await reset();
  const { runSpikeCheck } = await import("../src/workers/spike");
  await liveStreamer(prisma, "laughy");
  await liveStreamer(prisma, "gamer");
  await liveStreamer(prisma, "sleepy", { paused: true });
  const c = new ChatHeat();
  for (const l of ["laughy", "gamer", "sleepy"]) baseline(c, l);
  burst(c, "laughy", ["LMAOOO", "KEKW", "😂", "ICANT"]);
  burst(c, "gamer", ["W", "Pog", "no way", "clip it"]);
  burst(c, "sleepy", ["LMAOOO", "KEKW", "😂", "ICANT"]);
  const msg = await runSpikeCheck(c, at(309.5), async () => "vod1");
  assert.match(msg ?? "", /laughy: .*funny chat spike/);
  assert.match(msg ?? "", /gamer: .*gaming chat spike/);
  const moments = await prisma.moment.findMany({ include: { clips: true, streamer: true }, orderBy: { streamer: { login: "asc" } } });
  assert.deepEqual(moments.map((m) => [m.streamer.login, m.category, m.clips[0].category]), [["gamer", "gaming", "gaming"], ["laughy", "funny", "funny"]]);
  assert.equal(JSON.parse(moments[1].stats!).laughShare, 1);

  // Funny off: the same kind of spike makes no moment and is counted once.
  await reset({ clipFunny: false });
  await liveStreamer(prisma, "laughy2");
  const d = new ChatHeat();
  baseline(d, "laughy2");
  burst(d, "laughy2", ["LMAOOO", "KEKW", "😂", "ICANT"]);
  assert.equal(await runSpikeCheck(d, at(309.5), async () => "vod1"), "skipped 1 funny (off in Settings)");
  assert.equal(await runSpikeCheck(d, at(309.5) + 5000, async () => "vod1"), null, "not counted again 5s later");
  assert.equal(await prisma.moment.count(), 0);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const twClip = (id: string, broadcaster_id: string, game_id: string, title: string) => ({
  id, url: `https://clips.twitch.tv/${id}`, broadcaster_id, broadcaster_name: "B", creator_name: "x", video_id: "", game_id,
  title, view_count: 500, created_at: new Date().toISOString(), thumbnail_url: "", duration: 30, vod_offset: null,
});
function stubTwitch(clips: Record<string, ReturnType<typeof twClip>[]>, streams: unknown[] = []) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.hostname !== "api.twitch.tv") return realFetch(input, init);
    if (u.pathname.endsWith("/games")) return json({ data: [{ id: "jc", name: "Just Chatting" }, { id: "fn", name: "Fortnite" }].filter((g) => u.searchParams.getAll("id").includes(g.id)) });
    if (u.pathname.endsWith("/clips")) {
      const b = u.searchParams.get("broadcaster_id");
      if (b) asked.push(b);
      return json({ data: b ? clips[b] ?? [] : [], pagination: {} });
    }
    if (u.pathname.endsWith("/streams") && u.searchParams.get("game_id")) return json({ data: [], pagination: {} });
    if (u.pathname.endsWith("/streams")) return json({ data: streams.filter((s) => u.searchParams.getAll("user_id").includes((s as { user_id: string }).user_id)) });
    return json({ data: [], pagination: {} });
  }) as typeof fetch;
  return asked;
}

test("clips poller: Just Chatting / laugh-title clips are funny, game clips gaming; funny off skips them; paused creators aren't asked", async () => {
  const prisma = await reset();
  await prisma.streamer.create({ data: { twitchId: "b1", login: "kai", name: "Kai", approved: true } });
  await prisma.streamer.create({ data: { twitchId: "b2", login: "zzz", name: "Zzz", approved: true, paused: true } });
  const clips = {
    b1: [twClip("c-jc", "b1", "jc", "kai at the store"), twClip("c-fn", "b1", "fn", "200 IQ play"), twClip("c-fn-lol", "b1", "fn", "he fell off LMAO 💀")],
    b2: [twClip("c-paused", "b2", "jc", "paused guy")],
  };
  let asked = stubTwitch(clips);
  const { runClipsPoll } = await import("../src/workers/clips");
  await runClipsPoll();
  assert.ok(!asked.includes("b2"), "paused creator not asked for clips");
  const got = await prisma.moment.findMany({ include: { clips: true } });
  assert.deepEqual(Object.fromEntries(got.map((m) => [m.twitchClipId, [m.category, m.clips[0].category]])),
    { "c-jc": ["funny", "funny"], "c-fn": ["gaming", "gaming"], "c-fn-lol": ["funny", "funny"] });

  await reset({ clipFunny: false });
  await prisma.streamer.create({ data: { twitchId: "b1", login: "kai", name: "Kai", approved: true } });
  asked = stubTwitch(clips);
  const msg = await runClipsPoll();
  assert.match(msg, /1 new sent to the Grabber · skipped 2 funny \(off in Settings\)/);
  assert.deepEqual((await prisma.moment.findMany()).map((m) => m.twitchClipId), ["c-fn"]);
});

test("scout: paused creators are still tracked live but their chat isn't joined", async () => {
  const prisma = await reset();
  await prisma.streamer.create({ data: { twitchId: "u1", login: "awake", name: "Awake", approved: true } });
  await prisma.streamer.create({ data: { twitchId: "u2", login: "napping", name: "Napping", approved: true, paused: true } });
  const st = (user_id: string, login: string) => ({ id: "s" + user_id, user_id, user_login: login, user_name: login, game_id: "jc", game_name: "Just Chatting", title: "t", viewer_count: 10, started_at: new Date().toISOString(), thumbnail_url: "" });
  stubTwitch({}, [st("u1", "awake"), st("u2", "napping")]);
  const joined: string[][] = [];
  const { runScout } = await import("../src/workers/scout");
  await runScout({ setChannels: (l: string[]) => joined.push(l) } as unknown as ChatHeat);
  assert.deepEqual(joined.at(-1), ["awake"]);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "u2" } })).isLive, true);
});

function ytFixtures(categories: string[]) {
  const heat = Array.from({ length: 100 }, (_, i) => ({ start_time: i * 6, end_time: i * 6 + 6, value: [120, 300].includes(i * 6) ? 0.9 : 0.1 }));
  fs.writeFileSync(fixtures, JSON.stringify({
    lists: {
      [`/channel/${UC("fun")}/videos`]: { id: UC("fun"), entries: [{ id: "vidFUN", title: "Our worst road trip", duration: 600 }] },
      [`/channel/${UC("nap")}/videos`]: { id: UC("nap"), entries: [{ id: "vidNAP", title: "x", duration: 600 }] },
    },
    videos: {
      vidFUN: { id: "vidFUN", title: "Our worst road trip", duration: 600, view_count: 1000, timestamp: Math.floor(Date.now() / 1000) - 3600, heatmap: heat, categories },
      vidNAP: { id: "vidNAP", title: "x", duration: 600, view_count: 1000, timestamp: Math.floor(Date.now() / 1000) - 3600, heatmap: heat, categories },
    },
  }));
}

test("YouTube scanner: category from yt-dlp; funny off → video set aside and counted, rescanned once back on; paused channel skipped", async () => {
  const prisma = await reset({ clipFunny: false, ytScanEnabled: true, ytMomentsPerVideo: 2 });
  await prisma.streamer.create({ data: { twitchId: `yt:${UC("fun")}`, platform: "youtube", login: "funchan", name: "Fun Chan", approved: true } });
  await prisma.streamer.create({ data: { twitchId: `yt:${UC("nap")}`, platform: "youtube", login: "napchan", name: "Nap Chan", approved: true, paused: true } });
  ytFixtures(["Comedy"]);
  fs.rmSync(calls, { force: true });
  const { runYouTubeScan } = await import("../src/workers/youtube");
  const msg = await runYouTubeScan();
  assert.match(msg, /^1 channel, 1 videos checked, 0 peaks sent .*skipped 2 funny \(off in Settings\)/);
  assert.equal(await prisma.moment.count(), 0);
  assert.equal((await prisma.youTubeVideo.findUniqueOrThrow({ where: { id: "vidFUN" } })).status, "off_funny");
  assert.ok(!fs.readFileSync(calls, "utf8").includes(UC("nap")), "paused channel never listed");
  // Still off: not fetched again.
  fs.rmSync(calls, { force: true });
  await runYouTubeScan();
  assert.ok(!fs.readFileSync(calls, "utf8").includes("--skip-download"), "set-aside video not re-fetched while funny is off");
  // Back on: its peaks become funny moments.
  await prisma.settings.update({ where: { id: "main" }, data: { clipFunny: true } });
  assert.match(await runYouTubeScan(), /2 peaks sent/);
  const ms = await prisma.moment.findMany({ include: { clips: true } });
  assert.deepEqual(ms.map((m) => [m.category, m.clips[0].category]), [["funny", "funny"], ["funny", "funny"]]);
  // A Gaming-category video is gaming.
  await reset({ ytMomentsPerVideo: 1 });
  await prisma.streamer.create({ data: { twitchId: `yt:${UC("fun")}`, platform: "youtube", login: "funchan", name: "Fun Chan", approved: true } });
  ytFixtures(["Gaming"]);
  await runYouTubeScan();
  assert.deepEqual((await prisma.moment.findMany()).map((m) => m.category), ["gaming"]);
});

test("saveSettings stores the What to clip switches; setPaused / removeStreamer", async () => {
  const prisma = await reset();
  const actions = await import("../app/actions");
  const f = new FormData();
  f.set("clipGaming", "on"); // funny unticked
  await actions.saveSettings(f);
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.deepEqual([s.clipFunny, s.clipGaming], [false, true]);
  const row = await prisma.streamer.create({ data: { twitchId: "p1", login: "p1", name: "P1", approved: true } });
  await actions.setPaused(row.id, true);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: row.id } })).paused, true);
  await actions.setPaused(row.id, false);
  await actions.setPaused(row.id, true);
  await actions.removeStreamer(row.id);
  const gone = await prisma.streamer.findUniqueOrThrow({ where: { id: row.id } });
  assert.deepEqual([gone.approved, gone.paused], [false, false]);
  await actions.setApproved(row.id, true);
  assert.ok((await prisma.streamer.findUniqueOrThrow({ where: { id: row.id } })).approvedAt instanceof Date, "approval date recorded");
});

// ---------- Queue filter ----------
test("queue filter: cat + creator params, where clause, links, and real counts", async () => {
  assert.deepEqual(parseQueueParams({}), { tab: "pending", cat: "all", creator: null });
  assert.deepEqual(parseQueueParams({ tab: "posted", cat: "funny", creator: "abc123" }), { tab: "posted", cat: "funny", creator: "abc123" });
  assert.deepEqual(parseQueueParams({ tab: "nope", cat: "cooking", creator: "x y;drop" }), { tab: "pending", cat: "all", creator: null });
  const f = parseQueueParams({ cat: "funny", creator: "s1" });
  assert.deepEqual(queueWhere(f), { status: "pending", category: "funny", moment: { streamerId: "s1" } });
  assert.deepEqual(queueWhere(f, "cat"), { status: "pending", moment: { streamerId: "s1" } });
  assert.deepEqual(queueWhere(f, "tab"), { category: "funny", moment: { streamerId: "s1" } });
  assert.equal(queueHref(f, { tab: "approved" }), "/queue?tab=approved&cat=funny&creator=s1");
  assert.equal(queueHref(f, { cat: "all", creator: null }), "/queue");

  const prisma = await reset();
  const a = await prisma.streamer.create({ data: { twitchId: "qa", login: "qa", name: "QA", approved: true } });
  const b = await prisma.streamer.create({ data: { twitchId: "qb", login: "qb", name: "QB", approved: true } });
  const mk = async (sid: string, category: string | null, status = "pending") => {
    const m = await prisma.moment.create({ data: { streamerId: sid, timestamp: new Date(), source: "chat", category } });
    await prisma.clip.create({ data: { momentId: m.id, status, category } });
  };
  await mk(a.id, "funny"); await mk(a.id, "funny"); await mk(a.id, "gaming"); await mk(b.id, "funny"); await mk(b.id, null); await mk(a.id, "funny", "posted");
  const n = (q: Parameters<typeof parseQueueParams>[0]) => prisma.clip.count({ where: queueWhere(parseQueueParams(q)) });
  assert.equal(await n({}), 5);
  assert.equal(await n({ cat: "funny" }), 3);
  assert.equal(await n({ cat: "gaming" }), 1);
  assert.equal(await n({ cat: "funny", creator: a.id }), 2);
  assert.equal(await n({ tab: "posted", cat: "funny", creator: a.id }), 1);
});

// ---------- Creators ----------
const row = (o: Partial<CreatorRow> & { id: string; name: string }): CreatorRow => ({
  login: o.name.toLowerCase(), platform: "twitch", avatar: null, live: false, viewers: 0, gameName: null, paused: false, approvalNote: null,
  approvedAt: new Date(0), moments: 0, clips: 0, approved: 0, posted: 0, views: 0, lastClipAt: null, ...o,
});

test("creators: sort live first then most clips; search + filters; summary line", () => {
  const rows = sortCreators([
    row({ id: "1", name: "Alpha", clips: 3 }), row({ id: "2", name: "Bravo", clips: 9, platform: "youtube", login: "bravoyt" }),
    row({ id: "3", name: "Charlie", live: true, clips: 1 }), row({ id: "4", name: "delta", clips: 3, paused: true }),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["Charlie", "Bravo", "Alpha", "delta"]);
  assert.deepEqual(filterCreators(rows, { filter: "twitch" }).map((r) => r.id), ["3", "1", "4"]);
  assert.deepEqual(filterCreators(rows, { filter: "youtube" }).map((r) => r.id), ["2"]);
  assert.deepEqual(filterCreators(rows, { filter: "live" }).map((r) => r.id), ["3"]);
  assert.deepEqual(filterCreators(rows, { q: "AL" }).map((r) => r.id), ["1"]);
  assert.deepEqual(filterCreators(rows, { q: "@bravoyt" }).map((r) => r.id), ["2"], "login / @handle works too");
  assert.deepEqual(filterCreators(rows, { q: "al", filter: "youtube" }), []);
  assert.equal(summaryLine(summarize(rows)), "4 creators · 3 Twitch · 1 YouTube · 1 live now · 1 paused");
  assert.equal(summaryLine({ total: 21, twitch: 14, youtube: 7, live: 3, paused: 0 }), "21 creators · 14 Twitch · 7 YouTube · 3 live now");
});

test("creators: stats from the database (moments, cut clips, approved, posted, views, last clip); only approved creators", async () => {
  const prisma = await reset();
  const kai = await prisma.streamer.create({ data: { twitchId: "k", login: "kai", name: "Kai", approved: true, approvalNote: "Paid campaign", isLive: true, gameName: "Just Chatting", viewers: 9000 } });
  const yt = await prisma.streamer.create({ data: { twitchId: `yt:${UC("mb")}`, platform: "youtube", login: "mrbeast", name: "MrBeast", approved: true, isLive: true } });
  await prisma.streamer.create({ data: { twitchId: "x", login: "nope", name: "Nope", approved: false } });
  const mk = async (sid: string, status: string, duration: number | null, views: number[] = [], createdAt = new Date()) => {
    const m = await prisma.moment.create({ data: { streamerId: sid, timestamp: new Date(), source: "chat" } });
    const c = await prisma.clip.create({ data: { momentId: m.id, status, duration, createdAt } });
    for (const v of views) await prisma.post.create({ data: { clipId: c.id, platform: "youtube", views: v } });
  };
  const old = new Date(Date.now() - 86400_000), recent = new Date(Date.now() - 3600_000);
  await mk(kai.id, "posted", 30, [1000, 250], old);
  await mk(kai.id, "approved", 30, [], recent);
  await mk(kai.id, "rejected", 30);
  await mk(kai.id, "processing", null);
  await mk(kai.id, "failed", null);
  await prisma.moment.create({ data: { streamerId: kai.id, timestamp: new Date(), source: "chat" } }); // moment, no clip
  await prisma.post.create({ data: { clipId: (await prisma.clip.findFirstOrThrow({ where: { status: "posted" } })).id, platform: "tiktok", status: "draft", views: 99999 } });
  const { creatorStats, getCreators } = await import("../src/lib/creators");
  const rows = await creatorStats();
  assert.deepEqual(rows.map((r) => r.name), ["Kai", "MrBeast"]);
  const k = rows[0];
  assert.deepEqual({ moments: k.moments, clips: k.clips, approved: k.approved, posted: k.posted, views: k.views, live: k.live, game: k.gameName, note: k.approvalNote },
    { moments: 6, clips: 3, approved: 2, posted: 1, views: 1250, live: true, game: "Just Chatting", note: "Paid campaign" });
  assert.ok(k.lastClipAt && Math.abs(k.lastClipAt.getTime() - Date.now()) < 60_000, "newest cut clip");
  assert.equal(rows[1].live, false, "a YouTube row is never 'live'");
  assert.deepEqual([rows[1].clips, rows[1].lastClipAt], [0, null]);
  const g = await getCreators({ filter: "youtube" });
  assert.deepEqual(g.summary, { total: 2, twitch: 1, youtube: 1, live: 1, paused: 0 });
  assert.deepEqual(g.creators.map((r) => r.id), [yt.id]);
});

// ---------- Database upgrade ----------
test("db push upgrade from the v1.7.1 schema (5486a81) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  // v1.7.1 = today's schema without the v1.7.2 lines.
  const old = now
    .replace(/^ {2}(paused|approvedAt|category|clipFunny|clipGaming)\s.*\n/gm, "")
    .replace(/^\/\/ \| off_funny.*\n/m, "");
  for (const f of ["paused", "approvedAt", "category", "clipFunny", "clipGaming"]) assert.doesNotMatch(old, new RegExp(`^\\s+${f}\\s`, "m"), f);
  const git = spawnSync("git", ["show", "5486a81:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 5486a81 one");
  const uniques = (s: string) => (s.match(/@unique|@@unique|@@id/g) ?? []).length;
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
  `], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, approvalNote, createdAt, updatedAt) VALUES
    ('a', '2', 'kaicenat', 'KaiCenat', 'twitch', 1, 'Paid campaign', 0, 0),
    ('b', 'yt:${UC("b")}', 'mrbeast', 'MrBeast', 'youtube', 1, 'Approved by Krew', 0, 0)`);
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'chat', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 0, 0)`);
  sql(`INSERT INTO Settings (id, gameMode) VALUES ('main', 'any')`);
  // Exactly what the web container runs on start: no flags.
  const second = push(SCHEMA);
  const out = second.stdout + second.stderr;
  assert.equal(second.status, 0, out);
  assert.doesNotMatch(out, /data loss|accept-data-loss|unique constraint/i);
  assert.match(out, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, login, approved, approvalNote, paused, approvedAt FROM Streamer ORDER BY id")), [
    { id: "a", login: "kaicenat", approved: 1, approvalNote: "Paid campaign", paused: 0, approvedAt: null },
    { id: "b", login: "mrbeast", approved: 1, approvalNote: "Approved by Krew", paused: 0, approvedAt: null },
  ].map((r) => ({ ...r, approved: true, paused: false })));
  assert.deepEqual(JSON.parse(sql("SELECT m.category AS mc, c.category AS cc, c.status FROM Clip c JOIN Moment m ON m.id = c.momentId")), [{ mc: null, cc: null, status: "pending" }]);
  assert.deepEqual(JSON.parse(sql("SELECT gameMode, clipFunny, clipGaming FROM Settings")), [{ gameMode: "any", clipFunny: true, clipGaming: true }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
