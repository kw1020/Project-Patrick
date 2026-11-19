// v1.9.5 Suggestions focused on big streamers: pure ranking + filters (worker and Streamers page share them).
import { KREW_TOP_21 } from "./starter-creators";

export const TIER_5M = 5_000_000;
export const TIER_2M = 2_000_000;

/** 2 = 5M+ followers, 1 = 2M+, 0 = below (or unknown). */
export function followerTier(followers: number | null | undefined): 0 | 1 | 2 {
  if (followers == null) return 0;
  return followers >= TIER_5M ? 2 : followers >= TIER_2M ? 1 : 0;
}
export const tierLabel = (followers: number | null | undefined) => (followerTier(followers) === 2 ? "5M+" : followerTier(followers) === 1 ? "2M+" : null);
export const isBig = (followers: number | null | undefined) => followerTier(followers) >= 1;

/** 6_200_000 → "6.2M followers". */
export function followersText(n: number) {
  const f = (v: number, u: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${u}`;
  const s = n >= 1e6 ? f(n / 1e6, "M") : n >= 1e3 ? f(n / 1e3, "K") : String(n);
  return `${s} follower${n === 1 ? "" : "s"}`;
}

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const TOP = KREW_TOP_21.map(norm);
/** Position (0-20) in Krew's top 21 by display name or login ("Kai Cenat" = kaicenat, "CaseOh" = caseoh_), else -1. */
export function top21Index(name: string | null | undefined, login?: string | null): number {
  for (const k of [norm(name), norm(login)]) {
    if (!k) continue;
    const i = TOP.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

export type Rankable = { name: string; login: string; score: number; followers: number | null; viewers: number };

/**
 * Krew's top 21 first (in his order), then by follower tier (5M+, 2M+, below), then the existing score. Without the
 * Twitch user token (byFollowers false) the fallback is peak viewers, then score.
 */
export function rankSuggestions<T extends Rankable>(rows: T[], byFollowers: boolean): T[] {
  const pin = (r: T) => { const i = top21Index(r.name, r.login); return i < 0 ? 99 : i; };
  return [...rows].sort((a, b) =>
    pin(a) - pin(b)
    || (byFollowers ? followerTier(b.followers) - followerTier(a.followers) || b.score - a.score : b.viewers - a.viewers || b.score - a.score));
}

/** Suggestions tab filters. "Big only" needs follower counts (ignored without them); Krew's top 21 always pass it. */
export function filterSuggestions<T extends Rankable & { gameName?: string | null }>(rows: T[], o: { bigOnly: boolean; gtaNow: boolean; byFollowers: boolean; isGta6: (g: string | null | undefined) => boolean }): T[] {
  return rows.filter((r) =>
    (!o.gtaNow || o.isGta6(r.gameName))
    && (!o.bigOnly || !o.byFollowers || isBig(r.followers) || top21Index(r.name, r.login) >= 0));
}
