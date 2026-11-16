import { prisma, getSettings } from "../lib/db";
import { resolveStored } from "../lib/paths";
import { fetchViews, getYouTubeAccount, uploadVideo } from "../lib/youtube";

/** Poster: uploads an APPROVED clip to YouTube. Refuses anything Krew hasn't approved. */
export async function runPost(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { posts: true, moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Clip isn't approved, so it won't be posted");
  if (clip.posts.some((p) => p.platform === "youtube")) return "already on YouTube";
  if (!clip.finalPath) throw new Error("No finished video to upload");
  const streamer = clip.moment.streamer;
  const settings = await getSettings();

  // The credit must be in what gets posted, even if the caption was edited.
  const credit = `https://twitch.tv/${streamer.login}`;
  let description = clip.caption || clip.title || "";
  if (!description.includes(`twitch.tv/${streamer.login}`)) description += `\n\n🎥 Credit: ${streamer.name} — ${credit}`;
  if (!/#shorts\b/i.test(description)) description += "\n#Shorts";
  const tags = (clip.hashtags || "#GTA6 #GTAVI").split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);

  const privacy = (["public", "unlisted", "private"] as const).find((p) => p === settings.ytPrivacy) ?? "public";
  const id = await uploadVideo({ file: resolveStored(clip.finalPath), title: clip.title || `${streamer.name} in GTA 6`, description, tags, privacy });

  await prisma.post.create({ data: { clipId, platform: "youtube", externalId: id, url: `https://youtube.com/shorts/${id}` } });
  await prisma.clip.update({ where: { id: clipId }, data: { status: "posted", stage: null, postError: null } });
  return `uploaded ${streamer.name} clip to YouTube (${privacy}): ${id}`;
}

/** Pull YouTube view counts into the Posted page. */
export async function runViewsSync() {
  if (!(await getYouTubeAccount())) return "YouTube not connected";
  const posts = await prisma.post.findMany({ where: { platform: "youtube", externalId: { not: null } }, orderBy: { postedAt: "desc" }, take: 500 });
  if (!posts.length) return "no YouTube posts yet";
  const views = await fetchViews(posts.map((p) => p.externalId!));
  let n = 0;
  for (const p of posts) {
    const v = views.get(p.externalId!);
    if (v !== undefined && v !== p.views) { await prisma.post.update({ where: { id: p.id }, data: { views: v } }); n++; }
  }
  return `checked ${posts.length} YouTube posts, ${n} updated`;
}
