// Workroom page data: where every clip is on the production line right now.
// Columns: Finding (new moments) → Downloading (grab) → Captions (transcribe) → Judge → Cutting → Ready for you
// (pending) → Posting (uploading, or TikTok drafts waiting in Krew's inbox) → Posted (live in the last 24h).
import { prisma } from "./db";
import { maxBacklog } from "./guards";

export type ColumnKey = "finding" | "downloading" | "captions" | "judge" | "cutting" | "ready" | "posting" | "posted";
export const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "finding", label: "Finding" },
  { key: "downloading", label: "Downloading" },
  { key: "captions", label: "Captions" },
  { key: "judge", label: "Judge" },
  { key: "cutting", label: "Cutting" },
  { key: "ready", label: "Ready for you" },
  { key: "posting", label: "Posting" },
  { key: "posted", label: "Posted" },
];

export type WorkItem = {
  key: string;            // unique per card
  clipId: string | null;  // null for a moment that has no clip yet
  creator: { name: string; avatar: string | null; login: string; platform: string };
  source: string;         // twitch_clip | chat | youtube
  sourceLabel: string;    // "Twitch clip" | "Chat spike" | "YouTube peak"
  title: string;
  since: string;          // ISO: when it entered its current column (time in this step)
  score: number | null;
  error?: string | null;
  url?: string | null;    // posted link
  where?: string;         // Posting / Posted: which platform
};

export type Workroom = {
  columns: Record<ColumnKey, WorkItem[]>;
  counts: Record<ColumnKey, number>;
  problems: WorkItem[];
  summary: { inLine: number; ready: number; postedToday: number; perHour: number; backlogMax: number; lineFull: boolean };
};

const SOURCE: Record<string, string> = { twitch_clip: "Twitch clip", chat: "Chat spike", youtube: "YouTube peak" };
export const sourceLabel = (s: string) => SOURCE[s] ?? s;

/** Which line column a clip in "processing" belongs to (no stage yet = waiting to download). */
export function columnForStage(stage: string | null): ColumnKey {
  switch (stage) {
    case "transcribe": return "captions";
    case "judge": return "judge";
    case "cut": return "cutting";
    case "post": return "posting";
    default: return "downloading";
  }
}

/** "45s", "2m", "1h 5m". */
export function stageAge(since: Date | string, now: Date = new Date()): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

const LIMIT = 12;
const MIN = 60_000;

type ClipRow = {
  id: string; title: string | null; score: number | null; stage: string | null; stageAt: Date | null; updatedAt: Date; error: string | null;
  moment: { source: string; sourceTitle: string | null; streamer: { name: string; login: string; platform: string; profileImage: string | null } };
};

function clipItem(c: ClipRow, extra: Partial<WorkItem> = {}): WorkItem {
  const s = c.moment.streamer;
  return {
    key: `clip-${c.id}`, clipId: c.id,
    creator: { name: s.name, avatar: s.profileImage, login: s.login, platform: s.platform },
    source: c.moment.source, sourceLabel: sourceLabel(c.moment.source),
    title: c.title || c.moment.sourceTitle || "Untitled moment",
    since: (c.stageAt ?? c.updatedAt).toISOString(), score: c.score, error: c.error,
    ...extra,
  };
}

const clipInclude = { moment: { include: { streamer: true } } } as const;

export async function getWorkroom(now: Date = new Date()): Promise<Workroom> {
  const since10m = new Date(now.getTime() - 10 * MIN);
  const since24h = new Date(now.getTime() - 24 * 60 * MIN);
  const since3h = new Date(now.getTime() - 3 * 60 * MIN);

  const [moments, momentCount, processing, ready, readyCount, uploading, drafts, posted, postedToday, failed, made3h] = await Promise.all([
    prisma.moment.findMany({ where: { createdAt: { gte: since10m } }, orderBy: { createdAt: "desc" }, take: 6, include: { streamer: true } }),
    prisma.moment.count({ where: { createdAt: { gte: since10m } } }),
    prisma.clip.findMany({ where: { status: "processing" }, orderBy: { createdAt: "asc" }, include: clipInclude, take: 200 }),
    prisma.clip.findMany({ where: { status: "pending" }, orderBy: { updatedAt: "desc" }, include: clipInclude, take: LIMIT }),
    prisma.clip.count({ where: { status: "pending" } }),
    prisma.clip.findMany({ where: { stage: "post", status: { not: "processing" } }, orderBy: { updatedAt: "desc" }, include: clipInclude, take: LIMIT }),
    prisma.post.findMany({ where: { status: "draft", postedAt: { gte: since24h } }, orderBy: { postedAt: "desc" }, take: LIMIT, include: { clip: { include: clipInclude } } }),
    prisma.post.findMany({ where: { status: "live", postedAt: { gte: since24h } }, orderBy: { postedAt: "desc" }, take: LIMIT, include: { clip: { include: clipInclude } } }),
    prisma.post.count({ where: { status: "live", postedAt: { gte: since24h } } }),
    prisma.clip.findMany({ where: { status: "failed", updatedAt: { gte: since24h } }, orderBy: { updatedAt: "desc" }, include: clipInclude, take: 10 }),
    // Clips that came out of the line (cut and scored) in the last 3h. createdAt is close enough: a clip takes minutes.
    prisma.clip.count({ where: { createdAt: { gte: since3h }, duration: { not: null }, status: { in: ["pending", "approved", "rejected", "posted"] } } }),
  ]);

  const columns: Record<ColumnKey, WorkItem[]> = { finding: [], downloading: [], captions: [], judge: [], cutting: [], ready: [], posting: [], posted: [] };

  columns.finding = moments.map((m) => ({
    key: `moment-${m.id}`, clipId: null,
    creator: { name: m.streamer.name, avatar: m.streamer.profileImage, login: m.streamer.login, platform: m.streamer.platform },
    source: m.source, sourceLabel: sourceLabel(m.source), title: m.sourceTitle || `${m.streamer.name} moment`,
    since: m.createdAt.toISOString(), score: null,
  }));
  for (const c of processing) columns[columnForStage(c.stage)].push(clipItem(c));
  columns.ready = ready.map((c) => clipItem(c));
  columns.posting = [
    ...uploading.map((c) => clipItem(c, { where: "uploading" })),
    ...drafts.map((p) => clipItem(p.clip, { key: `post-${p.id}`, since: p.postedAt.toISOString(), where: "TikTok draft (finish in the app)" })),
  ].slice(0, LIMIT);
  columns.posted = posted.map((p) => clipItem(p.clip, { key: `post-${p.id}`, since: p.postedAt.toISOString(), url: p.url, where: p.platform === "youtube" ? "YouTube" : p.platform === "tiktok" ? "TikTok" : p.platform }));

  const counts = Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length])) as Record<ColumnKey, number>;
  counts.finding = momentCount;
  counts.ready = readyCount;
  counts.posted = postedToday;
  counts.posting = uploading.length + drafts.length;

  const backlogMax = maxBacklog();
  return {
    columns, counts,
    problems: failed.map((c) => clipItem(c, { since: c.updatedAt.toISOString() })),
    summary: {
      inLine: processing.length, ready: readyCount, postedToday,
      perHour: Math.round((made3h / 3) * 10) / 10,
      backlogMax, lineFull: processing.length >= backlogMax,
    },
  };
}
