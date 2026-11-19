import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dedupe, isUsable, pickMoments, rankCandidates, usableCount, wantedSlices, type Candidate } from "../src/lib/edit-pick";
import {
  FPS, allocateBeats, beatsForLength, buildEditAss, buildPlan, clipBarsFor, frameOf, steadyGrid, trackGrid, zoomExprN, type PlanSource,
} from "../src/lib/edit-plan";
import { editCaption } from "../src/lib/edit-text";
import { metronomeWav, musicPath } from "../src/lib/beats";
import { run } from "../src/lib/media";
import { toV198Schema } from "./schema-v173";

// v2.0.0 Edits: beat-synced montages + Clip -> Edit, edit channel accounts.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v200-"));
const storage = path.join(dir, "storage");
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, REDIS_URL: "redis://localhost:6379/13", WHISPER_ENGINE: "off",
    MUSIC_DIR: path.join(dir, "music"), CAM_DETECT: "off", MIN_FREE_GB: "0",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  fs.mkdirSync(path.join(dir, "music"), { recursive: true });
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  try { const { redis } = await import("../src/lib/queues"); await redis().flushdb(); redis().disconnect(); } catch { /* never connected */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const cand = (o: Partial<Candidate>): Candidate => ({
  momentId: Math.random().toString(36).slice(2), clipId: "c", source: "twitch_clip", status: "pending", score: 7, sourceViews: 100, category: "gaming",
  createdAt: new Date("2026-11-17T12:00:00Z"), payoffAt: 12, hasRaw: false, sourceUrl: `https://clips.twitch.tv/${Math.random()}`, vodId: null, vodOffset: null, ...o,
});
const NOW = new Date("2026-11-18T12:00:00Z");

// ---------- Picking moments ----------
test("edit-pick: rejected / failed / undownloadable moments are out; score, standout, vibe fit and payoff rank the rest", () => {
  assert.equal(isUsable(cand({ status: "rejected" })), false);
  assert.equal(isUsable(cand({ status: "failed" })), false);
  assert.equal(isUsable(cand({ status: null })), true, "a moment without a clip yet is fine");
  assert.equal(isUsable(cand({ source: "chat", sourceUrl: null, vodId: null })), false);
  assert.equal(isUsable(cand({ source: "chat", sourceUrl: null, vodId: "v1", vodOffset: 300 })), true);
  assert.equal(isUsable(cand({ source: "youtube", vodOffset: null })), false);
  assert.equal(isUsable(cand({ sourceUrl: null, hasRaw: true })), true, "raw still on disk");

  const best = cand({ momentId: "best", score: 9.5, sourceViews: 2000 });
  const funny = cand({ momentId: "funny", score: 7, category: "funny" });
  const gaming = cand({ momentId: "gaming", score: 7, category: "gaming" });
  const noPayoff = cand({ momentId: "nopay", score: 7, category: "gaming", payoffAt: null });
  const old = cand({ momentId: "old", score: 7, category: "gaming", createdAt: new Date("2026-09-01T00:00:00Z") });
  const hype = rankCandidates([funny, gaming, best, noPayoff, old], "hype", NOW).map((c) => c.momentId);
  assert.equal(hype[0], "best");
  assert.ok(hype.indexOf("gaming") < hype.indexOf("funny"), "hype prefers gaming");
  assert.ok(hype.indexOf("gaming") < hype.indexOf("nopay"), "a known payoff ranks higher");
  assert.ok(hype.indexOf("gaming") < hype.indexOf("old"), "recent ranks higher");
  const fun = rankCandidates([funny, gaming], "funny", NOW).map((c) => c.momentId);
  assert.deepEqual(fun, ["funny", "gaming"], "funny vibe prefers funny");
});

test("edit-pick: same-source overlaps are one moment; avoid list only used when short; slice counts per vibe", () => {
  const a = cand({ source: "chat", vodId: "v9", vodOffset: 100, sourceUrl: null, score: 9 });
  const b = cand({ source: "chat", vodId: "v9", vodOffset: 110, sourceUrl: null, score: 6 });
  const c = cand({ source: "chat", vodId: "v9", vodOffset: 200, sourceUrl: null, score: 6 });
  const same = cand({ sourceUrl: "https://clips.twitch.tv/X", twitchClipId: "X", score: 8 });
  const same2 = cand({ sourceUrl: "https://clips.twitch.tv/X", twitchClipId: "X", score: 5 });
  const d = dedupe(rankCandidates([a, b, c, same, same2], "hype", NOW));
  assert.equal(d.length, 3);
  assert.ok(d.some((x) => x.momentId === a.momentId) && !d.some((x) => x.momentId === b.momentId), "kept the stronger of the overlap");
  assert.equal(usableCount([a, b, c, same, same2, cand({ status: "rejected" })]), 3);

  const many = Array.from({ length: 10 }, (_, i) => cand({ momentId: `m${i}`, score: 10 - i * 0.3 }));
  const picked = pickMoments(many, { vibe: "hype", want: 5, spares: 0, avoid: ["m0", "m1"], now: NOW }).map((x) => x.momentId);
  assert.deepEqual(picked, ["m2", "m3", "m4", "m5", "m6"], "moments of the last edits are skipped while there are others");
  const few = pickMoments(many.slice(0, 5), { vibe: "hype", want: 5, spares: 0, avoid: ["m0"], now: NOW }).map((x) => x.momentId);
  assert.deepEqual(few, ["m1", "m2", "m3", "m4", "m0"], "...and used last when there aren't");
  assert.equal(wantedSlices(20, "hype"), 12);
  assert.equal(wantedSlices(20, "funny"), 9);
  assert.equal(wantedSlices(20, "smooth"), 7);
  assert.equal(wantedSlices(15, "smooth"), 5);
});

// ---------- Beats ----------
/** 128 BPM click track with noise, accented (kick) downbeats, and a "drop" (bass + louder bed) from bar 9 on. */
function clickTrack(file: string, o: { bpm: number; offset: number; seconds: number; dropBar: number }) {
  const sr = 22050, n = Math.round(o.seconds * sr), P = 60 / o.bpm;
  const y = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const dropAt = o.offset + o.dropBar * 4 * P;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    y[i] = 0.04 * rnd() + (t >= dropAt ? 0.18 * Math.sin(2 * Math.PI * 55 * t) + 0.06 * rnd() : 0);
  }
  for (let k = 0; o.offset + k * P < o.seconds - 0.1; k++) {
    const i0 = Math.round((o.offset + k * P) * sr), down = k % 4 === 0;
    for (let i = 0; i < 0.04 * sr && i0 + i < n; i++) {
      const env = Math.exp(-i / sr / 0.008);
      y[i0 + i] += (down ? 0.7 : 0.45) * Math.sin((2 * Math.PI * (down ? 1600 : 1000) * i) / sr) * env + (down ? 0.6 * Math.sin((2 * Math.PI * 60 * i) / sr) * env : 0);
    }
  }
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(y[i] * 32767 * 0.9))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

test("beats.py: 128 BPM click track -> tempo within 1 BPM, every beat within 30 ms, downbeats + the drop found", { timeout: 120_000 }, async () => {
  const { findTrackBeats } = await import("../src/lib/beats");
  const song = path.join(dir, "music", "click128.wav");
  const offset = 0.37, P = 60 / 128;
  clickTrack(song, { bpm: 128, offset, seconds: 40, dropBar: 8 });
  assert.equal(musicPath("click128.wav"), song);
  assert.equal(musicPath("../click128.wav"), null, "no paths out of the music folder");
  assert.equal(musicPath("notes.txt"), null);
  const tb = await findTrackBeats(song, path.join(dir, "work-beats"));
  assert.ok(Math.abs(tb.tempo - 128) <= 1, `tempo ${tb.tempo}`);
  const errs = tb.beats.map((b) => Math.abs(b - (offset + Math.round((b - offset) / P) * P)) * 1000);
  assert.ok(tb.beats.length >= 80, `${tb.beats.length} beats`);
  assert.ok(Math.max(...errs) <= 30, `max beat error ${Math.max(...errs).toFixed(1)} ms`);
  for (const d of tb.downbeats) assert.equal(Math.round((d - offset) / P) % 4, 0, `downbeat ${d} is on a bar line`);
  assert.ok(tb.drops.length >= 1, "drop found");
  assert.ok(Math.abs(tb.drops[0].t - (offset + 32 * P)) < 0.05, `drop at ${tb.drops[0].t}`);

  // the grid puts the song's drop on the edit's drop bar and says where to start the sound
  const g = trackGrid(tb, 20);
  assert.equal(g.beats.length - 1, 44);
  assert.equal(g.dropBeat, 16);
  assert.ok(g.dropOnBar);
  assert.ok(Math.abs(g.offset + g.beats[g.dropBeat] - tb.drops[0].t) < 0.03, "edit drop = song drop");
  assert.ok(Math.abs(g.offset - (offset + 16 * P)) < 0.03, `starts the sound at ${g.offset}`);
});

// ---------- Plan ----------
const srcs = (n: number, o: Partial<PlanSource> = {}): PlanSource[] =>
  Array.from({ length: n }, (_, i) => ({ dur: 10, payoff: 5, strength: 1 - i * 0.05, category: i % 2 ? "funny" : "gaming", focus: null, ...o }));

test("plan: slices are whole beats, cut on beat frames, add up to the grid exactly; strongest moment on the drop", () => {
  for (const [bpm, len] of [[128, 20], [128, 15], [128, 30], [95, 20], [174, 30], [70, 15]] as const) {
    for (const vibe of ["hype", "funny", "smooth"] as const) {
      const g = steadyGrid(bpm, len);
      const N = g.beats.length - 1;
      assert.equal(N % 4, 0);
      assert.equal(N, beatsForLength(bpm, len));
      const plan = buildPlan({ format: "montage", vibe, grid: g, sources: srcs(8), title: "Kai Cenat" });
      const frames = plan.slices.reduce((n, s) => n + (s.f1 - s.f0), 0);
      assert.equal(frames, plan.frames, `${bpm}/${len}/${vibe}: slices sum to the grid`);
      assert.equal(plan.frames, frameOf(g.beats[N]));
      assert.ok(Math.abs(plan.duration - g.beats[N]) <= 1 / FPS, "length within a frame of the bars");
      assert.ok(plan.slices.length >= 5 && plan.slices.length <= 12, `${plan.slices.length} slices`);
      plan.slices.forEach((s, i) => {
        if (i) assert.equal(s.f0, plan.slices[i - 1].f1, "back to back");
        assert.equal(s.f0, frameOf(g.beats[s.beat0]), "starts on a beat frame");
        assert.ok(s.beat1 - s.beat0 >= 1 && s.beat1 - s.beat0 <= 8);
        const rendered = s.parts.reduce((n, p) => n + p.frames, 0);
        assert.equal(rendered, s.f1 - s.f0 + s.pre + s.post, "parts fill the slice exactly");
        assert.ok(Math.abs(s.f0 / FPS - g.beats[s.beat0]) <= 0.5 / FPS + 1e-9, "cut within half a frame of its beat");
      });
      const drop = plan.slices.find((s) => s.role === "drop")!;
      assert.ok(drop, "there is a drop slice");
      assert.equal(drop.src, 0, "strongest moment on the drop");
      assert.equal(drop.hitFrame, frameOf(g.beats[g.dropBeat]), "its hit lands on the drop downbeat");
      assert.equal(g.dropBeat % 4, 0, "the drop is a downbeat");
    }
  }
});

test("plan: allocateBeats keeps bars, splits the build-up first for Hype, merges far from the drop", () => {
  const u = allocateBeats(44, 12, 16, "funny");
  assert.equal(u.reduce((n, [, l]) => n + l, 0), 44);
  assert.equal(u.length, 12);
  assert.ok(u.some(([s, l]) => s === 15 && l >= 2), "the drop slice starts a beat before the drop");
  const h = allocateBeats(44, 12, 16, "hype");
  assert.ok(h.some(([s]) => s === 15), "hype: the drop slice starts a beat early (slow-mo into the hit)");
  const m = allocateBeats(64, 7, 20, "smooth");
  assert.equal(m.reduce((n, [, l]) => n + l, 0), 64);
  assert.ok(m.length <= 9 && m.some(([s]) => s === 19) && m.every(([s, l]) => s >= 19 || s + l <= 19), "8-beat slices never run into the drop slice");
});

test("plan: per-vibe effects", async () => {
  const g = steadyGrid(128, 20);
  const hype = buildPlan({ format: "montage", vibe: "hype", grid: g, sources: srcs(8), title: "X" });
  // v2.0.5: no zoom pulse on every beat any more: one zoom on the drop, a shake + RGB split only there
  assert.ok(hype.fx.flashes.length >= 1 && hype.fx.rgb.length === 1 && hype.fx.shakes.length === 1 && hype.fx.pulses.length === 1);
  assert.ok(hype.slices.some((s) => s.parts.some((p) => p.speed === 0.5)), "speed ramp");
  const drop = hype.slices.find((s) => s.role === "drop")!;
  assert.deepEqual(drop.parts.map((p) => p.speed), [0.5, 1], "slow-mo into the hit, then 1x");
  assert.equal(drop.parts[0].frames, drop.hitFrame! - drop.f0, "snaps back exactly on the hit");
  assert.ok(Math.abs(drop.srcIn + drop.parts[0].frames * 0.5 / FPS - 5) < 0.02, "the payoff is what plays at the hit");
  assert.equal(hype.transition.kind, "cut");
  assert.ok(hype.grade.saturation > 1.2);

  const funny = buildPlan({ format: "montage", vibe: "funny", grid: g, sources: srcs(8, { focus: { x: 540, y: 700 } }), title: "X" });
  assert.equal(funny.fx.rgb.length, 0, "no RGB split");
  assert.ok(funny.fx.flashes.length <= 2, "less flashing");
  assert.ok(funny.slices.some((s) => s.role === "freeze" && s.parts[s.parts.length - 1].speed === 0), "freeze-frame on the punchline");
  assert.ok(funny.fx.punches.length >= 1 && funny.fx.punches.length <= 3, "a punch-in on the drop / freeze, not on every slice");
  assert.match(zoomExprN(funny.fx), /min\(1\.4,1\+/);

  const smooth = buildPlan({ format: "montage", vibe: "smooth", grid: g, sources: srcs(8), title: "X" });
  assert.equal(smooth.transition.kind, "xfade");
  assert.equal(smooth.fx.flashes.length + smooth.fx.shakes.length + smooth.fx.rgb.length, 0);
  assert.equal(smooth.fx.drifts.length, 0, "v2.0.5: no zoom drifting in and out on every slice");
  smooth.slices.forEach((s, i) => { assert.equal(s.pre, i ? 3 : 0); assert.equal(s.post, i < smooth.slices.length - 1 ? 3 : 0); });

  const ass = buildEditAss(hype, { credit: "twitch.tv/kaicenat" });
  assert.match(ass, /Credit,,0,0,0,,\{\\an8\}\{\\pos\(475,290\)\}twitch\.tv\/kaicenat/);
  assert.match(ass, /Title,,0,0,0,,\{\\pos\(475,1320\)\}.*X$/m, "centred on the v1.9.8 safe-zone centre");
  assert.match(ass, /Credit,,0,0,0,,\{\\an8\}\{\\pos\(475,290\)\}/, "credit at the top of the safe zone");
  const { unsafeText } = await import("../src/lib/platform-file");
  const { EDIT_PLACE } = await import("../src/lib/edit-plan");
  assert.deepEqual(unsafeText(EDIT_PLACE), [], "all edit text inside every app's safe zone");
  assert.equal((ass.match(/,Title,/g) ?? []).length, 4, "the name pops on each beat of the first bar");
  assert.match(buildEditAss(hype, { credit: "c", previewLabel: true }), /DON'T POST THIS ONE/);
  assert.match(buildEditAss(hype, { credit: "c", watermark: "ViceCityClips" }), /,Mark,,0,0,0,,\{\\an3\\pos\(890,1440\)\}@ViceCityClips/, "channel watermark on edits");
  assert.doesNotMatch(buildEditAss(hype, { credit: "c", watermark: null }), /,Mark,,/);
});

test("plan: Clip -> Edit = whole bars of clip, the drop exactly on the payoff, replays + other hits after", () => {
  const P = 60 / 128;
  const bars = clipBarsFor(128, 9, 10);
  assert.equal(bars, 3, "~5s of clip at 128 BPM");
  assert.equal(clipBarsFor(128, 2.5, 10), 1, "never more setup than the source has");
  const g = steadyGrid(128, 20, bars);
  assert.equal(g.dropBeat, 12);
  const words = [{ word: "no", start: 6.0, end: 6.3 }, { word: "way", start: 6.4, end: 6.8 }, { word: "later", start: 12, end: 12.4 }];
  const s: PlanSource[] = [{ dur: 18, payoff: 10, strength: 1, category: "funny", focus: null, words }, ...srcs(2, { payoff: 4, dur: 9 })];
  const plan = buildPlan({ format: "clipedit", vibe: "hype", grid: g, sources: s, title: "Kai", creatorAudio: true });
  const [clip, drop] = plan.slices;
  assert.equal(clip.role, "clip");
  assert.equal(clip.f1, frameOf(12 * P), "clip part = 3 bars");
  assert.ok(Math.abs(clip.srcIn + clip.f1 / FPS - 10) < 1e-3, "the clip part ends exactly on the payoff");
  assert.equal(drop.role, "drop");
  assert.equal(drop.srcIn, 10, "the drop continues from the payoff");
  assert.equal(plan.dropFrame, drop.f0);
  assert.ok(plan.fx.flashes.includes(drop.f0) && plan.fx.shakes[0].f0 === drop.f0 && plan.fx.punches[0].f === drop.f0 && plan.fx.rgb[0].f0 === drop.f0);
  assert.equal(plan.slices.reduce((n, x) => n + (x.f1 - x.f0), 0), plan.frames);
  const replays = plan.slices.filter((x) => x.src === 0 && x.role === "replay");
  assert.ok(replays.length >= 2 && replays.some((x) => x.parts.some((p) => p.speed === 0.5)), "replays incl. a slow-mo ramp");
  assert.ok(plan.slices.some((x) => x.role === "freeze"), "freeze on the reaction");
  assert.ok(plan.slices.some((x) => x.src > 0), "other hits fill the length");
  assert.deepEqual(plan.audio, { duckFrom: drop.f0, stabFrames: 18, duckTo: 0.22 });
  assert.deepEqual(plan.captions.map((c) => c.text), ["no way"], "captions only in the clip part");
  assert.ok(Math.abs(plan.captions[0].start - (6 - clip.srcIn)) < 0.01);
  assert.equal(plan.title.f0, drop.f0, "the name pops on the drop");
  assert.equal(buildPlan({ format: "clipedit", vibe: "hype", grid: g, sources: s, title: "Kai", creatorAudio: false }).audio.duckTo, 0);
});

// ---------- Accounts: what each channel is for ----------
test("edit captions: v1.9.1 format + #edit, campaign rules apply", () => {
  const kai = { platform: "twitch", login: "kaicenat", name: "Kai Cenat" };
  assert.equal(editCaption("Kai Cenat edit", kai), "Kai Cenat edit\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #StreamerMoments #edit", "v1.9.1 caption format + #edit");
  assert.match(editCaption("Kai Cenat funniest moments", kai, { vibe: "funny" }), /#ViceCity #GTA6Funny #edit$/);
  const camp = editCaption("Kai Cenat edit", kai, { campaign: { requiredText: "#ad\nUse code KAI", active: true } });
  assert.match(camp, /#GTA6 #GTAVI #ViceCity #StreamerMoments #ad\nUse code KAI$/, "campaign rules still apply (no #edit when it would make 6 hashtags)");
});

async function mkStreamer(login: string, o: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  return prisma.streamer.create({ data: { twitchId: `t-${login}-${Math.random()}`, login, name: login.toUpperCase(), approved: true, ...o } });
}

test("posting an edit: only approved, only to the channel that takes Edits; Upload column + by-hand Mark posted", async () => {
  const { startMocks, mockEnv } = await import("./mocks");
  const mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url));
  try {
    const { prisma } = await import("../src/lib/db");
    const { runPostEdit } = await import("../src/workers/poster");
    const { toPostEditItems } = await import("../src/lib/to-post-edits");
    const { markEditPostedToAccount, postEditToAll } = await import("../app/edit-actions");
    const { queue } = await import("../src/lib/queues");
    await queue("post").obliterate({ force: true });
    await prisma.channel.createMany({ data: [
      { id: "ch-gta", name: "ViceCityClips", kinds: "gaming,funny,edits", focus: "gta", createdAt: new Date(1000) },
      { id: "ch-gg", name: "ClipFactoryGG", kinds: "edits", focus: "any", createdAt: new Date(2000) },
      { id: "ch-gam", name: "WantedLevelClips", kinds: "gaming", focus: "any", createdAt: new Date(3000) },
    ] });
    const st = await mkStreamer("poster");
    fs.mkdirSync(path.join(storage, "edits", "e1"), { recursive: true });
    fs.writeFileSync(path.join(storage, "edits", "e1", "final.mp4"), Buffer.alloc(2048, 1));
    const e = await prisma.edit.create({ data: { id: "e1", streamerId: st.id, vibe: "hype", lengthSec: 20, bpm: 128, status: "pending", finalPath: "edits/e1/final.mp4", title: "POSTER edit", caption: "POSTER edit\n\n🎥 @poster" } });
    const exp = new Date(Date.now() + 3600_000);
    const yt = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-ed", channelTitle: "EditChan", refreshToken: "r", accessToken: "x", expiresAt: exp, homeChannelId: "ch-gg" } });
    const tt = await prisma.account.create({ data: { platform: "tiktok", channelId: "open-ed", channelTitle: "@edits", refreshToken: "r", accessToken: "x", expiresAt: exp, homeChannelId: "ch-gg" } });
    const ig = await prisma.account.create({ data: { platform: "instagram", mode: "manual", handle: "@clipfactorygg", refreshToken: "", homeChannelId: "ch-gg" } });
    const gaming = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-gam", channelTitle: "GamingChan", refreshToken: "r", accessToken: "x", expiresAt: exp, homeChannelId: "ch-gam" } });
    const loose = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-x", channelTitle: "NoChannel", refreshToken: "r", accessToken: "x", expiresAt: exp } });

    assert.equal((await toPostEditItems()).items.length, 0, "a pending edit isn't on Upload");
    await assert.rejects(runPostEdit(e.id, yt.id), /isn't approved/);
    assert.equal(mock.requests.filter((r) => r.path.includes("upload")).length, 0, "nothing uploaded");
    await prisma.edit.update({ where: { id: e.id }, data: { status: "approved" } });
    assert.equal(await queue("post").count(), 0, "approving an edit never auto-posts");

    // Upload: the first non-GTA channel whose types include Edits gets it (not ViceCityClips' GTA focus, not the gaming channel)
    let up = await toPostEditItems();
    assert.equal(up.channel?.name, "ClipFactoryGG");
    assert.deepEqual(up.items.map((x) => x.rows.map((r) => r.account.platform)), [["youtube", "tiktok", "instagram"]]);

    // v1.9.8 Platform check applies to edits: a landscape file is blocked
    await prisma.edit.update({ where: { id: e.id }, data: { platformInfo: JSON.stringify({ file: { width: 1920, height: 1080, vcodec: "h264", acodec: "aac", fps: 30, seconds: 20, bytes: 1e6, kbps: 4000, faststart: true }, render: null }) } });
    await assert.rejects(runPostEdit(e.id, yt.id), /Platform check failed: .*isn't vertical/);
    await prisma.edit.update({ where: { id: e.id }, data: { platformInfo: null } });
    await assert.rejects(runPostEdit(e.id, gaming.id), /isn't in a channel that takes Edits/);
    await assert.rejects(runPostEdit(e.id, loose.id), /isn't in a channel that takes Edits/);
    await assert.rejects(runPostEdit(e.id, ig.id), /posted to by hand/);
    await assert.rejects(postEditToAll(e.id, "ch-gam"), /doesn't take Edits/);
    const r = await postEditToAll(e.id, "ch-gg");
    assert.deepEqual([r.queued.length, r.byHand], [2, ["Instagram @clipfactorygg"]]);
    const jobs = await queue("post").getJobs(["waiting", "delayed", "prioritized"]);
    assert.deepEqual(jobs.map((j) => [j.name, j.data.accountId, j.opts.attempts]).sort(), [["edit", tt.id, 1], ["edit", yt.id, 1]].sort(), "single-attempt edit uploads");

    assert.match(await runPostEdit(e.id, yt.id), /uploaded POSTER edit to EditChan/);
    const init = mock.requests.find((r) => r.path.startsWith("/upload/youtube/v3/videos"))!;
    assert.match(JSON.parse(init.body.toString()).snippet.description, /Credit: POSTER — https:\/\/twitch\.tv\/poster/, "channel link added to the YouTube description");
    assert.match(await runPostEdit(e.id, yt.id), /already sent/);
    assert.match(await runPostEdit(e.id, tt.id), /TikTok inbox/);
    up = await toPostEditItems();
    assert.equal(up.items.length, 1, "still waiting on the by-hand Instagram");
    const fd = new FormData(); fd.set("url", "https://instagram.com/reel/abc");
    await markEditPostedToAccount(e.id, ig.id, fd);
    assert.equal((await toPostEditItems()).items.length, 0, "on every account of the channel: off Upload");
    const posts = await prisma.editPost.findMany({ where: { editId: e.id } });
    assert.deepEqual(posts.map((p) => [p.platform, p.status, p.channelId]).sort(), [["instagram", "live", "ch-gg"], ["tiktok", "draft", "ch-gg"], ["youtube", "live", "ch-gg"]]);
    assert.equal((await prisma.edit.findUniqueOrThrow({ where: { id: e.id } })).status, "posted");
    await queue("post").obliterate({ force: true });
    await prisma.account.deleteMany({});
    await prisma.channel.deleteMany({});
  } finally {
    await mock.close();
  }
});

// ---------- Media route ----------
test("media route: final / beat variants, Range, download names, 404s", async () => {
  const { prisma } = await import("../src/lib/db");
  const { GET } = await import("../app/api/media/edit/[id]/route");
  const st = await mkStreamer("media");
  fs.mkdirSync(path.join(storage, "edits", "m1"), { recursive: true });
  fs.writeFileSync(path.join(storage, "edits", "m1", "final.mp4"), Buffer.from("0123456789"));
  fs.writeFileSync(path.join(storage, "edits", "m1", "beat.mp4"), Buffer.from("BEATBEATBEAT"));
  await prisma.edit.create({ data: { id: "m1", streamerId: st.id, vibe: "funny", lengthSec: 20, bpm: 128, status: "pending", finalPath: "edits/m1/final.mp4", finalWithBeatPath: "edits/m1/beat.mp4" } });
  await prisma.edit.create({ data: { id: "m2", streamerId: st.id, vibe: "hype", lengthSec: 20, bpm: 128, status: "pending", finalPath: "../../etc/passwd" } });
  const get = (id: string, q = "", h: Record<string, string> = {}) => GET(new Request(`http://x/api/media/edit/${id}${q}`, { headers: h }), { params: Promise.resolve({ id }) });
  let r = await get("m1");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "0123456789");
  r = await get("m1", "?variant=beat");
  assert.equal(await r.text(), "BEATBEATBEAT");
  r = await get("m1", "", { range: "bytes=2-4" });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await r.text(), "234");
  r = await get("m1", "?download=1");
  assert.match(r.headers.get("content-disposition")!, /media-funny-edit\.mp4/);
  r = await get("m1", "?variant=beat&download=1");
  assert.match(r.headers.get("content-disposition")!, /PREVIEW-with-beat-dont-post/);
  assert.equal((await get("m2")).status, 400);
  assert.equal((await get("nope")).status, 404);
});

// ---------- Real ffmpeg renders ----------
async function testSource(file: string, seconds: number, audio = true) {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-shortest"] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", ...(audio ? ["-c:a", "aac"] : []), file]);
}
const probe = async (f: string) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,nb_read_frames", "-of", "json", f]);
  return JSON.parse(stdout).streams as { codec_type: string; width?: number; height?: number; nb_read_frames?: string }[];
};

test("render: 1080x1920 montage, exact planned length, audio on/off, beat preview always has sound", { timeout: 600_000 }, async () => {
  const { renderEdit } = await import("../src/lib/edit-render");
  const { planLayout } = await import("../src/lib/layout");
  const work = path.join(dir, "render");
  fs.mkdirSync(work, { recursive: true });
  const a = path.join(work, "a.mp4"), b = path.join(work, "b.mp4");
  await testSource(a, 8);
  await testSource(b, 8, false);
  const blur = planLayout({ choice: { layout: "blur", cam: null, camFrom: null, why: "" }, det: null, src: { w: 1280, h: 720 } });
  const sources = [a, b, a, b, a].map((file, i) => ({ file, hasAudio: file === a, layout: blur, plan: { dur: 8, payoff: 2 + i, strength: 1 - i / 10, category: "gaming" } }));
  const grid = steadyGrid(128, 8);
  for (const [vibe, creatorAudio] of [["hype", true], ["smooth", false]] as const) {
    const plan = buildPlan({ format: "montage", vibe, grid, sources: sources.map((s) => s.plan), title: "Test", endText: "follow for more" });
    const click = path.join(work, "click.wav");
    metronomeWav(grid.beats, plan.duration + 1, click);
    const out = path.join(work, `${vibe}.mp4`), beat = path.join(work, `${vibe}-beat.mp4`);
    const r = await renderEdit({ plan, sources, credit: "twitch.tv/test", workDir: path.join(work, vibe), final: out, beatPreview: beat, beat: { file: click, offset: 0 }, creatorAudio });
    const s = await probe(out);
    const v = s.find((x) => x.codec_type === "video")!;
    assert.deepEqual([v.width, v.height], [1080, 1920]);
    assert.ok(Math.abs(Number(v.nb_read_frames) - plan.frames) <= 1, `${vibe}: ${v.nb_read_frames} frames, planned ${plan.frames}`);
    assert.equal(s.some((x) => x.codec_type === "audio"), creatorAudio, `${vibe}: creator audio ${creatorAudio ? "kept" : "off = no audio"}`);
    const sb = await probe(beat);
    assert.ok(sb.some((x) => x.codec_type === "audio"), "the beat preview has the click");
    assert.ok(Math.abs(r.duration - plan.duration) <= 1.5 / FPS + 0.03, `${vibe}: ${r.duration}s vs ${plan.duration}s`);
    assert.equal(fs.readdirSync(path.join(work, vibe)).filter((f) => f.endsWith(".mkv")).length, 0, "slice files cleaned up");
  }
});

// ---------- Worker ----------
test("runEdit: a montage from raw files end to end (picks, beats, render, pending) + too few moments fails readably", { timeout: 600_000 }, async () => {
  const { prisma } = await import("../src/lib/db");
  const { runEdit, createEdit, runEditAuto } = await import("../src/workers/edit");
  const { queue } = await import("../src/lib/queues");
  await queue("edit").obliterate({ force: true });
  fs.mkdirSync(path.join(storage, "raw"), { recursive: true });
  const raw = path.join(storage, "raw", "edsrc.mp4");
  await testSource(raw, 12);
  const st = await mkStreamer("worker");
  for (let i = 0; i < 6; i++) {
    const m = await prisma.moment.create({ data: { streamerId: st.id, timestamp: new Date(), source: "twitch_clip", sourceUrl: `https://clips.twitch.tv/w${i}`, twitchClipId: `w${i}`, sourceViews: 100 + i * 50 } });
    await prisma.clip.create({ data: { momentId: m.id, status: i === 5 ? "rejected" : "pending", rawPath: "raw/edsrc.mp4", payoffAt: 3 + i, score: 6 + i / 2, category: "gaming" } });
  }
  const few = await mkStreamer("fewmoments");
  const e0 = await createEdit({ streamerId: few.id, vibe: "hype", lengthSec: 15, bpm: 128, creatorAudio: true });
  await assert.rejects(runEdit(e0.id), /only 0 usable moments \(an edit needs 5\)/);

  const e = await createEdit({ streamerId: st.id, vibe: "funny", lengthSec: 15, bpm: 128, creatorAudio: true, endText: "follow for more" });
  const jobs = await queue("edit").getJobs(["waiting"]);
  assert.ok(jobs.some((j) => j.data.editId === e.id), "queued on the edit queue");
  const { backlogRoom } = await import("../src/lib/guards");
  assert.equal(await backlogRoom(), 12 - 2, "edits in progress count against the backlog");
  const msg = await runEdit(e.id);
  assert.match(msg, /montage funny edit of WORKER: \d+ slices from 5 moments/);
  const done = await prisma.edit.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(done.status, "pending", "waits for Krew's Approve");
  assert.ok(fs.existsSync(path.join(storage, done.finalPath!)) && fs.existsSync(path.join(storage, done.finalWithBeatPath!)));
  assert.deepEqual(fs.readdirSync(path.join(storage, "edits", e.id)).sort(), ["beat.mp4", "final.mp4"], "downloads + work files gone");
  assert.match(done.caption!, /🎥 @worker\n\n#GTA6 #GTAVI #ViceCity .*#edit/);
  const info = JSON.parse(done.platformInfo!);
  assert.deepEqual([info.file.width, info.file.height, info.file.vcodec, info.render.unsafeText], [1080, 1920, "h264", []], "Platform check facts stored");
  const { platformCheck, parsePlatformInfo } = await import("../src/lib/platform-rules");
  const { captionCredits } = await import("../src/lib/social");
  assert.equal(platformCheck({ caption: done.caption!, title: done.title, creditOk: captionCredits(done.caption!, st), info: parsePlatformInfo(done.platformInfo) }).fails, 0, "a fresh edit passes the Platform check");
  const rep = JSON.parse(done.slices!);
  assert.equal(rep.picks.length, 5);
  assert.ok(rep.picks.every((p: { reused: boolean }) => p.reused), "raw files reused, nothing downloaded");
  assert.ok(Math.abs(done.duration! - beatsForLength(128, 15) * 60 / 128) < 0.1);

  // daily edits: off by default; on -> one per creator with 8+ moments (this one has 5) -> none
  assert.equal(await runEditAuto(), "daily edits are off");
  await prisma.settings.upsert({ where: { id: "main" }, update: { editAuto: true }, create: { id: "main", editAuto: true } });
  assert.match(await runEditAuto(), /made 0, \d+ had one today/);
  await prisma.settings.update({ where: { id: "main" }, data: { editAuto: false } });
});

test("retention: edit finals follow the clip rules, work files go after 24h", async () => {
  const { prisma } = await import("../src/lib/db");
  const { cleanEdits } = await import("../src/workers/retention");
  const st = await mkStreamer("ret");
  const now = Date.now(), old = new Date(now - 30 * 3600_000);
  const mk = async (id: string, status: string) => {
    fs.mkdirSync(path.join(storage, "edits", id), { recursive: true });
    for (const f of ["final.mp4", "beat.mp4", "src-0.mp4"]) {
      fs.writeFileSync(path.join(storage, "edits", id, f), "x");
      fs.utimesSync(path.join(storage, "edits", id, f), old, old);
    }
    await prisma.edit.create({ data: { id, streamerId: st.id, vibe: "hype", lengthSec: 20, bpm: 128, status, finalPath: `edits/${id}/final.mp4`, finalWithBeatPath: `edits/${id}/beat.mp4` } });
    await prisma.$executeRawUnsafe(`UPDATE Edit SET updatedAt = ${old.getTime()} WHERE id = '${id}'`);
  };
  await mk("r-rej", "rejected");
  await mk("r-ok", "approved");
  fs.mkdirSync(path.join(storage, "edits", "gone"), { recursive: true });
  fs.writeFileSync(path.join(storage, "edits", "gone", "final.mp4"), "x");
  fs.utimesSync(path.join(storage, "edits", "gone", "final.mp4"), old, old);
  const r = await cleanEdits(now);
  assert.equal(r.finals, 1);
  assert.equal(fs.existsSync(path.join(storage, "edits", "r-rej")), false, "rejected edit's folder emptied + removed");
  assert.deepEqual(fs.readdirSync(path.join(storage, "edits", "r-ok")).sort(), ["beat.mp4", "final.mp4"], "approved finals kept, the download went");
  assert.equal(fs.existsSync(path.join(storage, "edits", "gone")), false, "folder of a deleted edit");
  assert.equal((await prisma.edit.findUniqueOrThrow({ where: { id: "r-rej" } })).finalPath, null);
});

// ---------- db push upgrade ----------
test("db push upgrade from the v1.9.8 schema (2e4801e) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV198Schema(now);
  const git = spawnSync("git", ["show", "2e4801e:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 2e4801e one");
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
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'twitch_clip', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, layout, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 'split', 0, 0)`);
  sql(`INSERT INTO Account (id, platform, channelId, refreshToken, autoPost, homeChannelId, createdAt) VALUES ('ac', 'youtube', 'UC1', 'r', 1, 'clipfactorygg', 0)`);
  sql(`INSERT INTO Channel (id, name, kinds, focus, createdAt) VALUES ('clipfactorygg', 'ClipFactoryGG', 'edits', 'any', 0)`);
  sql(`INSERT INTO Settings (id, layout) VALUES ('main', 'auto')`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, status, layout FROM Clip")), [{ id: "c1", status: "pending", layout: "split" }]);
  assert.deepEqual(JSON.parse(sql("SELECT homeChannelId, autoPost FROM Account")), [{ homeChannelId: "clipfactorygg", autoPost: true }]);
  assert.deepEqual(JSON.parse(sql("SELECT kinds FROM Channel")), [{ kinds: "edits" }]);
  assert.deepEqual(JSON.parse(sql("SELECT editBpm, editVibe, editLength, editAuto, editCreatorAudio FROM Settings")), [{ editBpm: 128, editVibe: "hype", editLength: 20, editAuto: false, editCreatorAudio: true }]);
  assert.deepEqual(JSON.parse(sql("SELECT COUNT(*) AS n FROM Edit")), [{ n: 0 }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
