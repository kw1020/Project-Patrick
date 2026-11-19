// v2.0.0: approved edits on the Upload page, in the column of the channel whose types include Edits (ClipFactoryGG).
// Same rules as clips (src/lib/to-post.ts): one account per platform slot, by-hand accounts = Download + copy caption ->
// Mark posted, done once every (not switched off) account of the channel has it. Edits never auto-post.
import { prisma } from "./db";
import { POST_PLATFORMS, channelForClip, donePost, isFullyPosted, slotAccount } from "./channels";

/** Approved edits, plus edits posted through Upload (a post with a channel) that some account of the channel still lacks. */
export async function toPostEditItems(take = 100) {
  const [channels, accounts, edits] = await Promise.all([
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.account.findMany({ where: { platform: { in: [...POST_PLATFORMS] } }, orderBy: [{ createdAt: "asc" }] }),
    prisma.edit.findMany({
      where: { OR: [{ status: "approved" }, { status: "posted", finalPath: { not: null }, posts: { some: { channelId: { not: null } } } }] },
      include: { posts: true, streamer: { include: { campaign: true } } }, orderBy: { createdAt: "desc" }, take,
    }),
  ]);
  const channel = channelForClip(channels, { category: "edits" }); // the first (non-GTA) channel that takes Edits
  const accs = channel ? POST_PLATFORMS.map((p) => slotAccount(accounts, channel.id, p)).filter((a): a is (typeof accounts)[number] => Boolean(a)) : [];
  const items = edits.map((edit) => ({ edit, channel, accounts: accs, rows: accs.map((a) => ({ account: a, post: donePost(edit.posts, a.id) })) }))
    .filter((x) => !isFullyPosted(x.edit.posts, x.accounts.filter((a) => !a.disabled)));
  return { channel, items };
}
