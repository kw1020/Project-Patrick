// v1.9.8 "better clips" (Krew: "We also need the clip finder to be better, or just better clips"). Pure, tested offline in
// test/v198.test.ts against hand-labelled fixtures (old ranking vs new).
//
// What changed vs v1.9.4:
// - Twitch clips: views PER HOUR (how fast a clip is taking off right now) count, not only views vs the creator's median, so
//   in launch week a clip blowing up this hour beats an older one that collected views over a day. A clip the streamer made
//   themselves gets a small bonus (they think it's a moment).
// - After the audio is measured: a chat spike that lines up with a sound spike (scream, laugh, bang) is worth much more than
//   chat going wild over nothing on screen (a donation, a raid joke); long silence / AFK stretches are dropped before the
//   Judge is paid to look at them.
// - Overlapping candidates (same VOD stretch from two sources) count once: the better one is kept.

import { isReaction as isReactionWord } from "./window";

/** Twitch clip rank: standout (vs the creator's usual clip) x how fast it's getting views now, faded by age. */
export function twitchClipRank(o: { views: number; base: number; ageHours: number; byStreamer?: boolean }): number {
  const base = Math.max(1, o.base), age = Math.max(0, o.ageHours);
  const standout = o.views / base;
  // views/hour against "the usual clip gets its views over a day"; +1h so a brand-new clip isn't infinite.
  const relVelocity = (o.views / (age + 1)) / (base / 24);
  const heat = 1 + 0.5 * Math.log2(1 + Math.max(0, relVelocity));
  return (standout * heat * (o.byStreamer ? 1.2 : 1)) / (1 + age / 48);
}

/** The v1.8.0-v1.9.4 rank, kept for the offline comparison. */
export function oldTwitchClipRank(o: { views: number; base: number; ageHours: number }): number {
  return (o.views / Math.max(1, o.base)) / (1 + Math.max(0, o.ageHours) / 48);
}

/** Below this the window is "dead air": skipped before the Judge (saves its cost, keeps the queue clean). */
export const DEAD_SILENCE = 0.5;
export const DEAD_SPEECH = 0.1;

/**
 * A window not worth judging: mostly real silence with almost no talking, or no talking, no sound spike and no change of
 * picture at all (AFK / "be right back" screen). Returns a plain-English reason or null.
 */
export function deadAir(o: { silenceShare: number; speechShare: number; wordCount: number; soundSpikes: number; sceneChanges: number | null }): string | null {
  if (o.silenceShare >= DEAD_SILENCE && o.speechShare < DEAD_SPEECH && o.wordCount < 6)
    return `${Math.round(o.silenceShare * 100)}% of it is silence and nobody talks (AFK or muted)`;
  if (o.speechShare < 0.05 && o.wordCount < 3 && o.soundSpikes === 0 && o.sceneChanges === 0)
    return "nothing happens: no talking, no sound spikes and the picture never changes (AFK / BRB screen?)";
  return null;
}

/** A sound spike this far over the streamer's usual level (dB) counts as an event. */
export const SPIKE_DB = 6;
/** Chat this many times its own usual rate counts as an event. */
export const CHAT_SPIKE_X = 2.5;

export type GateInput = {
  silenceShare: number; speechShare: number; wordCount: number;
  /** Biggest loudness jump in the window, dB over that stream's own usual level (scoreMoments "usual"), 0 = none. */
  audioJumpDb: number;
  /** Chat peak vs that chat's own median in this window (null = no chat data). */
  chatX: number | null;
  /** Reaction words (no way / what / bro / ha ha / oh my god…) from 2s before to 3s after the peak, and all words within +-3s. */
  reactNear: number; wordsNear: number;
  sceneChanges: number | null;
};
export type GateResult = { pass: boolean; kind: "dead_air" | "afk" | "no_spike" | "no_reaction" | null; reason: string | null };

/**
 * v1.9.8 "is something actually happening" gate (Krew: "some of the clips there are just random pieces that have nothing
 * entertaining in them"). Runs before the Judge is paid. A clip passes only with a REAL event: sound and/or chat well over
 * that stream's own baseline (relative, never absolute), and someone reacting near it (reaction words, talking, or a
 * scream-level spike), and no dead-air / AFK stretch.
 */
export function eventGate(g: GateInput): GateResult {
  const dead = deadAir({ silenceShare: g.silenceShare, speechShare: g.speechShare, wordCount: g.wordCount, soundSpikes: g.audioJumpDb >= SPIKE_DB ? 1 : 0, sceneChanges: g.sceneChanges });
  if (dead) return { pass: false, kind: dead.startsWith("nothing happens") ? "afk" : "dead_air", reason: dead };
  const soundSpike = g.audioJumpDb >= SPIKE_DB, chatSpike = (g.chatX ?? 0) >= CHAT_SPIKE_X;
  if (!soundSpike && !chatSpike) {
    return { pass: false, kind: "no_spike", reason: g.speechShare >= 0.4
      ? "just talking, nothing happens: no spike in sound or chat over this stream's usual"
      : "a random piece: no spike in sound or chat over this stream's usual (menus, loading or ordinary play)" };
  }
  if (g.reactNear < 1 && g.wordsNear < 3 && g.audioJumpDb < 9) {
    return { pass: false, kind: "no_reaction", reason: `${soundSpike ? `a ${Math.round(g.audioJumpDb)} dB sound spike` : "chat spiked"} but nobody reacts around it (no words, no laugh, no shout)` };
  }
  return { pass: true, kind: null, reason: null };
}

export type Candidate = {
  id: string; source: "twitch_clip" | "chat" | "youtube"; streamer: string;
  /** VOD stretch (seconds) when known, for overlap dedupe. */
  vodId?: string | null; from?: number | null; to?: number | null;
  // twitch_clip
  views?: number; base?: number; ageHours?: number; byStreamer?: boolean;
  // chat
  chatRatio?: number;
  // youtube (0-1 replay heat)
  replay?: number;
  // measured after the grab (null = not measured yet)
  audioJumpDb?: number | null; coincide?: boolean | null; silenceShare?: number | null; speechShare?: number | null; wordCount?: number | null;
  sceneChanges?: number | null;
  chatX?: number | null; reactNear?: number | null; wordsNear?: number | null;
  /** Fixtures only: what kind of clip this is, for the report ("random gameplay", "real fail"…). */
  label?: string; good?: boolean;
};

/** Gate inputs from measured audio + words around the peak (seconds in the source). Pure. */
export function gateInputs(o: { levels: number[]; words: { start: number; end: number; word: string }[]; win: { start: number; end: number }; peak: number | null; silenceShare: number; speechShare: number; chatX: number | null; sceneChanges: number | null; jumps: { at: number; db: number }[] }): GateInput {
  const inWin = o.jumps.filter((j) => j.at >= o.win.start && j.at <= o.win.end);
  const audioJumpDb = inWin.reduce((b, j) => Math.max(b, j.db), 0);
  const big = inWin.reduce<{ at: number; db: number } | null>((b, j) => (!b || j.db > b.db ? j : b), null);
  const peak = o.peak != null && o.peak >= o.win.start && o.peak <= o.win.end ? o.peak : big?.at ?? (o.win.start + o.win.end) / 2;
  const ws = o.words.filter((w) => w.word.trim() && w.end > o.win.start && w.start < o.win.end);
  // Reactions near the peak, or near the biggest sound spike when that's elsewhere in the window.
  const near = (t: number, a: number, b: number) => ws.filter((w) => w.start >= t - a && w.start <= t + b);
  const react = (t: number) => near(t, 2, 3).filter((w) => isReactionWord(w.word)).length;
  return {
    silenceShare: o.silenceShare, speechShare: o.speechShare, wordCount: ws.length, audioJumpDb, chatX: o.chatX,
    reactNear: Math.max(react(peak), big ? react(big.at) : 0), wordsNear: Math.max(near(peak, 3, 3).length, big ? near(big.at, 3, 3).length : 0),
    sceneChanges: o.sceneChanges,
  };
}

/** v1.9.4 behaviour: each source's own number, nothing about the audio, no cross-source dedupe. */
export function oldCandidateScore(c: Candidate): number {
  if (c.source === "twitch_clip") return oldTwitchClipRank({ views: c.views ?? 0, base: c.base ?? 1, ageHours: c.ageHours ?? 0 });
  if (c.source === "chat") return c.chatRatio ?? 0;
  return (c.replay ?? 0) * 5;
}

/** v1.9.8 score: the source's evidence x what the audio says (coincidence, spikes) x dead-air filter. */
export function candidateScore(c: Candidate): number {
  let s = c.source === "twitch_clip" ? twitchClipRank({ views: c.views ?? 0, base: c.base ?? 1, ageHours: c.ageHours ?? 0, byStreamer: c.byStreamer })
    : c.source === "chat" ? 2 * Math.log2(1 + (c.chatRatio ?? 0))
      : 5 * (c.replay ?? 0);
  if (c.coincide === true) s *= 1.6;
  else if (c.coincide === false && c.source === "chat") s *= (c.audioJumpDb ?? 0) >= 6 ? 0.9 : 0.5;
  if (c.audioJumpDb != null) s *= c.audioJumpDb >= 9 ? 1.3 : c.audioJumpDb >= 6 ? 1.15 : 1;
  if (c.silenceShare != null && c.speechShare != null && c.reactNear != null) {
    // Fully measured: the event gate decides (dropped = 0, never judged).
    const g = eventGate({ silenceShare: c.silenceShare, speechShare: c.speechShare, wordCount: c.wordCount ?? 0, audioJumpDb: c.audioJumpDb ?? 0, chatX: c.chatX ?? null, reactNear: c.reactNear, wordsNear: c.wordsNear ?? 0, sceneChanges: c.sceneChanges ?? null });
    if (!g.pass) return 0;
    s *= 1 - 0.5 * Math.max(0, c.silenceShare - 0.2);
  } else if (c.silenceShare != null && c.speechShare != null) {
    const dead = deadAir({ silenceShare: c.silenceShare, speechShare: c.speechShare, wordCount: c.wordCount ?? 0, soundSpikes: (c.audioJumpDb ?? 0) >= 6 ? 1 : 0, sceneChanges: c.sceneChanges ?? null });
    if (dead) s *= 0.05;
    else s *= 1 - 0.5 * Math.max(0, c.silenceShare - 0.2); // some silence is fine, lots drags
  }
  return Math.round(s * 1000) / 1000;
}

const overlap = (a: Candidate, b: Candidate, slack = 10) =>
  !!a.vodId && a.vodId === b.vodId && a.from != null && a.to != null && b.from != null && b.to != null && a.from <= b.to + slack && b.from <= a.to + slack;

/** Best first; a candidate overlapping a better one on the same VOD is dropped (`dedupe` false = keep all, the old way). */
export function rankCandidates(cs: Candidate[], score: (c: Candidate) => number, dedupe = true): { c: Candidate; score: number }[] {
  const sorted = cs.map((c) => ({ c, score: score(c) })).sort((a, b) => b.score - a.score);
  if (!dedupe) return sorted;
  const out: { c: Candidate; score: number }[] = [];
  for (const x of sorted) if (!out.some((y) => overlap(x.c, y.c))) out.push(x);
  return out;
}

/** BullMQ priority for the Judge queue (1 = first): the more promising a clip looks, the sooner it's judged and cut. */
export function judgePriority(score: number): number {
  return Math.max(1, Math.min(20, Math.round(20 - 2 * score)));
}

/** judgeReason prefix of clips the clip finder set aside before the Judge (the Queue funnel line counts them). */
export const FINDER_PREFIX = "Set aside by the clip finder (the Judge was not asked):";
