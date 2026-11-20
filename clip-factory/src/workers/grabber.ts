import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/db";
import { brokenVideo, run } from "../lib/media";
import { storageDir, storagePath } from "../lib/paths";
import { enqueueTranscribe, getStatuses, queue, setStatus, type AgentStatus } from "../lib/queues";
import { freeGb, minFreeGb } from "../lib/guards";
import { ytdlpBin } from "../lib/ytdlp";

const DISK_RETRY_MS = 5 * 60_000;

/** Grabber: download the source video. Prefers the Twitch clip; falls back to a ~45s VOD section.
 *  YouTube peaks: a 45s section around the most-replayed point (25s before, 20s after). */
export async function runGrab(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  const { moment } = clip;
  if (!moment.streamer.approved) {
    await prisma.clip.update({ where: { id: clipId }, data: { status: "rejected", stage: null, stageAt: new Date(), error: "Streamer is not approved" } });
    return "skipped: streamer not approved";
  }

  // Disk guard: below MIN_FREE_GB, don't download. Try the same grab again in 5 min (the clip stays in the line).
  const free = await freeGb(storageDir()).catch(() => Infinity), min = minFreeGb();
  if (free < min) {
    const msg = `${free.toFixed(1)} GB free — grabbing paused below ${min} GB`;
    await setStatus("disk", false, msg);
    await queue("grab").add("grab", { momentId: clip.momentId, clipId }, { jobId: `grab-${clipId}-disk-${Date.now()}`, delay: DISK_RETRY_MS });
    await prisma.clip.update({ where: { id: clipId }, data: { stage: "grab", stageAt: new Date() } });
    return `low disk (${msg}), retrying in ${DISK_RETRY_MS / 60_000} min`;
  }
  const last = (await getStatuses().catch(() => ({} as Record<string, AgentStatus>))).disk;
  if (last && !last.ok) await setStatus("disk", true, `${free.toFixed(1)} GB free — grabbing again`);

  const outBase = storagePath("raw", clipId);
  // v2.0.10: a half-written file from a killed download (Clip Factory restarted) must never be reused: yt-dlp would see the
  // name and skip the download. Remove leftovers, download, then check the file really is a whole video.
  removeLeftovers(outBase);
  const file = await ytdlpDownload(moment, outBase);
  const bad = await brokenVideo(file);
  if (bad) {
    fs.rmSync(file, { force: true });
    throw new Error(`Download failed: ${bad}. Press Retry.`);
  }

  const rel = "raw/" + file.split(/[\\/]/).pop();
  await prisma.clip.update({ where: { id: clipId }, data: { rawPath: rel, stage: "transcribe", stageAt: new Date(), error: null } });
  await enqueueTranscribe(clipId);
  return `downloaded ${rel}`;
}

/** Delete raw/<clipId>.* left by an earlier, interrupted download. */
export function removeLeftovers(outBase: string) {
  const dir = path.dirname(outBase), base = path.basename(outBase);
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith(base + ".")) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* no dir yet */ }
}

export type Downloadable = { source: string; sourceUrl: string | null; vodId: string | null; vodOffset: number | null };

/**
 * The grabber's yt-dlp command for a moment. Default ranges: YouTube 25s before / 20s after the peak, chat-spike VOD 30s before /
 * 15s after, Twitch clip = the whole clip. `range` (seconds in the VOD / video) replaces them (v2.0.0 Edits download short
 * sections around the payoff). A Twitch clip is always downloaded whole (<= 60s).
 */
export function ytdlpArgs(moment: Downloadable, outBase: string, range?: { from: number; to: number }): string[] {
  // v2.0.9: -N = download several pieces of a section at once (HLS/DASH fragments), much faster on long VODs/videos.
  const common = ["-N", process.env.YTDLP_FRAGMENTS || "4", "--no-playlist", "--no-part", "--force-overwrites", "--no-progress", "--quiet", "--merge-output-format", "mp4", "-o", `${outBase}.%(ext)s`, "--print", "after_move:filepath"];
  const sect = (from: number, to: number) => ["--download-sections", `*${Math.max(0, Math.round(from * 10) / 10)}-${Math.round(to * 10) / 10}`];
  if (moment.source === "youtube") {
    if (!moment.sourceUrl || moment.vodOffset == null) throw new Error("YouTube moment has no video URL or peak time");
    const r = range ?? { from: Math.max(0, moment.vodOffset - 25), to: moment.vodOffset + 20 };
    return ["-f", "bv*[height<=1080]+ba/b[height<=1080]", ...sect(r.from, r.to), "--force-keyframes-at-cuts", ...common, moment.sourceUrl];
  }
  if (moment.source === "twitch_clip" && moment.sourceUrl) return ["-f", "best[ext=mp4]/best", ...common, moment.sourceUrl];
  if (moment.vodId && moment.vodOffset != null) {
    const r = range ?? { from: Math.max(0, moment.vodOffset - 30), to: moment.vodOffset + 15 };
    return ["-f", "best[height<=1080]/best", ...sect(r.from, r.to), ...common, `https://www.twitch.tv/videos/${moment.vodId}`];
  }
  throw new Error("Moment has neither a Twitch clip URL nor a VOD offset");
}

/** Run yt-dlp for a moment; returns the file it wrote. */
export async function ytdlpDownload(moment: Downloadable, outBase: string, range?: { from: number; to: number }): Promise<string> {
  const { stdout } = await run(ytdlpBin(), ytdlpArgs(moment, outBase, range), { timeoutMs: 8 * 60_000 });
  const file = stdout.trim().split("\n").filter(Boolean).pop();
  if (!file || !fs.existsSync(file)) throw new Error("yt-dlp finished but no file was written");
  return file;
}
