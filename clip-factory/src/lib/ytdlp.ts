// YouTube via yt-dlp only (no API key): resolve a channel, list its newest videos, read a video's
// "most replayed" heatmap. Every call goes through ytdlpBin() so tests (and Krew) can swap the binary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./media";

export const ytdlpBin = () => process.env.YTDLP || "yt-dlp";

async function ytJson(args: string[], timeoutMs = 90_000): Promise<any> {
  const { stdout } = await run(ytdlpBin(), ["-J", "--no-warnings", ...args], { timeoutMs });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("yt-dlp returned something that isn't JSON");
  }
}

/** Last line of a yt-dlp error, without the "yt-dlp exited 1:" noise. */
export function ytError(e: unknown) {
  const msg = (e as Error).message || String(e);
  const line = msg.split("\n").filter((l) => l.trim()).pop() ?? msg;
  return line.replace(/^.*?exited \d+:\s*/, "").replace(/^ERROR:\s*/, "").slice(0, 300);
}

/** "@MrBeast", "MrBeast", "youtube.com/@MrBeast/videos", "https://www.youtube.com/channel/UC…" → channel page URL. */
export function channelPageUrl(input: string): string | null {
  const raw = input.trim();
  const handle = raw.match(/^@?([A-Za-z0-9._-]{3,30})$/);
  if (handle) return `https://www.youtube.com/@${handle[1]}`;
  const url = raw.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(@[A-Za-z0-9._-]{3,30}|channel\/UC[A-Za-z0-9_-]{22}|c\/[^/?#]+|user\/[^/?#]+)/i);
  return url ? `https://www.youtube.com/${url[1]}` : null;
}

export type YtChannel = {
  channelId: string; handle: string; title: string; avatar: string | null;
  subscribers?: number | null; description?: string | null; // v2.0.8 YouTube scout (yt-dlp's channel_follower_count / description, when given)
};

/** Look a channel up (one flat listing call). Throws with a plain message when it can't. */
export async function resolveChannel(input: string): Promise<YtChannel> {
  const page = channelPageUrl(input);
  if (!page) throw new Error("That doesn't look like a YouTube @handle or channel link.");
  let j: any;
  try {
    j = await ytJson(["--flat-playlist", "--playlist-end", "1", `${page}/videos`], 60_000);
  } catch (e) {
    throw new Error(`YouTube couldn't find that channel (${ytError(e)}).`);
  }
  const channelId: string | undefined = j.channel_id || (/^UC[\w-]{22}$/.test(j.id ?? "") ? j.id : undefined);
  const fromUploader = typeof j.uploader_id === "string" && j.uploader_id.startsWith("@") ? j.uploader_id.slice(1) : null;
  const fromUrl = String(j.uploader_url ?? j.channel_url ?? "").match(/\/@([^/?#]+)/)?.[1] ?? null;
  const typed = page.match(/\/@([^/?#]+)$/)?.[1] ?? null;
  const handle = fromUploader || fromUrl || typed;
  if (!channelId) throw new Error("Found the page, but yt-dlp didn't return a channel id.");
  if (!handle) throw new Error("Couldn't find this channel's @handle (needed for the credit link). Paste the @handle instead.");
  const thumbs: any[] = Array.isArray(j.thumbnails) ? j.thumbnails : [];
  const avatar = thumbs.find((t) => t.id === "avatar_uncropped")?.url ?? thumbs.find((t) => t.width && t.width === t.height)?.url ?? null;
  return {
    channelId, handle, title: String(j.channel || j.uploader || handle).replace(/ - Videos$/, ""), avatar,
    subscribers: num(j.channel_follower_count), description: typeof j.description === "string" ? j.description : null,
  };
}

export type YtListed = { id: string; url: string; title: string | null; duration: number | null; uploadDate: Date | null };

/** The newest `n` uploads from the channel's Videos tab (that tab has no Shorts or lives). */
export async function listChannelVideos(channelId: string, n: number): Promise<YtListed[]> {
  const j = await ytJson(["--flat-playlist", "--playlist-end", String(n), `https://www.youtube.com/channel/${channelId}/videos`]);
  const entries: any[] = Array.isArray(j.entries) ? j.entries : [];
  return entries
    .filter((e) => e && typeof e.id === "string")
    .slice(0, n)
    .map((e) => ({ id: e.id, url: videoUrl(e.id), title: e.title ?? null, duration: num(e.duration), uploadDate: ytDate(e) }));
}

export type Heat = { start_time: number; end_time: number; value: number };
export type YtVideo = {
  id: string; title: string; duration: number | null; views: number; uploadDate: Date | null; heatmap: Heat[] | null;
  categories: string[]; // YouTube's category for the video ("Gaming", "Comedy", "Entertainment"…), when yt-dlp gives it
};

/** Full metadata for one video, no download: duration, views, title, upload date, heatmap. */
export async function videoInfo(id: string): Promise<YtVideo> {
  const j = await ytJson(["--skip-download", "--no-playlist", videoUrl(id)]);
  const heat = Array.isArray(j.heatmap)
    ? (j.heatmap as any[]).filter((h) => [h?.start_time, h?.end_time, h?.value].every((x) => typeof x === "number"))
    : [];
  return {
    id: j.id ?? id, title: String(j.title ?? ""), duration: num(j.duration), views: num(j.view_count) ?? 0,
    uploadDate: ytDate(j), heatmap: heat.length ? heat : null,
    categories: [...(Array.isArray(j.categories) ? j.categories : []), j.category].filter((c): c is string => typeof c === "string" && c.trim() !== ""),
  };
}

/**
 * v2.0.8: channel ids of the first `n` results of a YouTube search (yt-dlp `ytsearch`, no API key), in result order, each once.
 * The flat result entries are videos; their channel_id is what we want.
 */
export async function ytSearchChannels(query: string, n = 5): Promise<string[]> {
  const j = await ytJson(["--flat-playlist", `ytsearch${n}:${query}`], 60_000);
  const ids: string[] = [];
  for (const e of Array.isArray(j.entries) ? j.entries : []) {
    const id = e?.channel_id;
    if (typeof id === "string" && /^UC[\w-]{22}$/.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * v2.0.8 captions route: the video's English auto-captions (WebVTT text), or null when it has none. Only the captions are
 * fetched (`--skip-download`), which works even where the video download itself is blocked. Temp files are removed.
 */
export async function videoCaptions(id: string): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-subs-"));
  try {
    await run(ytdlpBin(), ["--skip-download", "--write-auto-subs", "--sub-langs", "en", "--sub-format", "vtt", "--no-warnings", "--no-playlist",
      "-o", path.join(dir, "%(id)s.%(ext)s"), videoUrl(id)], { timeoutMs: 90_000 });
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".vtt"));
    if (!file) return null;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    return /-->/.test(text) ? text : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
/** yt-dlp gives `timestamp` (unix s) and/or `upload_date` (YYYYMMDD); flat listings often have neither. */
function ytDate(j: any): Date | null {
  const ts = num(j?.timestamp) ?? num(j?.release_timestamp);
  if (ts != null) return new Date(ts * 1000);
  const d = String(j?.upload_date ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
  return d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])) : null;
}

export type Peak = { center: number; value: number };

/**
 * The most-replayed moments: highest heatmap values whose centers are ≥ minGap seconds apart,
 * ignoring the first `head` and last `tail` seconds (intros, end screens).
 */
export function pickPeaks(heatmap: Heat[], duration: number | null, n: number, opts: { minGap?: number; head?: number; tail?: number } = {}): Peak[] {
  const { minGap = 60, head = 15, tail = 20 } = opts;
  const end = duration ?? Math.max(0, ...heatmap.map((h) => h.end_time));
  const ranked = heatmap
    .map((h) => ({ center: (h.start_time + h.end_time) / 2, value: h.value }))
    .filter((p) => p.center >= head && p.center <= end - tail)
    .sort((a, b) => b.value - a.value || a.center - b.center);
  const out: Peak[] = [];
  for (const p of ranked) {
    if (out.length >= n) break;
    if (out.every((q) => Math.abs(q.center - p.center) >= minGap)) out.push(p);
  }
  return out.map((p) => ({ center: Math.round(p.center), value: Math.round(p.value * 1000) / 1000 }));
}
