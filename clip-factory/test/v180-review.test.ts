import { test } from "node:test";
import assert from "node:assert/strict";
import { audioCues, findPayoff, pickSmartWindow, reactionEnd, snapWindowToWords, timedTranscript } from "../src/lib/window";
import { dedupe, momentTimeSpan, scoreCreatorClips, SAME_MOMENT_SEC } from "../src/lib/standout";
import { planEdit, planJumpCuts, quietRuns, silenceThreshold, windowPeak } from "../src/lib/edit";
import { judgeMarks } from "../src/workers/judge";
import type { Word } from "../src/lib/media";
import type { TwitchClip } from "../src/lib/twitch";

// v1.8.0 review fixes (each test is a bug found in the 9489388 candidate).

/** Words with a talking burst at each [start, n] (0.3s per word). */
function talk(...bursts: [number, number][]): Word[] {
  const out: Word[] = [];
  for (const [s, n] of bursts) for (let i = 0; i < n; i++) out.push({ word: `w${out.length}`, start: s + i * 0.3, end: s + i * 0.3 + 0.28 });
  return out;
}
/** 100ms levels: `base` dB everywhere, `v` dB inside each [from, to) range. */
function levelsWith(length: number, base: number, ...ranges: [number, number, number][]): number[] {
  return Array.from({ length: Math.round(length * 10) }, (_, i) => {
    const t = i / 10 + 0.05;
    const r = ranges.find(([a, b]) => t >= a && t < b);
    return r ? r[2] : base;
  });
}

test("jump cuts: a pause that is half game audio, half real silence -> only the silent half is cut (was: nothing, or all of it)", () => {
  // Talk 0-4.48, pause until 9 (game bed -30 dB until 6.5, then digital silence), talk 9-13.48, game-filled pause, talk 16-20.48.
  const words = talk([0, 15], [9, 15], [16, 15]);
  const speechAt = (t: number) => words.some((w) => t >= w.start && t <= w.end);
  const levels = Array.from({ length: 220 }, (_, i) => { const t = i / 10 + 0.05; return speechAt(t) ? -18 : t >= 6.5 && t < 9 ? -Infinity : -30; });
  const segs = planJumpCuts({ words, length: 22, minSec: 5, maxGap: 1.2, pad: 0.35, levels });
  assert.equal(segs.length, 2, JSON.stringify(segs));
  const cut = { start: segs[0].end, end: segs[1].start };
  assert.ok(cut.start >= 6.5 && cut.start <= 6.6, `cut starts where the silence starts: ${cut.start}`);
  assert.ok(Math.abs(cut.end - (9 - 0.35)) < 0.04, `0.35s kept before the next word: ${cut.end}`);
  // Nothing of the game-filled pause (13.48-16) is cut.
  assert.ok(segs.every((s) => !(s.end > 13.5 && s.end < 16)));
  assert.deepEqual(quietRuns(levels, 4.48, 9, -45).map((r) => [r.start, r.end]), [[6.5, 9]]);
});

test("jump cuts: a quiet game/music bed (-40 dBFS) is not silence any more (cap -45, 20 dB under speech)", () => {
  const words = talk([0, 15], [7, 15], [14, 15]);
  const speechAt = (t: number) => words.some((w) => t >= w.start && t <= w.end);
  const bed = Array.from({ length: 200 }, (_, i) => (speechAt(i / 10 + 0.05) ? -16 : -40));
  assert.equal(silenceThreshold(bed, words), -45);
  assert.equal(planEdit({ style: "hype", words, length: 20, minSec: 5, peak: null, levels: bed, jumpCuts: "normal" }).segs.length, 1);
  const silent = bed.map((v) => (v === -40 ? -70 : v));
  assert.ok(planEdit({ style: "hype", words, length: 20, minSec: 5, peak: null, levels: silent, jumpCuts: "normal" }).segs.length > 1);
});

test("payoff: the steady loudest second of game audio is not a payoff; a reaction (words + jump) is; laughter tokens count", () => {
  // 60s viewer clip: loud game all along (-16), speech at -18, an explosion decoy at 25s (0.4s, -6 dB), the streamer
  // screams at 43.5s (only +3 dB: mic compressor) and laughs.
  const levels = levelsWith(60, -16, [25, 25.4, -6], [43.5, 46, -13], [46.2, 47.7, -13]);
  const words: Word[] = [
    ...talk([28.5, 10]),
    { word: "No", start: 43.5, end: 43.8 }, { word: "way!", start: 43.9, end: 44.2 }, { word: "What?", start: 44.4, end: 44.8 }, { word: "no", start: 44.9, end: 45.1 }, { word: "no.", start: 45.2, end: 45.5 },
    { word: "Ha", start: 46.2, end: 46.4 }, { word: "ha", start: 46.5, end: 46.7 }, { word: "ha.", start: 46.8, end: 47.0 },
    { word: "Bro,", start: 48.5, end: 48.8 }, { word: "that", start: 48.9, end: 49.1 }, { word: "just", start: 49.2, end: 49.4 }, { word: "happened.", start: 49.5, end: 50 },
    ...talk([53, 10]),
  ];
  const p = findPayoff({ source: "twitch_clip", duration: 60, levels, words });
  assert.ok(Math.abs(p.at - 43.5) <= 0.2, `payoff ${p.at} (${p.why})`);
  assert.ok(reactionEnd({ payoff: p.at, levels, words, duration: 60 }) >= 47, "the laughter is part of the reaction");
  const w = pickSmartWindow({ duration: 60, payoff: p.at, words, levels, minSec: 15, maxSec: 35 });
  const end = w.start + w.length;
  assert.ok(end >= 50 && end <= 50.5, `ends right after the capper "Bro, that just happened.": ${end}`);
  assert.ok(end < 53, "not on the next topic");
});

test("reaction end: wordless laughter at talking level after a scream is part of the reaction; a game bed alone is not", () => {
  // Game bed -33, talking -18 (28-40s), scream -10 (43.5-45.3), laughing -18 (45.8-48.3), then only the bed.
  const levels = levelsWith(60, -33, [28.5, 40, -18], [43.5, 45.3, -10], [45.8, 48.3, -18]);
  assert.equal(findPayoff({ source: "twitch_clip", duration: 60, levels, words: [] }).at, 43.5);
  const end = reactionEnd({ payoff: 43.5, levels, words: [], duration: 60 });
  assert.ok(end >= 48 && end <= 49, `laughter kept: ${end}`);
  // Loud game all the time (bed = talking level): only the scream counts, the reaction doesn't run on for 8s.
  const loudGame = levelsWith(60, -18, [43.5, 45.3, -8]);
  const e2 = reactionEnd({ payoff: 43.5, levels: loudGame, words: [], duration: 60 });
  assert.ok(e2 >= 45 && e2 <= 46.5, `stops with the scream: ${e2}`);
});

test("chat hint: sharpened to the reaction, else kept; range limits the search", () => {
  const levels = levelsWith(45, -20, [33, 35, -8]);
  assert.equal(findPayoff({ source: "chat", duration: 45, levels, words: [], hint: 30 }).at, 33);
  assert.equal(findPayoff({ source: "chat", duration: 45, levels: levelsWith(45, -20), words: [], hint: 30 }).at, 30);
  // Range (the Judge's window): the burst at 33 is outside [5, 25] -> nothing there, the middle of the range.
  assert.equal(findPayoff({ source: "window", duration: 45, levels, words: [], range: { from: 5, to: 25 } }).at, 15);
});

test("punch-in fallback (old rows / payoff outside the window): the reaction jump, not the loudest second", () => {
  // Window levels: loud game everywhere (-12) with one gunshot second at -4, and a scream at 20s; words react at 20s.
  const fine = levelsWith(30, -20, [5, 6, -10], [20, 22, -6]);
  const perSec = Array.from({ length: 30 }, (_, i) => (i === 5 ? -10 : i === 20 || i === 21 ? -6 : -20));
  const words: Word[] = [{ word: "oh", start: 20, end: 20.2 }, { word: "no", start: 20.3, end: 20.5 }, { word: "bro!", start: 20.7, end: 21 }];
  assert.equal(windowPeak({ peakHint: { source: "twitch_clip", vodOffset: null }, start: 10, length: 30, fine, levels: perSec, words }), 20);
  // Chat spikes keep their known moment.
  assert.equal(windowPeak({ peakHint: { source: "chat", vodOffset: 30, vodId: "v" }, start: 10, length: 30, fine, levels: perSec, words }), 20);
  // Nothing known: the loudest second as before.
  assert.equal(windowPeak({ peakHint: null, start: 0, length: 30, fine: [], levels: perSec, words: [] }), 20.2);
});

test("Judge window: snapped so it never opens or ends mid-word", () => {
  const words: Word[] = [{ word: "okay", start: 9.8, end: 10.4 }, { word: "watch", start: 10.5, end: 10.9 }, { word: "this", start: 29.6, end: 30.3 }];
  assert.deepEqual(snapWindowToWords({ start: 10, length: 20 }, words, { duration: 60, maxSec: 35 }), { start: 9.65, length: 20.85 });
  // Running on would break maxSec: stop before the word instead.
  assert.deepEqual(snapWindowToWords({ start: 10, length: 20 }, words, { duration: 60, maxSec: 20.5 }), { start: 9.65, length: 19.9 });
  assert.deepEqual(snapWindowToWords({ start: 0, length: 20 }, [], { duration: 15, maxSec: 35 }), { start: 0, length: 15 });
});

test("Judge timeline: window edges, payoff, loudness jumps and silences are marked in time order", () => {
  const levels = levelsWith(40, -25, [10, 12, -70], [30, 31.5, -10]);
  const cues = audioCues(levels);
  assert.deepEqual(cues.jumps.map((j) => j.at), [30]);
  assert.ok(cues.jumps[0].db >= 10);
  assert.equal(cues.silences.length, 1);
  assert.ok(Math.abs(cues.silences[0].from - 10) < 0.2 && Math.abs(cues.silences[0].to - 12) < 0.4);
  const t = timedTranscript([{ word: "watch.", start: 29, end: 29.5 }, { word: "NO!", start: 30.1, end: 30.5 }], 80, judgeMarks(levels, { start: 8, end: 34 }, 30));
  assert.deepEqual(t.split("\n").map((l) => l.replace(/ dB.*$/, " dB")), [
    "[8.0s] (proposed window starts)", "[10.0s] (sound: silence until 12.0s)", "[29.0s] watch.", "[30.0s] (likely payoff / reaction)",
    `[30.0s] (sound: sudden loud burst, ${cues.jumps[0].db} dB`, "[30.1s] NO!", "[34.0s] (proposed window ends)",
  ]);
});

// ---------- Clips poller dedupe while the stream is live ----------
const NOW = Date.UTC(2026, 10, 18, 12);
function clip(id: string, views: number, secAgo: number, o: Partial<TwitchClip> = {}): TwitchClip {
  return { id, url: "", broadcaster_id: "k", broadcaster_name: "K", creator_name: "x", video_id: "", game_id: "jc", title: id, view_count: views,
    created_at: new Date(NOW - secAgo * 1000).toISOString(), thumbnail_url: "", duration: 30, vod_offset: null, ...o };
}

test("dedupe: live clips without vod_offset made within 30s of each other are one moment; existing chat/clip moments block them", () => {
  const clips = [clip("a", 900, 600), clip("b", 400, 590), clip("c", 300, 575), clip("d", 800, 300), clip("e", 700, 100), ...Array.from({ length: 6 }, (_, i) => clip(`f${i}`, 10, 5000 + i * 100))];
  const kept = scoreCreatorClips(clips, { minClipViews: 25, standoutMin: 2, now: NOW }).kept;
  assert.deepEqual(dedupe(kept).map((k) => k.clip.id).sort(), ["a", "d", "e"], "b (10s after a) and c (25s after a) are the same moment");
  // A chat moment detected at -320s (viewers clip 0-60s later) and an existing viewer clip at -110s.
  const existing = [momentTimeSpan({ source: "chat", timestamp: new Date(NOW - 320_000) }), momentTimeSpan({ source: "twitch_clip", timestamp: new Date(NOW - 110_000) })];
  assert.deepEqual(dedupe(kept, [], 20, existing).map((k) => k.clip.id), ["a"]);
  assert.equal(SAME_MOMENT_SEC, 30);
});
