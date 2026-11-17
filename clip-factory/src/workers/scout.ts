import { prisma, getSettings } from "../lib/db";
import { getGameId, getLiveStreams, getStreamsByUserIds, getUsers } from "../lib/twitch";
import type { ChatHeat } from "../lib/chat";

/** Scout: who's live in GTA 6 right now. Discovers everyone; chat is only joined for approved streamers.
 *  Settings → "Any game": approved streamers are tracked live whatever they play. */
export async function runScout(chat: ChatHeat) {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  const gameId = await getGameId();
  const streams = await getLiveStreams(gameId);

  // /streams?game_id only returns the top 500: look up approved streamers directly so a small one is never missed.
  // "gta6" mode: their streams in another game are ignored (they end up not live). "any" mode: kept, any game.
  const anyGame = settings.gameMode === "any";
  const approvedIds = (await prisma.streamer.findMany({ where: { approved: true }, select: { twitchId: true } })).map((s) => s.twitchId);
  if (approvedIds.length) {
    const seen = new Set(streams.map((s) => s.user_id));
    // Fail-soft: if this extra lookup fails, keep the game-wide list rather than losing the whole scan.
    const extra = await getStreamsByUserIds(approvedIds).catch((e) => {
      console.warn("[scout] approved-streamer lookup failed:", (e as Error).message);
      return [];
    });
    for (const st of extra) {
      if ((anyGame || st.game_id === gameId) && !seen.has(st.user_id)) { streams.push(st); seen.add(st.user_id); }
    }
  }
  const now = new Date();

  const existing = new Map(
    (await prisma.streamer.findMany({ where: { twitchId: { in: streams.map((s) => s.user_id) } } })).map((s) => [s.twitchId, s]),
  );

  await prisma.$transaction(
    streams.map((st) => {
      const prev = existing.get(st.user_id);
      const live = {
        login: st.user_login, name: st.user_name, isLive: true, viewers: st.viewer_count,
        peakViewers: Math.max(prev?.peakViewers ?? 0, st.viewer_count), streamTitle: st.title,
        gameName: st.game_name || null, streamId: st.id, liveSince: new Date(st.started_at), lastSeenAt: now,
      };
      return prisma.streamer.upsert({ where: { twitchId: st.user_id }, update: live, create: { twitchId: st.user_id, ...live } });
    }),
  );
  await prisma.streamer.updateMany({
    where: { isLive: true, twitchId: { notIn: streams.map((s) => s.user_id) } },
    data: { isLive: false, viewers: 0, chatRate: 0, chatAvg: 0 },
  });

  // Profile pictures for new faces (one /users call per 100, capped).
  const missing = await prisma.streamer.findMany({ where: { profileImage: null, isLive: true }, orderBy: { viewers: "desc" }, take: 200, select: { twitchId: true } });
  if (missing.length) {
    const users = await getUsers({ ids: missing.map((m) => m.twitchId) });
    await prisma.$transaction(users.map((u) => prisma.streamer.update({ where: { twitchId: u.id }, data: { profileImage: u.profile_image_url } })));
  }

  const approvedLive = await prisma.streamer.findMany({ where: { approved: true, isLive: true }, select: { login: true } });
  chat.setChannels(approvedLive.map((s) => s.login));
  const otherGames = streams.filter((st) => st.game_id !== gameId).length;
  return `${streams.length - otherGames} live in GTA 6, ${approvedLive.length} approved live${otherGames ? ` (${otherGames} in other games)` : ""}`;
}

/** Write chat heat for approved live streamers (every 10s). */
export async function flushChatHeat(chat: ChatHeat) {
  const live = await prisma.streamer.findMany({ where: { approved: true, isLive: true }, select: { id: true, login: true } });
  if (!live.length) return;
  // One transaction instead of N writes: fewer lock grabs while the web app is writing too.
  await prisma.$transaction(live.map((s) => {
    const st = chat.stats(s.login);
    return prisma.streamer.update({ where: { id: s.id }, data: { chatRate: st.rate, chatAvg: st.avg } });
  }));
}
