import { prisma, getSettings } from "../lib/db";
import { getClips, getGameId, getGameNames, type TwitchClip } from "../lib/twitch";
import { enqueueGrab } from "../lib/queues";
import { defaultCaption, defaultTitle, GTA6_NAME } from "../lib/social";
import { backlogRoom } from "../lib/guards";
import { categoryOff, skippedNote, twitchClipCategory, type Category } from "../lib/category";
import { dedupe, momentTimeSpan, roundRobin, scoreCreatorClips, type Scored, type VodSpan } from "../lib/standout";

const MAX_NEW_PER_RUN = 15;

/**
 * Twitch Clips poller (v1.8.0 "Better moments"): for each approved, not-paused Twitch creator, their viewer-made clips
 * from the lookback window; only clips that stand out against THAT creator's usual clip (Settings.standoutMin), no
 * near-duplicates, shared out round-robin (at most Settings.maxPerCreatorPerRun each) so no channel hogs the line.
 */
export async function runClipsPoll() {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  // Paused creators (Creators page) stay approved but are skipped.
  const approved = await prisma.streamer.findMany({ where: { approved: true, paused: false, platform: "twitch" } });
  if (!approved.length) return "no approved streamers yet (or all paused) — add some on the Streamers page";

  // "any" mode (default since v1.8.0): every game, only approved creators. "gta6": GTA clips only, plus the GTA-wide list.
  const anyGame = settings.gameMode !== "gta6";
  const gameId = anyGame ? await getGameId().catch(() => null) : await getGameId();
  const startedAt = new Date(Date.now() - settings.clipLookbackHrs * 3600_000).toISOString();

  const perCreator = new Map<string, Map<string, TwitchClip>>(approved.map((s) => [s.twitchId, new Map()]));
  for (const s of approved) {
    for (const c of await getClips({ broadcaster_id: s.twitchId, started_at: startedAt }, 1)) {
      if (c.broadcaster_id === s.twitchId) perCreator.get(s.twitchId)!.set(c.id, c); // ground rule: only their own channel's clips
    }
  }
  if (!anyGame && gameId) {
    // GTA discovery (gta6 mode only): the game-wide top clips, kept for approved creators (ground rule).
    for (const c of await getClips({ game_id: gameId, started_at: startedAt }, 2)) perCreator.get(c.broadcaster_id)?.set(c.id, c);
  }

  const known = new Set(
    (await prisma.moment.findMany({ where: { twitchClipId: { in: [...perCreator.values()].flatMap((m) => [...m.keys()]) } }, select: { twitchClipId: true } })).map((m) => m.twitchClipId),
  );

  // Score each creator's clips against their own usual; then drop clips we already have and near-duplicates.
  let nothing = 0;
  const lists: Scored[][] = [];
  for (const s of approved) {
    const clips = [...perCreator.get(s.twitchId)!.values()].filter((c) => anyGame || c.game_id === gameId);
    const { kept } = scoreCreatorClips(clips, { minClipViews: settings.minClipViews, standoutMin: settings.standoutMin });
    if (!kept.length) nothing++;
    lists.push(kept.filter((k) => !known.has(k.clip.id)));
  }

  // Twitch clips carry only game_id: look up names for the other games (cached; a failed lookup just leaves it blank).
  const otherIds = lists.flat().map((k) => k.clip.game_id).filter((g) => g && g !== gameId);
  const names = otherIds.length ? await getGameNames(otherIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  const gameOf = (c: TwitchClip) => (gameId && c.game_id === gameId ? GTA6_NAME : names.get(c.game_id) ?? null);

  // Settings → "What to clip": a switched-off kind never becomes a moment. Unknown game name: try again next poll.
  const skipped: Record<Category, number> = { funny: 0, gaming: 0 };
  for (let i = 0; i < lists.length; i++) {
    lists[i] = lists[i].filter((k) => {
      const game = gameOf(k.clip);
      if (!game) return false;
      const cat = twitchClipCategory(game, k.clip.title);
      if (categoryOff(settings, cat)) { skipped[cat]++; return false; }
      return true;
    });
    if (!lists[i].length) continue;
    // Viewers often clip the same moment several times: keep the most-viewed, and skip moments we already have.
    const s = approved[i];
    const vodIds = [...new Set(lists[i].map((k) => k.clip.video_id).filter(Boolean))];
    const existing: VodSpan[] = vodIds.length
      ? (await prisma.moment.findMany({ where: { streamerId: s.id, vodId: { in: vodIds }, vodOffset: { not: null } }, select: { vodId: true, vodOffset: true, source: true } }))
        .map((m) => ({ vodId: m.vodId!, from: m.vodOffset! - (m.source === "chat" ? 30 : 0), to: m.vodOffset! + (m.source === "chat" ? 15 : 30) }))
      : [];
    // Recent clips (stream still live) have no vod_offset: compare creation times with this creator's recent moments too.
    const since = new Date(Math.min(...lists[i].map((k) => Date.parse(k.clip.created_at))) - 120_000);
    const recent = (await prisma.moment.findMany({ where: { streamerId: s.id, source: { in: ["chat", "twitch_clip"] }, timestamp: { gte: since } }, select: { source: true, timestamp: true } }))
      .map(momentTimeSpan);
    lists[i] = dedupe(lists[i], existing, 20, recent);
  }

  // Fair mix: round-robin across creators, capped per creator and by the room in the line.
  const room = await backlogRoom();
  const limit = Math.min(MAX_NEW_PER_RUN, room);
  const picks = roundRobin(lists, Math.max(1, settings.maxPerCreatorPerRun), limit);
  const waiting = lists.reduce((n, l) => n + l.length, 0); // standout clips not taken this time come next scan

  const from = new Set<number>();
  for (const { creator, pick } of picks) {
    const s = approved[creator], c = pick.clip, game = gameOf(c)!;
    const title = defaultTitle(c.title, s.name, game);
    const category = twitchClipCategory(game, c.title);
    const moment = await prisma.moment.create({
      data: {
        streamerId: s.id, timestamp: new Date(c.created_at), spikeScore: pick.standout, source: "twitch_clip",
        twitchClipId: c.id, sourceUrl: c.url, sourceTitle: c.title, sourceViews: c.view_count, gameName: game,
        vodId: c.video_id || null, vodOffset: c.vod_offset ?? null, category,
        clips: { create: { title, caption: defaultCaption(title, s, game), status: "processing", stage: "grab", stageAt: new Date(), category } },
      },
      include: { clips: true },
    });
    await enqueueGrab(moment.id, moment.clips[0].id);
    from.add(creator);
  }

  const n = picks.length, parts = [`picked ${n} standout clip${n === 1 ? "" : "s"} from ${from.size} creator${from.size === 1 ? "" : "s"}`];
  if (nothing) parts.push(`${nothing} had nothing standout`);
  if (waiting > n) parts.push(room <= n ? (room ? `line has room for ${room}, rest next scan` : "line full, skipped new ones") : "rest next scan");
  const skip = skippedNote(skipped);
  if (skip) parts.push(skip);
  return parts.join(" · ");
}
