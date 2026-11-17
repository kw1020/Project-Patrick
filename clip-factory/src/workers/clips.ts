import { prisma, getSettings } from "../lib/db";
import { getClips, getGameId, getGameNames, type TwitchClip } from "../lib/twitch";
import { enqueueGrab } from "../lib/queues";
import { defaultCaption, defaultTitle, GTA6_NAME } from "../lib/social";
import { backlogRoom } from "../lib/guards";

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

  // "any" mode: an approved streamer's clips count whatever game they're from.
  const anyGame = settings.gameMode === "any";
  const candidates = [...found.values()]
    .filter((c) => byTwitchId.has(c.broadcaster_id)) // ground rule: approved streamers only
    .filter((c) => anyGame || c.game_id === gameId)
    .filter((c) => c.view_count >= settings.minClipViews)
    .sort((a, b) => b.view_count - a.view_count);

  const known = new Set(
    (await prisma.moment.findMany({ where: { twitchClipId: { in: candidates.map((c) => c.id) } }, select: { twitchClipId: true } })).map((m) => m.twitchClipId),
  );

  // Launch-day cap: only take as many as the line has room for (candidates are highest views first).
  const room = await backlogRoom();
  const limit = Math.min(MAX_NEW_PER_RUN, room);
  // Twitch clips carry only game_id: look up names for the other games (cached; a failed lookup just leaves it blank).
  const otherIds = candidates.filter((c) => c.game_id && c.game_id !== gameId).map((c) => c.game_id);
  const names = otherIds.length ? await getGameNames(otherIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  const gameOf = (c: TwitchClip) => (c.game_id === gameId ? GTA6_NAME : names.get(c.game_id) ?? null);

  let added = 0;
  for (const c of candidates) {
    if (known.has(c.id) || added >= limit) continue;
    const s = byTwitchId.get(c.broadcaster_id)!;
    // Skip if the spike detector already caught this same moment from chat.
    if (c.video_id && c.vod_offset != null) {
      const dupe = await prisma.moment.findFirst({
        where: { streamerId: s.id, source: "chat", vodId: c.video_id, vodOffset: { gte: c.vod_offset - 10, lte: c.vod_offset + Math.ceil(c.duration) + 10 } },
        select: { id: true },
      });
      if (dupe) continue;
    }
    const game = gameOf(c);
    if (!game) continue; // game name lookup failed: try again next poll rather than mislabel it
    const title = defaultTitle(c.title, s.name, game);
    const moment = await prisma.moment.create({
      data: {
        streamerId: s.id, timestamp: new Date(c.created_at), spikeScore: c.view_count, source: "twitch_clip",
        twitchClipId: c.id, sourceUrl: c.url, sourceTitle: c.title, sourceViews: c.view_count, gameName: game,
        vodId: c.video_id || null, vodOffset: c.vod_offset ?? null,
        clips: { create: { title, caption: defaultCaption(title, s.name, s.login, game), status: "processing", stage: "grab" } },
      },
      include: { clips: true },
    });
    await enqueueGrab(moment.id, moment.clips[0].id);
    added++;
  }
  return `${candidates.length} eligible clips, ${added} new sent to the Grabber${room < MAX_NEW_PER_RUN ? ` (line ${room ? `has room for ${room}` : "full, skipped new ones"})` : ""}`;
}
