// v2.0.0 Edits: the beat grid, the slice plan and the effect timeline. Everything here is pure (test/v200.test.ts);
// src/lib/edit-render.ts turns a plan into ffmpeg commands. Times are in OUTPUT FRAMES at 30 fps wherever cuts or
// effects must land on a beat: frame(t) = round(t * 30), so every cut is within half a frame (16.7 ms) of its beat and
// the slices' frame counts add up to exactly the length of the grid.
import { chunkWords, type Word } from "./media";
import type { EditFormat, Vibe } from "./edit-vibes";
import { watermarkPlace, watermarkStyle, watermarkText, type OverlayPlace } from "./layout";
import { SAFE_Y_TOP, TEXT_MAX_W, TEXT_SAFE, TEXT_X, fitScale } from "./platform-rules";

export const FPS = 30;
export const W = 1080, H = 1920;
export const frameOf = (t: number) => Math.round(t * FPS);
const r3 = (t: number) => Math.round(t * 1000) / 1000;

// ---------- Beat grid ----------
export type BeatGrid = {
  bpm: number;
  beats: number[];   // N+1 times in edit seconds: beats[0] = 0, beats[N] = the end of the edit
  dropBeat: number;  // beat index of the drop (always a downbeat: every 4th beat from 0 is a downbeat)
  offset: number;    // where in the timing track the edit starts (seconds); 0 for a steady beat
  source: "steady" | "track";
  drops?: number[];  // track: drop times found in the song (edit seconds), for the report
  dropOnBar?: boolean; // track: the song's own drop was put on the edit's drop bar
};

/** Number of beats for a length: a whole number of bars (4 beats) closest to lengthSec, at least 2 bars. */
export function beatsForLength(bpm: number, lengthSec: number): number {
  const P = 60 / bpm;
  return Math.max(8, 4 * Math.round(lengthSec / P / 4));
}

/** Bars before the drop: about a third of the way in for montages (after the title bar); clipedit passes its clip-part bars. */
export const montageDropBar = (nBars: number) => Math.max(1, Math.min(nBars - 2, Math.round(nBars * 0.35)));

/** A steady grid at `bpm` (Settings.editBpm): beat k at k x 60/bpm. */
export function steadyGrid(bpm: number, lengthSec: number, dropBar?: number): BeatGrid {
  const N = beatsForLength(bpm, lengthSec), P = 60 / bpm;
  const db = dropBar ?? montageDropBar(N / 4);
  return { bpm, beats: Array.from({ length: N + 1 }, (_, k) => r3(k * P)), dropBeat: Math.min(N - 4, db * 4), offset: 0, source: "steady" };
}

export type TrackBeats = { tempo: number; beats: number[]; downbeats: number[]; drops: { t: number; ratio: number }[]; duration: number };

/**
 * A grid from a timing track (scripts/beats.py): N beats starting on a downbeat of the song, placed so the song's biggest drop
 * lands on the edit's drop bar when it can; otherwise from the first downbeat that leaves room. Beats missing at the end of
 * the song are continued at the found tempo. `offset` = the song time of the edit's first beat (start the sound there).
 */
export function trackGrid(tb: TrackBeats, lengthSec: number, dropBar?: number): BeatGrid {
  const bpm = tb.tempo > 0 ? tb.tempo : 120;
  const P = 60 / bpm;
  const N = beatsForLength(bpm, lengthSec);
  const db = dropBar ?? montageDropBar(N / 4);
  const beats = tb.beats.length ? tb.beats : [0];
  const near = (t: number) => beats.reduce((bi, b, i) => (Math.abs(b - t) < Math.abs(beats[bi] - t) ? i : bi), 0);
  const downIdx = (tb.downbeats.length ? tb.downbeats : [beats[0]]).map(near);
  let start = -1, dropFound: number | null = null;
  for (const d of [...tb.drops].sort((a, b) => b.ratio - a.ratio)) {
    const s = near(d.t) - db * 4;
    if (s >= 0 && downIdx.includes(s)) { start = s; dropFound = d.t; break; }
  }
  if (start < 0) start = downIdx.find((s) => s + N <= beats.length - 1) ?? downIdx[0] ?? 0;
  const t0 = beats[start];
  const out: number[] = [];
  for (let k = 0; k <= N; k++) {
    const i = start + k;
    out.push(r3(i < beats.length ? beats[i] - t0 : out[out.length - 1] + P));
  }
  return {
    bpm: Math.round(bpm * 10) / 10, beats: out, dropBeat: Math.min(N - 4, db * 4), offset: r3(t0), source: "track",
    drops: tb.drops.map((d) => r3(d.t - t0)).filter((t) => t >= 0 && t <= out[N]),
    dropOnBar: dropFound != null,
  };
}

/** clipedit: whole bars of "clip part" before the drop, about 5s (3-8s), never more than the setup the source has before the payoff. */
export function clipBarsFor(bpm: number, setupAvail: number, totalBars: number): number {
  const bar = 240 / bpm;
  let bars = Math.max(1, Math.round(5 / bar));
  while (bars > 1 && bars * bar > 8) bars--;
  while (bars * bar < 3 && (bars + 1) * bar <= 8) bars++;
  while (bars > 1 && bars * bar > setupAvail + 0.05) bars--;
  return Math.max(1, Math.min(bars, totalBars - 2));
}

// ---------- The plan ----------
/** speed 1 = normal, 0.5 = slow-mo (half the source per output second), 0 = freeze-frame. */
export type Part = { frames: number; speed: 1 | 0.5 | 0 };
export type Focus = { x: number; y: number };

export type PlanSource = {
  dur: number;           // seconds of video in the file
  payoff: number;        // seconds into the file where the moment hits
  strength: number;      // 0..1 (edit-pick.ts rank)
  category: string | null;
  focus?: Focus | null;  // where the face is in the 1080x1920 frame (zoom centre), null = middle
  words?: Word[];        // words timed in this file (captions)
};

export type Role = "title" | "slice" | "drop" | "clip" | "replay" | "freeze" | "hit";
export type PlanSlice = {
  i: number; src: number; role: Role;
  beat0: number; beat1: number;  // beat indices
  f0: number; f1: number;        // output frames [f0, f1)
  pre: number; post: number;     // extra frames rendered before/after for crossfades (smooth)
  srcIn: number;                 // seconds into the source where the rendered slice (incl. pre) starts
  parts: Part[];                 // how the slice's frames (incl. pre/post) play
  hitFrame: number | null;       // output frame where the payoff lands
  focus: Focus | null;
};

export type Fx = {
  flashes: number[];                                        // frames: white flash ~80ms
  pulses: { f: number; len: number; amp: number }[];       // zoom 1+amp at f easing back to 1 over len frames
  punches: { f: number; end: number; amp: number }[];      // zoom in over 6 frames, held until end
  drifts: { f0: number; f1: number; a: number; b: number }[]; // zoom a -> b across [f0, f1)
  shakes: { f0: number; f1: number }[];
  rgb: { f0: number; f1: number }[];
};

export type EditPlan = {
  format: EditFormat; vibe: Vibe; fps: number;
  frames: number; duration: number; bpm: number; beatFrames: number[]; dropFrame: number;
  slices: PlanSlice[]; fx: Fx;
  transition: { kind: "cut" | "xfade"; frames: number };
  title: { text: string; f0: number; f1: number; pops: number[] };
  end: { text: string; f0: number; f1: number } | null;
  captions: { start: number; end: number; text: string }[]; // edit seconds
  audio: { duckFrom: number | null; stabFrames: number; duckTo: number }; // frames; clipedit ducks the creator after the drop
  grade: { contrast: number; saturation: number; gamma: number; brightness: number; vignette: string | null };
};

export const GRADE: Record<Vibe, EditPlan["grade"]> = {
  hype: { contrast: 1.12, saturation: 1.3, gamma: 0.98, brightness: 0, vignette: "PI/5" },
  funny: { contrast: 1.05, saturation: 1.15, gamma: 1, brightness: 0.01, vignette: "PI/7" },
  smooth: { contrast: 0.97, saturation: 0.9, gamma: 1.04, brightness: 0.01, vignette: "PI/6" },
};
/** Smooth: 6-frame (0.2s) crossfades / whip-pans centred on each cut. */
export const XFADE_FRAMES = 6;

/**
 * Split N beats into K slices of whole beats: bars of 4 first; fewer slices than bars -> 8-beat slices (never across the drop);
 * more -> split bars in halves (4 -> 2+2 -> 2+1+1 ...), the bars with the fewest slices first, in vibe order (Hype: the build-up
 * right before the drop first). Then the drop slice's start moves one beat early, so its payoff (on the slice's 2nd beat) lands
 * ON the drop (Hype plays that lead-in beat in slow-mo).
 * Returns [startBeat, lengthBeats] per slice.
 */
export function allocateBeats(N: number, K: number, dropBeat: number, vibe: Vibe): [number, number][] {
  const nBars = Math.max(1, Math.floor(N / 4));
  const dropBar = Math.floor(dropBeat / 4);
  let units: [number, number][] = Array.from({ length: nBars }, (_, b) => [b * 4, 4] as [number, number]);
  // merge pairs of bars (far from the drop first), never across the drop
  while (units.length > K) {
    let best = -1, bestD = -1;
    for (let i = 0; i + 1 < units.length; i++) {
      const [s, l] = units[i], [s2, l2] = units[i + 1];
      if (l !== 4 || l2 !== 4 || s2 === dropBeat || s === dropBeat) continue;
      const d = Math.abs(s - dropBeat);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best < 0) break;
    units.splice(best, 2, [units[best][0], 8]);
  }
  // split, spreading the cuts over the bars
  const order = Array.from({ length: nBars }, (_, b) => b).sort((a, b) => {
    const pri = (x: number) => vibe === "hype"
      ? (x === dropBar ? 1000 : x < dropBar ? dropBar - x : 100 + (x - dropBar)) + (x === 0 ? 50 : 0)
      : (x === dropBar ? 1000 : x === 0 ? 500 : Math.abs(x - dropBar));
    return pri(a) - pri(b);
  });
  while (units.length < K) {
    const countIn = (b: number) => units.filter(([s]) => Math.floor(s / 4) === b).length;
    let did = false;
    const cands = [...order].sort((a, b) => countIn(a) - countIn(b));
    for (const b of cands) {
      const inBar = units.map((u, i) => [u, i] as const).filter(([[s, l]]) => Math.floor(s / 4) === b && l >= 2 && l <= 4);
      if (!inBar.length) continue;
      const [[s, l], i] = inBar.reduce((m, x) => (x[0][1] > m[0][1] ? x : m));
      const h = Math.floor(l / 2);
      units.splice(i, 1, [s, h], [s + h, l - h]);
      did = true;
      break;
    }
    if (!did) break;
  }
  units.sort((a, b) => a[0] - b[0]);
  {
    const di = units.findIndex(([s]) => s === dropBeat);
    if (di > 0 && units[di - 1][1] >= 2) {
      units[di - 1] = [units[di - 1][0], units[di - 1][1] - 1];
      units[di] = [dropBeat - 1, units[di][1] + 1];
    }
  }
  return units;
}

/** The slice whose hit lands on the drop: it starts a beat before it (one beat of lead-in), or on it when that wasn't possible. */
export function dropSlotOf(units: [number, number][], dropBeat: number): number {
  const early = units.findIndex(([s, l]) => s === dropBeat - 1 && l >= 2);
  return early >= 0 ? early : units.findIndex(([s]) => s === dropBeat);
}

/** Which slot gets the strongest moment: the drop, then the opener, the end, downbeat starts, longer slices. */
export function slotImportance(units: [number, number][], dropBeat: number, vibe: Vibe): number[] {
  return units.map(([s, l], i) => {
    const isDrop = i === dropSlotOf(units, dropBeat);
    return (isDrop ? 100 : 0) + (i === 0 ? 60 : 0) + (i === units.length - 1 ? 30 : 0) + (s % 4 === 0 ? 20 : 0) + l * 3;
  });
}

/** Source seconds a list of parts plays. */
export const partsSource = (parts: Part[]) => parts.reduce((n, p) => n + (p.frames * p.speed) / FPS, 0);
const partsFrames = (parts: Part[]) => parts.reduce((n, p) => n + p.frames, 0);

/** Frames played before output frame `k` of the slice -> source seconds consumed. */
function sourceBefore(parts: Part[], k: number) {
  let left = k, s = 0;
  for (const p of parts) {
    const f = Math.min(left, p.frames);
    s += (f * p.speed) / FPS;
    left -= f;
    if (left <= 0) break;
  }
  return s;
}

/** Place the slice in its source: the payoff at `hitOffset` frames into the slice, kept inside the file. */
function placeIn(src: PlanSource, parts: Part[], pre: number, hitOffset: number | null, shift = 0): number {
  const total = partsSource(parts);
  const before = hitOffset == null ? 0 : sourceBefore(parts, pre + hitOffset);
  let srcIn = src.payoff + shift - before;
  srcIn = Math.min(srcIn, src.dur - total - 0.05);
  return r3(Math.max(0, srcIn));
}

function emptyFx(): Fx { return { flashes: [], pulses: [], punches: [], drifts: [], shakes: [], rgb: [] }; }

export type PlanInput = {
  format: EditFormat; vibe: Vibe; grid: BeatGrid; sources: PlanSource[]; title: string; endText?: string | null;
  captions?: boolean; creatorAudio?: boolean;
};

/** Build the whole plan (montage or clip -> edit). sources[0] is the best moment (and the clip for clipedit). */
export function buildPlan(o: PlanInput): EditPlan {
  return o.format === "clipedit" ? planClipEdit(o) : planMontage(o);
}

function base(o: PlanInput, slices: PlanSlice[], fx: Fx, extra: Partial<EditPlan>): EditPlan {
  const g = o.grid, N = g.beats.length - 1;
  const beatFrames = g.beats.map(frameOf);
  const frames = beatFrames[N];
  const barEnd = beatFrames[Math.min(4, N)];
  const pops = beatFrames.slice(0, Math.min(4, N));
  return {
    format: o.format, vibe: o.vibe, fps: FPS, frames, duration: r3(frames / FPS), bpm: g.bpm, beatFrames, dropFrame: beatFrames[g.dropBeat],
    slices, fx, transition: { kind: "cut", frames: 0 },
    title: { text: o.title, f0: 0, f1: barEnd, pops },
    end: o.endText ? { text: o.endText, f0: beatFrames[Math.max(0, N - 4)], f1: frames } : null,
    captions: [], audio: { duckFrom: null, stabFrames: 0, duckTo: 1 }, grade: GRADE[o.vibe],
    ...extra,
  };
}

function planMontage(o: PlanInput): EditPlan {
  const { grid: g, vibe } = o;
  const N = g.beats.length - 1;
  const bf = g.beats.map(frameOf);
  const nSrc = o.sources.length;
  if (nSrc < 1) throw new Error("no moments to edit");
  const duration = g.beats[N];
  const per = vibe === "hype" ? 1.2 : vibe === "funny" ? 2.3 : 2.8;
  const K = Math.max(Math.min(5, N), Math.min(12, Math.round(duration / per)));
  const units = allocateBeats(N, K, g.dropBeat, vibe);
  const imp = slotImportance(units, g.dropBeat, vibe);
  const slotOrder = units.map((_, i) => i).sort((a, b) => imp[b] - imp[a] || a - b);
  // strongest moment -> most important slot; moments reused (later part of the source) only when there are more slots
  const srcOrder = o.sources.map((_, i) => i).sort((a, b) => o.sources[b].strength - o.sources[a].strength);
  const assign: { src: number; use: number }[] = new Array(units.length);
  slotOrder.forEach((slot, k) => { assign[slot] = { src: srcOrder[k % nSrc], use: Math.floor(k / nSrc) }; });
  // a reused moment never plays right next to itself: swap it with a later slice that isn't next to the same moment
  const keepSlot = dropSlotOf(units, g.dropBeat);
  if (nSrc > 2) for (let i = 1; i < assign.length; i++) {
    if (assign[i].src !== assign[i - 1].src) continue;
    const i2 = i === keepSlot ? i - 1 : i; // move the other one, never the drop's moment
    if (i2 === keepSlot) continue;
    const near = (j: number, src: number) => [j - 1, j + 1].some((x) => assign[x]?.src === src);
    const j = assign.findIndex((x, k) => k !== keepSlot && Math.abs(k - i2) > 1 && x.src !== assign[i2].src && !near(k, assign[i2].src) && !near(i2, x.src));
    if (j >= 0) [assign[i2], assign[j]] = [assign[j], assign[i2]];
  }

  const xf = vibe === "smooth" ? XFADE_FRAMES : 0;
  const fx = emptyFx();
  const dropSlot = dropSlotOf(units, g.dropBeat);
  // Funny: freeze the punchline of the two strongest funny-ish slots that are long enough
  const freezeSlots = new Set(vibe === "funny"
    ? slotOrder.filter((i) => units[i][1] >= 4 && i !== units.length - 1).slice(0, 2) : []);
  const rampSlots = new Set(vibe === "hype" ? [dropSlot, ...slotOrder.filter((i) => i !== dropSlot && units[i][1] >= 3).slice(0, 1)].filter((i) => i >= 0) : []);

  const slices: PlanSlice[] = units.map(([s, l], i) => {
    const e = s + l;
    const f0 = bf[s], f1 = bf[e];
    const pre = i > 0 ? xf / 2 : 0, post = i < units.length - 1 ? xf / 2 : 0;
    const n = f1 - f0;
    const beatLen = bf[Math.min(N, s + 1)] - bf[s];
    const hitOffset = l >= 2 ? bf[s + 1] - f0 : Math.round(beatLen * 0.2);
    let parts: Part[];
    if (rampSlots.has(i) && l >= 2) {
      parts = [{ frames: pre + hitOffset, speed: 0.5 }, { frames: n - hitOffset + post, speed: 1 }];
    } else if (freezeSlots.has(i)) {
      const fr = Math.min(bf[e] - bf[e - 1], 24);
      parts = [{ frames: pre + n - fr, speed: 1 }, { frames: fr + post, speed: 0 }];
    } else {
      parts = [{ frames: pre + n + post, speed: 1 }];
    }
    const a = assign[i];
    const src = o.sources[a.src];
    const srcIn = placeIn(src, parts, pre, hitOffset, a.use * 1.5);
    return {
      i, src: a.src, role: i === dropSlot ? "drop" : freezeSlots.has(i) ? "freeze" : i === 0 ? "title" : "slice",
      beat0: s, beat1: e, f0, f1, pre, post, srcIn, parts, hitFrame: f0 + hitOffset, focus: src.focus ?? null,
    } as PlanSlice;
  });

  // ---- effects on the beat ----
  const dropHit = dropSlot >= 0 ? slices[dropSlot].hitFrame! : bf[g.dropBeat];
  const strong = slotOrder.filter((i) => i !== dropSlot).slice(0, 2);
  if (vibe === "hype") {
    for (const sl of slices) if (sl.beat0 % 4 === 0) fx.flashes.push(sl.f0);
    fx.flashes.push(dropHit);
    for (let k = 0; k < N; k++) fx.pulses.push({ f: bf[k], len: Math.min(10, bf[k + 1] - bf[k]), amp: k % 4 === 0 ? 0.08 : 0.05 });
    fx.shakes.push({ f0: dropHit, f1: dropHit + 9 });
    fx.rgb.push({ f0: dropHit, f1: dropHit + 8 });
    for (const i of strong) { const h = slices[i].hitFrame!; fx.shakes.push({ f0: h, f1: h + 6 }); fx.rgb.push({ f0: h, f1: h + 4 }); }
  } else if (vibe === "funny") {
    fx.flashes.push(dropHit);
    fx.shakes.push({ f0: dropHit, f1: dropHit + 6 });
    for (const sl of slices) {
      if (sl.role === "freeze") {
        const frz = sl.parts[sl.parts.length - 1].frames - sl.post;
        fx.punches.push({ f: sl.hitFrame!, end: sl.f1 - frz, amp: 0.1 });
        fx.drifts.push({ f0: sl.f1 - frz, f1: sl.f1, a: 0.1, b: 0.24 });
      } else if (sl.beat1 - sl.beat0 >= 2) {
        fx.punches.push({ f: sl.hitFrame!, end: sl.f1, amp: 0.1 });
      }
    }
    for (let k = 0; k < N; k += 4) fx.pulses.push({ f: bf[k], len: Math.min(8, bf[k + 1] - bf[k]), amp: 0.03 });
  } else {
    slices.forEach((sl, i) => fx.drifts.push({ f0: sl.f0, f1: sl.f1, a: i % 2 ? 0.06 : 0, b: i % 2 ? 0 : 0.06 }));
  }
  fx.flashes = [...new Set(fx.flashes)].sort((a, b) => a - b);
  return base(o, slices, fx, { transition: { kind: xf ? "xfade" : "cut", frames: xf }, captions: o.captions ? planCaptions(o, slices) : [] });
}

/**
 * Clip -> Edit: (a) the clip part plays one moment normally with its own audio and captions for whole bars (~5s), (b) the drop
 * lands exactly on its payoff (flash, punch-in, shake, RGB split, a short stab of the reaction audio), (c) the edit part: 2-3
 * replays of the hit (slow-mo ramp into 1x, a double hit, a freeze-frame + zoom on the reaction) and up to 3 short hits of the
 * creator's other top moments, ending on a hard cut. The creator's audio ducks under after the stab.
 */
function planClipEdit(o: PlanInput): EditPlan {
  const g = o.grid, N = g.beats.length - 1;
  const bf = g.beats.map(frameOf);
  const D = g.dropBeat; // the clip part = beats [0, D)
  const main = o.sources[0];
  if (!main) throw new Error("no clip to edit");
  const slices: PlanSlice[] = [];
  const push = (src: number, role: Role, s: number, e: number, parts: Part[], hitOffset: number | null, srcIn?: number) => {
    const f0 = bf[s], f1 = bf[e];
    const fixed = fitParts(parts, f1 - f0);
    slices.push({ i: slices.length, src, role, beat0: s, beat1: e, f0, f1, pre: 0, post: 0, parts: fixed, hitFrame: hitOffset == null ? null : f0 + hitOffset,
      srcIn: srcIn ?? placeIn(o.sources[src], fixed, 0, hitOffset), focus: o.sources[src].focus ?? null });
  };
  // (a) clip part: ends exactly on the payoff
  const clipFrames = bf[D];
  push(0, "clip", 0, D, [{ frames: clipFrames, speed: 1 }], clipFrames, r3(Math.max(0, main.payoff - clipFrames / FPS)));
  // (b) the drop bar: continues from the payoff at 1x
  const dropEnd = Math.min(N, D + 4);
  push(0, "drop", D, dropEnd, [{ frames: bf[dropEnd] - bf[D], speed: 1 }], 0, r3(main.payoff));
  // (c) the edit part
  const others = o.sources.map((_, i) => i).filter((i) => i > 0).sort((a, b) => o.sources[b].strength - o.sources[a].strength).slice(0, 3);
  type Item = { src: number; role: Role; beats: number; kind: "ramp" | "hit" | "freeze" | "fill" };
  const items: Item[] = [
    { src: 0, role: "replay", beats: 4, kind: "ramp" },
    { src: 0, role: "replay", beats: 2, kind: "hit" },
    { src: 0, role: "replay", beats: 2, kind: "hit" },
    ...others.slice(0, 1).map((s) => ({ src: s, role: "hit" as Role, beats: 4, kind: "fill" as const })),
    { src: 0, role: "freeze", beats: 4, kind: "freeze" },
    ...others.slice(1).map((s) => ({ src: s, role: "hit" as Role, beats: 4, kind: "fill" as const })),
    { src: 0, role: "replay", beats: 4, kind: "ramp" },
    { src: 0, role: "replay", beats: 4, kind: "hit" },
  ];
  let b = dropEnd;
  for (let k = 0; b < N; k++) {
    const it = items[k % items.length];
    let e = Math.min(N, b + it.beats);
    if (N - e > 0 && N - e < 2) e = N; // never leave a 1-beat scrap at the end
    const n = bf[e] - bf[b];
    const beat = bf[Math.min(N, b + 1)] - bf[b];
    if (it.kind === "ramp" && e - b >= 3) {
      const slow = bf[b + 2] - bf[b];
      push(it.src, it.role, b, e, [{ frames: slow, speed: 0.5 }, { frames: n - slow, speed: 1 }], slow);
    } else if (it.kind === "freeze" && e - b >= 2) {
      const play = bf[b + 2] - bf[b];
      push(it.src, it.role, b, e, [{ frames: play, speed: 1 }, { frames: n - play, speed: 0 }], Math.round(beat * 0.5));
    } else if (it.kind === "fill" && e - b >= 2) {
      push(it.src, it.role, b, e, [{ frames: n, speed: 1 }], bf[b + 1] - bf[b]);
    } else {
      push(it.src, it.role, b, e, [{ frames: n, speed: 1 }], Math.min(n - 1, Math.round(beat * 0.15)));
    }
    b = e;
  }
  // effects
  const fx = emptyFx();
  const drop = bf[D];
  const calm = o.vibe === "smooth";
  fx.flashes.push(drop);
  fx.punches.push({ f: drop, end: bf[dropEnd], amp: 0.14 });
  fx.shakes.push({ f0: drop, f1: drop + (calm ? 5 : 10) });
  fx.rgb.push({ f0: drop, f1: drop + 8 });
  for (let k = D + 1; k < N; k++) {
    if (k < dropEnd) continue;
    fx.pulses.push({ f: bf[k], len: Math.min(10, bf[k + 1] - bf[k]), amp: calm ? 0.03 : k % 4 === 0 ? 0.09 : 0.05 });
    if (k % 4 === 0 && !calm) fx.rgb.push({ f0: bf[k], f1: bf[k] + 3 });
  }
  for (const sl of slices) {
    if (sl.f0 <= drop) continue;
    if (sl.beat0 % 4 === 0 && !calm) fx.flashes.push(sl.f0);
    if (sl.role === "freeze") {
      const frz = sl.parts[sl.parts.length - 1].frames;
      fx.drifts.push({ f0: sl.f1 - frz, f1: sl.f1, a: 0.04, b: 0.22 });
    }
    if (sl.role === "replay" && sl.hitFrame != null && sl.hitFrame > sl.f0 && !calm) fx.shakes.push({ f0: sl.hitFrame, f1: sl.hitFrame + 6 });
  }
  fx.flashes = [...new Set(fx.flashes)].sort((a, b) => a - b);
  // the name pops on the drop bar (the clip part has the captions)
  const plan = base(o, slices, fx, {
    title: { text: o.title, f0: drop, f1: bf[dropEnd], pops: bf.slice(D, dropEnd) },
    audio: { duckFrom: drop, stabFrames: 18, duckTo: o.creatorAudio === false ? 0 : 0.22 },
  });
  plan.captions = planCaptions(o, slices.filter((s) => s.role === "clip"));
  return plan;
}

/** Make a list of parts play exactly n frames (rounding can leave a frame over or short): the last part absorbs it. */
function fitParts(parts: Part[], n: number): Part[] {
  const out = parts.map((p) => ({ ...p }));
  const diff = n - partsFrames(out);
  out[out.length - 1].frames += diff;
  return out.filter((p) => p.frames > 0);
}

/** Word captions for slices played at 1x (in edit seconds). Words come from each source's own timing. */
function planCaptions(o: PlanInput, slices: PlanSlice[]) {
  const words: Word[] = [];
  for (const sl of slices) {
    const ws = o.sources[sl.src].words ?? [];
    if (!ws.length || sl.parts.length !== 1 || sl.parts[0].speed !== 1) continue;
    const a = sl.srcIn, b = sl.srcIn + (sl.f1 - sl.f0) / FPS;
    for (const w of ws) {
      if (w.start < a || w.end > b + 0.3) continue;
      words.push({ word: w.word, start: r3(sl.f0 / FPS + w.start - a), end: r3(Math.min(sl.f1 / FPS, sl.f0 / FPS + w.end - a)) });
    }
  }
  return chunkWords(words).map((c) => ({ ...c, start: r3(c.start), end: r3(c.end) }));
}

// ---------- ffmpeg expressions from the plan ----------
const gate = (a: number, b: number) => `gte(n,${a})*lt(n,${b})`;

/** Zoom factor per output frame n (1 = no zoom), capped at 1.4. */
export function zoomExprN(fx: Fx): string {
  const t: string[] = [];
  for (const p of fx.pulses) t.push(`${p.amp}*${gate(p.f, p.f + p.len)}*pow(1-(n-${p.f})/${p.len},2)`);
  for (const p of fx.punches) t.push(`${p.amp}*${gate(p.f, p.end)}*min(1,(n-${p.f})/6)`);
  for (const d of fx.drifts) t.push(`${gate(d.f0, d.f1)}*(${d.a}+${r3(d.b - d.a)}*(n-${d.f0})/${Math.max(1, d.f1 - d.f0)})`);
  for (const s of fx.shakes) t.push(`0.04*${gate(s.f0, s.f1)}`);
  return t.length ? `min(1.4,1+${t.join("+")})` : "1";
}

/** Shake: a small jitter of the crop (px), only inside shake windows. */
export function shakeExprN(fx: Fx, axis: "x" | "y"): string {
  if (!fx.shakes.length) return "0";
  const g = fx.shakes.map((s) => gate(s.f0, s.f1)).join("+");
  return axis === "x" ? `14*(${g})*sin(n*2.7)` : `14*(${g})*cos(n*2.1)`;
}

/** Zoom centre per slice (face for Funny/clip edits when known, else the middle). */
export function focusExprN(slices: PlanSlice[], axis: "x" | "y"): string {
  const def = axis === "x" ? W / 2 : H / 2;
  const v = slices.map((s) => Math.round(s.focus ? (axis === "x" ? s.focus.x : s.focus.y) : def));
  if (v.every((x) => x === v[0])) return String(v[0] ?? def);
  let e = String(v[v.length - 1]);
  for (let i = slices.length - 2; i >= 0; i--) e = `if(lt(n,${slices[i].f1}),${v[i]},${e})`;
  return e;
}

/** White flash: brightness up at each flash frame, gone after ~3 frames (80-100 ms). */
export function flashExprN(fx: Fx, base = 0): string {
  if (!fx.flashes.length) return String(base);
  return `${base}+${fx.flashes.map((f) => `0.55*gte(n,${f})*max(0,1-(n-${f})/2.6)`).join("+")}`;
}

export const rgbEnable = (fx: Fx) => fx.rgb.map((r) => `between(n,${r.f0},${r.f1 - 1})`).join("+");

/** The scale+crop chain for zoom/shake/focus on the 1080x1920 stream (same trick as edit.ts: crop repeats the size math). */
export function zoomChainN(plan: EditPlan): string {
  const z = zoomExprN(plan.fx);
  if (z === "1") return "null";
  const zw = `2*trunc(${W}*(${z})/2)`, zh = `2*trunc(${H}*(${z})/2)`;
  const cx = focusExprN(plan.slices, "x"), cy = focusExprN(plan.slices, "y");
  const x = `max(0,min(${zw}-${W},(${cx})*(${zw})/${W}-${W / 2}+${shakeExprN(plan.fx, "x")}))`;
  const y = `max(0,min(${zh}-${H},(${cy})*(${zh})/${H}-${H / 2}+${shakeExprN(plan.fx, "y")}))`;
  return `scale=w='${zw}':h='${zh}':eval=frame:flags=bilinear,crop=${W}:${H}:x='${x}':y='${y}'`;
}

// ---------- ASS (title, credit, end text, captions, preview label) ----------
function assTime(t: number) {
  const cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = (cs % 6000) / 100;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
const esc = (s: string) => s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();

/** Big name: fits ~900px wide (DejaVu Sans Bold is ~0.62 em per capital). */
export const titleSize = (text: string) => Math.max(72, Math.min(170, Math.floor(1450 / Math.max(4, text.length) / 0.62 / 1.6)));
// v1.9.8 safe zone (src/lib/platform-rules.ts TEXT_SAFE): all edit text sits inside it, centred on TEXT_X, fitted to TEXT_MAX_W.
export const TITLE_Y = 1320;
export const CREDIT_Y = SAFE_Y_TOP;
export const CAPTION_Y = 1100;
/** Where an edit's text is, in the clip OverlayPlace shape (the Platform check's unsafeText reads it). */
export const EDIT_PLACE: OverlayPlace = { capY: CAPTION_Y, hookY: TITLE_Y - 95, hookAlign: 8, creditY: CREDIT_Y, creditAlign: 8 };

export function buildEditAss(plan: EditPlan, o: { credit: string; font?: string; previewLabel?: boolean; watermark?: string | null }): string {
  const font = o.font || process.env.CAPTION_FONT || "DejaVu Sans";
  const t = (f: number) => assTime(f / FPS);
  const title = esc(plan.title.text).toUpperCase().slice(0, 40);
  const ts = Math.round(titleSize(title) * fitScale(title, titleSize(title), TEXT_MAX_W, { spacing: 2, outline: 10 }));
  const pos = (y: number) => `{\\pos(${TEXT_X},${y})}`;
  const fit = (text: string, size: number, outline: number) => {
    const k = fitScale(text, size, TEXT_MAX_W, { outline });
    return k < 1 ? `{\\fscx${Math.round(k * 100)}\\fscy${Math.round(k * 100)}}` : "";
  };
  const titleColour = plan.vibe === "hype" ? "&H0000E6FF" : "&H00FFFFFF";
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Title,${font},${ts},${titleColour},&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,2,0,1,10,5,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Credit,${font},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,3,10,0,8,${TEXT_SAFE.left},${TEXT_SAFE.right},${CREDIT_Y},1`,
    `Style: End,${font},96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,8,4,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Cap,${font},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,7,3,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Label,${font},40,&H00FFFFFF,&H00FFFFFF,&H002020D0,&H002020D0,-1,0,0,0,100,100,0,0,3,12,0,8,${TEXT_SAFE.left},${TEXT_SAFE.right},${CREDIT_Y + 70},1`,
    watermarkStyle(font),
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 3,${t(0)},${t(plan.frames)},Credit,,0,0,0,,{\\an8}${pos(CREDIT_Y)}${fit(esc(o.credit), 44, 10)}${esc(o.credit)}`,
  ];
  // v1.9.1 channel watermark ("@ViceCityClips", bottom right), the whole edit long
  const mark = watermarkText(o.watermark);
  if (mark) lines.push(`Dialogue: 3,${t(0)},${t(plan.frames)},Mark,,0,0,0,,${watermarkPlace(null).tag}${mark}`);
  if (o.previewLabel) lines.push(`Dialogue: 4,${t(0)},${t(plan.frames)},Label,,0,0,0,,PREVIEW WITH THE BEAT - DON'T POST THIS ONE`);
  if (title) {
    // one line per beat of the title bar, each popping on its beat (the first one pops in from small)
    const pops = plan.title.pops.length ? plan.title.pops : [plan.title.f0];
    pops.forEach((f, k) => {
      const end = k + 1 < pops.length ? pops[k + 1] : plan.title.f1;
      const pop = k === 0 ? "{\\fscx55\\fscy55\\t(0,90,\\fscx112\\fscy112)\\t(90,190,\\fscx100\\fscy100)}"
        : plan.vibe === "smooth" ? "" : "{\\t(0,70,\\fscx108\\fscy108)\\t(70,160,\\fscx100\\fscy100)}";
      const fade = k === pops.length - 1 ? "{\\fad(0,120)}" : "";
      lines.push(`Dialogue: 2,${t(f)},${t(end)},Title,,0,0,0,,${pos(TITLE_Y)}${fade}${pop}${title}`);
    });
  }
  if (plan.end) lines.push(`Dialogue: 2,${t(plan.end.f0)},${t(plan.end.f1)},End,,0,0,0,,${pos(TITLE_Y)}{\\fad(120,0)\\fscx70\\fscy70\\t(0,150,\\fscx100\\fscy100)}${esc(plan.end.text)}`);
  for (const c of plan.captions) {
    const text = esc(c.text).toUpperCase();
    if (text) lines.push(`Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${pos(CAPTION_Y)}${fit(text, 84, 7)}{\\fad(50,0)}${text}`);
  }
  return lines.join("\n") + "\n";
}

/** Plain-English summary of the plan for the report / Edits page. */
export function describePlan(plan: EditPlan): string[] {
  return plan.slices.map((s) => {
    const sp = s.parts.map((p) => (p.speed === 1 ? `${p.frames}f` : p.speed === 0 ? `${p.frames}f freeze` : `${p.frames}f slow`)).join(" + ");
    return `#${s.i + 1} beats ${s.beat0}-${s.beat1} (${(s.f0 / FPS).toFixed(3)}-${(s.f1 / FPS).toFixed(3)}s) ${s.role} src${s.src}@${s.srcIn.toFixed(2)}s [${sp}]${s.hitFrame != null ? ` hit ${(s.hitFrame / FPS).toFixed(3)}s` : ""}`;
  });
}
