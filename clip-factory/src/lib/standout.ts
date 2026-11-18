// v1.8.0 "Better moments": which viewer-made Twitch clips are worth cutting. Pure (tested in test/v180.test.ts).
// Krew: "It's only Kai and Hasan. Nothing entertaining." Raw view counts favour the biggest channels and let mediocre
// clips in, so each clip is compared with ITS creator's usual clip, and picks are shared out round-robin.
import type { TwitchClip } from "./twitch";

export type Scored = { clip: TwitchClip; standout: number; rank: number; ageHours: number };

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Score one creator's clips from the lookback window.
 * standout = views / max(creator's median clip views, minClipViews); rank = standout / (1 + ageHours/48).
 * Kept: views >= minClipViews AND standout >= standoutMin, plus the creator's single most-viewed clip when it has
 * >= 5x minClipViews (a creator whose every clip does well still gets their best one). Best rank first.
 */
export function scoreCreatorClips(clips: TwitchClip[], o: { minClipViews: number; standoutMin: number; now?: number }): { kept: Scored[]; median: number } {
  const now = o.now ?? Date.now();
  const med = median(clips.map((c) => c.view_count));
  const base = Math.max(med, o.minClipViews, 1);
  const best = clips.reduce<TwitchClip | null>((b, c) => (!b || c.view_count > b.view_count ? c : b), null);
  const kept: Scored[] = [];
  for (const c of clips) {
    const ageHours = Math.max(0, (now - new Date(c.created_at).getTime()) / 3600_000);
    const standout = c.view_count / base;
    const ok = (c.view_count >= o.minClipViews && standout >= o.standoutMin) || (c === best && c.view_count >= 5 * o.minClipViews);
    if (ok) kept.push({ clip: c, standout: Math.round(standout * 100) / 100, rank: standout / (1 + ageHours / 48), ageHours });
  }
  kept.sort((a, b) => b.rank - a.rank || b.clip.view_count - a.clip.view_count);
  return { kept, median: med };
}

export type VodSpan = { vodId: string; from: number; to: number };
/** The VOD stretch a clip covers, or null when Twitch doesn't say (no VOD / offset). */
export function clipSpan(c: Pick<TwitchClip, "video_id" | "vod_offset" | "duration">): VodSpan | null {
  if (!c.video_id || c.vod_offset == null) return null;
  return { vodId: c.video_id, from: c.vod_offset, to: c.vod_offset + Math.max(1, Math.ceil(c.duration || 0)) };
}
/** Same VOD and the stretches overlap, with `slack` seconds either side (viewers clip one moment several times). */
export function overlaps(a: VodSpan | null, b: VodSpan | null, slack = 20) {
  return !!a && !!b && a.vodId === b.vodId && a.from <= b.to + slack && b.from <= a.to + slack;
}

/**
 * Drop near-duplicates: a clip overlapping one already taken (`existing` = moments we already have) or a
 * higher-viewed clip in this list. Keeps the order of `scored` for the survivors.
 */
export function dedupe(scored: Scored[], existing: VodSpan[] = [], slack = 20): Scored[] {
  const byViews = [...scored].sort((a, b) => b.clip.view_count - a.clip.view_count);
  const taken: VodSpan[] = [...existing];
  const keep = new Set<Scored>();
  for (const s of byViews) {
    const span = clipSpan(s.clip);
    if (span && taken.some((t) => overlaps(span, t, slack))) continue;
    if (span) taken.push(span);
    keep.add(s);
  }
  return scored.filter((s) => keep.has(s));
}

/**
 * Fair mix: one from each creator in turn (creators with the best clip first), at most `perCreator` each, `limit` total.
 * `lists` = each creator's picks, best first. Returns [creatorIndex, pick] in pick order.
 */
export function roundRobin<T extends { rank: number }>(lists: T[][], perCreator: number, limit: number): { creator: number; pick: T }[] {
  const order = lists.map((l, i) => ({ i, best: l[0]?.rank ?? -1 })).filter((x) => x.best >= 0).sort((a, b) => b.best - a.best).map((x) => x.i);
  const out: { creator: number; pick: T }[] = [];
  for (let round = 0; round < perCreator && out.length < limit; round++) {
    for (const i of order) {
      if (out.length >= limit) break;
      const p = lists[i][round];
      if (p) out.push({ creator: i, pick: p });
    }
  }
  return out;
}
