import { prisma, getSettings } from "../lib/db";
import { getClips, getGameId, type TwitchClip } from "../lib/twitch";
import { enqueueGrab } from "../lib/queues";
import { defaultCaption, defaultTitle } from "../lib/social";

const MAX_NEW_PER_RUN = 15;

/** Twitch Clips poller: viewer-made clips of approved streamers are free, pre-picked hype moments. */
export async function runClipsPoll() {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  const approved = await prisma.streamer.findMany({ where: { approved: true } });
  if (!approved.length) return "no approved streamers yet — add some on the Streamers page";
  const byTwitchId = new Map(approved.map((s) => [s.twitchId, s]));

  const gameId = await getGameId();
  const startedAt = new Date(Date.now() - settings.clipLookbackHrs * 3600_000).toISOString();

  const found = new Map<string, TwitchClip>();
  // 1) Game-wide top clips, 2) each approved streamer's own clips (catches smaller channels).
  for (const c of await getClips({ game_id: gameId, started_at: startedAt }, 2)) found.set(c.id, c);
  for (const s of approved) {
    for (const c of await getClips({ broadcaster_id: s.twitchId, started_at: startedAt }, 1)) found.set(c.id, c);
  }

  const candidates = [...found.values()]
    .filter((c) => byTwitchId.has(c.broadcaster_id)) // ground rule: approved streamers only
    .filter((c) => c.game_id === gameId)
    .filter((c) => c.view_count >= settings.minClipViews)
    .sort((a, b) => b.view_count - a.view_count);

  const known = new Set(
    (await prisma.moment.findMany({ where: { twitchClipId: { in: candidates.map((c) => c.id) } }, select: { twitchClipId: true } })).map((m) => m.twitchClipId),
  );

  let added = 0;
  for (const c of candidates) {
    if (known.has(c.id) || added >= MAX_NEW_PER_RUN) continue;
    const s = byTwitchId.get(c.broadcaster_id)!;
    // Skip if the spike detector already caught this same moment from chat.
    if (c.video_id && c.vod_offset != null) {
      const dupe = await prisma.moment.findFirst({
        where: { streamerId: s.id, source: "chat", vodId: c.video_id, vodOffset: { gte: c.vod_offset - 10, lte: c.vod_offset + Math.ceil(c.duration) + 10 } },
        select: { id: true },
      });
      if (dupe) continue;
    }
    const title = defaultTitle(c.title, s.name);
    const moment = await prisma.moment.create({
      data: {
        streamerId: s.id, timestamp: new Date(c.created_at), spikeScore: c.view_count, source: "twitch_clip",
        twitchClipId: c.id, sourceUrl: c.url, sourceTitle: c.title, sourceViews: c.view_count,
        vodId: c.video_id || null, vodOffset: c.vod_offset ?? null,
        clips: { create: { title, caption: defaultCaption(title, s.name, s.login), status: "processing", stage: "grab" } },
      },
      include: { clips: true },
    });
    await enqueueGrab(moment.id, moment.clips[0].id);
    added++;
  }
  return `${candidates.length} eligible clips, ${added} new sent to the Grabber`;
}
