import { prisma, getSettings } from "../lib/db";
import { helix, helixAll, getUsers, twitchConfigured, type TwitchClip, type TwitchStream } from "../lib/twitch";
import { findPermissionEvidence, type PermissionEvidence } from "../lib/permission";
import { compact } from "../lib/format";
import { setStatus } from "../lib/queues";
import { runYouTubeSuggestScan } from "./suggest-youtube";

// Suggestions: streamers Krew could approve — mainly big ones whose viewers clip a lot.
// This NEVER approves anyone. It only writes Suggestion rows; Krew approves on the Streamers page with a reason.

const PAGES = 3;              // /streams pages of 100 → top 300 live streams on all of Twitch
const DEEP_CHECK = 40;        // candidates (by viewers) whose clips + bio get fetched
const KEEP = 25;              // pending suggestions kept
const FRESH_MS = 50 * 60_000; // pending suggestions scored this recently aren't re-scored (hourly scan always re-scores)
const SEEN_DAYS = 7;          // GTA-Scout streamers seen this recently are candidates too
const DAY = 86_400_000;

type Candidate = {
  twitchId: string; login: string; name: string; viewers: number; live: boolean;
  gameName: string | null; title: string | null;
};

export type ScoreInput = { viewers: number; clipCount: number; topClipViews: number; evidence: boolean };
/**
 * score = 2·log10(viewers+1) + 1.5·log10(clipCount+1) + 1.5·log10(topClipViews+1) + (permission evidence ? 2 : 0)
 * viewers = live viewers now (or peak, for a GTA-Scout streamer who isn't live); clipCount = clips viewers made
 * in the last 7 days (one Helix page, max 100); topClipViews = views of their most-watched clip of those.
 * e.g. 20K viewers, 100 clips, top clip 50K, no evidence ≈ 8.6 + 3.0 + 7.0 = 18.6.
 */
export function suggestionScore(i: ScoreInput) {
  return 2 * Math.log10(i.viewers + 1) + 1.5 * Math.log10(i.clipCount + 1) + 1.5 * Math.log10(i.topClipViews + 1) + (i.evidence ? 2 : 0);
}

export function suggestionReasons(c: { viewers: number; live: boolean; gameName: string | null }, clipCount: number, moreClips: boolean, topClipViews: number, ev: PermissionEvidence | null): string[] {
  const game = c.gameName ? ` (${c.gameName})` : "";
  const out = [c.live ? `${compact(c.viewers)} watching now${game}` : `peaked at ${compact(c.viewers)} viewers${game}`];
  if (clipCount > 0) out.push(`viewers made ${clipCount}${moreClips ? "+" : ""} clip${clipCount === 1 && !moreClips ? "" : "s"} this week`);
  if (topClipViews > 0) out.push(`top clip ${compact(topClipViews)} views`);
  if (ev) out.push(`${ev.source}: '${ev.match.length > 40 ? ev.match.slice(0, 39) + "…" : ev.match}'`);
  return out;
}

/**
 * The hourly Suggestions job: Twitch first, then YouTube (src/workers/suggest-youtube.ts). Each half has its
 * own try/catch so one failing never stops the other; each half's line is also saved as its own status
 * ("suggest_twitch" / "suggest_youtube") for the Streamers page tabs. Throws (→ red status) only when a half
 * hit an unexpected error, after both halves ran.
 */
export async function runSuggestScan(): Promise<string> {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  const parts: { name: string; key: string; run: () => Promise<string> }[] = [
    { name: "Twitch", key: "suggest_twitch", run: runTwitchSuggestScan },
    { name: "YouTube", key: "suggest_youtube", run: () => runYouTubeSuggestScan(settings.ytSuggestRegion || "US") },
  ];
  const lines: string[] = [];
  let failed = false;
  for (const p of parts) {
    let ok = true, msg: string;
    try {
      msg = await p.run();
    } catch (e) {
      ok = false; failed = true;
      msg = `failed: ${(e as Error).message}`;
      console.warn(`[suggest] ${p.name} part failed:`, (e as Error).message);
    }
    await setStatus(p.key, ok, msg).catch(() => {});
    lines.push(`${p.name}: ${msg}`);
  }
  const all = lines.join(" · ");
  if (failed) throw new Error(all);
  return all;
}

async function runTwitchSuggestScan(): Promise<string> {
  if (!twitchConfigured()) return "keys missing (skipped)";
  const now = new Date();

  // Already-approved streamers are never suggested; keep their old pending suggestion out of the feed.
  await prisma.suggestion.updateMany({ where: { status: "pending", streamer: { approved: true } }, data: { status: "approved" } });

  const streams = await helixAll<TwitchStream>("/streams", { first: 100, type: "live" }, PAGES);

  // A YouTube channel with the same name doesn't block a Twitch suggestion (login is unique per platform since v1.7.1).
  const [approved, existing, seenByScout] = await Promise.all([
    prisma.streamer.findMany({ where: { approved: true, platform: "twitch" }, select: { twitchId: true } }),
    prisma.suggestion.findMany({ where: { platform: "twitch" }, include: { streamer: { select: { twitchId: true } } } }),
    prisma.streamer.findMany({ where: { platform: "twitch", approved: false, lastSeenAt: { gte: new Date(now.getTime() - SEEN_DAYS * DAY) } } }),
  ]);
  const approvedIds = new Set(approved.map((s) => s.twitchId));
  const skip = new Set<string>();
  for (const s of existing) {
    const fresh = s.status === "pending" && now.getTime() - s.updatedAt.getTime() < FRESH_MS;
    const snoozed = s.status === "dismissed" && s.dismissedUntil && s.dismissedUntil > now;
    if (fresh || snoozed) skip.add(s.streamer.twitchId);
  }

  const cands = new Map<string, Candidate>();
  for (const st of streams) {
    if (cands.has(st.user_id)) continue;
    cands.set(st.user_id, { twitchId: st.user_id, login: st.user_login, name: st.user_name, viewers: st.viewer_count, live: true, gameName: st.game_name || null, title: st.title || null });
  }
  for (const s of seenByScout) {
    if (cands.has(s.twitchId)) continue;
    cands.set(s.twitchId, { twitchId: s.twitchId, login: s.login, name: s.name, viewers: s.isLive ? s.viewers : s.peakViewers, live: s.isLive, gameName: s.gameName, title: s.streamTitle });
  }
  const pool = [...cands.values()]
    .filter((c) => !approvedIds.has(c.twitchId) &&!skip.has(c.twitchId))
    .sort((a, b) => b.viewers - a.viewers)
    .slice(0, DEEP_CHECK);

  // Bios (+ avatars) in batches of 100, then each candidate's clips from the last 7 days (one page each).
  const users = pool.length ? await getUsers({ ids: pool.map((c) => c.twitchId) }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const startedAt = new Date(now.getTime() - 7 * DAY).toISOString();

  const scored = [];
  for (const c of pool) {
    let clips: TwitchClip[] = [], more = false;
    try {
      const page = await helix<TwitchClip>("/clips", { broadcaster_id: c.twitchId, started_at: startedAt, first: 100 });
      clips = page.data;
      more = clips.length >= 100 && Boolean(page.pagination?.cursor);
    } catch (e) {
      console.warn(`[suggest] clips for ${c.login} failed:`, (e as Error).message);
    }
    const topClipViews = clips.reduce((m, x) => Math.max(m, x.view_count), 0);
    const user = userById.get(c.twitchId);
    const ev = findPermissionEvidence(user?.description, c.title);
    scored.push({
      c, user, ev,
      score: suggestionScore({ viewers: c.viewers, clipCount: clips.length, topClipViews, evidence: Boolean(ev) }),
      reasons: suggestionReasons(c, clips.length, more, topClipViews, ev),
    });
  }

  // Top 25 overall: newly scored candidates compete with pending suggestions that are still fresh.
  const freshPending = existing.filter((s) => s.status === "pending" && skip.has(s.streamer.twitchId));
  const ranked = [
    ...freshPending.map((s) => ({ kind: "fresh" as const, score: s.score, streamerId: s.streamerId })),
    ...scored.map((s) => ({ kind: "new" as const, score: s.score, s })),
  ].sort((a, b) => b.score - a.score).slice(0, KEEP);

  const keepIds: string[] = [];
  let added = 0;
  for (const r of ranked) {
    if (r.kind === "fresh") { keepIds.push(r.streamerId); continue; }
    const { c, user, ev, score, reasons } = r.s;
    // Only fields describing this stream: never isLive/viewers (the Scout owns "live in GTA 6"), never approved.
    const info = {
      login: c.login, name: user?.display_name || c.name,
      ...(user?.profile_image_url ? { profileImage: user.profile_image_url } : {}),
      ...(c.live ? { gameName: c.gameName, streamTitle: c.title, lastSeenAt: now } : {}),
    };
    let streamer;
    try {
      const prev = await prisma.streamer.findUnique({ where: { twitchId: c.twitchId }, select: { peakViewers: true } });
      streamer = await prisma.streamer.upsert({
        where: { twitchId: c.twitchId },
        update: { ...info, peakViewers: Math.max(prev?.peakViewers ?? 0, c.viewers) },
        create: { twitchId: c.twitchId, platform: "twitch", approved: false, peakViewers: c.viewers, ...info },
      });
    } catch (e) {
      console.warn(`[suggest] couldn't save ${c.login}:`, (e as Error).message);      continue;
    }
    const data = {
      platform: "twitch", score, reasons: JSON.stringify(reasons), evidence: ev?.snippet ?? null, evidenceSource: ev?.source ?? null,
      viewers: c.viewers, gameName: c.gameName, status: "pending", dismissedUntil: null,
    };
    const before = await prisma.suggestion.findUnique({ where: { streamerId: streamer.id }, select: { status: true } });
    if (before?.status !== "pending") added++;
    await prisma.suggestion.upsert({ where: { streamerId: streamer.id }, update: data, create: { streamerId: streamer.id, ...data } });
    keepIds.push(streamer.id);
  }
  // Pending suggestions that fell out of the top 25 aren't kept (dismissed ones stay, to remember "Not now").
  await prisma.suggestion.deleteMany({ where: { platform: "twitch", status: "pending", streamerId: { notIn: keepIds } } });

  return `${keepIds.length} suggestions (${added} new) · checked ${pool.length} of ${cands.size} streamers`;
}
