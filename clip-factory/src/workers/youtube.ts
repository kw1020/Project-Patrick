import { prisma, getSettings } from "../lib/db";
import { enqueueGrab, setStatus } from "../lib/queues";
import { runYouTubeScout } from "./yt-scout";
import { brandedCaption, defaultTitle } from "../lib/social";
import { backlogRoom } from "../lib/guards";
import { categoryOff, offReason, skippedNote, youtubeCategory, type Category } from "../lib/category";
import { listChannelVideos, pickPeaks, videoCaptions, videoInfo, videoUrl, ytError } from "../lib/ytdlp";
import { captionPeaks, parseVtt } from "../lib/yt-captions";

const MAX_NEW_PER_RUN = 15;
const NO_HEATMAP_RECHECK_MS = 6 * 3600_000; // new videos get a "most replayed" graph once enough people watch
const DEDUPE_SEC = 30;
const CAPTION_DEDUPE_SEC = 45; // v2.0.8: caption moments are less exact, so they keep further apart

type Peak = { center: number; value: number; snippet?: string; signals?: string[] };

/**
 * The "youtube" queue job (every 30 min, and "Find YouTube channels now" = job name "find"): first the YouTube scout looks for
 * approved Twitch creators' channels (a few per run; a scout failure never stops the scan), then the scanner runs. The scout's
 * own line is saved as status "yt_scout"; the returned line is the scanner's.
 */
export async function runYouTubeJob(name?: string): Promise<string> {
  try {
    const msg = await runYouTubeScout({ manual: name === "find" });
    console.log(`[yt-scout] ${msg}`);
  } catch (e) {
    console.error("[yt-scout]", (e as Error).message);
    await setStatus("yt_scout", false, (e as Error).message).catch(() => {});
  }
  return runYouTubeScan();
}

/**
 * YouTube scanner (every 30 min): for each APPROVED, not-paused YouTube channel (added by Krew, or linked to an approved Twitch
 * creator by the YouTube scout, src/workers/yt-scout.ts), the newest videos' moments become moments for the Grabber.
 * First choice: the most-replayed parts (yt-dlp's `heatmap`). v2.0.8: a video with no heatmap yet (every new upload) that is
 * inside clipLookbackHrs goes the captions route: its English auto-captions are read (no video download) and the best reaction
 * peaks become moments (src/lib/yt-captions.ts), each carrying the caption snippet for the Judge. No heatmap and no caption
 * peaks -> skipped and looked at again in 6h, never guessed. At most maxPerCreatorPerRun new moments per creator per scan
 * (a Twitch creator and their linked YouTube channels count as one creator) and never more than the line has room for.
 */
export async function runYouTubeScan() {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  if (!settings.ytScanEnabled) return "off (Settings → YouTube scanner)";
  // Paused creators (Creators page) stay approved but are skipped.
  const channels = await prisma.streamer.findMany({ where: { approved: true, paused: false, platform: "youtube" }, include: { campaign: true } });
  if (!channels.length) return "no approved YouTube channels yet (or all paused) — add one on the Streamers page";
  // A channel linked to a paused Twitch creator is paused with them.
  const linkedIds = [...new Set(channels.map((c) => c.linkedFromId).filter((x): x is string => !!x))];
  const pausedOwners = new Set((await prisma.streamer.findMany({ where: { id: { in: linkedIds }, paused: true }, select: { id: true } })).map((s) => s.id));
  const active = channels.filter((c) => !c.linkedFromId || !pausedOwners.has(c.linkedFromId));
  const skipped: Record<Category, number> = { funny: 0, gaming: 0 };

  const room = await backlogRoom();
  const limit = Math.min(MAX_NEW_PER_RUN, room);
  const perCreator = Math.max(1, settings.maxPerCreatorPerRun);
  const sent = new Map<string, number>(); // creator key -> moments sent this scan
  const maxAgeMs = settings.ytMaxVideoAgeDays * 86400_000;
  const lookbackMs = settings.clipLookbackHrs * 3600_000;
  const tooOld = (d: Date | null) => d != null && Date.now() - d.getTime() > maxAgeMs;
  let added = 0, checked = 0, full = false, viaCaptions = 0, capped = 0;
  const notes: string[] = [];

  scan: for (const ch of active) {
    const who = ch.linkedFromId ?? ch.id;
    if ((sent.get(who) ?? 0) >= perCreator) continue;
    const channelId = ch.twitchId.replace(/^yt:/, "");
    let videos;
    try {
      videos = await listChannelVideos(channelId, settings.ytVideosPerChannel); // the Videos tab: newest first
    } catch (e) {
      notes.push(`${ch.name}: ${ytError(e)}`);
      continue;
    }
    for (const v of videos) {
      const seen = await prisma.youTubeVideo.findUnique({ where: { id: v.id } });
      if (seen && (seen.status === "done" || seen.status === "old")) continue;
      if (seen?.status === "no_heatmap" && Date.now() - seen.checkedAt.getTime() < NO_HEATMAP_RECHECK_MS) continue;
      // Skipped because its kind was off in Settings: looked at again only once that kind is back on.
      const offCat = seen?.status.match(/^off_(funny|gaming)$/)?.[1] as Category | undefined;
      if (offCat && categoryOff(settings, offCat)) continue;
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
      const duration = info.duration ?? v.duration;

      let peaks: Peak[];
      let route: "heatmap" | "captions" = "heatmap";
      if (info.heatmap) {
        peaks = pickPeaks(info.heatmap, duration, settings.ytMomentsPerVideo);
      } else {
        // v2.0.8 captions route: only for recent uploads (older ones simply wait for their heatmap).
        const recent = !info.uploadDate || Date.now() - info.uploadDate.getTime() <= lookbackMs;
        let vtt: string | null = null;
        if (recent) {
          try {
            vtt = await videoCaptions(v.id);
          } catch (e) {
            notes.push(`${ch.name} ${v.id} captions: ${ytError(e)}`);
          }
        }
        const found = vtt ? captionPeaks(parseVtt(vtt), duration, settings.ytMomentsPerVideo) : [];
        if (!found.length) {
          const why = !recent ? "" : vtt ? " (captions had no clear reactions)" : " (no captions either)";
          await mark("no_heatmap", `No most-replayed data on YouTube yet${why} (checked again in 6h)`, info.title, info.uploadDate);
          notes.push(`${ch.name}: "${info.title.slice(0, 40)}" has no most-replayed data yet, skipped${why}`);
          continue;
        }
        route = "captions";
        peaks = found.map((p) => ({ center: p.center, value: p.value, snippet: p.snippet, signals: p.signals }));
      }

      const url = videoUrl(v.id);
      const category = youtubeCategory(info.title, info.categories);
      if (categoryOff(settings, category)) {
        await mark(`off_${category}`, offReason(category), info.title, info.uploadDate);
        skipped[category] += peaks.length;
        continue;
      }
      const existing = await prisma.moment.findMany({ where: { source: "youtube", sourceUrl: url }, select: { vodOffset: true } });
      const gap = route === "captions" ? CAPTION_DEDUPE_SEC : DEDUPE_SEC;
      const fresh = peaks.filter((p) => !existing.some((m) => m.vodOffset != null && Math.abs(m.vodOffset - p.center) < gap));
      let made = 0, creatorFull = false;
      for (const p of fresh) {
        if (added >= limit) { full = true; break; }
        if ((sent.get(who) ?? 0) >= perCreator) { creatorFull = true; break; }
        const title = defaultTitle(info.title, ch.name, null);
        const stats = route === "captions" ? JSON.stringify({ kind: "captions", captions: p.snippet ?? "", signals: p.signals ?? [] }) : null;
        const moment = await prisma.moment.create({
          data: {
            streamerId: ch.id, timestamp: info.uploadDate ?? new Date(), spikeScore: p.value, source: "youtube",
            sourceUrl: url, sourceTitle: info.title, sourceViews: info.views, vodId: v.id, vodOffset: p.center, category, stats,
            clips: { create: { title, caption: brandedCaption({ hook: title, streamer: ch, category, game: null, campaign: ch.campaign }), status: "processing", stage: "grab", stageAt: new Date(), category } },
          },
          include: { clips: true },
        });
        await enqueueGrab(moment.id, moment.clips[0].id);
        added++; made++;
        if (route === "captions") viaCaptions++;
        sent.set(who, (sent.get(who) ?? 0) + 1);
      }
      // Partial = the line (or this creator's share) filled up mid-video: the rest of its peaks come next scan
      // (deduped by sourceUrl + time).
      const label = route === "captions" ? "caption peaks" : "peaks";
      await mark(made < fresh.length ? "partial" : "done", `${peaks.length} ${label}, ${existing.length + made} clipped`, info.title, info.uploadDate);
      if (full) break scan;
      if (creatorFull) { capped++; break; }
    }
  }

  const parts = [`${active.length} channel${active.length === 1 ? "" : "s"}, ${checked} videos checked, ${added} peaks sent to the Grabber`];
  if (viaCaptions) parts.push(`${viaCaptions} from captions (no most-replayed data yet)`);
  if (capped) parts.push(`${capped} creator${capped === 1 ? "" : "s"} at the ${perCreator}-per-scan limit, rest next scan`);
  if (full) parts.push(room ? `line has room for ${room}, rest next scan` : "line full, skipped new ones");
  const skip = skippedNote(skipped);
  if (skip) parts.push(skip);
  if (notes.length) parts.push(notes.slice(0, 3).join("; ") + (notes.length > 3 ? ` (+${notes.length - 3} more)` : ""));
  return parts.join(" · ");
}
