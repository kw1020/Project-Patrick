import { prisma } from "../lib/db";
import { findDescriptionEvidence, type PermissionEvidence } from "../lib/permission";
import { compact } from "../lib/format";
import { loginTakenBy } from "../lib/streamers";

// YouTube suggestions: big YouTube channels Krew could approve, from YouTube's own "trending" charts.
// Like the Twitch part, this NEVER approves anyone. It only writes Suggestion rows (platform "youtube");
// Krew approves on the Streamers page (one click; a note is optional).
//
// Data: YouTube Data API v3 with a plain API key (YOUTUBE_API_KEY). Each call costs 1 quota unit
// (default quota 10,000/day): 4 chart calls + 1 per 50 channels ≈ 6 units per hourly scan ≈ 150/day.

const KEEP = 25;              // pending YouTube suggestions kept (separate from Twitch's 25)
const FRESH_MS = 50 * 60_000; // pending suggestions scored this recently aren't re-scored
// Charts: overall (no category), Gaming (20), Entertainment (24), Comedy (23).
export const YT_CHART_CATEGORIES: (string | null)[] = [null, "20", "24", "23"];
const INT_MAX = 2_147_483_647;

const API_URL = () => process.env.YOUTUBE_API_URL || "https://www.googleapis.com/youtube/v3";
export const youtubeKeyConfigured = () => Boolean(process.env.YOUTUBE_API_KEY);

/** A YouTube API problem Krew can fix (or wait out): the message is already plain English. */
export class YouTubeApiError extends Error {
  constructor(message: string, public reason: string, public fatal: boolean) { super(message); }
}

type ApiErrorBody = { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };

/** GET one Data API endpoint with the key. quotaExceeded / bad key / API not enabled → fatal YouTubeApiError. */
export async function ytApi<T>(path: string, params: Record<string, string>): Promise<T> {
  const u = new URL(API_URL() + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", process.env.YOUTUBE_API_KEY || "");
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  const j = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (res.ok) return j;
  const reasons = [...(j.error?.errors ?? []), ...(j.error?.details ?? [])].map((e) => e.reason ?? "");
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));
  if (has("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "RATE_LIMIT_EXCEEDED"))
    throw new YouTubeApiError("daily API quota used up — it resets at midnight Pacific", "quotaExceeded", true);
  if (has("keyInvalid", "API_KEY_INVALID", "keyExpired", "API_KEY_EXPIRED"))
    throw new YouTubeApiError("the API key was rejected — check YOUTUBE_API_KEY in .env", "keyInvalid", true);
  if (has("accessNotConfigured", "SERVICE_DISABLED", "API_KEY_SERVICE_BLOCKED"))
    throw new YouTubeApiError("YouTube Data API v3 isn't enabled for this key — enable it at console.cloud.google.com (APIs & Services → Library)", "accessNotConfigured", true);
  if (has("ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "forbidden"))
    throw new YouTubeApiError("the API key's restrictions block this computer — loosen them at console.cloud.google.com (Credentials)", "keyRestricted", true);
  throw new YouTubeApiError(`YouTube API ${res.status}: ${j.error?.message || "request failed"}`, reasons[0] || String(res.status), false);
}

type ApiVideo = { id: string; snippet?: { channelId?: string; title?: string }; statistics?: { viewCount?: string } };
type ApiChannel = {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; viewCount?: string; videoCount?: string };
};

export type YtScoreInput = { subscribers: number; trendingViews: number; trendingCount: number; evidence: boolean };
/**
 * score = 2·log10(subscribers+1) + 1.5·log10(trendingViews+1) + 3·log10(trendingCount+1) + (permission evidence ? 2 : 0)
 * subscribers = the channel's subscriber count (hidden → channel viewCount/1000 as a stand-in, and the reasons say so);
 * trendingViews = views of their biggest video on the trending charts right now; trendingCount = how many of their
 * videos are on those charts (overall + Gaming + Entertainment + Comedy, each video counted once).
 * e.g. 12.4M subs, a 8.1M-view trending video, 2 trending, no evidence ≈ 14.2 + 10.4 + 1.4 = 26.0.
 */
export function youtubeSuggestionScore(i: YtScoreInput) {
  return 2 * Math.log10(i.subscribers + 1) + 1.5 * Math.log10(i.trendingViews + 1) + 3 * Math.log10(i.trendingCount + 1) + (i.evidence ? 2 : 0);
}

const short = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

export function youtubeSuggestionReasons(o: { subscribers: number | null; channelViews: number; topTitle: string; topViews: number; trendingCount: number; ev: PermissionEvidence | null }): string[] {
  const out = [o.subscribers != null
    ? `${compact(o.subscribers)} subscribers`
    : `subscribers hidden (scored on ${compact(o.channelViews)} channel views)`];
  out.push(`trending now: '${short(o.topTitle, 50)}' (${compact(o.topViews)} views)`);
  if (o.trendingCount > 1) out.push(`${o.trendingCount} videos trending`);
  if (o.ev) out.push(`description: '${short(o.ev.match, 40)}'`);
  return out;
}

type Trending = { channelId: string; videos: Map<string, { id: string; title: string; views: number }> };

/**
 * The YouTube half of the hourly Suggestions scan. Returns a one-line status; throws only for unexpected
 * errors (a used-up quota or a bad key is returned as a plain message, not thrown).
 */
export async function runYouTubeSuggestScan(region: string): Promise<string> {
  if (!youtubeKeyConfigured()) return "no API key (skipped) — add YOUTUBE_API_KEY to .env";
  try {
    return await scan(region);
  } catch (e) {
    if (e instanceof YouTubeApiError && e.fatal) return e.message;
    throw e;
  }
}

async function scan(region: string): Promise<string> {
  const now = new Date();
  const notes: string[] = [];

  // 1. Trending charts → channels with their trending videos (each video once).
  const byChannel = new Map<string, Trending>();
  let chartsOk = 0;
  for (const cat of YT_CHART_CATEGORIES) {
    const params: Record<string, string> = { part: "snippet,statistics", chart: "mostPopular", regionCode: region, maxResults: "50" };
    if (cat) params.videoCategoryId = cat;
    let items: ApiVideo[];
    try {
      items = (await ytApi<{ items?: ApiVideo[] }>("/videos", params)).items ?? [];
      chartsOk++;
    } catch (e) {
      if (e instanceof YouTubeApiError && e.fatal) throw e;
      notes.push(`chart ${cat ?? "overall"}: ${(e as Error).message}`); // e.g. a category with no chart in this region
      continue;
    }
    for (const v of items) {
      const ch = v.snippet?.channelId;
      if (!ch || !v.id) continue;
      const t = byChannel.get(ch) ?? { channelId: ch, videos: new Map() };
      t.videos.set(v.id, { id: v.id, title: v.snippet?.title ?? "", views: Number(v.statistics?.viewCount ?? 0) || 0 });
      byChannel.set(ch, t);
    }
  }
  if (!chartsOk) throw new Error(`no YouTube chart loaded (${notes.join("; ")})`);

  // 2. Exclusions: approved channels, fresh pending, "Not now" until dismissedUntil.
  const ids = [...byChannel.keys()];
  const [rows, existing] = await Promise.all([
    prisma.streamer.findMany({ where: { twitchId: { in: ids.map((id) => `yt:${id}`) } }, select: { twitchId: true, approved: true } }),
    prisma.suggestion.findMany({ where: { platform: "youtube" }, include: { streamer: { select: { twitchId: true } } } }),
  ]);
  const approved = new Set(rows.filter((r) => r.approved).map((r) => r.twitchId));
  const skip = new Set<string>();
  for (const s of existing) {
    const fresh = s.status === "pending" && now.getTime() - s.updatedAt.getTime() < FRESH_MS;
    const snoozed = s.status === "dismissed" && s.dismissedUntil && s.dismissedUntil > now;
    if (fresh || snoozed) skip.add(s.streamer.twitchId);
  }
  const pool = ids.filter((id) => !approved.has(`yt:${id}`) && !skip.has(`yt:${id}`));

  // 3. Channel details, 50 per call.
  const channels: ApiChannel[] = [];
  for (let i = 0; i < pool.length; i += 50) {
    const batch = pool.slice(i, i + 50);
    channels.push(...((await ytApi<{ items?: ApiChannel[] }>("/channels", { part: "snippet,statistics", id: batch.join(","), maxResults: "50" })).items ?? []));
  }

  let noHandle = 0;
  const scored = [];
  for (const ch of channels) {
    const handle = (ch.snippet?.customUrl ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!handle) { noHandle++; continue; } // need an @handle for yt-dlp + the credit link
    const t = byChannel.get(ch.id);
    if (!t) continue;
    const vids = [...t.videos.values()].sort((a, b) => b.views - a.views);
    const top = vids[0];
    const st = ch.statistics ?? {};
    const hidden = st.hiddenSubscriberCount === true || st.subscriberCount == null;
    const subscribers = hidden ? null : Number(st.subscriberCount) || 0;
    const channelViews = Number(st.viewCount ?? 0) || 0;
    const ev = findDescriptionEvidence(ch.snippet?.description);
    const thumbs = ch.snippet?.thumbnails ?? {};
    scored.push({
      channelId: ch.id, handle, title: ch.snippet?.title || handle, avatar: thumbs.medium?.url || thumbs.high?.url || thumbs.default?.url || null,
      subscribers, top, ev,
      score: youtubeSuggestionScore({ subscribers: subscribers ?? channelViews / 1000, trendingViews: top.views, trendingCount: vids.length, evidence: Boolean(ev) }),
      reasons: youtubeSuggestionReasons({ subscribers, channelViews, topTitle: top.title, topViews: top.views, trendingCount: vids.length, ev }),
    });
  }

  // 4. Top 25: newly scored channels compete with fresh pending YouTube suggestions.
  const freshPending = existing.filter((s) => s.status === "pending" && !s.linkedFromId && skip.has(s.streamer.twitchId));
  const ranked = [
    ...freshPending.map((s) => ({ kind: "fresh" as const, score: s.score, streamerId: s.streamerId })),
    ...scored.map((s) => ({ kind: "new" as const, score: s.score, s })),
  ].sort((a, b) => b.score - a.score);

  const keepIds: string[] = [];
  let added = 0, clashes = 0;
  for (const r of ranked) {
    if (keepIds.length >= KEEP) break;
    if (r.kind === "fresh") { keepIds.push(r.streamerId); continue; }
    const c = r.s;
    const twitchId = `yt:${c.channelId}`;
    // Same rule as "Add YouTube channel": only another YouTube channel holding this @handle clashes. A Twitch streamer
    // with the same name is fine (login is unique per platform since v1.7.1).
    if (await loginTakenBy("youtube", c.handle, twitchId)) {
      clashes++;
      console.warn(`[suggest] YouTube @${c.handle} skipped: another YouTube channel with that name is already in the list`);
      continue;
    }
    let streamer;
    try {
      const info = { login: c.handle, name: c.title, ...(c.avatar ? { profileImage: c.avatar } : {}) };
      streamer = await prisma.streamer.upsert({
        where: { twitchId },
        update: info, // never touches approved
        create: { twitchId, platform: "youtube", approved: false, ...info },
      });
    } catch (e) {
      console.warn(`[suggest] couldn't save YouTube @${c.handle}:`, (e as Error).message);
      continue;
    }
    if (streamer.platform !== "youtube" || streamer.approved) continue;
    const data = {
      platform: "youtube", score: c.score, reasons: JSON.stringify(c.reasons),
      evidence: c.ev?.snippet ?? null, evidenceSource: c.ev?.source ?? null,
      subscribers: c.subscribers == null ? null : Math.min(c.subscribers, INT_MAX),
      videoId: c.top.id, videoTitle: c.top.title.slice(0, 200), videoViews: Math.min(c.top.views, INT_MAX),
      viewers: 0, gameName: null, status: "pending", dismissedUntil: null,
    };
    const before = await prisma.suggestion.findUnique({ where: { streamerId: streamer.id }, select: { status: true } });
    if (before?.status !== "pending") added++;
    await prisma.suggestion.upsert({ where: { streamerId: streamer.id }, update: data, create: { streamerId: streamer.id, ...data } });
    keepIds.push(streamer.id);
  }
  // Pending YouTube suggestions that fell out of the top 25 go (dismissed ones stay, to remember "Not now").
  // v2.0.8: the YouTube scout's cards ("maybe the YouTube of Twitch @x", linkedFromId set) are not trending picks and stay.
  await prisma.suggestion.deleteMany({ where: { platform: "youtube", status: "pending", linkedFromId: null, streamerId: { notIn: keepIds } } });

  const extra = [
    noHandle ? `${noHandle} without an @handle skipped` : "",
    clashes ? `${clashes} name clash${clashes === 1 ? "" : "es"} skipped` : "",
    ...notes,
  ].filter(Boolean);
  return `${keepIds.length} suggestions (${added} new) · checked ${channels.length} of ${byChannel.size} trending channels${extra.length ? " · " + extra.join(" · ") : ""}`;
}
