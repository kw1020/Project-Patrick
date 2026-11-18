// v1.8.0 "Better moments": which part of the source to keep. Pure (tested in test/v180.test.ts, test/v180-review.test.ts).
// Viewers clip right AFTER something happens, so in a Twitch clip the payoff is usually late, not in the middle.
// 1) findPayoff: the reaction moment. Game audio is loud all the time, so "the loudest second" means little on Twitch:
//    we score each moment by how far its loudness JUMPS over the usual level of the 8 seconds before it (the 80th
//    percentile = normal talking/game level, and the median), plus reaction words (no / what / bro / ha ha…) right after.
//    Chat spikes and YouTube replay peaks give a hint that is sharpened the same way.
// 2) pickSmartWindow: ends just after the reaction (a short "capper" sentence included), starts at the beginning of a
//    sentence about 80% of the max length earlier, so the payoff lands around 2/3 in and nothing drags after it.
import type { Word } from "./media";

/** Loudness frames are this long (seconds). measureLevels() in src/lib/edit.ts makes them. */
export const FRAME = 0.1;
const r2 = (t: number) => Math.round(t * 100) / 100;
/** dB used for digital silence in the maths below. */
const FLOOR = -90;
/** Below this (dBFS, 1s average) a stretch counts as real silence: no game audio, no mic. */
export const SILENT_DB = -50;

/** Mean power of dB levels, back in dB (-Infinity stays silent). */
export function meanDb(levels: number[]) {
  const ok = levels.filter((v) => Number.isFinite(v));
  if (!ok.length) return -Infinity;
  const p = ok.reduce((n, v) => n + 10 ** (v / 10), 0) / levels.length;
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
}

function quantile(xs: number[], q: number) {
  if (!xs.length) return FLOOR;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 1e-9)))];
}

/** Mean level (dB, silence = -90) of the `span` seconds starting at each frame. */
export function smoothLevels(levels: number[], span = 1, frame = FRAME): number[] {
  const n = Math.max(1, Math.round(span / frame));
  const pre = [0];
  for (const v of levels) pre.push(pre[pre.length - 1] + (Number.isFinite(v) ? 10 ** (v / 10) : 0));
  return levels.map((_, i) => {
    const j = Math.min(levels.length, i + n), p = (pre[j] - pre[i]) / (j - i);
    return p > 0 ? Math.max(FLOOR, 10 * Math.log10(p)) : FLOOR;
  });
}

/** Center (seconds) of the loudest `span`-second stretch at or after `from`; null if it's all near-silent. */
export function loudestStretch(levels: number[], opts: { from?: number; to?: number; span?: number; frame?: number } = {}): { at: number; db: number } | null {
  const frame = opts.frame ?? FRAME, n = Math.max(1, Math.round((opts.span ?? 1.5) / frame));
  const first = Math.max(0, Math.floor((opts.from ?? 0) / frame));
  const last = Math.min(levels.length, opts.to != null ? Math.ceil(opts.to / frame) : levels.length);
  let best: { at: number; db: number } | null = null;
  for (let i = first; i + n <= Math.max(last, first + Math.min(n, last - first)); i++) {
    const db = meanDb(levels.slice(i, Math.min(i + n, last)));
    if (best == null || db > best.db) best = { at: r2((i + n / 2) * frame), db };
  }
  return best && best.db > -50 ? best : null;
}

// Reaction words: laughing, shouting, disbelief. Many in a short stretch = something just happened.
// Whisper writes laughter as separate "Ha" tokens, so a lone ha/he/ah counts too.
const REACT = /^(o+h+|a+h+|no+|nah+|bro+|bru+h|wh?a+t+|yo+|wo+w+|(h[ae])+h?|lol|lmao|lmfao|dude|holy|omg|yes+|wait|stop|run|go+|dead|huh|ayo|oh my god|let'?s go|clip it|oh my|jesus|crazy|insane)$/i;
export const isReaction = (w: string) => REACT.test(w.toLowerCase().replace(/[^a-z' ]/g, "").trim());
const exclaimed = (w: Word) => w.word.trim().endsWith("!") && w.word.trim().length <= 8;
const reactive = (w: Word) => isReaction(w.word) || exclaimed(w);

/** Center of the densest 3s burst of reaction words / very short words (>= 3 of them), or null. */
export function reactionBurst(words: Word[], opts: { from?: number; span?: number } = {}): { at: number; count: number } | null {
  const span = opts.span ?? 3, from = opts.from ?? 0;
  const hits = words.filter((w) => w.start >= from && reactive(w)).map((w) => w.start).sort((a, b) => a - b);
  let best: { at: number; count: number } | null = null;
  for (let i = 0; i < hits.length; i++) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1] - hits[i] <= span) j++;
    const count = j - i + 1;
    if (count >= 3 && (!best || count > best.count)) best = { at: r2((hits[i] + hits[j]) / 2), count };
  }
  return best;
}

/** Per-frame "something just happened" score. audio = loudness jump; react = reaction words in the next 3s. */
export type Moments = { smooth: number[]; usual: number[]; audio: number[]; react: number[]; firstReact: (number | null)[]; frame: number };

/**
 * Score every frame. audio = (1s level - the 80th percentile of the 1-8s before) clamped to 0..15, plus a quarter of the
 * jump over the median (clamped 0..20), so a talker coming back after a pause scores low and a scream / crash over the usual
 * level scores high. react = 2.5 per reaction word starting in the next 3s (max 6 words), once there are 2 or more.
 */
export function scoreMoments(levels: number[], words: Word[], frame = FRAME): Moments {
  const smooth = smoothLevels(levels, 1, frame);
  const all = smooth.filter((v) => v > FLOOR);
  const globalHi = quantile(all, 0.75), globalMed = quantile(all, 0.5);
  const back = Math.round(8 / frame), gap = Math.round(1 / frame);
  const usual: number[] = [], audio: number[] = [];
  for (let i = 0; i < smooth.length; i++) {
    const prior = smooth.slice(Math.max(0, i - back), Math.max(0, i - gap));
    // Never below the whole source's usual level: someone starting to talk again after a pause is not a moment.
    const hi = Math.max(globalHi, prior.length >= 15 ? quantile(prior, 0.8) : globalHi);
    const med = Math.max(globalMed, prior.length >= 15 ? quantile(prior, 0.5) : globalMed);
    usual.push(hi);
    const v = smooth[i];
    audio.push(v <= SILENT_DB ? 0 : Math.min(15, Math.max(0, v - hi)) + 0.25 * Math.min(20, Math.max(0, v - med)));
  }
  const hits = words.filter((w) => w.word.trim() && reactive(w)).map((w) => w.start).sort((a, b) => a - b);
  const n = Math.max(levels.length, Math.ceil((words.reduce((m, w) => Math.max(m, w.end), 0) + 1) / frame));
  const react: number[] = [], firstReact: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * frame, inside = hits.filter((h) => h >= t - 0.3 && h <= t + 3);
    react.push(inside.length >= 2 ? 2.5 * Math.min(6, inside.length) : 0);
    firstReact.push(inside.length ? inside[0] : null);
  }
  return { smooth, usual, audio, react, firstReact, frame };
}

/** Best-scoring frame in [from, to) (seconds) and its parts; `late` adds a small bonus for later frames (viewer clips). */
function bestMoment(m: Moments, from: number, to: number, late = 0) {
  const f = m.frame, a = Math.max(0, Math.floor(from / f)), b = Math.min(Math.max(m.audio.length, m.react.length), Math.ceil(to / f));
  let best: { i: number; score: number; audio: number; react: number } | null = null;
  for (let i = a; i < b; i++) {
    const audio = m.audio[i] ?? 0, react = m.react[i] ?? 0;
    const score = audio + react + late * (i - a) / Math.max(1, b - a);
    if (!best || score > best.score + 1e-9) best = { i, score, audio, react };
  }
  // The late bonus only picks between moments: within one moment, go back to where its score plateau starts.
  if (best) {
    const raw = best.audio + best.react;
    let j = best.i;
    while (j - 1 >= a && best.i - (j - 1) <= Math.round(1.5 / f) && (m.audio[j - 1] ?? 0) + (m.react[j - 1] ?? 0) >= raw - 1) j--;
    if (j !== best.i) best = { i: j, score: best.score, audio: m.audio[j] ?? 0, react: m.react[j] ?? 0 };
  }
  return best;
}

/** Onset of the moment found at frame i: the first frame of its 1s window that is near the window's level, or the first reaction word. */
function onsetOf(m: Moments, levels: number[], i: number, audio: number) {
  const f = m.frame, t = i * f;
  if (audio >= 5) {
    const target = (m.smooth[i] ?? FLOOR) - 3;
    for (let j = i; j < Math.min(levels.length, i + Math.round(1 / f)); j++) if (Number.isFinite(levels[j]) && levels[j] >= target) return r2(j * f);
    return r2(t);
  }
  const fr = m.firstReact[i];
  return r2(fr != null ? Math.max(t, fr) : t);
}

export type PayoffInput = {
  source: string; // twitch_clip | chat | youtube (anything else: searched everywhere)
  duration: number; // seconds of source
  levels: number[]; // loudness per FRAME seconds of the whole source (dB); [] when unknown
  words: Word[]; // timed in the source
  hint?: number | null; // chat spike: the reaction point; YouTube: the most-replayed center (seconds in the source)
  range?: { from: number; to: number } | null; // only look here (e.g. inside the window the Judge chose)
};

/** A frame needs this score (dB of jump + reaction points) to count as a real clue. */
export const CLUE_MIN = 5;

/** One payoff time (seconds in the source) and why. */
export function findPayoff(i: PayoffInput): { at: number; why: string } {
  const d = i.duration;
  const lo = Math.max(0, i.range?.from ?? 0), hi = Math.min(d, i.range?.to ?? d);
  const m = scoreMoments(i.levels, i.words);
  const why = (b: { audio: number; react: number }) =>
    b.audio >= CLUE_MIN && b.react > 0 ? "loudness jump + reactions" : b.audio >= CLUE_MIN ? "loudness jump" : b.react > 0 ? "reaction words" : "small loudness jump";
  const hint = i.hint != null && i.hint > lo && i.hint < hi ? i.hint : null;
  if (hint != null) {
    // Known point (chat reaction / replay peak): sharpen it to the strongest moment close by, if there is one.
    const label = i.source === "chat" ? "chat reaction" : "replay peak";
    const b = bestMoment(m, Math.max(lo, hint - 3), Math.min(hi - 0.5, hint + 5));
    if (b && b.audio + b.react >= CLUE_MIN + 1) return { at: onsetOf(m, i.levels, b.i, b.audio), why: `${label} + ${why(b)} near it` };
    return { at: r2(hint), why: i.source === "chat" ? "chat reaction point" : "most-replayed point" };
  }
  // Twitch viewer clip: the payoff is late. Look in the last 70%, slightly favouring later moments.
  const viewer = i.source === "twitch_clip";
  const from = viewer && !i.range ? Math.max(lo, d * 0.3) : lo;
  const b = bestMoment(m, from, Math.max(from + 0.1, hi - 1), viewer ? 2 : 0);
  if (b && b.audio + b.react >= CLUE_MIN) return { at: onsetOf(m, i.levels, b.i, b.audio), why: why(b) };
  const span = hi - lo;
  return { at: r2(lo + (viewer && !i.range ? span * 0.7 : span / 2)), why: "no clear audio or reaction clue, default spot" };
}

/** Sentences from timed words: a break after . ! ? or a pause of >= 0.8s. */
export function sentences(words: Word[]): { start: number; end: number; words: Word[] }[] {
  const out: { start: number; end: number; words: Word[] }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur }); cur = []; };
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end >= 0.8) flush();
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.word.trim())) flush();
  }
  flush();
  return out;
}

/**
 * When the reaction to the payoff is over (seconds in the source): the loud stretch (1s level >= usual + 2 dB, dips up to
 * 0.8s allowed) and the chain of reaction words (gaps <= 1.2s) that start at the payoff, at most 8s after it.
 */
export function reactionEnd(o: { payoff: number; levels: number[]; words: Word[]; duration: number; frame?: number }): number {
  const f = o.frame ?? FRAME, p = o.payoff, cap = Math.min(o.duration, p + 8);
  let end = Math.min(o.duration, p + 1);
  if (o.levels.length) {
    const m = scoreMoments(o.levels, [], f), i0 = Math.max(0, Math.min(m.smooth.length - 1, Math.round(p / f)));
    const usual = m.usual[i0] ?? FLOOR, half = smoothLevels(o.levels, 0.5, f);
    let lastLoud = p;
    for (let i = i0; i < half.length && i * f <= cap; i++) {
      if (half[i] >= usual + 2 && half[i] > SILENT_DB) lastLoud = i * f + 0.5;
      else if (i * f - lastLoud > 0.8) break;
    }
    end = Math.max(end, Math.min(cap, lastLoud));
  }
  let last: number | null = null;
  for (const w of [...o.words].filter((w) => w.word.trim()).sort((a, b) => a.start - b.start)) {
    if (w.start < p - 0.5) continue;
    if (w.start > cap) break;
    if (last != null && w.start - last > 1.2) break; // the reaction chain is over
    if (reactive(w)) last = w.end;
    else if (last == null && w.start > p + 1.5) break; // no reaction words right at the payoff
  }
  if (last != null) end = Math.max(end, Math.min(cap, last));
  return r2(end);
}

export type Window = { start: number; length: number };

/**
 * The window around a payoff. End: just after the reaction (reactionEnd); a sentence that is under way then or starts within
 * 2s (the streamer's "capper" line) is kept when it finishes within 10s of the payoff; never mid-word; at least 2s after the
 * payoff. Start: the sentence start closest to (end - 80% of maxSec), at least 3s before the payoff; no words = that spot,
 * moved past real silence. Length in [minSec, maxSec] and inside the source; a source no longer than minSec is kept whole.
 */
export function pickSmartWindow(o: { duration: number; payoff: number; words: Word[]; minSec: number; maxSec: number; levels?: number[] }): Window {
  const d = o.duration, minSec = Math.min(o.minSec, o.maxSec), maxSec = Math.max(o.minSec, o.maxSec);
  if (d <= minSec + 0.5) return { start: 0, length: r2(d) };
  const levels = o.levels ?? [];
  const p = Math.min(Math.max(o.payoff, 0), d);
  const words = o.words.filter((w) => w.word.trim() && w.end > w.start - 0.01).sort((a, b) => a.start - b.start);
  const sents = sentences(words);

  // ---- End: after the reaction (+ a capper line), not mid-word.
  const react = reactionEnd({ payoff: p, levels, words, duration: d });
  let end = react + 0.8;
  const capper = sents.find((s) => s.end > react && s.start <= react + 2 && s.end <= p + 10 && s.end >= p + 1);
  if (capper) {
    const next = words.find((w) => w.start >= capper.end - 0.01 && !capper.words.includes(w));
    end = Math.max(end - 0.8, Math.min(capper.end + 0.4, next ? next.start - 0.05 : Infinity));
  } else {
    const mid = words.find((w) => w.start < end && w.end > end);
    if (mid) end = mid.end + 0.2 <= react + 2.5 ? mid.end + 0.2 : mid.start - 0.05;
  }
  end = Math.min(d, Math.max(end, p + 2));

  // ---- Start: a sentence start near end - 80% of max, leaving at least 3s of build-up.
  const target = Math.min(maxSec, Math.max(minSec, Math.round(maxSec * 0.8)));
  const nominal = end - target;
  const latest = Math.min(p - 3, end - minSec);
  const cands = sents.map((s) => s.start - 0.25).filter((c) => c >= Math.max(0, end - maxSec) - 1e-6 && c <= latest + 1e-6);
  let start: number;
  if (cands.length) start = cands.reduce((b, c) => (Math.abs(c - nominal) < Math.abs(b - nominal) - 1e-6 ? c : b));
  else {
    start = nominal;
    // No sentence to start on: don't open on real silence (game audio is fine).
    if (levels.length) {
      const sm = smoothLevels(levels, 0.5);
      let i = Math.max(0, Math.round(start / FRAME));
      while (i < sm.length && sm[i] <= SILENT_DB && i * FRAME < latest) i++;
      if (i * FRAME < latest) start = Math.max(start, i * FRAME); // silent all the way: nothing better to start on
    }
    // Don't open mid-word.
    const mid = words.find((w) => w.start < start && w.end > start);
    if (mid && mid.start >= end - maxSec) start = mid.start - 0.15;
  }
  start = Math.max(0, start);

  // ---- Length limits.
  if (end - start > maxSec) start = end - maxSec;
  if (end - start < minSec) start = Math.max(0, end - minSec);
  if (end - start < minSec) end = Math.min(d, start + minSec);
  return { start: r2(start), length: r2(Math.min(end - start, d - start)) };
}

/** A Judge-chosen window (seconds in the source): used only when it's a sane length and inside the source. */
export function validJudgeWindow(best: { start?: number | null; end?: number | null }, o: { duration: number; minSec: number; maxSec: number }): Window | null {
  const s = best.start, e = best.end;
  if (s == null || e == null || !Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0 || e > o.duration + 0.5 || e <= s) return null;
  const len = Math.min(e, o.duration) - s;
  // Short sources can't reach minSec: then the whole-source length is fine.
  const min = Math.min(o.minSec, o.duration);
  if (len < min - 0.5 || len > o.maxSec + 0.5) return null;
  return { start: r2(s), length: r2(Math.min(len, o.maxSec)) };
}

/**
 * The Judge reads a transcript, so its times are rough: don't open or end mid-word (start backs up to the word, end runs
 * on to the word's end when that stays within maxSec, else stops before it), and stay inside the source.
 */
export function snapWindowToWords(w: Window, words: Word[], o: { duration: number; maxSec: number }): Window {
  let start = w.start, end = w.start + w.length;
  const ws = words.filter((x) => x.word.trim());
  const a = ws.find((x) => x.start < start && x.end > start + 0.05);
  if (a) start = Math.max(0, a.start - 0.15);
  const b = ws.find((x) => x.start < end - 0.05 && x.end > end);
  if (b) end = b.end + 0.2 - start <= o.maxSec ? b.end + 0.2 : b.start - 0.05;
  end = Math.min(o.duration, end);
  if (end - start > o.maxSec) start = end - o.maxSec;
  return { start: r2(Math.max(0, start)), length: r2(end - Math.max(0, start)) };
}

/**
 * What the audio says, for the Judge (it can't hear): the strongest loudness jumps (>= 6 dB over the usual level, local
 * peaks >= 3s apart, best `max`) and real silences of 1.5s+. Times in seconds of the source.
 */
export function audioCues(levels: number[], frame = FRAME, max = 4): { jumps: { at: number; db: number }[]; silences: { from: number; to: number }[] } {
  if (!levels.length) return { jumps: [], silences: [] };
  const m = scoreMoments(levels, [], frame);
  const jumps: { at: number; db: number; i: number }[] = [];
  const order = m.smooth.map((v, i) => ({ i, db: v - m.usual[i] })).filter((x) => x.db >= 6 && m.smooth[x.i] > SILENT_DB).sort((a, b) => b.db - a.db);
  for (const x of order) {
    if (jumps.length >= max) break;
    if (jumps.some((j) => Math.abs(j.i - x.i) * frame < 3)) continue;
    let i = x.i; // back to where this jump's plateau starts
    while (i > 0 && x.i - i < Math.round(1.5 / frame) && m.smooth[i - 1] - m.usual[i - 1] >= x.db - 1) i--;
    jumps.push({ at: onsetOf(m, levels, i, 99), db: Math.round(x.db), i: x.i });
  }
  const silences: { from: number; to: number }[] = [];
  const half = smoothLevels(levels, 0.3, frame);
  let runStart = -1;
  for (let i = 0; i <= half.length; i++) {
    const quiet = i < half.length && half[i] <= SILENT_DB;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const from = runStart * frame, to = Math.min(levels.length * frame, (i - 1) * frame + 0.3);
      if (to - from >= 1.5) silences.push({ from: r2(from), to: r2(to) });
      runStart = -1;
    }
  }
  return { jumps: jumps.sort((a, b) => a.at - b.at).map(({ at, db }) => ({ at, db })), silences };
}

/** Words of a window, moved to window time (0 = window start). */
export function windowWords(words: Word[], start: number, length: number): Word[] {
  return words.filter((w) => w.end > start && w.start < start + length)
    .map((w) => ({ word: w.word, start: r2(Math.max(0, w.start - start)), end: r2(Math.min(length, w.end - start)) }));
}

/**
 * "[12.4s] text…" one line per sentence (or ~12 words), for the Judge. Optional `marks` (e.g. audio cues, the proposed
 * window's edges) are put in as their own lines at their time.
 */
export function timedTranscript(words: Word[], maxLines = 80, marks: { at: number; text: string }[] = []): string {
  const lines: { at: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) lines.push({ at: cur[0].start, text: `[${cur[0].start.toFixed(1)}s] ${cur.map((w) => w.word.trim()).join(" ")}` }); cur = []; };
  for (const w of words) {
    if (!w.word.trim()) continue;
    if (cur.length && w.start - cur[cur.length - 1].end > 1.5) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word.trim()) || cur.length >= 12) flush();
  }
  flush();
  const speech = lines.slice(0, maxLines);
  const all = [...speech, ...marks.map((m) => ({ at: m.at, text: `[${m.at.toFixed(1)}s] (${m.text})` }))];
  // Stable: a mark at the same time as a line goes after it.
  return all.map((l, k) => ({ ...l, k })).sort((a, b) => a.at - b.at || a.k - b.k).map((l) => l.text).join("\n");
}
