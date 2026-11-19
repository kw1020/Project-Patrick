// v2.0.0 Edits: which of a creator's moments go into an edit. Pure (tested in test/v200.test.ts).
import type { Vibe } from "./edit-vibes";

/** One moment the edit could use (built from a Moment and its newest Clip, see src/workers/edit.ts loadCandidates). */
export type Candidate = {
  momentId: string;
  clipId: string | null;
  source: string;            // twitch_clip | chat | youtube
  status: string | null;     // the clip's status (null = no clip made yet)
  score: number | null;      // Judge score 1-10
  sourceViews: number;
  category: string | null;   // funny | gaming
  createdAt: Date;
  payoffAt: number | null;   // seconds into the clip's raw file
  hasRaw: boolean;           // the raw file is still on disk (no download needed)
  sourceUrl: string | null;
  vodId: string | null;
  vodOffset: number | null;
  twitchClipId?: string | null;
};

export type Ranked = Candidate & { strength: number; why: string };

const USABLE_STATUS = new Set(["pending", "approved", "posted"]);

/** Can this moment be used at all? Clips Krew rejected (or that failed / got set aside) are out; it must be downloadable. */
export function isUsable(c: Candidate): boolean {
  if (c.status != null && !USABLE_STATUS.has(c.status)) return false;
  if (c.hasRaw) return true;
  if (c.source === "twitch_clip") return Boolean(c.sourceUrl);
  if (c.source === "youtube") return Boolean(c.sourceUrl) && c.vodOffset != null;
  return Boolean(c.vodId) && c.vodOffset != null;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Rank: Judge score (0-10 -> 0..1, unscored = 0.55) x 0.45, standout vs the creator's median views x 0.25, category fit for the
 * vibe (funny vibe likes funny, hype likes gaming) +-0.15, recency up to +0.1 (14-day half-life), a known payoff +0.1.
 */
export function rankCandidates(cands: Candidate[], vibe: Vibe, now = new Date()): Ranked[] {
  const views = cands.filter((c) => c.source === "twitch_clip" && c.sourceViews > 0).map((c) => c.sourceViews);
  const med = Math.max(1, median(views));
  return cands.filter(isUsable).map((c) => {
    const score = c.score == null ? 0.55 : Math.max(0, Math.min(1, c.score / 10));
    const standout = c.source === "twitch_clip" && c.sourceViews > 0 ? Math.max(0, Math.min(1, Math.log2(c.sourceViews / med + 1) / 3)) : 0.3;
    const fit = vibe === "funny" ? (c.category === "funny" ? 0.15 : c.category === "gaming" ? -0.05 : 0)
      : vibe === "hype" ? (c.category === "gaming" ? 0.1 : c.category === "funny" ? -0.03 : 0) : 0;
    const ageDays = Math.max(0, (now.getTime() - c.createdAt.getTime()) / 86_400_000);
    const recency = 0.1 * Math.pow(0.5, ageDays / 14);
    const payoff = c.payoffAt != null ? 0.1 : 0;
    const strength = Math.round((0.45 * score + 0.25 * standout + fit + recency + payoff) * 1000) / 1000;
    return { ...c, strength, why: `score ${c.score ?? "-"}, standout ${standout.toFixed(2)}, ${c.category ?? "?"}${c.payoffAt != null ? ", payoff known" : ""}` };
  }).sort((a, b) => b.strength - a.strength || b.createdAt.getTime() - a.createdAt.getTime());
}

/** Same source, overlapping time = one moment (same Twitch clip, same VOD/video within 20s). Keeps the stronger (first) one. */
export function sameMoment(a: Candidate, b: Candidate): boolean {
  if (a.momentId === b.momentId) return true;
  if (a.twitchClipId && a.twitchClipId === b.twitchClipId) return true;
  if (a.source === "twitch_clip" && b.source === "twitch_clip" && a.sourceUrl && a.sourceUrl === b.sourceUrl) return true;
  if (a.vodId && a.vodId === b.vodId && a.vodOffset != null && b.vodOffset != null) return Math.abs(a.vodOffset - b.vodOffset) < 20;
  if (a.source === "youtube" && b.source === "youtube" && a.sourceUrl === b.sourceUrl && a.vodOffset != null && b.vodOffset != null) return Math.abs(a.vodOffset - b.vodOffset) < 20;
  return false;
}

export function dedupe<T extends Candidate>(ranked: T[]): T[] {
  const out: T[] = [];
  for (const c of ranked) if (!out.some((o) => sameMoment(o, c))) out.push(c);
  return out;
}

/** How many usable, distinct moments a creator has (Edits page creator picker). */
export const usableCount = (cands: Candidate[]) => dedupe(rankCandidates(cands, "hype")).length;

/** How many slices an edit of this length and vibe wants (5-12): about 1.2s each for Hype, 2.3s Funny, 2.8s Smooth. */
export function wantedSlices(lengthSec: number, vibe: Vibe): number {
  const per = vibe === "hype" ? 1.2 : vibe === "funny" ? 2.3 : 2.8;
  return Math.max(5, Math.min(12, Math.round(lengthSec / per)));
}

/**
 * The moments for one montage: best first, deduped, `avoid` (moments used in the creator's last edits) only when there
 * aren't enough others. Returns up to `want + spares` so a failed download can be replaced.
 */
export function pickMoments(cands: Candidate[], o: { vibe: Vibe; want: number; spares?: number; avoid?: string[]; now?: Date }): Ranked[] {
  const all = dedupe(rankCandidates(cands, o.vibe, o.now));
  const avoid = new Set(o.avoid ?? []);
  const fresh = all.filter((c) => !avoid.has(c.momentId)), used = all.filter((c) => avoid.has(c.momentId));
  return [...fresh, ...used].slice(0, o.want + (o.spares ?? 2));
}
