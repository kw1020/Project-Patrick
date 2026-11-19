// v1.9.5 Channels + Upload: database side (the one-time channel migration and the Upload list).
import { getSettings, prisma } from "./db";
import { DEFAULT_CHANNEL } from "./campaigns";
import { isGta6, momentGame } from "./social";
import { balancedChannel, channelForClip, donePost, isFullyPosted, isPostingAccount, POST_PLATFORMS, slotAccount } from "./channels";
import { CHANNEL_SEEDS, matchesSeed } from "./channel-seeds";

/** The id of the channel the one-time migration makes, so two processes starting at once can't make two. */
export const FIRST_CHANNEL_ID = "main";

/**
 * One-time (Settings.migratedChannels): if there is no Channel yet, make Krew's brands (`CHANNEL_SEEDS`: ViceCityClips =
 * focus gta / every type, StreamHeistClips funny, WantedLevelClips gaming, ClipFactoryGG edits) with their YouTube / TikTok /
 * Instagram handles. An account that's already connected and matches a seeded handle takes that slot (no duplicate by-hand
 * row); other existing posting accounts go into a free slot of their platform in the first channel, else wait in "Not in a
 * channel yet". Seeded ids are fixed, so two processes starting at once can't make two. Krew's own channels are never touched:
 * nothing is seeded once any channel exists. Safe to call often (web layout + worker start).
 */
export async function ensureChannels(): Promise<string | null> {
  const s = await getSettings();
  if (s.migratedChannels) return null;
  let made = 0, seededAccounts = 0, matched = 0, moved = 0;
  if ((await prisma.channel.count()) === 0) {
    const existing = await prisma.account.findMany({ where: { platform: { in: [...POST_PLATFORMS] } }, orderBy: { createdAt: "asc" } });
    const used = new Set<string>();
    for (const [i, ch] of CHANNEL_SEEDS.entries()) {
      // The first brand keeps Settings.channelName if Krew renamed it (it's the header + watermark name).
      const name = i === 0 && s.channelName && s.channelName !== DEFAULT_CHANNEL ? s.channelName : ch.name;
      await prisma.channel.upsert({ where: { id: ch.id }, update: {}, create: { id: ch.id, name, focus: ch.focus, kinds: ch.kinds, createdAt: new Date(Date.UTC(2026, 10, 19, 0, 0, i)) } });
      made++;
      for (const sa of ch.accounts) {
        const hit = existing.find((a) => !used.has(a.id) && !a.homeChannelId && matchesSeed(a, ch, sa));
        const flags = sa.disabled ? { disabled: true, error: sa.disabled } : {};
        if (hit) {
          used.add(hit.id); matched++;
          await prisma.account.update({ where: { id: hit.id }, data: { homeChannelId: ch.id, handle: hit.handle ?? sa.handle, ...flags } });
          continue;
        }
        const dup = await prisma.account.findFirst({ where: { platform: sa.platform, mode: "manual", handle: sa.handle } });
        if (dup) { if (!dup.homeChannelId) await prisma.account.update({ where: { id: dup.id }, data: { homeChannelId: ch.id } }); continue; }
        await prisma.account.create({
          data: { platform: sa.platform, mode: "manual", handle: sa.handle, channelTitle: sa.handle, username: sa.handle.slice(1), refreshToken: "", homeChannelId: ch.id, ...flags },
        });
        seededAccounts++;
      }
    }
  }
  // Older connected accounts that matched no seed: a free slot of their platform in the first channel, else Krew places them.
  const first = await prisma.channel.findFirst({ orderBy: { createdAt: "asc" } });
  if (first) {
    const accounts = await prisma.account.findMany({ where: { platform: { in: [...POST_PLATFORMS] } }, orderBy: { createdAt: "asc" } });
    for (const p of POST_PLATFORMS) {
      if (slotAccount(accounts, first.id, p)) continue;
      const free = accounts.find((a) => a.platform === p && !a.homeChannelId);
      if (free) { await prisma.account.update({ where: { id: free.id }, data: { homeChannelId: first.id } }); moved++; }
    }
  }
  await prisma.settings.update({ where: { id: "main" }, data: { migratedChannels: true } });
  return `${made ? `made ${made} channels (${CHANNEL_SEEDS.map((c) => c.name).join(", ")}) with ${seededAccounts} by-hand accounts, ${matched} connected accounts matched` : "channels already there"}${moved ? `, ${moved} more put in ${first?.name}` : ""}`;
}

/**
 * After an OAuth connect: an account with no channel goes into the channel Krew connected it from (its slot for that
 * platform), else the first channel whose slot for that platform is free. A taken slot is never overwritten.
 */
export async function assignHomeChannel(accountId: string, wanted?: string | null) {
  await ensureChannels().catch(() => null);
  const a = await prisma.account.findUnique({ where: { id: accountId } });
  if (!a || !isPostingAccount(a)) return null;
  const [channels, accounts] = await Promise.all([
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.account.findMany({ where: { platform: a.platform, id: { not: a.id } } }),
  ]);
  const free = (id: string) => !slotAccount(accounts, id, a.platform);
  if (wanted && channels.some((c) => c.id === wanted) && free(wanted)) {
    await prisma.account.update({ where: { id: a.id }, data: { homeChannelId: wanted } });
    return wanted;
  }
  if (a.homeChannelId) return a.homeChannelId;
  const c = channels.find((x) => free(x.id));
  if (c) await prisma.account.update({ where: { id: a.id }, data: { homeChannelId: c.id } });
  return c?.id ?? null;
}

const clipInclude = { posts: true, moment: { include: { streamer: { include: { campaign: true } } } } } as const;

/**
 * Clips waiting on Upload: APPROVED clips, plus clips already posted through the Upload flow (a post with a channel)
 * that some account of their channel still hasn't got. Old clips posted by hand before v1.9.5 (posts without a channel)
 * never come back. Sorted Supreme picks first, then the Judge's score, then newest.
 */
export async function toPostItems(take = 200) {
  await assignChannels(); // v2.0.1: spread unassigned approved clips over all channels first
  const [channels, accounts, clips] = await Promise.all([
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.account.findMany({ where: { platform: { in: [...POST_PLATFORMS] } }, orderBy: [{ createdAt: "asc" }] }),
    prisma.clip.findMany({
      where: { OR: [{ status: "approved" }, { status: "posted", finalPath: { not: null }, posts: { some: { channelId: { not: null } } } }] },
      include: clipInclude, orderBy: { createdAt: "desc" }, take,
    }),
  ]);
  const items = clips.map((clip) => {
    const channel = channelForClip(channels, { channelId: clip.channelId, category: clip.category ?? clip.moment.category, gta: isGta6(momentGame(clip.moment)) });
    // One account per platform, YouTube first (Krew's rule: what goes on the channel's YouTube goes on its TikTok + Instagram).
    const accs = channel ? POST_PLATFORMS.map((p) => slotAccount(accounts, channel.id, p)).filter((a): a is (typeof accounts)[number] => Boolean(a)) : [];
    return { clip, channel, accounts: accs, rows: accs.map((a) => ({ account: a, post: donePost(clip.posts, a.id) })) };
  }).filter((x) => !isFullyPosted(x.clip.posts, x.accounts.filter((a) => !a.disabled))); // a disabled account (e.g. banned) is not waited for
  return { channels, accounts, items: sortToPost(items) };
}

type Sortable = { clip: { score: number | null; createdAt: Date } & { supremePick?: boolean; supremeRank?: number | null } };
export function sortToPost<T extends Sortable>(items: T[]): T[] {
  const rank = (x: T) => (x.clip.supremePick ? x.clip.supremeRank ?? 99 : 1000);
  return [...items].sort((a, b) => rank(a) - rank(b) || (b.clip.score ?? -1) - (a.clip.score ?? -1) || b.clip.createdAt.getTime() - a.clip.createdAt.getTime());
}

/** Nav badge: approved clips (and v2.0.0 edits) not yet posted to every account of their channel. */
export async function toPostCount() {
  const { toPostEditItems } = await import("./to-post-edits");
  return (await toPostItems()).items.length + (await toPostEditItems().catch(() => ({ items: [] }))).items.length;
}

/**
 * v2.0.1: give every approved clip without a channel one, spread over all channels (`balancedChannel`), and save it on
 * Clip.channelId so the Upload page, auto-post and Supreme agree. Load = clips given to each channel that were approved or
 * posted in the last 24h. Returns how many clips got a channel.
 */
export async function assignChannels(clipIds?: string[]): Promise<number> {
  const channels = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  if (!channels.length) return 0;
  const since = new Date(Date.now() - 24 * 3600_000);
  const counts = await prisma.clip.groupBy({ by: ["channelId"], where: { channelId: { not: null }, status: { in: ["approved", "posted"] }, updatedAt: { gte: since } }, _count: { _all: true } });
  const load: Record<string, number> = {};
  for (const c of counts) if (c.channelId) load[c.channelId] = c._count._all;
  const clips = await prisma.clip.findMany({
    where: { status: "approved", channelId: null, ...(clipIds ? { id: { in: clipIds } } : {}) },
    include: { moment: true }, orderBy: { createdAt: "asc" },
  });
  let n = 0;
  for (const clip of clips) {
    const ch = balancedChannel(channels, { category: clip.category ?? clip.moment.category, gta: isGta6(momentGame(clip.moment)) }, load);
    if (!ch) continue;
    await prisma.clip.update({ where: { id: clip.id }, data: { channelId: ch.id } });
    load[ch.id] = (load[ch.id] ?? 0) + 1;
    n++;
  }
  return n;
}
