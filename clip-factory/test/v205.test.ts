import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CARD_FRAMES, END_FRAMES, ENTRY_MAX, ENTRY_MIN, FPS, MAX_PER_CREATOR, TITLE_FRAMES, cardAss, countdown, endAss, entryAss, entryCaptions, entryWindow,
  fitTotal, pickTop5, punchExpr, titleAss, titleLines, top5Caption, top5Titles, top5Total, type Top5Cand,
} from "../src/lib/top5";
import { buildPlan, steadyGrid, ZOOM_GAP_BEATS, type PlanSource } from "../src/lib/edit-plan";
import { run } from "../src/lib/media";
import { SAFE_Y_BOTTOM, SAFE_Y_TOP, TEXT_MAX_W, textWidth } from "../src/lib/platform-rules";
import { overlayPlace } from "../src/lib/layout";
import { toV203Schema } from "./schema-v173";

// v2.0.5 Edits: the "Top 5" countdown compilation + toned-down montage zooms.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v205-"));
const storage = path.join(dir, "storage");
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, REDIS_URL: "redis://localhost:6379/3", WHISPER_ENGINE: "off",
    CAM_DETECT: "off", MIN_FREE_GB: "0",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  try { const { redis } = await import("../src/lib/queues"); await redis().flushdb(); redis().disconnect(); } catch { /* never connected */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-19T12:00:00Z");
let seq = 0;
const cand = (o: Partial<Top5Cand>): Top5Cand => {
  const n = seq++;
  return {
    momentId: `m${n}`, clipId: `c${n}`, source: "twitch_clip", status: "pending", score: 7, sourceViews: 100, category: "funny",
    createdAt: new Date(NOW.getTime() - 3600_000), payoffAt: 12, hasRaw: true, sourceUrl: `https://clips.twitch.tv/x${n}`, vodId: null, vodOffset: null,
    twitchClipId: `x${n}`, streamerId: "s1", login: "kai", name: "Kai", platform: "twitch", approved: true, gameName: null, spikeScore: 3,
    judgePayoff: "he crashes into the cop car", winStart: 4, winLength: 16, ...o,
  };
};

// ---------- Picking ----------
test("pickTop5: theme filter, best first, never the same moment twice, max 2 per creator, rejected/unapproved out", () => {
  const cs = [
    cand({ momentId: "a1", streamerId: "a", score: 9.5 }), cand({ momentId: "a2", streamerId: "a", score: 9.4 }), cand({ momentId: "a3", streamerId: "a", score: 9.3 }),
    cand({ momentId: "b1", streamerId: "b", score: 9 }),
    cand({ momentId: "b1dup", streamerId: "b", score: 8.9, twitchClipId: "SAME", sourceUrl: "u" }), cand({ momentId: "b2", streamerId: "b", score: 6, twitchClipId: "SAME", sourceUrl: "u" }),
    cand({ momentId: "c1", streamerId: "c", score: 8, category: "gaming" }),
    cand({ momentId: "d1", streamerId: "d", score: 7 }), cand({ momentId: "e1", streamerId: "e", score: 6.5 }),
    cand({ momentId: "rej", streamerId: "f", score: 10, status: "rejected" }), cand({ momentId: "off", streamerId: "g", score: 10, approved: false }),
    cand({ momentId: "vod1", streamerId: "h", score: 6.2, source: "chat", vodId: "v", vodOffset: 100, sourceUrl: null, twitchClipId: null }),
    cand({ momentId: "vod2", streamerId: "i", score: 6.1, source: "chat", vodId: "v", vodOffset: 110, sourceUrl: null, twitchClipId: null }),
  ];
  const r = pickTop5(cs, { theme: "funny", now: NOW });
  const ids = r.picks.map((p) => p.momentId);
  assert.equal(r.enough, true);
  assert.deepEqual(ids, ["a1", "a2", "b1", "b1dup", "d1"], "best first, 2 per creator, the duplicate of b1dup (same Twitch clip) dropped");
  assert.ok(![...ids, ...r.spares.map((s) => s.momentId)].some((x) => ["a3", "b2", "rej", "off", "c1"].includes(x)));
  assert.ok(r.spares.some((s) => s.momentId === "vod1") && !r.spares.some((s) => s.momentId === "vod2"), "same VOD within 20s = one moment");
  const per = new Map<string, number>();
  for (const p of r.picks) per.set(p.streamerId, (per.get(p.streamerId) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= MAX_PER_CREATOR));
  // one creator: no cap
  const kai = pickTop5(cs, { theme: "creator", creatorId: "a", now: NOW });
  assert.equal(kai.picks.length, 3);
  assert.equal(kai.enough, false, "only 3 moments of that creator");
  const gaming = pickTop5(cs, { theme: "gaming", now: NOW });
  assert.deepEqual(gaming.picks.map((p) => p.momentId), ["c1"]);
  // gta: older rows (no gameName) count as GTA 6; another game does not
  const g = pickTop5([cand({ momentId: "g1", gameName: "Grand Theft Auto VI" }), cand({ momentId: "g2", gameName: "Fortnite" }), cand({ momentId: "g3", gameName: null })], { theme: "gta", now: NOW });
  assert.deepEqual(g.picks.map((p) => p.momentId).sort(), ["g1", "g3"]);
  // recent first: 7 days, widened to 30 when short
  const old = pickTop5([cand({ momentId: "old", createdAt: new Date(NOW.getTime() - 20 * 86_400_000) })], { theme: "funny", now: NOW, want: 1 });
  assert.deepEqual(old.picks.map((p) => p.momentId), ["old"]);
  // moments of the last Top 5s go last
  const many = Array.from({ length: 8 }, (_, i) => cand({ momentId: `k${i}`, streamerId: `s${i}`, score: 9 - i * 0.2 }));
  assert.deepEqual(pickTop5(many, { theme: "funny", now: NOW, avoid: ["k0", "k1"] }).picks.map((p) => p.momentId), ["k2", "k3", "k4", "k5", "k6"]);
  assert.deepEqual(countdown([1, 2, 3, 4, 5]), [5, 4, 3, 2, 1], "#5 first, the best (#1) last");
});

// ---------- Cuts ----------
test("entryWindow: setup -> payoff -> reaction in 6-12s, opens on a sentence, never mid-word; fitTotal makes 45-75s", () => {
  const words = [
    { word: "okay", start: 3.0, end: 3.3 }, { word: "watch", start: 3.4, end: 3.7 }, { word: "this.", start: 3.8, end: 4.1 },
    { word: "I'm", start: 7.6, end: 7.8 }, { word: "going", start: 7.9, end: 8.2 }, { word: "in", start: 8.3, end: 8.5 },
    { word: "NO", start: 12.1, end: 12.4 }, { word: "WAY", start: 12.5, end: 12.9 }, { word: "hahaha", start: 16.3, end: 16.9 },
  ];
  const w = entryWindow({ payoff: 12, dur: 30, words, win: { start: 2, end: 22 } });
  assert.ok(w.end - w.start >= ENTRY_MIN && w.end - w.start <= ENTRY_MAX, `${w.start}-${w.end}`);
  assert.ok(w.start <= 12 - 2.5 && w.start >= 12 - 6, "2.5-6s of setup");
  assert.ok(Math.abs(w.start - 7.35) < 0.01, `opens 0.25s before the setup sentence (${w.start})`);
  assert.ok(w.end >= 16.9, `the laugh at 16.3-16.9 is kept whole (${w.end})`);
  assert.ok(!words.some((x) => x.start < w.start && x.end > w.start) && !words.some((x) => x.start < w.end && x.end > w.end), "no word cut in half");
  // a short source: still >= 6s
  const s = entryWindow({ payoff: 2, dur: 7, words: [] });
  assert.ok(s.end - s.start >= ENTRY_MIN - 0.06 && s.start >= 0 && s.end <= 7);
  // inside the clip's own tightened window when it's long enough
  const t = entryWindow({ payoff: 12, dur: 60, words: [], win: { start: 9, end: 17 } });
  assert.ok(t.start >= 8.7 && t.end <= 17.3);

  const base = Array.from({ length: 5 }, () => ({ start: 10, end: 16, payoff: 13 }));
  const fit = fitTotal(base, base.map(() => 60));
  const total = top5Total(fit.map((x) => x.end - x.start));
  assert.ok(total >= 45 && total <= 75, `total ${total}s`);
  assert.ok(fit.every((x) => x.end - x.start <= ENTRY_MAX && x.start <= x.payoff - 2.5));
  const long = Array.from({ length: 5 }, () => ({ start: 0, end: 12, payoff: 5 }));
  assert.ok(top5Total(fitTotal(long, long.map(() => 60)).map((x) => x.end - x.start)) <= 75);
  assert.equal(top5Total([10, 10, 10, 10, 10]), 50 + (TITLE_FRAMES + 4 * CARD_FRAMES + END_FRAMES) / FPS);
});

test("effects: one punch-in on each entry's payoff, nothing else zooms", () => {
  const z = punchExpr(5, 10)!;
  assert.equal((z.match(/\(1\+/g) ?? []).length, 1, "exactly one zoom");
  assert.match(z, /0\.12/);
  assert.equal(punchExpr(0.1, 10), null, "not on the first frames");
  assert.equal(punchExpr(9.8, 10), null, "not on the last frames");
  // evaluate the expression at a few times: 1 before, 1.12 during, back to 1 after
  const at = (t: number) => Function("t", "lt", "if_", `return ${z.replace(/if\(/g, "if_(")}`)(t, (a: number, b: number) => (a < b ? 1 : 0), (c: number, a: number, b: number) => (c ? a : b));
  assert.equal(at(4), 1);
  assert.ok(Math.abs(at(5.5) - 1.12) < 1e-9);
  assert.equal(at(7), 1);
});

test("v2.0.5 montage + clip edit: zoom only on the drop, at most one zoom per 2 bars, no shake loops", () => {
  const g = steadyGrid(128, 20);
  const srcs = (n: number): PlanSource[] => Array.from({ length: n }, (_, i) => ({ dur: 12, payoff: 5, strength: 1 - i / 10, category: "funny", focus: { x: 540, y: 700 } }));
  const gap = Math.round((60 / 128) * 30 * ZOOM_GAP_BEATS) - 1;
  for (const vibe of ["hype", "funny", "smooth"] as const) {
    const p = buildPlan({ format: "montage", vibe, grid: g, sources: srcs(8), title: "X" });
    const starts = [...p.fx.pulses.map((x) => x.f), ...p.fx.punches.map((x) => x.f), ...p.fx.drifts.map((x) => x.f0)].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= gap, `${vibe}: zooms ${starts[i - 1]} and ${starts[i]} too close`);
    assert.ok(p.fx.pulses.length <= 1, `${vibe}: no pulse on every beat (${p.fx.pulses.length})`);
    assert.ok(p.fx.shakes.length <= 1, `${vibe}: shake only on the drop`);
    if (starts.length) assert.ok(Math.abs(starts[0] - p.dropFrame) <= 30 || starts.some((f) => Math.abs(f - p.dropFrame) <= 30), `${vibe}: the zoom is on the drop`);
  }
  const ce = buildPlan({ format: "clipedit", vibe: "hype", grid: steadyGrid(128, 20, 3), sources: srcs(3), title: "Kai", creatorAudio: true });
  assert.equal(ce.fx.pulses.length, 0, "clip -> edit: no beat pulses after the drop");
  assert.equal(ce.fx.punches[0].f, ce.dropFrame);
  assert.ok(ce.fx.shakes.length === 1);
});

// ---------- Text ----------
test("titles, caption credits every creator, all text inside the safe zone", () => {
  assert.deepEqual(top5Titles("funny", { allGta: true }), { card: "TOP 5 FUNNIEST GTA 6 MOMENTS", hook: "Top 5 funniest GTA 6 moments 😂" });
  assert.equal(top5Titles("gaming", { allGta: false }).hook, "Top 5 craziest plays 🔥");
  assert.equal(top5Titles("creator", { allGta: false, creatorName: "Kai Cenat", funnyShare: 0.8 }).hook, "Kai Cenat's top 5 moments 😂");
  assert.deepEqual(titleLines("TOP 5 FUNNIEST GTA 6 MOMENTS"), ["TOP 5", "FUNNIEST", "GTA 6 MOMENTS"], "GTA 6 never split");
  const cs = [{ login: "kaicenat", name: "Kai", platform: "twitch" }, { login: "jynxzi", name: "J", platform: "twitch" }, { login: "kaicenat", name: "Kai", platform: "twitch" }, { login: "xqc", name: "x", platform: "twitch" }];
  const cap = top5Caption("Top 5 funniest GTA 6 moments 😂", cs, { theme: "funny" });
  assert.equal(cap, "Top 5 funniest GTA 6 moments 😂\n\n🎥 @kaicenat @jynxzi @xqc\n\n#GTA6 #GTAVI #ViceCity #GTA6Funny #edit");
  assert.ok((cap.match(/#\w+/g) ?? []).length <= 5);
  const { captionCredits } = require("../src/lib/social") as typeof import("../src/lib/social");
  assert.ok(cs.every((c) => captionCredits(cap, c)));

  const ys = (ass: string) => [...ass.matchAll(/\\pos\((\d+),(\d+)\)/g)].map((m) => Number(m[2]));
  const long = "averyveryverylongtwitchlogin_123";
  for (const ass of [
    titleAss({ card: "KAI CENAT'S TOP 5 GTA 6 MOMENTS", first: 5, watermark: "ClipFactoryGG" }), cardAss({ n: 3, login: long, watermark: "ClipFactoryGG" }),
    endAss({ channel: "ClipFactoryGG" }),
    ...(["blur", "split", "fullcam"] as const).map((l) => entryAss({ n: 1, login: long, len: 9, captions: [{ start: 0, end: 1, text: "no way bro" }], place: overlayPlace(l, null), watermark: "ClipFactoryGG" })),
  ]) {
    for (const y of ys(ass)) assert.ok(y >= SAFE_Y_TOP && y <= SAFE_Y_BOTTOM, `y=${y} outside the safe zone`);
  }
  // the long login fits: fitScale shrink applied
  assert.match(cardAss({ n: 3, login: long }), /\\fscx\d+/);
  assert.ok(textWidth("#1  @kaicenat", 46, { outline: 5 }) < TEXT_MAX_W);
  assert.ok(entryCaptions([{ word: "a", start: 1, end: 1.2 }, { word: "b", start: 30, end: 31 }], { start: 0.5, end: 9, payoff: 5 }).every((c) => c.start >= 0 && c.end <= 8.5));
});

// ---------- Worker: real render ----------
async function testSource(file: string, seconds: number) {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", file]);
}

test("runEdit top5: picks at creation, renders #5 -> #1 with cards, 45-75s, pending, every creator credited, Platform check clean", { timeout: 600_000 }, async () => {
  const { prisma } = await import("../src/lib/db");
  const { runEdit } = await import("../src/workers/edit");
  const { createTop5Edit, top5ThemeCounts } = await import("../src/workers/top5");
  const { queue } = await import("../src/lib/queues");
  await queue("edit").obliterate({ force: true });
  fs.mkdirSync(path.join(storage, "raw"), { recursive: true });
  await testSource(path.join(storage, "raw", "t5.mp4"), 20);
  await assert.rejects(createTop5Edit({ theme: "funny" }), /only 0 different funny moments/);
  const names = ["kaicenat", "jynxzi", "xqc", "caseoh_"];
  for (let s = 0; s < names.length; s++) {
    const st = await prisma.streamer.create({ data: { twitchId: `t5-${s}`, login: names[s], name: names[s].toUpperCase(), approved: true } });
    for (let i = 0; i < 3; i++) {
      const m = await prisma.moment.create({ data: { streamerId: st.id, timestamp: new Date(), source: "twitch_clip", sourceUrl: `https://clips.twitch.tv/t5${s}${i}`, twitchClipId: `t5${s}${i}`, sourceViews: 100, spikeScore: 2 + i, category: "funny" } });
      await prisma.clip.create({ data: { momentId: m.id, status: "pending", rawPath: "raw/t5.mp4", payoffAt: 11, winStart: 3, winLength: 16, score: 9 - s - i / 3, category: "funny", layout: "blur",
        words: JSON.stringify([{ word: "no", start: 10.9, end: 11.2 }, { word: "way!", start: 11.3, end: 11.7 }]), wordsFull: true } });
    }
  }
  assert.ok((await top5ThemeCounts()).funny >= 5);
  const e = await createTop5Edit({ theme: "funny" });
  const st = JSON.parse(e.slices!).top5;
  assert.equal(st.picks.length, 5);
  assert.equal(e.format, "top5");
  const msg = await runEdit(e.id);
  assert.match(msg, /^Top 5 \(funny\): #5 @\w+, #4 @\w+, #3 @\w+, #2 @\w+, #1 @kaicenat/);
  const done = await prisma.edit.findUniqueOrThrow({ where: { id: e.id }, include: { streamer: true } });
  assert.equal(done.status, "pending");
  assert.equal(done.streamer.login, "kaicenat", "lead = #1's creator");
  assert.ok(done.duration! >= 45 && done.duration! <= 75, `${done.duration}s`);
  assert.deepEqual(fs.readdirSync(path.join(storage, "edits", e.id)), ["final.mp4"], "downloads + work files gone, no beat preview");
  assert.equal(done.title, "Top 5 funniest GTA 6 moments 😂");
  const creators = JSON.parse(done.creators!);
  assert.ok(creators.length >= 3);
  const { captionCredits } = await import("../src/lib/social");
  for (const c of creators) assert.ok(captionCredits(done.caption!, c), `credits @${c.login}`);
  const rep = JSON.parse(done.slices!);
  assert.equal(rep.entries.length, 5);
  const per = new Map<string, number>();
  for (const p of rep.picks) per.set(p.login, (per.get(p.login) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 2), "max 2 per creator");
  assert.equal(new Set(rep.picks.map((p: { momentId: string }) => p.momentId)).size, 5, "no moment twice");
  const info = JSON.parse(done.platformInfo!);
  assert.deepEqual([info.file.width, info.file.height, info.file.vcodec, info.file.acodec], [1080, 1920, "h264", "aac"]);
  const { platformCheck, parsePlatformInfo } = await import("../src/lib/platform-rules");
  const chk = platformCheck({ caption: done.caption!, title: done.title, creditOk: captionCredits(done.caption!, done.streamer), info: parsePlatformInfo(done.platformInfo) });
  assert.equal(chk.fails, 0, chk.summary);
  // exact length: cards + entries
  const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path.join(storage, done.finalPath!)]);
  const planned = rep.entries.reduce((n: number, s: string) => { const m = s.match(/ ([\d.]+)-([\d.]+)s/)!; return n + Math.round((Number(m[2]) - Number(m[1])) * FPS); }, 0) + TITLE_FRAMES + 4 * CARD_FRAMES + END_FRAMES;
  assert.ok(Math.abs(Number(stdout.trim()) - planned) <= 2, `${stdout.trim()} frames vs ${planned}`);
  // Re-make picks other moments first
  const { remakeEdit } = await import("../app/edit-actions");
  await remakeEdit(e.id);
  const again = await prisma.edit.findFirstOrThrow({ where: { format: "top5", id: { not: e.id } }, orderBy: { createdAt: "desc" } });
  const second = JSON.parse(again.slices!).top5.picks as string[];
  assert.ok(second.filter((id) => st.picks.includes(id)).length < 5, "the second Top 5 is not the same five");
});

// ---------- db push upgrade ----------
test("db push upgrade from the v2.0.3 schema (f01d7cb) with rows: no prompt, rows kept, Top 5 columns null", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV203Schema(now);
  const git = spawnSync("git", ["show", "f01d7cb:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the f01d7cb one");
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
  `], { encoding: "utf8", cwd: ROOT });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, 0, 0)`);
  sql(`INSERT INTO Edit (id, streamerId, format, vibe, lengthSec, bpm, status, createdAt, updatedAt) VALUES ('e1', 'a', 'montage', 'hype', 20, 128, 'pending', 0, 0)`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, format, vibe, status, theme, creators FROM Edit")), [{ id: "e1", format: "montage", vibe: "hype", status: "pending", theme: null, creators: null }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
