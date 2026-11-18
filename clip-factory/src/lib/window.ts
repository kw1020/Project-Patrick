// v1.8.0 "Better moments": which part of the source to keep. Pure (tested in test/v180.test.ts).
// Viewers clip right AFTER something happens, so in a Twitch clip the payoff is usually late, not in the middle.
// 1) findPayoff: one payoff time from loudness (the loudest 1.5s), reaction words in the transcript, the chat-spike
//    reaction point or the YouTube most-replayed center. 2) pickSmartWindow: payoff at ~65% of the window, start on a
//    word (no dead-air opening), end after the reaction, ideally on a sentence end, clamped to [minSec, maxSec].
import type { Word } from "./media";

/** Loudness frames are this long (seconds). measureLevels() in src/lib/edit.ts makes them. */
export const FRAME = 0.1;
const r2 = (t: number) => Math.round(t * 100) / 100;

/** Mean power of dB levels, back in dB (-Infinity stays silent). */
export function meanDb(levels: number[]) {
  const ok = levels.filter((v) => Number.isFinite(v));
  if (!ok.length) return -Infinity;
  const p = ok.reduce((n, v) => n + 10 ** (v / 10), 0) / levels.length;
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
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
const REACT = /^(o+h+|a+h+|no+|bro+|what+|wha+t|yo+|wow+|ha(ha)+h?|lol|lmao|dude|holy|omg|nah+|yes+|wait|stop|run|go+|dead|bruh|huh|ayo|oh my god|let's go|lets go|clip it)$/i;
export const isReaction = (w: string) => REACT.test(w.toLowerCase().replace(/[^a-z' ]/g, "").trim());

/** Center of the densest 3s burst of reaction words / very short words (>= 3 of them), or null. */
export function reactionBurst(words: Word[], opts: { from?: number; span?: number } = {}): { at: number; count: number } | null {
  const span = opts.span ?? 3, from = opts.from ?? 0;
  const hits = words.filter((w) => w.start >= from && (isReaction(w.word) || (w.word.trim().endsWith("!") && w.word.trim().length <= 6))).map((w) => w.start).sort((a, b) => a - b);
  let best: { at: number; count: number } | null = null;
  for (let i = 0; i < hits.length; i++) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1] - hits[i] <= span) j++;
    const count = j - i + 1;
    if (count >= 3 && (!best || count > best.count)) best = { at: r2((hits[i] + hits[j]) / 2), count };
  }
  return best;
}

export type PayoffInput = {
  source: string; // twitch_clip | chat | youtube
  duration: number; // seconds of source
  levels: number[]; // loudness per FRAME seconds of the whole source (dB); [] when unknown
  words: Word[]; // timed in the source
  hint?: number | null; // chat spike: the reaction point; YouTube: the most-replayed center (seconds in the source)
};

/** One payoff time (seconds in the source) and why. */
export function findPayoff(i: PayoffInput): { at: number; why: string } {
  const d = i.duration;
  const hint = i.hint != null && i.hint > 0 && i.hint < d ? i.hint : null;
  if (hint != null) {
    // Known point (chat reaction / replay peak): sharpen it to a loud moment close by, if there is one.
    const near = loudestStretch(i.levels, { from: Math.max(0, hint - 3), to: Math.min(d, hint + 5) });
    const typical = meanDb(i.levels);
    if (near && near.db >= typical + 3) return { at: near.at, why: `${i.source === "chat" ? "chat reaction" : "replay peak"} + loudest moment near it` };
    return { at: r2(hint), why: i.source === "chat" ? "chat reaction point" : "most-replayed point" };
  }
  // Twitch viewer clip (and anything else): the payoff is late. Look in the last 70%.
  const from = i.source === "twitch_clip" ? d * 0.3 : 0;
  const loud = loudestStretch(i.levels, { from });
  const burst = reactionBurst(i.words, { from });
  if (loud && burst && Math.abs(loud.at - burst.at) <= 4) return { at: r2(Math.min(loud.at, burst.at) + Math.abs(loud.at - burst.at) / 2), why: "loudest moment + reactions" };
  if (loud) return { at: loud.at, why: "loudest moment" };
  if (burst) return { at: burst.at, why: "reaction words" };
  return { at: r2(i.source === "twitch_clip" ? d * 0.7 : d / 2), why: "no audio clue, default spot" };
}

export type Window = { start: number; length: number };

/**
 * The window around a payoff: payoff at ~65%, start on a word (skipping > 1s of leading dead air when there are words),
 * end >= 1.5s after the payoff, ideally right after a sentence end; length in [minSec, maxSec] and inside the source.
 * A source no longer than minSec is kept whole.
 */
export function pickSmartWindow(o: { duration: number; payoff: number; words: Word[]; minSec: number; maxSec: number }): Window {
  const d = o.duration, minSec = Math.min(o.minSec, o.maxSec), maxSec = Math.max(o.minSec, o.maxSec);
  if (d <= minSec + 0.5) return { start: 0, length: r2(d) };
  const L = Math.min(maxSec, d);
  const p = Math.min(Math.max(o.payoff, 0), d);
  let start = p - 0.65 * L, end = start + L;
  if (end > d) { start -= end - d; end = d; }
  if (start < 0) { end = Math.min(d, end - start); start = 0; }
  const words = o.words.filter((w) => w.word.trim()).sort((a, b) => a.start - b.start);

  if (words.length) {
    // Start: don't open mid-word or on > 1s of dead air.
    const inside = words.find((w) => w.end > start);
    if (inside && inside.start < start && inside.start >= 0 && p - inside.start >= 1) start = Math.max(0, inside.start - 0.15); // opened mid-word: back up to its start
    else if (inside && inside.start - start > 1 && inside.start <= p - 1) start = Math.max(0, inside.start - 0.3); // leading silence
    // End: right after a sentence end between payoff+1.5 and the nominal end; else don't stop mid-word.
    const minEnd = Math.min(d, p + 1.5);
    const sentence = [...words].reverse().find((w) => /[.!?]$/.test(w.word.trim()) && w.end >= minEnd && w.end + 0.3 <= end);
    if (sentence && end - sentence.end <= 6) end = Math.min(d, sentence.end + 0.4);
    else {
      const cut = words.find((w) => w.start < end && w.end > end);
      if (cut) end = cut.end + 0.2 - start <= maxSec ? Math.min(d, cut.end + 0.2) : Math.max(minEnd, cut.start - 0.05);
    }
    end = Math.max(end, minEnd);
  }
  // Too short after trimming: more build-up first, then more after.
  let len = end - start;
  if (len < minSec) { const add = Math.min(start, minSec - len); start -= add; len += add; }
  if (len < minSec) { end = Math.min(d, start + minSec); len = end - start; }
  if (len > maxSec) { start = end - maxSec; len = maxSec; }
  return { start: r2(Math.max(0, start)), length: r2(Math.min(len, d - Math.max(0, start))) };
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

/** Words of a window, moved to window time (0 = window start). */
export function windowWords(words: Word[], start: number, length: number): Word[] {
  return words.filter((w) => w.end > start && w.start < start + length)
    .map((w) => ({ word: w.word, start: r2(Math.max(0, w.start - start)), end: r2(Math.min(length, w.end - start)) }));
}

/** "[12.4s] text…" one line per sentence (or ~12 words), for the Judge. */
export function timedTranscript(words: Word[], maxLines = 80): string {
  const lines: string[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) lines.push(`[${cur[0].start.toFixed(1)}s] ${cur.map((w) => w.word.trim()).join(" ")}`); cur = []; };
  for (const w of words) {
    if (!w.word.trim()) continue;
    if (cur.length && w.start - cur[cur.length - 1].end > 1.5) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word.trim()) || cur.length >= 12) flush();
  }
  flush();
  return lines.slice(0, maxLines).join("\n");
}
