// v1.8.0 "Better moments": which viewer-made Twitch clips are worth cutting. Pure (tested in test/v180.test.ts).
// Krew: "It's only Kai and Hasan. Nothing entertaining." Raw view counts favour the biggest channels and let mediocre
// clips in, so each clip is compared with ITS creator's usual clip, and picks are shared out round-robin.
import type { TwitchClip } from "./twitch";
import { twitchClipRank } from "./rank";

export type Scored = { clip: TwitchClip; standout: number; rank: number; ageHours: number };

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Score one creator's clips from the lookback window.
 * standout = views / max(creator's median clip views, minClipViews); rank = twitchClipRank (v1.9.8: standout x views-per-hour heat, faded by age).
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
    // v1.9.8: rank also counts how fast it is getting views right now (src/lib/rank.ts twitchClipRank).
    const byStreamer = !!c.creator_name && !!c.broadcaster_name && c.creator_name.toLowerCase() === c.broadcaster_name.toLowerCase();
    if (ok) kept.push({ clip: c, standout: Math.round(standout * 100) / 100, rank: twitchClipRank({ views: c.view_count, base, ageHours, byStreamer }), ageHours });
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

/** Clips of one channel made within this many seconds of each other are the same moment (viewers press "clip" together). */
export const SAME_MOMENT_SEC = 30;
/** Wall-clock stretch (ms) in which a new clip's created_at means "we already have this moment". */
export type TimeSpan = { from: number; to: number };
/** Existing moment -> the created_at range of viewer clips of the same moment. */
export function momentTimeSpan(m: { source: string; timestamp: Date }): TimeSpan {
  const t = m.timestamp.getTime();
  // chat: timestamp = the moment itself, viewers clip it 0-60s later; twitch_clip: timestamp = that clip's created_at.
  return m.source === "chat" ? { from: t - 10_000, to: t + 60_000 } : { from: t - SAME_MOMENT_SEC * 1000, to: t + SAME_MOMENT_SEC * 1000 };
}

/**
 * Drop near-duplicates: a clip overlapping one already taken (`existing` = moments we already have) or a
 * higher-viewed clip in this list. Same moment = same VOD and overlapping (+-`slack`s), or, because Twitch leaves
 * vod_offset empty while the stream is live, created within SAME_MOMENT_SEC of a taken clip / inside an existing moment's
 * TimeSpan. Keeps the order of `scored` for the survivors.
 */
export function dedupe(scored: Scored[], existing: VodSpan[] = [], slack = 20, existingTimes: TimeSpan[] = []): Scored[] {
  const byViews = [...scored].sort((a, b) => b.clip.view_count - a.clip.view_count);
  const taken: VodSpan[] = [...existing];
  const times: TimeSpan[] = [...existingTimes];
  const keep = new Set<Scored>();
  for (const s of byViews) {
    const span = clipSpan(s.clip), at = Date.parse(s.clip.created_at);
    if (span && taken.some((t) => overlaps(span, t, slack))) continue;
    if (Number.isFinite(at) && times.some((t) => at >= t.from && at <= t.to)) continue;
    if (span) taken.push(span);
    if (Number.isFinite(at)) times.push({ from: at - SAME_MOMENT_SEC * 1000, to: at + SAME_MOMENT_SEC * 1000 });
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
