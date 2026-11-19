// Creators page data: every APPROVED creator (Twitch + YouTube) with what Clip Factory has made from them.
import { prisma } from "./db";

export type CreatorFilter = "all" | "twitch" | "youtube" | "live";
export const CREATOR_FILTERS: { key: CreatorFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "twitch", label: "Twitch" },
  { key: "youtube", label: "YouTube" },
  { key: "live", label: "Live now" },
];

export type CreatorRow = {
  id: string; name: string; login: string; platform: string; avatar: string | null;
  live: boolean; viewers: number; gameName: string | null; paused: boolean;
  approvalNote: string | null; approvedAt: Date; // Streamer.approvedAt, else when the row was added (approved before v1.7.2)
  moments: number;     // moments found
  clips: number;       // clips that came out of the line cut
  approved: number;    // clips Krew approved (approved + posted)
  posted: number;      // clips posted
  views: number;       // total views of their live posts
  lastClipAt: Date | null;
  webcam?: "manual" | "auto" | null; // v1.9.0: typed-in webcam box, one found automatically (Streamer.facecamAuto), or none
  campaignId?: string | null; // v1.9.1 Campaign mode
  followers?: number | null; // v1.9.5: Twitch follower count (Connect Twitch in Settings)
};
export type CreatorSummary = { total: number; twitch: number; youtube: number; live: number; paused: number };

const CUT = new Set(["pending", "approved", "rejected", "posted"]);

/** Every approved creator with stats, sorted live first, then most clips, then name. */
export async function creatorStats(): Promise<CreatorRow[]> {
  const streamers = await prisma.streamer.findMany({ where: { approved: true } });
  if (!streamers.length) return [];
  const ids = streamers.map((s) => s.id);
  const [moments, clips] = await Promise.all([
    prisma.moment.groupBy({ by: ["streamerId"], where: { streamerId: { in: ids } }, _count: true }),
    prisma.clip.findMany({
      where: { moment: { streamerId: { in: ids } } },
      select: { status: true, duration: true, createdAt: true, moment: { select: { streamerId: true } }, posts: { select: { views: true, status: true } } },
    }),
  ]);
  const momentCount = new Map(moments.map((m) => [m.streamerId, m._count]));
  const agg = new Map<string, { clips: number; approved: number; posted: number; views: number; last: Date | null }>();
  for (const c of clips) {
    const id = c.moment.streamerId;
    const a = agg.get(id) ?? { clips: 0, approved: 0, posted: 0, views: 0, last: null };
    if (c.duration != null && CUT.has(c.status)) {
      a.clips++;
      if (!a.last || c.createdAt > a.last) a.last = c.createdAt;
    }
    if (c.status === "approved" || c.status === "posted") a.approved++;
    if (c.status === "posted") a.posted++;
    for (const p of c.posts) if (p.status === "live") a.views += p.views ?? 0;
    agg.set(id, a);
  }
  return sortCreators(streamers.map((s) => {
    const a = agg.get(s.id);
    return {
      id: s.id, name: s.name, login: s.login, platform: s.platform, avatar: s.profileImage,
      live: s.platform === "twitch" && s.isLive, viewers: s.viewers, gameName: s.gameName, paused: s.paused,
      approvalNote: s.approvalNote, approvedAt: s.approvedAt ?? s.createdAt,
      moments: momentCount.get(s.id) ?? 0, clips: a?.clips ?? 0, approved: a?.approved ?? 0, posted: a?.posted ?? 0,
      views: a?.views ?? 0, lastClipAt: a?.last ?? null,
      webcam: s.facecam ? "manual" : s.facecamAuto ? "auto" : null,
      campaignId: s.campaignId,
      followers: s.followers,
    };
  }));
}

export function sortCreators(rows: CreatorRow[]): CreatorRow[] {
  return [...rows].sort((a, b) =>
    Number(b.live) - Number(a.live) || b.clips - a.clips || b.moments - a.moments || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function parseCreatorFilter(f: string | undefined): CreatorFilter {
  return CREATOR_FILTERS.find((x) => x.key === f)?.key ?? "all";
}

/** Search by name or login (case-insensitive) and the platform / live chips. Keeps the order. */
export function filterCreators(rows: CreatorRow[], opts: { q?: string; filter?: CreatorFilter }): CreatorRow[] {
  const q = (opts.q ?? "").trim().toLowerCase().replace(/^@/, "");
  const f = opts.filter ?? "all";
  return rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.login.toLowerCase().includes(q)) &&
    (f === "all" || (f === "live" ? r.live : r.platform === f)));
}

export function summarize(rows: CreatorRow[]): CreatorSummary {
  return {
    total: rows.length,
    twitch: rows.filter((r) => r.platform === "twitch").length,
    youtube: rows.filter((r) => r.platform === "youtube").length,
    live: rows.filter((r) => r.live).length,
    paused: rows.filter((r) => r.paused).length,
  };
}

/** "21 creators · 14 Twitch · 7 YouTube · 3 live now" */
export function summaryLine(s: CreatorSummary) {
  const parts = [`${s.total} creator${s.total === 1 ? "" : "s"}`, `${s.twitch} Twitch`, `${s.youtube} YouTube`, `${s.live} live now`];
  if (s.paused) parts.push(`${s.paused} paused`);
  return parts.join(" · ");
}

/** Everything the page needs. */
export async function getCreators(opts: { q?: string; filter?: CreatorFilter } = {}) {
  const all = await creatorStats();
  return { summary: summarize(all), creators: filterCreators(all, opts) };
}
