// v2.0.7 (Krew: "lets get to clipping the Mr. Beast video I sent"): clip chosen moments of one YouTube video (for brand-new videos that have no "most replayed" data yet).
// Run on Krew's PC:  docker compose exec worker npm run clip-link -- <youtube url> [--channel <channel id>] <m:ss[=funny|gaming]> ...
// Each time is the PAYOFF (the moment itself): the Grabber takes 25s before to 20s after, then the normal line runs
// (captions -> event gate -> Judge -> cut) and the clip lands in the Queue for Krew's approval. Nothing posts by itself.
// The video's channel must already be an APPROVED YouTube creator in Clip Factory (Streamers -> Add a YouTube channel).
import { prisma } from "../src/lib/db";
import { enqueueGrab } from "../src/lib/queues";
import { brandedCaption, defaultTitle } from "../src/lib/social";
import { youtubeCategory, type Category } from "../src/lib/category";
import { videoInfo, videoUrl } from "../src/lib/ytdlp";
import { execFileSync } from "node:child_process";

export function parseTime(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s.trim()) ?? /^(\d+)$/.exec(s.trim());
  if (!m) return null;
  if (m.length === 2) return Number(m[1]);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function videoIdOf(url: string): string | null {
  const m = /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/.exec(url) ?? /^([A-Za-z0-9_-]{11})$/.exec(url);
  return m ? m[1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.shift();
  const id = url ? videoIdOf(url) : null;
  if (!id) throw new Error("First give the YouTube link, then the times, e.g. https://www.youtube.com/watch?v=XXXX 2:15 4:18=funny");
  let channelId: string | null = null;
  const times: { at: number; cat: Category | null }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel") { channelId = args[++i] ?? null; continue; }
    const [t, c] = args[i].split("=");
    const at = parseTime(t);
    if (at == null) throw new Error(`Not a time: ${args[i]} (use m:ss, e.g. 4:18)`);
    times.push({ at, cat: c === "funny" || c === "gaming" ? c : null });
  }
  if (!times.length) throw new Error("No times given");
  if (channelId && !(await prisma.channel.findUnique({ where: { id: channelId } }))) {
    const all = await prisma.channel.findMany({ select: { id: true, name: true } });
    throw new Error(`No channel "${channelId}". Use one of: ${all.map((c) => `${c.id} (${c.name})`).join(", ")}`);
  }

  // Which creator: the video's own YouTube channel id, read with yt-dlp.
  const ytChannel = execFileSync(process.env.YTDLP || "yt-dlp", ["--skip-download", "--no-playlist", "--print", "channel_id", videoUrl(id)], { encoding: "utf8" }).trim().split("\n").pop()!;
  const streamer = await prisma.streamer.findUnique({ where: { twitchId: `yt:${ytChannel}` }, include: { campaign: true } });
  if (!streamer) throw new Error("That video's channel isn't in Clip Factory yet. Streamers -> Add a YouTube channel, then Approve it.");
  if (!streamer.approved) throw new Error(`${streamer.name} isn't approved. Approve it on the Streamers page first.`);

  const info = await videoInfo(id);
  const existing = await prisma.moment.findMany({ where: { source: "youtube", sourceUrl: videoUrl(id) }, select: { vodOffset: true } });
  let made = 0;
  for (const t of times) {
    if (info.duration && t.at > info.duration) { console.log(`skip ${t.at}s: the video is only ${Math.round(info.duration)}s long`); continue; }
    if (existing.some((e) => e.vodOffset != null && Math.abs(e.vodOffset - t.at) < 15)) { console.log(`skip ${t.at}s: already clipped`); continue; }
    const category = t.cat ?? youtubeCategory(info.title, info.categories);
    const title = defaultTitle(info.title, streamer.name, null).slice(0, 60);
    const moment = await prisma.moment.create({
      data: {
        streamerId: streamer.id, timestamp: info.uploadDate ?? new Date(), spikeScore: 1, source: "youtube",
        sourceUrl: videoUrl(id), sourceTitle: info.title, sourceViews: info.views, vodId: id, vodOffset: t.at, category,
        clips: { create: { title, caption: brandedCaption({ hook: title, streamer, category, game: null, campaign: streamer.campaign }), status: "processing", stage: "grab", stageAt: new Date(), category, channelId } },
      },
      include: { clips: true },
    });
    await enqueueGrab(moment.id, moment.clips[0].id);
    existing.push({ vodOffset: t.at });
    made++;
    console.log(`queued ${Math.floor(t.at / 60)}:${String(t.at % 60).padStart(2, "0")} (${category})`);
  }
  console.log(`\n${made} moment${made === 1 ? "" : "s"} sent to the line from "${info.title}". Watch them in Workroom; they land in the Queue for your approval.`);
}

if (require.main === module) {
  main().then(() => process.exit(0), (e) => { console.error(`\nCouldn't clip it: ${(e as Error).message}`); process.exit(1); });
}
