import { prisma, getSettings } from "../lib/db";
import type { ChatHeat } from "../lib/chat";
import { enqueueGrab } from "../lib/queues";
import { brandedCaption, defaultTitle, GTA6_NAME } from "../lib/social";
import { getLiveVodId } from "../lib/twitch";
import { backlogRoom } from "../lib/guards";
import { categoryOff, skippedNote, type Category } from "../lib/category";

const COOLDOWN_MS = 180_000;          // one moment per streamer per 3 min
const SKIP_QUIET_MS = 30_000;         // a spike of a switched-off kind is counted once, not every 5s while the window lasts
const lastSkip = new Map<string, number>();
const REACTION_LAG_SEC = 12;          // stream delay + time for chat to react
const VOD_CATCHUP_MS = 150_000;       // live VODs trail the stream; wait before grabbing

const lastSpike = new Map<string, number>();
const vodCache = new Map<string, { vodId: string | null; at: number }>();

async function liveVod(twitchId: string, streamId: string | null, now: number) {
  const key = `${twitchId}:${streamId}`;
  const hit = vodCache.get(key);
  if (hit && (hit.vodId || now - hit.at < 5 * 60_000)) return hit.vodId;
  const vodId = await getLiveVodId(twitchId, streamId);
  vodCache.set(key, { vodId, at: now });
  return vodId;
}

/** Spike detector: runs every 5s over the chat the Scout is reading. Returns a status line when something happened. */
export async function runSpikeCheck(chat: ChatHeat, now = Date.now(), lookupVod = liveVod): Promise<string | null> {
  const settings = await getSettings();
  if (!settings.spikeEnabled || settings.scoutPaused) return null;
  // Paused creators (Creators page) stay approved but make no new moments.
  const live = await prisma.streamer.findMany({ where: { approved: true, paused: false, isLive: true, platform: "twitch" }, include: { campaign: true } });
  const notes: string[] = [];
  const skipped: Record<Category, number> = { funny: 0, gaming: 0 };
  let room: number | null = null; // looked up only once a spike shows up

  for (const s of live) {
    if (now - (lastSpike.get(s.id) ?? 0) < COOLDOWN_MS) continue;
    if (now - (lastSkip.get(s.id) ?? 0) < SKIP_QUIET_MS) continue;
    const sp = chat.spike(s.login, settings.spikeMultiplier, now);
    if (!sp) continue;
    if (categoryOff(settings, sp.category)) {
      // Settings → "What to clip" has this kind off: no moment. Short quiet time so one spike is counted once.
      lastSkip.set(s.id, now);
      skipped[sp.category]++;
      continue;
    }
    if (room == null) room = await backlogRoom();
    if (room <= 0) {
      // Line is full: skip without using up the streamer's cooldown.
      notes.push(`${s.name}: ${sp.ratio}x spike, but the line is full, skipped`);
      continue;
    }
    lastSpike.set(s.id, now);

    const vodId = await lookupVod(s.twitchId, s.streamId, now).catch(() => null);
    if (!vodId || !s.liveSince) {
      notes.push(`${s.name}: ${sp.ratio}x spike, but no VOD to cut from (past broadcasts are off)`);
      continue;
    }
    const vodOffset = Math.max(0, Math.round((now - s.liveSince.getTime()) / 1000) - REACTION_LAG_SEC);
    const game = s.gameName || GTA6_NAME; // any-game mode: what they're playing right now
    const title = defaultTitle(null, s.name, game);
    const moment = await prisma.moment.create({
      data: {
        streamerId: s.id, timestamp: new Date(now - REACTION_LAG_SEC * 1000), spikeScore: sp.ratio, source: "chat", gameName: game,
        vodId, vodOffset, sourceUrl: `https://www.twitch.tv/videos/${vodId}?t=${Math.max(0, vodOffset - 30)}s`, category: sp.category,
        stats: JSON.stringify({ ...sp, viewers: s.viewers, chat: chat.samples(s.login, 20, 40, now) }),
        clips: { create: { title, caption: brandedCaption({ hook: title, streamer: s, category: sp.category, game, campaign: s.campaign }), status: "processing", stage: "grab", stageAt: new Date(), category: sp.category } },
      },
      include: { clips: true },
    });
    await enqueueGrab(moment.id, moment.clips[0].id, { delayMs: VOD_CATCHUP_MS });
    room--;
    notes.push(`${s.name}: ${sp.ratio}x ${sp.category} chat spike (${sp.kind}) → grabbing in ${VOD_CATCHUP_MS / 60_000} min`);
  }
  const skip = skippedNote(skipped);
  if (skip) notes.push(skip);
  return notes.length ? notes.join(" · ") : null;
}
