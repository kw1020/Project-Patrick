// v1.9.8: the Judge can't hear or watch video, so it gets the next best thing: a compact text picture of the sound over
// the proposed window (loudness per 0.5s, spikes = screams/laughs/bangs, where people talk and where it's silent) and, for
// chat-spike moments, how hard chat was going at each point. Pure (tested in test/v198.test.ts).
import type { Word } from "./media";
import { FRAME, SILENT_DB, audioCues, isReaction, meanDb, sentences } from "./window";

const r1 = (x: number) => Math.round(x * 10) / 10;
export const AUDIO_STEP = 0.5;

/** Chat heat as stored on Moment.stats (v1.9.8): counted messages per `step` seconds, oldest first, the last bucket ending at `endAt` (ms). */
export type ChatHeatSeries = { heat: number[]; step: number; endAt: number };

/**
 * Chat buckets moved to SOURCE seconds. For a chat-spike moment the VOD section starts 30s (or vodOffset) before the moment
 * and the moment itself is 12s (the spike worker's REACTION_LAG_SEC) before the detection time that ends the series.
 */
export function chatInSource(s: ChatHeatSeries | null | undefined, momentAtSource: number | null, lagSec = 12): { at: number; n: number }[] {
  if (!s || !Array.isArray(s.heat) || !s.heat.length || momentAtSource == null || !(s.step > 0)) return [];
  const endSrc = momentAtSource + lagSec;
  const n = s.heat.length;
  return s.heat.map((v, i) => ({ at: r1(endSrc - (n - i) * s.step), n: Math.max(0, Math.round(Number(v) || 0)) })).filter((b) => b.at + s.step > 0);
}

/** 0-9 per AUDIO_STEP over [from, to): 0 = silence, 9 = the loudest moment of the window (relative, so game beds don't read as "loud"). */
export function loudnessDigits(levels: number[], from: number, to: number, step = AUDIO_STEP, frame = FRAME): { digits: string; db: number[] } {
  const k = Math.max(1, Math.round(step / frame));
  const db: number[] = [];
  for (let t = from; t < to - 1e-6; t += step) {
    const i = Math.max(0, Math.round(t / frame));
    db.push(meanDb(levels.slice(i, Math.min(levels.length, i + k))));
  }
  const live = db.filter((v) => Number.isFinite(v) && v > SILENT_DB);
  if (!live.length) return { digits: "0".repeat(db.length), db };
  const lo = Math.min(...live), hi = Math.max(...live);
  const digits = db.map((v) => (!Number.isFinite(v) || v <= SILENT_DB ? "0" : String(Math.max(1, Math.min(9, 1 + Math.round(((v - lo) / Math.max(6, hi - lo)) * 8)))))).join("");
  return { digits, db };
}

/** Stretches with speech (words merged when gaps < 0.8s) and real silences (>= 1s under SILENT_DB) inside [from, to]. */
export function speechAndSilence(levels: number[], words: Word[], from: number, to: number, frame = FRAME) {
  const speech: { from: number; to: number }[] = [];
  for (const s of sentences(words.filter((w) => w.word.trim() && w.end > from && w.start < to))) {
    const a = Math.max(from, s.start), b = Math.min(to, s.end), last = speech[speech.length - 1];
    if (last && a - last.to < 0.8) last.to = b; else speech.push({ from: a, to: b });
  }
  const silences = audioCues(levels, frame, 0).silences.filter((x) => x.to > from && x.from < to && x.to - x.from >= 1)
    .map((x) => ({ from: Math.max(from, x.from), to: Math.min(to, x.to) }));
  const len = Math.max(0.1, to - from);
  const talk = speech.reduce((n, s) => n + (s.to - s.from), 0) / len;
  const quiet = silences.reduce((n, s) => n + (s.to - s.from), 0) / len;
  return { speech, silences, speechShare: Math.round(talk * 100) / 100, silenceShare: Math.round(quiet * 100) / 100 };
}

export type AudioPeak = { at: number; db: number; kind: string };
/** The loudness spikes inside the window, labelled from the words around them (laugh/shout words → reaction). */
export function audioPeaks(levels: number[], words: Word[], from: number, to: number, max = 3, frame = FRAME): AudioPeak[] {
  return audioCues(levels, frame, 8).jumps.filter((j) => j.at >= from && j.at <= to).sort((a, b) => b.db - a.db).slice(0, max).map((j) => {
    const near = words.filter((w) => Math.abs(w.start - j.at) <= 1.5 && isReaction(w.word));
    const laugh = near.some((w) => /^(h[ae])+h?$/i.test(w.word.replace(/[^a-z]/gi, "")) || /lol|lmao/i.test(w.word));
    const kind = laugh ? "laughing" : near.length ? `shouting ("${near.slice(0, 2).map((w) => w.word.trim()).join(" ")}")` : "loud burst, no words (game sound, scream or bang)";
    return { at: j.at, db: j.db, kind };
  }).sort((a, b) => a.at - b.at);
}

/** The chat bucket with the most messages, if chat clearly peaked (>= 2x its median and >= 5 messages). */
export function chatPeak(chat: { at: number; n: number }[]): { at: number; n: number; x: number } | null {
  if (chat.length < 3) return null;
  const s = [...chat.map((c) => c.n)].sort((a, b) => a - b), med = Math.max(1, s[Math.floor(s.length / 2)]);
  const best = chat.reduce((b, c) => (c.n > b.n ? c : b));
  return best.n >= 5 && best.n >= 2 * med ? { ...best, x: Math.round((best.n / med) * 10) / 10 } : null;
}

export type AudioSummary = { text: string; peaks: number[]; speechShare: number; silenceShare: number; coincide: boolean | null };

/**
 * The block the Judge reads. Times in source seconds (the same as the frames and the transcript). `peaks` = the times worth
 * a frame (biggest audio spike, chat peak) for pickFrameTimes. `coincide` = chat and audio spiked within 4s of each other
 * (null without chat data).
 */
export function audioSummary(o: { levels: number[]; words: Word[]; window: { start: number; end: number }; chat?: { at: number; n: number }[]; frame?: number }): AudioSummary {
  const { start, end } = o.window, frame = o.frame ?? FRAME;
  if (!o.levels.length) return { text: "", peaks: [], speechShare: 0, silenceShare: 0, coincide: null };
  const loud = loudnessDigits(o.levels, start, end, AUDIO_STEP, frame);
  const groups: string[] = [];
  for (let i = 0; i < loud.digits.length; i += 10) groups.push(`${r1(start + i * AUDIO_STEP).toFixed(1)}s ${loud.digits.slice(i, i + 10)}`);
  const ss = speechAndSilence(o.levels, o.words, start, end, frame);
  const peaks = audioPeaks(o.levels, o.words, start, end, 3, frame);
  const fmt = (xs: { from: number; to: number }[]) => xs.length ? xs.slice(0, 6).map((x) => `${x.from.toFixed(1)}-${x.to.toFixed(1)}s`).join(", ") : "none";
  const lines = [
    `<audio_summary>`,
    `Loudness from ${start.toFixed(1)}s, one digit per ${AUDIO_STEP}s (0 = silence, 1-9 = quiet to the loudest point of this window):`,
    ...groups,
    `Sound spikes: ${peaks.length ? peaks.map((p) => `${p.at.toFixed(1)}s +${p.db} dB ${p.kind}`).join("; ") : "none (steady level)"}`,
    `Speech: ${fmt(ss.speech)} (${Math.round(ss.speechShare * 100)}% of the window). Real silence: ${fmt(ss.silences)} (${Math.round(ss.silenceShare * 100)}%).`,
  ];
  const chat = (o.chat ?? []).filter((c) => c.at >= start - 5 && c.at <= end + 5);
  const cp = chatPeak(chat);
  let coincide: boolean | null = null;
  if (chat.length) {
    const step = chat.length > 1 ? r1(chat[1].at - chat[0].at) : 5;
    lines.push(`Chat messages per ${step}s (stream delay: chat reacts 2-6s after the screen): ${chat.map((c) => `${c.at.toFixed(0)}s:${c.n}`).join(" ")}`);
    const big = peaks.reduce<AudioPeak | null>((b, p) => (!b || p.db > b.db ? p : b), null);
    coincide = !!(cp && big && cp.at - big.at >= -2 && cp.at - big.at <= 8);
    lines.push(cp ? `Chat peaked at ${cp.at.toFixed(0)}s (${cp.x}x its usual)${big ? `; the biggest sound spike is at ${big.at.toFixed(1)}s, so chat and sound ${coincide ? "react to the SAME moment" : "do NOT line up"}` : "; no sound spike near it"}.` : "Chat never clearly peaked in this window.");
  }
  lines.push(`</audio_summary>`);
  const peakTimes = [...peaks.map((p) => p.at), ...(cp ? [Math.max(start, cp.at - 3)] : [])];
  return { text: lines.join("\n"), peaks: peakTimes, speechShare: ss.speechShare, silenceShare: ss.silenceShare, coincide };
}
