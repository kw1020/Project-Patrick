// v2.0.8 Streamers page "YouTube scout" line: channels found, videos checked, moments sent (counted from the database).
import { prisma } from "./db";

export type YtScoutSummary = { found: number; creators: number; checkedCreators: number; videos24h: number; moments24h: number; captionMoments24h: number };

export async function ytScoutSummary(now = Date.now()): Promise<YtScoutSummary> {
  const since = new Date(now - 86400_000);
  const [found, creators, checkedCreators, videos24h, moments24h, captionMoments24h] = await Promise.all([
    prisma.streamer.count({ where: { platform: "youtube", approved: true, linkedFromId: { not: null } } }),
    prisma.streamer.count({ where: { platform: "twitch", approved: true } }),
    prisma.streamer.count({ where: { platform: "twitch", approved: true, ytLookupAt: { not: null } } }),
    prisma.youTubeVideo.count({ where: { checkedAt: { gte: since } } }),
    prisma.moment.count({ where: { source: "youtube", createdAt: { gte: since } } }),
    prisma.moment.count({ where: { source: "youtube", createdAt: { gte: since }, stats: { contains: "\"kind\":\"captions\"" } } }),
  ]);
  return { found, creators, checkedCreators, videos24h, moments24h, captionMoments24h };
}

/** "3 YouTube channels found for 12 of 20 Twitch creators checked · 9 videos checked · 4 moments sent (2 from captions) in 24h" */
export function ytScoutLine(s: YtScoutSummary): string {
  const ch = `${s.found} YouTube channel${s.found === 1 ? "" : "s"} found (${s.checkedCreators} of ${s.creators} Twitch creator${s.creators === 1 ? "" : "s"} checked)`;
  const cap = s.captionMoments24h ? ` (${s.captionMoments24h} from captions)` : "";
  return `${ch} · ${s.videos24h} video${s.videos24h === 1 ? "" : "s"} checked · ${s.moments24h} moment${s.moments24h === 1 ? "" : "s"} sent${cap} in the last 24h`;
}
