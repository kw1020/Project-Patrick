import fs from "node:fs";
import { prisma } from "../lib/db";
import { run } from "../lib/media";
import { storagePath } from "../lib/paths";
import { enqueueTranscribe } from "../lib/queues";

/** Grabber: download the source video. Prefers the Twitch clip; falls back to a ~45s VOD section. */
export async function runGrab(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  const { moment } = clip;
  if (!moment.streamer.approved) {
    await prisma.clip.update({ where: { id: clipId }, data: { status: "rejected", stage: null, error: "Streamer is not approved" } });
    return "skipped: streamer not approved";
  }

  const outBase = storagePath("raw", clipId);
  const ytdlp = process.env.YTDLP || "yt-dlp";
  const common = ["--no-playlist", "--no-part", "--no-progress", "--quiet", "--merge-output-format", "mp4", "-o", `${outBase}.%(ext)s`, "--print", "after_move:filepath"];

  let args: string[];
  if (moment.source === "twitch_clip" && moment.sourceUrl) {
    args = ["-f", "best[ext=mp4]/best", ...common, moment.sourceUrl];
  } else if (moment.vodId && moment.vodOffset != null) {
    const from = Math.max(0, moment.vodOffset - 30), to = moment.vodOffset + 15;
    args = ["-f", "best[height<=1080]/best", "--download-sections", `*${from}-${to}`, ...common, `https://www.twitch.tv/videos/${moment.vodId}`];
  } else {
    throw new Error("Moment has neither a Twitch clip URL nor a VOD offset");
  }

  const { stdout } = await run(ytdlp, args, { timeoutMs: 8 * 60_000 });
  const file = stdout.trim().split("\n").filter(Boolean).pop();
  if (!file || !fs.existsSync(file)) throw new Error("yt-dlp finished but no file was written");

  const rel = "raw/" + file.split(/[\\/]/).pop();
  await prisma.clip.update({ where: { id: clipId }, data: { rawPath: rel, stage: "transcribe", error: null } });
  await enqueueTranscribe(clipId);
  return `downloaded ${rel}`;
}
