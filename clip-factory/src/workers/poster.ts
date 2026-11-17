import type { Account } from "@prisma/client";
import { prisma } from "../lib/db";
import { resolveStored } from "../lib/paths";
import { draftStatus, fetchTikTokStats, MAX_PENDING_DRAFTS, tiktokVideoUrl, uploadDraft } from "../lib/tiktok";
import { fetchStats, uploadVideo } from "../lib/youtube";
import { defaultTitle, gameHashtags, momentGame } from "../lib/social";

/** Poster: sends an APPROVED clip to one connected account. Refuses anything Krew hasn't approved. */
export async function runPost(clipId: string, accountId: string) {
  const [clip, acct] = await Promise.all([
    prisma.clip.findUnique({ where: { id: clipId }, include: { posts: true, moment: { include: { streamer: true } } } }),
    prisma.account.findUnique({ where: { id: accountId } }),
  ]);
  if (!clip) return "clip deleted";
  if (!acct) throw new Error("That account was disconnected");
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Clip isn't approved, so it won't be posted");
  if (clip.posts.some((p) => p.accountId === acct.id && p.status !== "failed")) return `already sent to ${acct.channelTitle}`;
  if (!clip.finalPath) throw new Error("No finished video to upload");
  const file = resolveStored(clip.finalPath);
  const streamer = clip.moment.streamer;

  if (acct.platform === "tiktok") {
    const waiting = await prisma.post.count({ where: { accountId: acct.id, status: "draft", postedAt: { gt: new Date(Date.now() - 24 * 3600_000) } } });
    if (waiting >= MAX_PENDING_DRAFTS) throw new Error(`${acct.channelTitle} already has ${waiting} drafts waiting today (TikTok allows ${MAX_PENDING_DRAFTS}). Post them in the TikTok app first.`);
    const publishId = await uploadDraft(acct, file);
    await prisma.post.create({ data: { clipId, platform: "tiktok", accountId: acct.id, status: "draft", publishId } });
    await prisma.clip.update({ where: { id: clipId }, data: { status: "posted", stage: null, postError: null } });
    return `sent ${streamer.name} clip to ${acct.channelTitle}'s TikTok inbox`;
  }

  // YouTube. The credit must be in what gets posted, even if the caption was edited.
  let description = clip.caption || clip.title || "";
  if (!description.includes(`twitch.tv/${streamer.login}`)) description += `\n\n🎥 Credit: ${streamer.name} — https://twitch.tv/${streamer.login}`;
  if (!/#shorts\b/i.test(description)) description += "\n#Shorts";
  const game = momentGame(clip.moment);
  const tags = (clip.hashtags || gameHashtags(game).join(" ")).split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
  const privacy = (["public", "unlisted", "private"] as const).find((p) => p === acct.privacy) ?? "public";
  const id = await uploadVideo(acct, { file, title: clip.title || defaultTitle(null, streamer.name, game), description, tags, privacy });

  await prisma.post.create({ data: { clipId, platform: "youtube", accountId: acct.id, externalId: id, url: `https://youtube.com/shorts/${id}` } });
  await prisma.clip.update({ where: { id: clipId }, data: { status: "posted", stage: null, postError: null } });
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
  const accounts = await prisma.account.findMany();
  if (!accounts.length) return "no accounts connected";
  // Phase 2 YouTube posts were saved before accounts had ids; attach them if there's exactly one channel.
  const yt = accounts.filter((a) => a.platform === "youtube");
  if (yt.length === 1) await prisma.post.updateMany({ where: { platform: "youtube", accountId: null, externalId: { not: null } }, data: { accountId: yt[0].id } });
  const out: string[] = [];
  for (const a of accounts) {
    try { out.push(await syncAccount(a)); } catch (e) { out.push(`${a.channelTitle}: ${(e as Error).message}`); }
  }
  return out.join(" · ");
}

/** Phase 2 kept "auto-upload" + privacy in Settings; Phase 3 keeps them on each account. Runs once. */
export async function migrateLegacySettings() {
  const s = await prisma.settings.findUnique({ where: { id: "main" } });
  if (!s?.ytAutoUpload) return;
  await prisma.account.updateMany({ where: { platform: "youtube" }, data: { autoPost: true, privacy: s.ytPrivacy } });
  await prisma.settings.update({ where: { id: "main" }, data: { ytAutoUpload: false } });
}
