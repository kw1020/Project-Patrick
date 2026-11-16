import { prisma, getSettings } from "../lib/db";
import { getGameId, getLiveStreams, getUsers } from "../lib/twitch";
import type { ChatHeat } from "../lib/chat";

/** Scout: who's live in GTA 6 right now. Discovers everyone; chat is only joined for approved streamers. */
export async function runScout(chat: ChatHeat) {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  const gameId = await getGameId();
  const streams = await getLiveStreams(gameId);
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
        streamId: st.id, liveSince: new Date(st.started_at), lastSeenAt: now,
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
  return `${streams.length} live in GTA 6, ${approvedLive.length} approved live`;
}

/** Write chat heat for approved live streamers (every 10s). */
export async function flushChatHeat(chat: ChatHeat) {
  const live = await prisma.streamer.findMany({ where: { approved: true, isLive: true }, select: { id: true, login: true } });
  for (const s of live) {
    const st = chat.stats(s.login);
    await prisma.streamer.update({ where: { id: s.id }, data: { chatRate: st.rate, chatAvg: st.avg } });
  }
}
