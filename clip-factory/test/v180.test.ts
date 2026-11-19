import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPayoff, loudestStretch, pickSmartWindow, reactionBurst, timedTranscript, validJudgeWindow, windowWords } from "../src/lib/window";
import { clipSpan, dedupe, median, overlaps, roundRobin, scoreCreatorClips } from "../src/lib/standout";
import { isQuiet, planEdit, planJumpCuts, segsDuration, silenceThreshold } from "../src/lib/edit";
import { parseJumpCuts } from "../src/lib/edit-styles";
import { probeDuration, run, type Word } from "../src/lib/media";
import type { TwitchClip } from "../src/lib/twitch";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV173Schema } from "./schema-v173";

// v1.8.0 "Better moments": any game by default, standout clips + fair mix, a window that lands on the payoff,
// a Judge that can pick the best stretch, and jump cuts that only cut real silence.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v180-"));
const storage = path.join(dir, "storage");
const SCHEMA = path.join(__dirname, "..", "prisma", "schema.prisma");
const realFetch = globalThis.fetch;
const HOUR = 3600_000;
let mock: Mock;

before(async () => {
  mock = await startMocks();
  const env = mockEnv(mock.url) as Record<string, string>;
  delete env.TWITCH_API_URL; delete env.TWITCH_AUTH_URL; // Twitch is stubbed per test with globalThis.fetch
  Object.assign(process.env, env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, REDIS_URL: "redis://localhost:6379/13",
    TWITCH_GAME_ID: "gta6-id", MAX_BACKLOG: "100", MIN_FREE_GB: "0", WHISPER_ENGINE: "off",
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

/** Words with a talking burst at each [start, n] (0.3s per word). */
function talk(...bursts: [number, number][]): Word[] {
  const out: Word[] = [];
  for (const [s, n] of bursts) for (let i = 0; i < n; i++) out.push({ word: `w${out.length}`, start: s + i * 0.3, end: s + i * 0.3 + 0.28 });
  return out;
}
/** 100ms levels: `base` dB everywhere, `loud` dB inside each [from, to) range. */
function levelsWith(length: number, base: number, ...ranges: [number, number, number][]): number[] {
  return Array.from({ length: Math.round(length * 10) }, (_, i) => {
    const t = i / 10 + 0.05;
    const r = ranges.find(([a, b]) => t >= a && t < b);
    return r ? r[2] : base;
  });
}
/** 100ms levels: -20 dB while a word is spoken, `gap` dB elsewhere. */
const speech = (words: Word[], length: number, gap = -70) =>
  Array.from({ length: Math.round(length * 10) }, (_, i) => (words.some((w) => i / 10 + 0.05 >= w.start && i / 10 + 0.05 <= w.end) ? -20 : gap));

// ---------- Window placement (pure) ----------
test("window: payoff near the end of a 60s clip -> the window ends ~3s after it, length within 15-35s", () => {
  const words: Word[] = Array.from({ length: 120 }, (_, i) => ({ word: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const w = pickSmartWindow({ duration: 60, payoff: 57, words, minSec: 15, maxSec: 35 });
  const end = w.start + w.length;
  assert.ok(end - 57 >= 1.5 && end - 57 <= 3.5, `ends ${end - 57}s after the payoff`);
  assert.ok(w.length >= 15 && w.length <= 35, String(w.length));
  // The payoff sits in the back part of the window (build-up first).
  assert.ok((57 - w.start) / w.length >= 0.6);
});

test("window: ends just after the reaction (+ a capper line), starts on a sentence ~80% of max earlier: payoff ~2/3 in", () => {
  // Steady talk, sentences every 4.2s; a reaction at 30s ("no no what bro"), then a capper line, then more rambling.
  const words = talk([0, 14], [4.5, 14], [9, 14], [13.5, 14], [18, 14], [22.5, 14]).map((w, i) => (i % 14 === 13 ? { ...w, word: "it." } : w));
  const react: Word[] = [{ word: "no", start: 30, end: 30.2 }, { word: "no", start: 30.4, end: 30.6 }, { word: "what!", start: 31, end: 31.4 }, { word: "bro", start: 31.8, end: 32.1 }];
  const capper = talk([33, 8]).map((w, i) => (i === 7 ? { ...w, word: "happened." } : w)); // 33 -> 35.38
  const after = talk([37, 30]); // he moves on
  const all = [...words, ...react, ...capper, ...after];
  const w = pickSmartWindow({ duration: 60, payoff: 30, words: all, minSec: 15, maxSec: 35 });
  const end = w.start + w.length;
  assert.ok(Math.abs(end - 35.78) < 0.05, `ends after the capper line: ${end}`);
  assert.equal(w.start, 9 - 0.25, "starts on a sentence start, 0.25s early");
  const at = (30 - w.start) / w.length;
  assert.ok(at > 0.6 && at < 0.85, `payoff at ${at}`);
  // No words: the end is 2s after the payoff at least, the length 80% of max.
  const plain = pickSmartWindow({ duration: 60, payoff: 30, words: [], minSec: 15, maxSec: 35 });
  assert.deepEqual(plain, { start: 4, length: 28 });
  // The reaction chain on its own (no capper): ends 0.8s after the last reaction word.
  const noCap = pickSmartWindow({ duration: 60, payoff: 30, words: [...words, ...react], minSec: 15, maxSec: 35 });
  assert.ok(Math.abs(noCap.start + noCap.length - 32.9) < 0.05, String(noCap.start + noCap.length));
});

test("window: no words -> loudness JUMPS (not the loudest second); Twitch clips look in the last 70%", () => {
  // Loud early (5s) and a bit less loud late (30s) over a quiet bed: a viewer clip's payoff is the late one, at its onset.
  const levels = levelsWith(40, -45, [5, 6.5, -8], [30, 31.5, -12]);
  const p = findPayoff({ source: "twitch_clip", duration: 40, levels, words: [] });
  assert.equal(p.at, 30);
  assert.equal(p.why, "loudness jump");
  const w = pickSmartWindow({ duration: 40, payoff: p.at, words: [], minSec: 15, maxSec: 35, levels });
  assert.ok(w.start + w.length >= 32 && w.start + w.length <= 33, `ends ~1s after the loud stretch: ${w.start + w.length}`);
  // Not a viewer clip: anywhere counts (the first big jump).
  assert.equal(findPayoff({ source: "youtube", duration: 40, levels, words: [] }).at, 5);
  // Silent and wordless: a late default spot for viewer clips, the middle otherwise.
  assert.equal(findPayoff({ source: "twitch_clip", duration: 40, levels: [], words: [] }).at, 28);
  assert.equal(findPayoff({ source: "chat", duration: 40, levels: [], words: [] }).at, 20);
  // Game audio loud all the time with louder gunfire bursts everywhere: the steady loudest second means nothing;
  // a scream 10 dB over the usual level does.
  const game = levelsWith(60, -18, [12, 12.4, -9], [20, 20.3, -9], [27, 27.4, -9], [44, 46, -6]);
  assert.ok(Math.abs(findPayoff({ source: "twitch_clip", duration: 60, levels: game, words: [] }).at - 44) <= 0.2);
  // Talking that starts again after a pause is NOT a payoff (it is only back at the usual level).
  const pauses = levelsWith(60, -40, [5, 15, -18], [20, 30, -18], [35, 45, -18], [50, 58, -18]);
  assert.match(findPayoff({ source: "twitch_clip", duration: 60, levels: pauses, words: [] }).why, /no clear/);
});

test("window: short source -> whole source; dead-air openings are skipped; reaction words and hints count", () => {
  assert.deepEqual(pickSmartWindow({ duration: 12, payoff: 10, words: talk([1, 10]), minSec: 15, maxSec: 35 }), { start: 0, length: 12 });
  // 30s source (fits): the first 4s are silence before anyone talks -> start just before the first word.
  const w = pickSmartWindow({ duration: 30, payoff: 22, words: talk([4, 60]), minSec: 15, maxSec: 35 });
  assert.equal(w.start, 3.75);
  assert.ok(w.start + w.length >= 24 && w.start + w.length <= 24.5, `ends ~2s after the payoff: ${w.start + w.length}`);
  // Reaction words: "oh no bro what" in 3s.
  const words: Word[] = [...talk([2, 10]), { word: "oh", start: 40, end: 40.2 }, { word: "no", start: 40.4, end: 40.6 }, { word: "bro!", start: 41, end: 41.3 }, { word: "WHAT", start: 42, end: 42.4 }];
  assert.deepEqual(reactionBurst(words), { at: 41, count: 4 });
  assert.equal(findPayoff({ source: "twitch_clip", duration: 50, levels: [], words }).at, 40);
  // Whisper writes laughter as separate "Ha" tokens: they count.
  assert.equal(reactionBurst([{ word: "Ha", start: 10, end: 10.2 }, { word: "ha", start: 10.3, end: 10.5 }, { word: "ha.", start: 10.6, end: 10.8 }])?.count, 3);
  // Loudness and reactions agree.
  const both = findPayoff({ source: "twitch_clip", duration: 50, levels: levelsWith(50, -40, [40, 43.5, -10]), words });
  assert.equal(both.why, "loudness jump + reactions");
  assert.equal(both.at, 40);
  // Chat spike: the known reaction point, sharpened to a loud moment close by.
  assert.equal(findPayoff({ source: "chat", duration: 45, levels: levelsWith(45, -40), words: [], hint: 30 }).at, 30);
  const sharp = findPayoff({ source: "chat", duration: 45, levels: levelsWith(45, -40, [32, 33.5, -10]), words: [], hint: 30 });
  assert.equal(sharp.at, 32);
  assert.match(sharp.why, /chat reaction \+ loudness jump near it/);
  assert.equal(loudestStretch(levelsWith(10, -80)), null, "silence = no peak");
});

test("Judge window validation + window words + timed transcript", () => {
  const o = { duration: 60, minSec: 15, maxSec: 35 };
  assert.deepEqual(validJudgeWindow({ start: 31.5, end: 58 }, o), { start: 31.5, length: 26.5 });
  assert.equal(validJudgeWindow({ start: null, end: null }, o), null);
  assert.equal(validJudgeWindow({ start: 50, end: 55 }, o), null, "too short");
  assert.equal(validJudgeWindow({ start: 5, end: 55 }, o), null, "too long");
  assert.equal(validJudgeWindow({ start: 40, end: 70 }, o), null, "past the end");
  assert.equal(validJudgeWindow({ start: -3, end: 20 }, o), null, "before the start");
  assert.equal(validJudgeWindow({ start: 30, end: 20 }, o), null, "backwards");
  assert.deepEqual(validJudgeWindow({ start: 0, end: 12 }, { duration: 12, minSec: 15, maxSec: 35 }), { start: 0, length: 12 }, "short source: whole is fine");
  assert.deepEqual(windowWords([{ word: "a", start: 9, end: 10.5 }, { word: "b", start: 11, end: 11.4 }, { word: "c", start: 40, end: 41 }], 10, 20),
    [{ word: "a", start: 0, end: 0.5 }, { word: "b", start: 1, end: 1.4 }]);
  const t = timedTranscript([{ word: "okay", start: 1.2, end: 1.5 }, { word: "watch.", start: 1.6, end: 2 }, { word: "NO", start: 12.4, end: 12.8 }, { word: "WAY!", start: 12.9, end: 13.3 }]);
  assert.equal(t, "[1.2s] okay watch.\n[12.4s] NO WAY!");
});

// ---------- Jump cuts only cut real silence ----------
test("jump cuts: a loud gap (music / untranscribed talk) is NOT cut; a truly silent gap is", () => {
  const words = talk([1, 6], [6, 6], [12, 6]); // gaps 2.78->6 and 7.78->12
  const loud = speech(words, 20, -70).map((v, i) => (i >= 30 && i < 60 ? -24 : v)); // 3-6s: music under the gap
  const a = planEdit({ style: "hype", words, length: 20, minSec: 8, peak: 17, levels: loud });
  assert.ok(a.segs.every((s) => !(s.end > 3.2 && s.end < 5.8)), "nothing cut inside the loud gap");
  const silent = speech(words, 20, -70);
  const b = planEdit({ style: "hype", words, length: 20, minSec: 8, peak: 17, levels: silent });
  assert.ok(b.segs.length > 1, "silent gap cut");
  // No loudness at all (no audio / measuring failed): nothing is cut.
  assert.equal(planEdit({ style: "hype", words, length: 20, minSec: 8, peak: null }).segs.length, 1);
  assert.equal(planEdit({ style: "hype", words, length: 20, minSec: 8, peak: null, levels: [] }).segs.length, 1);
  // Threshold: 20 dB under speech, never above -45 (quiet game/music beds are not silence).
  assert.equal(silenceThreshold(silent, words), -45);
  assert.equal(silenceThreshold(speech(words, 20, -70).map((v) => (v === -20 ? -30 : v)), words), -50);
  assert.equal(isQuiet(silent, 3.2, 5.6, -35), true);
  assert.equal(isQuiet(loud, 3.2, 5.6, -35), false);
  assert.equal(isQuiet(silent, 19, 25, -35), false, "past the measured audio = not quiet");
});

test("jump cuts: light caps (1.2s gaps, 0.35s pads, <= 15%, <= 4 cuts, not near the payoff); normal cuts more; off = none", () => {
  // 60s: 9 bursts with 2s silent gaps.
  const bursts: [number, number][] = Array.from({ length: 9 }, (_, i) => [i * 6.5, 15] as [number, number]); // 4.5s talk + 2s gap
  const words = talk(...bursts);
  const levels = speech(words, 60);
  const light = planEdit({ style: "clean", words, length: 60, minSec: 15, peak: null, levels });
  const removed = 60 - light.duration;
  assert.ok(light.segs.length - 1 <= 4, `${light.segs.length - 1} cuts`);
  assert.ok(removed <= 0.15 * 60 + 1e-6, `removed ${removed}s`);
  for (let i = 1; i < light.segs.length; i++) {
    const gapStart = light.segs[i - 1].end, gapEnd = light.segs[i].start;
    const before = words.filter((w) => w.end <= gapStart + 0.01).pop()!, after = words.find((w) => w.start >= gapEnd - 0.01)!;
    assert.ok(gapStart - before.end >= 0.33 && after.start - gapEnd >= 0.33, "0.35s kept either side");
  }
  // A 1.0s silent gap: light keeps it, normal cuts it.
  const short = talk([0, 15], [5.48, 15], [11, 15]); // gaps of ~1.0s
  const sl = speech(short, 16);
  assert.equal(planEdit({ style: "hype", words: short, length: 16, minSec: 5, peak: null, levels: sl, jumpCuts: "light" }).segs.length, 1);
  assert.ok(planEdit({ style: "hype", words: short, length: 16, minSec: 5, peak: null, levels: sl, jumpCuts: "normal" }).segs.length > 1);
  assert.equal(planEdit({ style: "hype", words, length: 60, minSec: 15, peak: null, levels, jumpCuts: "off" }).segs.length, 1);
  // Never within 1s of the payoff: the gap right before it stays.
  const near = planEdit({ style: "clean", words, length: 60, minSec: 15, peak: 13.3, levels }); // gap 10.78->13.0 ends 0.3s before the payoff
  assert.ok(near.segs.some((s) => s.start <= 11 && s.end >= 13.3), "gap before the payoff kept");
  // planJumpCuts low level: share cap on its own.
  const capped = planJumpCuts({ words, length: 60, minSec: 5, maxGap: 1.2, pad: 0.35, maxShare: 0.05, levels });
  assert.ok(60 - segsDuration(capped) <= 3 + 1e-6);
  assert.equal(parseJumpCuts("nope"), "light");
  assert.equal(parseJumpCuts("off"), "off");
});

// ---------- Standout scoring, dedupe, fair mix (pure) ----------
const NOW = Date.UTC(2026, 10, 18, 12);
let n = 0, made = 0; // made: every clip gets its own creation time (clips made within 30s = the same moment)
function tc(broadcaster_id: string, views: number, o: Partial<TwitchClip> & { ageH?: number } = {}): TwitchClip {
  const id = o.id ?? `c${++n}`;
  made++;
  return {
    id, url: `https://clips.twitch.tv/${id}`, broadcaster_id, broadcaster_name: "B", creator_name: "x", video_id: o.video_id ?? "", game_id: o.game_id ?? "jc",
    title: o.title ?? `clip ${id}`, view_count: views, created_at: new Date((o.created_at ? Date.parse(o.created_at) : NOW) - (o.ageH ?? 1) * HOUR - (o.created_at ? 0 : made * 120_000)).toISOString(),
    thumbnail_url: "", duration: o.duration ?? 30, vod_offset: o.vod_offset ?? null,
  };
}

test("standout scoring: against the creator's own median, recency-weighted, best clip always allowed at 5x minClipViews", () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  const clips = [tc("k", 5000, { id: "big" }), tc("k", 900, { id: "old", ageH: 150 }), tc("k", 1000, { id: "new", ageH: 1 }), ...Array.from({ length: 7 }, () => tc("k", 300))];
  const { kept, median: med } = scoreCreatorClips(clips, { minClipViews: 25, standoutMin: 2, now: NOW });
  assert.equal(med, 300);
  assert.deepEqual(kept.map((k) => k.clip.id), ["big", "new", "old"]);
  assert.ok(Math.abs(kept[0].standout - 16.67) < 0.01);
  // 1000 views 1h old beats 900 views 150h old by more than the raw views say.
  assert.ok(kept[1].rank / kept[2].rank > 2);
  // Everything about the same: nothing standout, unless the best has >= 5x minClipViews.
  assert.equal(scoreCreatorClips([tc("f", 100), tc("f", 100), tc("f", 90)], { minClipViews: 25, standoutMin: 2, now: NOW }).kept.length, 0);
  assert.deepEqual(scoreCreatorClips([tc("f", 200, { id: "top" }), tc("f", 200), tc("f", 190)], { minClipViews: 25, standoutMin: 2, now: NOW }).kept.map((k) => k.clip.id), ["top"]);
  // Small channel: the floor is minClipViews, not a tiny median.
  assert.deepEqual(scoreCreatorClips([tc("s", 60, { id: "s60" }), tc("s", 3), tc("s", 2)], { minClipViews: 25, standoutMin: 2, now: NOW }).kept.map((k) => k.clip.id), ["s60"]);
  assert.equal(scoreCreatorClips([tc("s", 20), tc("s", 2), tc("s", 1)], { minClipViews: 25, standoutMin: 2, now: NOW }).kept.length, 0, "below minClipViews");
});

test("dedupe: the same moment clipped several times keeps the most-viewed; existing moments block overlaps (+-20s)", () => {
  const a = tc("k", 5000, { id: "a", video_id: "v1", vod_offset: 100 });
  const b = tc("k", 4000, { id: "b", video_id: "v1", vod_offset: 125 }); // 25s later, 30s long: overlaps
  const c = tc("k", 3000, { id: "c", video_id: "v1", vod_offset: 400 });
  const d = tc("k", 2000, { id: "d", video_id: "v2", vod_offset: 100 }); // other VOD
  const e = tc("k", 1000, { id: "e" }); // no VOD info: never a duplicate
  const scored = scoreCreatorClips([a, b, c, d, e, ...Array.from({ length: 8 }, () => tc("k", 10))], { minClipViews: 25, standoutMin: 2, now: NOW }).kept;
  assert.deepEqual(dedupe(scored).map((k) => k.clip.id), ["a", "c", "d", "e"]);
  assert.deepEqual(dedupe(scored, [{ vodId: "v1", from: 380, to: 395 }]).map((k) => k.clip.id), ["a", "d", "e"], "existing chat moment at 380-395 blocks c (400)");
  assert.equal(overlaps(clipSpan(a), clipSpan(b)), true);
  assert.equal(overlaps(clipSpan(a), { vodId: "v1", from: 151, to: 160 }), false, "21s after a's end");
  assert.equal(clipSpan(e), null);
});

test("round-robin: one per creator in turn (best creator first), per-creator cap, total limit", () => {
  const lists = [
    [{ id: "k1", rank: 16 }, { id: "k2", rank: 6 }, { id: "k3", rank: 5 }],
    [{ id: "h1", rank: 30 }, { id: "h2", rank: 25 }, { id: "h3", rank: 24 }],
    [{ id: "s1", rank: 2.4 }],
    [],
  ];
  assert.deepEqual(roundRobin(lists, 2, 15).map((p) => p.pick.id), ["h1", "k1", "s1", "h2", "k2"]);
  assert.deepEqual(roundRobin(lists, 2, 3).map((p) => p.pick.id), ["h1", "k1", "s1"], "a full-ish line still gets one each");
  assert.deepEqual(roundRobin(lists, 1, 15).map((p) => p.creator), [1, 0, 2]);
  assert.deepEqual(roundRobin(lists, 5, 0), []);
});

// ---------- Clips poller against a Twitch stand-in ----------
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
function stubTwitch(clips: Record<string, TwitchClip[]>, gameWide: TwitchClip[] = []) {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.hostname !== "api.twitch.tv") return realFetch(input, init);
    asked.push(u);
    if (u.pathname.endsWith("/games")) return json({ data: [{ id: "jc", name: "Just Chatting" }, { id: "fn", name: "Fortnite" }].filter((g) => u.searchParams.getAll("id").includes(g.id)) });
    if (u.pathname.endsWith("/clips")) {
      const b = u.searchParams.get("broadcaster_id");
      return json({ data: b ? clips[b] ?? [] : gameWide, pagination: {} });
    }
    return json({ data: [], pagination: {} });
  }) as typeof fetch;
  return asked;
}
async function reset(settings: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany(); await prisma.streamer.deleteMany();
  await prisma.settings.deleteMany();
  await prisma.settings.create({ data: { id: "main", ...settings } });
  return prisma;
}
const creators = [["k1", "kai", "Kai"], ["h1", "hasan", "Hasan"], ["s1", "smally", "Smally"], ["f1", "flat", "Flat"], ["e1", "empty", "Empty"], ["p1", "napper", "Napper"]];
function feed(): Record<string, TwitchClip[]> {
  return {
    k1: [tc("k1", 5000, { id: "kai-big", video_id: "kv", vod_offset: 100 }), tc("k1", 4000, { id: "kai-dupe", video_id: "kv", vod_offset: 110 }),
      tc("k1", 2000, { id: "kai-2k", video_id: "kv", vod_offset: 900 }), tc("k1", 900, { id: "kai-900", ageH: 100 }), ...Array.from({ length: 8 }, () => tc("k1", 300))],
    h1: [tc("h1", 3000, { id: "h-3k" }), tc("h1", 2500, { id: "h-25" }), tc("h1", 2400, { id: "h-24" }), ...Array.from({ length: 4 }, () => tc("h1", 100))],
    s1: [tc("s1", 60, { id: "s-60", game_id: "fn" }), tc("s1", 20), tc("s1", 20)],
    f1: [tc("f1", 100), tc("f1", 100), tc("f1", 100)],
    p1: [tc("p1", 9000, { id: "paused-big" }), tc("p1", 10), tc("p1", 10)],
  };
}

test("clips poller: standout only, near-duplicates skipped, fair round-robin, per-creator cap, honest status line", async () => {
  const prisma = await reset({ gameMode: "any" });
  for (const [twitchId, login, name] of creators) await prisma.streamer.create({ data: { twitchId, login, name, approved: true, paused: twitchId === "p1" } });
  // The spike detector already caught kai's 2k moment from chat.
  const kai = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "k1" } });
  await prisma.moment.create({ data: { streamerId: kai.id, timestamp: new Date(), source: "chat", vodId: "kv", vodOffset: 920 } });
  const asked = stubTwitch(feed(), [tc("x", 99999, { id: "gta-wide" })]);
  const { runClipsPoll } = await import("../src/workers/clips");
  const msg = await runClipsPoll();
  assert.equal(msg, "picked 5 standout clips from 3 creators · 2 had nothing standout · rest next scan");
  const got = await prisma.moment.findMany({ where: { source: "twitch_clip" }, include: { streamer: true } });
  const ids = got.map((m) => m.twitchClipId).sort();
  assert.deepEqual(ids, ["h-25", "h-3k", "kai-900", "kai-big", "s-60"].sort());
  assert.ok(!ids.includes("kai-dupe"), "same moment clipped twice: only the most-viewed");
  assert.ok(!ids.includes("kai-2k"), "already caught by the spike detector");
  assert.ok(!ids.includes("paused-big"), "paused creators are skipped");
  assert.ok(!asked.some((u) => u.searchParams.get("broadcaster_id") === "p1"), "paused creator not asked");
  assert.ok(!asked.some((u) => u.pathname.endsWith("/clips") && u.searchParams.has("game_id")), "any mode: no game-wide GTA query");
  const lookback = asked.find((u) => u.pathname.endsWith("/clips"))!.searchParams.get("started_at")!;
  assert.ok(Math.abs(Date.now() - Date.parse(lookback) - 168 * HOUR) < 60_000, "7-day lookback by default");
  const s60 = got.find((m) => m.twitchClipId === "s-60")!;
  assert.equal(s60.gameName, "Fortnite");
  assert.ok(Math.abs(s60.spikeScore - 2.4) < 0.01, "spikeScore = how far it stands out");

  // Second scan: Hasan's third standout clip (over the per-creator cap last time); then nothing new.
  stubTwitch(feed());
  assert.equal(await runClipsPoll(), "picked 1 standout clip from 1 creator · 2 had nothing standout");
  assert.ok(await prisma.moment.findFirst({ where: { twitchClipId: "h-24" } }));
  stubTwitch(feed());
  assert.equal(await runClipsPoll(), "picked 0 standout clips from 0 creators · 2 had nothing standout");
});

test("clips poller: a nearly full line still gets one clip from each creator first", async () => {
  const prisma = await reset({ gameMode: "any" });
  for (const [twitchId, login, name] of creators.slice(0, 3)) await prisma.streamer.create({ data: { twitchId, login, name, approved: true } });
  stubTwitch(feed());
  process.env.MAX_BACKLOG = "3";
  try {
    const msg = await (await import("../src/workers/clips")).runClipsPoll();
    assert.match(msg, /^picked 3 standout clips from 3 creators · line has room for 3, rest next scan$/);
  } finally { process.env.MAX_BACKLOG = "100"; }
  const per = await prisma.moment.groupBy({ by: ["streamerId"], _count: true });
  assert.deepEqual(per.map((p) => p._count), [1, 1, 1]);
});

test("clips poller: gta6 mode keeps the GTA-wide query and only GTA clips; maxPerCreatorPerRun is honoured", async () => {
  const prisma = await reset({ gameMode: "gta6", maxPerCreatorPerRun: 1 });
  await prisma.streamer.create({ data: { twitchId: "h1", login: "hasan", name: "Hasan", approved: true } });
  const gta = [tc("h1", 800, { id: "h-gta-1", game_id: "gta6-id" }), tc("h1", 700, { id: "h-gta-2", game_id: "gta6-id" }), ...Array.from({ length: 4 }, () => tc("h1", 10, { game_id: "gta6-id" }))];
  const asked = stubTwitch({ h1: [...feed().h1, ...gta] }, [tc("someone-else", 5000, { id: "not-approved", game_id: "gta6-id" })]);
  const msg = await (await import("../src/workers/clips")).runClipsPoll();
  assert.ok(asked.some((u) => u.pathname.endsWith("/clips") && u.searchParams.get("game_id") === "gta6-id"), "GTA-wide query in gta6 mode");
  assert.deepEqual((await prisma.moment.findMany()).map((m) => m.twitchClipId), ["h-gta-1"]);
  assert.match(msg, /picked 1 standout clip from 1 creator · rest next scan/);
});

// ---------- One-time migration ----------
test("v1.8.0 migration: gta6 -> any, 24h -> 7 days, 45s -> 35s, once; a later manual change sticks", async () => {
  const { migrateV180Settings } = await import("../src/workers/migrate");
  const prisma = await reset({ gameMode: "gta6", clipLookbackHrs: 24, clipMaxSec: 45, migratedAnyGame: false });
  assert.match((await migrateV180Settings())!, /gameMode=any, clipLookbackHrs=168, clipMaxSec=35/);
  let s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.deepEqual([s.gameMode, s.clipLookbackHrs, s.clipMaxSec, s.migratedAnyGame], ["any", 168, 35, true]);
  // Krew switches back to GTA 6 and 24h later: the migration doesn't run again.
  await prisma.settings.update({ where: { id: "main" }, data: { gameMode: "gta6", clipLookbackHrs: 24, clipMaxSec: 45 } });
  assert.equal(await migrateV180Settings(), null);
  s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.deepEqual([s.gameMode, s.clipLookbackHrs, s.clipMaxSec], ["gta6", 24, 45]);
  // Custom values (not the old defaults) are left alone.
  await reset({ gameMode: "gta6", clipLookbackHrs: 48, clipMaxSec: 40, migratedAnyGame: false });
  await migrateV180Settings();
  s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.deepEqual([s.gameMode, s.clipLookbackHrs, s.clipMaxSec, s.migratedAnyGame], ["any", 48, 40, true]);
  // A fresh install: new defaults, nothing to move.
  await prisma.settings.deleteMany();
  assert.equal(await migrateV180Settings(), "settings already on v1.8.0 defaults");
  s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.deepEqual([s.gameMode, s.clipLookbackHrs, s.clipMinSec, s.clipMaxSec, s.standoutMin, s.maxPerCreatorPerRun, s.jumpCuts], ["any", 168, 15, 35, 2, 2, "light"]);
});

// ---------- Real line: transcribe (window on the payoff) -> Judge (its own window) -> cut -> re-cut ----------
async function makeSource(file: string) {
  // 60s viewer clip: quiet room tone, one loud burst (the payoff) at 50-52s.
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=60",
    "-f", "lavfi", "-i", "anoisesrc=d=60:a=0.01:r=48000", "-f", "lavfi", "-i", "anoisesrc=d=2:a=1:r=48000",
    "-filter_complex", "[2:a]volume=3,adelay=50000:all=1[b];[1:a][b]amix=inputs=2:normalize=0:duration=first[a]",
    "-map", "0:v", "-map", "[a]", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", file]);
}

test("line: window lands on the late payoff; the Judge's best_start/best_end is used when valid; re-cut keeps the stored window", { timeout: 300_000 }, async () => {
  const prisma = await reset();
  const raw = path.join(storage, "raw", "v180.mp4");
  await makeSource(raw);
  const s = await prisma.streamer.create({ data: { twitchId: "t1", login: "kai", name: "Kai", approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", sourceViews: 900, sourceTitle: "he screamed" } });
  const c = await prisma.clip.create({ data: { momentId: m.id, rawPath: "raw/v180.mp4", status: "processing", stage: "transcribe", title: "t", caption: "c" } });
  const { runTranscribe, runCut } = await import("../src/workers/cutter");
  const { runJudge } = await import("../src/workers/judge");

  await runTranscribe(c.id);
  let clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.ok(clip.payoffAt! > 49.5 && clip.payoffAt! < 50.5, `payoff at the burst's onset: ${clip.payoffAt}`);
  assert.equal(clip.wordsFull, true);
  assert.equal(clip.winLength, 28, "80% of the max length");
  const winEnd = clip.winStart! + clip.winLength!;
  assert.ok(winEnd >= 52.5 && winEnd <= 54, `ends ~1s after the 2s burst, not at the source end: ${winEnd}`);

  // Judge picks 34-56s (22s): valid, so the window moves. The prompt carried the source length + proposed window.
  mock.verdict = { ...mock.verdict, best_start: 34, best_end: 56 };
  const before = mock.requests.length;
  assert.match(await runJudge(c.id), /Judge picked 34-56s/);
  const sent = JSON.parse(mock.requests.slice(before).find((r) => r.path.includes("/messages"))!.body.toString());
  // v1.9.4: 8 labelled frames (image blocks) come first, then the text.
  const blocks = sent.messages[0].content as { type: string; text?: string }[];
  assert.equal(blocks.filter((b) => b.type === "image").length, 8);
  const userMsg = blocks.at(-1)!.text!;
  assert.match(userMsg, new RegExp(`Source video: 60s\\. Proposed window: ${clip.winStart!.toFixed(1)}s to ${winEnd.toFixed(1)}s`));
  assert.match(userMsg, /<source_transcript>/);
  // The Judge can't hear: the burst, the silence and the window edges are in its timeline; no duplicate window transcript.
  assert.match(userMsg, /\[50\.0s\] \(sound: sudden loud burst, \d+ dB over the usual level\)/);
  assert.match(userMsg, /\[0\.0s\] \(sound: silence until (49|50)\.\ds\)/);
  assert.match(userMsg, /\(proposed window starts\)/);
  assert.match(userMsg, /\(likely payoff \/ reaction\)/);
  assert.doesNotMatch(userMsg, /<transcript>/);
  assert.match(JSON.stringify(sent.output_config.format), /best_start/);
  clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([clip.winStart, clip.winLength, clip.duration], [34, 22, 22]);

  await runCut(c.id);
  clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(clip.status, "pending");
  assert.ok(Math.abs((await probeDuration(path.join(storage, clip.finalPath!))) - 22) < 0.3);

  // Re-cut in another style without jump cuts: the stored (Judge) window is kept.
  assert.match(await runCut(c.id, "clean", "off"), /cut 22s clean/);
  clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([clip.winStart, clip.winLength, clip.editStyle, clip.status], [34, 22, "clean", "pending"]);

  // An invalid Judge window (4s) is ignored: the heuristic window stays.
  await runTranscribe(c.id);
  mock.verdict = { ...mock.verdict, best_start: 50, best_end: 54 };
  assert.doesNotMatch(await runJudge(c.id), /Judge picked/);
  clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([clip.winStart! + clip.winLength!, clip.winLength], [winEnd, 28], "back to the heuristic window");
  // Review fix: a Judge window that leaves the payoff out gets a payoff (punch-in) inside it, not a stale one outside.
  mock.verdict = { ...mock.verdict, best_start: 10, best_end: 35 };
  assert.match(await runJudge(c.id), /Judge picked 10-35s/);
  clip = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.ok(clip.payoffAt! > 10.5 && clip.payoffAt! < 35, `payoff moved inside the Judge's window: ${clip.payoffAt}`);
  mock.verdict = { ...mock.verdict, best_start: null, best_end: null };
});

// ---------- db push upgrade ----------
test("db push upgrade from the v1.7.3 schema (bf79233) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV173Schema(now);
  const git = spawnSync("git", ["show", "bf79233:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the bf79233 one");
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
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, 0, 0)`);
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'twitch_clip', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, duration, winStart, winLength, words, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 30, 7.5, 45, '[]', 0, 0)`);
  sql(`INSERT INTO Settings (id, layout) VALUES ('main', 'facecam')`);
  assert.deepEqual(JSON.parse(sql("SELECT gameMode, clipLookbackHrs, clipMaxSec FROM Settings")), [{ gameMode: "gta6", clipLookbackHrs: 24, clipMaxSec: 45 }]);
  const second = push(SCHEMA);
  const out = second.stdout + second.stderr;
  assert.equal(second.status, 0, out);
  assert.doesNotMatch(out, /data loss|accept-data-loss|unique constraint/i);
  assert.match(out, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, status, duration, winStart, winLength, payoffAt, wordsFull FROM Clip")),
    [{ id: "c1", status: "pending", duration: 30, winStart: 7.5, winLength: 45, payoffAt: null, wordsFull: false }]);
  // Existing values are kept (the worker's one-time migration moves them), new columns get their defaults.
  assert.deepEqual(JSON.parse(sql("SELECT layout, gameMode, clipLookbackHrs, clipMaxSec, standoutMin, maxPerCreatorPerRun, jumpCuts, migratedAnyGame FROM Settings")),
    [{ layout: "facecam", gameMode: "gta6", clipLookbackHrs: 24, clipMaxSec: 45, standoutMin: 2, maxPerCreatorPerRun: 2, jumpCuts: "light", migratedAnyGame: false }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
