import type { Account } from "@prisma/client";
import { prisma } from "../lib/db";
import { resolveStored } from "../lib/paths";
import { draftStatus, fetchTikTokStats, MAX_PENDING_DRAFTS, tiktokVideoUrl, uploadDraft } from "../lib/tiktok";
import { fetchPublicStats, fetchStats, uploadVideo, youtubeIdFromUrl } from "../lib/youtube";
import { isApiPostingAccount } from "../lib/channels";
import { captionCredits, creatorCreditText, creatorUrl, creditLine, defaultTitle, gameHashtags, momentGame } from "../lib/social";

/** Poster: sends an APPROVED clip to one connected account. Refuses anything Krew hasn't approved. */
export async function runPost(clipId: string, accountId: string) {
  const [clip, acct] = await Promise.all([
    prisma.clip.findUnique({ where: { id: clipId }, include: { posts: true, moment: { include: { streamer: true } } } }),
    prisma.account.findUnique({ where: { id: accountId } }),
  ]);
  if (!clip) return "clip deleted";
  if (!acct) throw new Error("That account was disconnected");
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Clip isn't approved, so it won't be posted");
  // v1.9.5: by-hand accounts (and the Twitch follower-count login) are never uploaded to.
  if (!isApiPostingAccount(acct)) throw new Error(`${acct.channelTitle ?? acct.handle ?? "That account"} is posted to by hand: use Download + copy caption on Upload`);
  const channelId = acct.homeChannelId ?? null;
  if (clip.posts.some((p) => p.accountId === acct.id && p.status !== "failed")) return `already sent to ${acct.channelTitle}`;
  if (!clip.finalPath) throw new Error("No finished video to upload");
  const file = resolveStored(clip.finalPath);
  const streamer = clip.moment.streamer;

  if (acct.platform === "tiktok") {
    const waiting = await prisma.post.count({ where: { accountId: acct.id, status: "draft", postedAt: { gt: new Date(Date.now() - 24 * 3600_000) } } });
    if (waiting >= MAX_PENDING_DRAFTS) throw new Error(`${acct.channelTitle} already has ${waiting} drafts waiting today (TikTok allows ${MAX_PENDING_DRAFTS}). Post them in the TikTok app first.`);
    const publishId = await uploadDraft(acct, file);
    await prisma.post.create({ data: { clipId, platform: "tiktok", accountId: acct.id, status: "draft", publishId, campaignId: streamer.campaignId ?? null, channelId } });
    await prisma.clip.update({ where: { id: clipId }, data: { status: "posted", stage: null, stageAt: new Date(), postError: null } });
    return `sent ${streamer.name} clip to ${acct.channelTitle}'s TikTok inbox`;
  }

  // YouTube. The credit must be in what gets posted, even if the caption was edited: the "🎥 @login" line (v1.9.1) or the
  // channel link both count. The link line is still added to the YouTube description only (clickable there).
  let description = clip.caption || clip.title || "";
  if (!captionCredits(description, streamer)) description += `\n\n${creditLine(streamer)}`;
  else if (!description.includes(creatorCreditText(streamer))) description += `\n\n${creatorUrl(streamer)}`;
  if (!/#shorts\b/i.test(description)) description += "\n#Shorts";
  const game = momentGame(clip.moment);
  const tags = (clip.hashtags || gameHashtags(game).join(" ")).split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
  const privacy = (["public", "unlisted", "private"] as const).find((p) => p === acct.privacy) ?? "public";
  const id = await uploadVideo(acct, { file, title: clip.title || defaultTitle(null, streamer.name, game), description, tags, privacy });

  await prisma.post.create({ data: { clipId, platform: "youtube", accountId: acct.id, externalId: id, url: `https://youtube.com/shorts/${id}`, campaignId: streamer.campaignId ?? null, channelId } });
  await prisma.clip.update({ where: { id: clipId }, data: { status: "posted", stage: null, stageAt: new Date(), postError: null } });
  return `uploaded ${streamer.name} clip to ${acct.channelTitle} (${privacy}): ${id}`;
}

async function record(postId: string, prev: number | null, s: { views: number; likes: number | null; comments: number | null }) {
  await prisma.post.update({ where: { id: postId }, data: { views: s.views, likes: s.likes, comments: s.comments, syncedAt: new Date() } });
  if (prev !== s.views) await prisma.postStat.create({ data: { postId, views: s.views, likes: s.likes, comments: s.comments } });
}

async function syncAccount(acct: Account) {
  let changed = 0, finished = 0;
  if (acct.platform === "tiktok") {
    // Follow drafts until Krew posts them in the app (or 7 days pass).
    const drafts = await prisma.post.findMany({ where: { accountId: acct.id, status: "draft", publishId: { not: null }, postedAt: { gt: new Date(Date.now() - 7 * 86400_000) } } });
    for (const p of drafts) {
      const st = await draftStatus(acct, p.publishId!);
      if (st.status === "FAILED") {
        await prisma.post.update({ where: { id: p.id }, data: { status: "failed", error: `TikTok: ${st.failReason ?? "failed"}` } });
      } else if (st.status === "PUBLISH_COMPLETE") {
        const vid = st.postIds[0];
        await prisma.post.update({ where: { id: p.id }, data: { status: "live", postedAt: new Date(), ...(vid ? { externalId: vid, url: tiktokVideoUrl(acct, vid) } : {}) } });
        finished++;
      }
    }
    const live = await prisma.post.findMany({ where: { accountId: acct.id, status: "live", externalId: { not: null } }, orderBy: { postedAt: "desc" }, take: 200 });
    const stats = await fetchTikTokStats(acct, live.map((p) => p.externalId!));
    for (const p of live) { const s = stats.get(p.externalId!); if (s) { await record(p.id, p.views, s); if (p.views !== s.views) changed++; } }
    return `${acct.channelTitle}: ${finished} drafts went live, ${changed} updated`;
  }
  const live = await prisma.post.findMany({ where: { accountId: acct.id, externalId: { not: null } }, orderBy: { postedAt: "desc" }, take: 500 });
  const stats = await fetchStats(acct, live.map((p) => p.externalId!));
  for (const p of live) { const s = stats.get(p.externalId!); if (s) { await record(p.id, p.views, s); if (p.views !== s.views) changed++; } }
  return `${acct.channelTitle}: ${live.length} checked, ${changed} updated`;
}

/** Every 15 min: views/likes/comments for every account. One broken account doesn't stop the rest. */
export async function runStatsSync() {
  const out: string[] = [];
  // Only OAuth-connected YouTube/TikTok accounts sync through their own login (manual + Twitch rows are skipped).
  const accounts = (await prisma.account.findMany()).filter(isApiPostingAccount);
  // Phase 2 YouTube posts were saved before accounts had ids; attach them if there's exactly one channel.
  const yt = accounts.filter((a) => a.platform === "youtube");
  if (yt.length === 1) await prisma.post.updateMany({ where: { platform: "youtube", accountId: null, externalId: { not: null } }, data: { accountId: yt[0].id } });
  for (const a of accounts) {
    try { out.push(await syncAccount(a)); } catch (e) { out.push(`${a.channelTitle}: ${(e as Error).message}`); }
  }
  // v1.9.5: posts Krew made by hand on YouTube: public stats from the link with the plain API key (no OAuth).
  try { const m = await syncManualYouTube(); if (m) out.push(m); } catch (e) { out.push(`YouTube links: ${(e as Error).message}`); }
  return out.length ? out.join(" · ") : "no accounts connected";
}

/**
 * v1.9.5: views for posts made by hand (no account, or a manual account) whose link is a YouTube Shorts/watch link, with
 * YOUTUBE_API_KEY (public statistics, 1 quota unit per 50). Returns null when there's nothing to do (no key / no such posts).
 * TikTok and Instagram posts made by hand keep the views Krew types in.
 */
export async function syncManualYouTube(): Promise<string | null> {
  if (!process.env.YOUTUBE_API_KEY) return null;
  const posts = await prisma.post.findMany({
    where: { status: "live", url: { contains: "youtu" }, OR: [{ accountId: null }, { account: { mode: "manual" } }] },
    orderBy: { postedAt: "desc" }, take: 500,
  });
  const withId = posts.map((p) => ({ p, id: youtubeIdFromUrl(p.url) })).filter((x): x is { p: (typeof posts)[number]; id: string } => Boolean(x.id));
  if (!withId.length) return null;
  const stats = await fetchPublicStats(withId.map((x) => x.id));
  let changed = 0;
  for (const { p, id } of withId) { const s = stats.get(id); if (s) { await record(p.id, p.views, s); if (p.views !== s.views) changed++; } }
  return `YouTube links: ${withId.length} checked, ${changed} updated`;
}

/** Phase 2 kept "auto-upload" + privacy in Settings; Phase 3 keeps them on each account. Runs once. */
export async function migrateLegacySettings() {
  const s = await prisma.settings.findUnique({ where: { id: "main" } });
  if (!s?.ytAutoUpload) return;
  await prisma.account.updateMany({ where: { platform: "youtube" }, data: { autoPost: true, privacy: s.ytPrivacy } });
  await prisma.settings.update({ where: { id: "main" }, data: { ytAutoUpload: false } });
}
