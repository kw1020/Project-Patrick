import { prisma, getSettings } from "../lib/db";
import { enqueueGrab } from "../lib/queues";
import { defaultCaption, defaultTitle } from "../lib/social";
import { backlogRoom } from "../lib/guards";
import { listChannelVideos, pickPeaks, videoInfo, videoUrl, ytError } from "../lib/ytdlp";

const MAX_NEW_PER_RUN = 15;
const NO_HEATMAP_RECHECK_MS = 6 * 3600_000; // new videos get a "most replayed" graph once enough people watch
const DEDUPE_SEC = 30;

/**
 * YouTube scanner (every 30 min): for each APPROVED YouTube channel, the newest long videos' most-replayed
 * moments (yt-dlp's `heatmap`) become moments for the Grabber. No heatmap → skipped, never guessed.
 */
export async function runYouTubeScan() {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  if (!settings.ytScanEnabled) return "off (Settings → YouTube scanner)";
  const channels = await prisma.streamer.findMany({ where: { approved: true, platform: "youtube" } });
  if (!channels.length) return "no approved YouTube channels yet — add one on the Streamers page";

  const room = await backlogRoom();
  const limit = Math.min(MAX_NEW_PER_RUN, room);
  const maxAgeMs = settings.ytMaxVideoAgeDays * 86400_000;
  const tooOld = (d: Date | null) => d != null && Date.now() - d.getTime() > maxAgeMs;
  let added = 0, checked = 0, full = false;
  const notes: string[] = [];

  scan: for (const ch of channels) {
    const channelId = ch.twitchId.replace(/^yt:/, "");
    let videos;
    try {
      videos = await listChannelVideos(channelId, settings.ytVideosPerChannel);
    } catch (e) {
      notes.push(`${ch.name}: ${ytError(e)}`);
      continue;
    }
    for (const v of videos) {
      const seen = await prisma.youTubeVideo.findUnique({ where: { id: v.id } });
      if (seen && (seen.status === "done" || seen.status === "old")) continue;
      if (seen?.status === "no_heatmap" && Date.now() - seen.checkedAt.getTime() < NO_HEATMAP_RECHECK_MS) continue;
      if (added >= limit) { full = true; break scan; }
      const mark = (status: string, note: string | null, title: string | null, uploadedAt: Date | null) =>
        prisma.youTubeVideo.upsert({
          where: { id: v.id },
          update: { status, note, title, uploadedAt, checkedAt: new Date() },
          create: { id: v.id, streamerId: ch.id, status, note, title, uploadedAt },
        });
      if (tooOld(v.uploadDate)) { await mark("old", null, v.title, v.uploadDate); continue; }

      let info;
      try {
        info = await videoInfo(v.id); // the flat listing has no upload date or heatmap
      } catch (e) {
        notes.push(`${ch.name} ${v.id}: ${ytError(e)}`);
        continue;
      }
      checked++;
      if (tooOld(info.uploadDate)) { await mark("old", null, info.title, info.uploadDate); continue; }
      if (!info.heatmap) {
        await mark("no_heatmap", "No most-replayed data on YouTube yet (checked again in 6h)", info.title, info.uploadDate);
        notes.push(`${ch.name}: "${info.title.slice(0, 40)}" has no most-replayed data yet, skipped`);
        continue;
      }

      const url = videoUrl(v.id);
      const peaks = pickPeaks(info.heatmap, info.duration ?? v.duration, settings.ytMomentsPerVideo);
      const existing = await prisma.moment.findMany({ where: { source: "youtube", sourceUrl: url }, select: { vodOffset: true } });
      const fresh = peaks.filter((p) => !existing.some((m) => m.vodOffset != null && Math.abs(m.vodOffset - p.center) < DEDUPE_SEC));
      let made = 0;
      for (const p of fresh) {
        if (added >= limit) { full = true; break; }
        const title = defaultTitle(info.title, ch.name, null);
        const moment = await prisma.moment.create({
          data: {
            streamerId: ch.id, timestamp: info.uploadDate ?? new Date(), spikeScore: p.value, source: "youtube",
            sourceUrl: url, sourceTitle: info.title, sourceViews: info.views, vodId: v.id, vodOffset: p.center,
            clips: { create: { title, caption: defaultCaption(title, ch, null), status: "processing", stage: "grab", stageAt: new Date() } },
          },
          include: { clips: true },
        });
        await enqueueGrab(moment.id, moment.clips[0].id);
        added++; made++;
      }
      // Partial = the line filled up mid-video: the rest of its peaks come next scan (deduped by sourceUrl + time).
      await mark(made < fresh.length ? "partial" : "done", `${peaks.length} peaks, ${existing.length + made} clipped`, info.title, info.uploadDate);
      if (full) break scan;
    }
  }

  const parts = [`${channels.length} channel${channels.length === 1 ? "" : "s"}, ${checked} videos checked, ${added} peaks sent to the Grabber`];
  if (full) parts.push(room ? `line has room for ${room}, rest next scan` : "line full, skipped new ones");
  if (notes.length) parts.push(notes.slice(0, 3).join("; ") + (notes.length > 3 ? ` (+${notes.length - 3} more)` : ""));
  return parts.join(" · ");
}
