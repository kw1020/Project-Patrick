// v1.9.8 quality over quantity (Krew: "lesser of the clips that are lower quality and more clips that are just more higher
// quality"). Pure: which clips may reach review (near-duplicates + a per-creator hourly cap, the best kept) and the Queue's
// "X found, Y kept" line. Tested in test/v198.test.ts.

export type KeepClip = {
  id: string; streamerId: string; score: number | null; status: string; createdAt: number;
  /** Where the clip's window sits in the creator's VOD / video (seconds), when known. */
  vodId: string | null; from: number | null; to: number | null;
  /** The moment's wall-clock time (ms). */
  at: number;
};

/** Clips of one creator whose moments are this close (wall clock) are the same moment when the VOD can't tell. */
export const SAME_MOMENT_MS = 45_000;

/** VOD seconds of a window: the raw file starts this far into the VOD (chat: 30s before the moment, YouTube: 25s, Twitch clip: its own offset). */
export function vodSpan(m: { source: string; vodId: string | null; vodOffset: number | null }, winStart: number | null, winLength: number | null): { vodId: string | null; from: number | null; to: number | null } {
  if (!m.vodId || m.vodOffset == null || winStart == null || winLength == null) return { vodId: m.vodId ?? null, from: null, to: null };
  const rawAt = m.source === "chat" ? m.vodOffset - Math.min(30, m.vodOffset) : m.source === "youtube" ? m.vodOffset - Math.min(25, m.vodOffset) : m.vodOffset;
  return { vodId: m.vodId, from: rawAt + winStart, to: rawAt + winStart + winLength };
}

export function sameMoment(a: KeepClip, b: KeepClip): boolean {
  if (a.streamerId !== b.streamerId) return false;
  if (a.vodId && a.vodId === b.vodId && a.from != null && a.to != null && b.from != null && b.to != null) return a.from < b.to - 3 && b.from < a.to - 3;
  return Math.abs(a.at - b.at) <= SAME_MOMENT_MS;
}

const sc = (c: KeepClip) => c.score ?? 0;
const REVIEWED = new Set(["pending", "approved", "posted"]);

/**
 * May `me` (just judged + cut, would go to review) reach Krew? `others` = this creator's other clips. A near-duplicate of an
 * equal-or-better clip is set aside; a worse PENDING duplicate is set aside instead. Then at most `cap` clips per creator
 * created within the hour reach review: when full, `me` replaces the worst pending one if it's better, else it's set aside.
 * Approved/posted clips are never touched.
 */
export function keepBest(me: KeepClip, others: KeepClip[], cap: number, now = Date.now()): { keep: boolean; reason: string | null; demote: { id: string; reason: string }[] } {
  const live = others.filter((o) => o.id !== me.id && o.streamerId === me.streamerId && REVIEWED.has(o.status));
  const dupes = live.filter((o) => sameMoment(me, o));
  if (dupes.some((o) => sc(o) >= sc(me) || o.status !== "pending")) {
    return { keep: false, reason: "Near-duplicate: a better clip of the same moment is already in review", demote: [] };
  }
  const demote = dupes.map((o) => ({ id: o.id, reason: "Near-duplicate: replaced by a better clip of the same moment" }));
  const hour = live.filter((o) => !dupes.includes(o) && now - o.createdAt <= 3600_000);
  if (hour.length >= Math.max(1, cap)) {
    const worst = hour.filter((o) => o.status === "pending").sort((a, b) => sc(a) - sc(b))[0];
    if (!worst || sc(worst) >= sc(me)) return { keep: false, reason: `This creator already has ${hour.length} better clips this hour (max ${cap} per hour, Settings)`, demote: [] };
    demote.push({ id: worst.id, reason: `Replaced by a better clip from the same creator this hour (max ${cap} per hour)` });
  }
  return { keep: true, reason: null, demote };
}

/** Prefixes of judgeReason that mark WHY a clip was set aside (for the funnel line). */
export const DUPE_PREFIX = "Near-duplicate";
export const CAP_PREFIX_RE = /^(This creator already has|Replaced by a better clip)/;

export type FunnelCounts = { found: number; kept: number; finder: number; judge: number; dupes: number; working: number };
/** Count clips (last 24h) into the funnel. `finderPrefix` = judgeReason start of clips the clip finder set aside. */
export function funnelCounts(rows: { status: string; judgeReason: string | null }[], finderPrefix: string): FunnelCounts {
  const c: FunnelCounts = { found: rows.length, kept: 0, finder: 0, judge: 0, dupes: 0, working: 0 };
  for (const r of rows) {
    const why = r.judgeReason ?? "";
    if (r.status === "processing" || r.status === "failed") c.working++;
    else if (REVIEWED.has(r.status) || r.status === "expired") c.kept++;
    else if (why.startsWith(finderPrefix)) c.finder++;
    else if (why.startsWith(DUPE_PREFIX) || CAP_PREFIX_RE.test(why)) c.dupes++;
    else c.judge++;
  }
  return c;
}
export function funnelLine(c: FunnelCounts): string {
  if (!c.found) return "Last 24h: no clips found yet";
  const parts = [`${c.finder} nothing happening`, `${c.judge} below the Judge's cut-off`, `${c.dupes} duplicates or over the hourly cap`];
  return `Last 24h: ${c.found} found, ${c.kept} kept (${parts.join(", ")}${c.working ? `, ${c.working} still in the line` : ""})`;
}
