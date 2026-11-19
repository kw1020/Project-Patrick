// v1.9.5 Channels + Upload: database side (the one-time channel migration and the Upload list).
import { getSettings, prisma } from "./db";
import { DEFAULT_CHANNEL } from "./campaigns";
import { isGta6, momentGame } from "./social";
import { autoPostTargets, balancedChannel, channelBlurb, channelForClip, parseChannelStyle, donePost, isAutoUploadAccount, isFullyPosted, isPostingAccount, parseFocus, parseKinds, PLATFORM_LABEL, POST_PLATFORMS, slotAccount, validChannelPick } from "./channels";
import { enqueuePost } from "./queues";
import { parsePlatformInfo, platformCheck } from "./platform-rules";
import { captionCredits } from "./social";
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
      await prisma.channel.upsert({ where: { id: ch.id }, update: {}, create: { id: ch.id, name, focus: ch.focus, kinds: ch.kinds, editStyle: seedEditStyle(ch, s.editStyle), createdAt: new Date(Date.UTC(2026, 10, 19, 0, 0, i)) } });
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
 * v2.0.6: a seeded channel's own editing style. ViceCityClips (the first brand) takes whatever Settings → Editing style is now
 * (hype unless Krew changed it, so its clips look the same as before); the others get their seed (StreamHeistClips meme,
 * WantedLevelClips clean); ClipFactoryGG (edits only) none.
 */
export function seedEditStyle(ch: { id: string; editStyle?: string }, current: string | null | undefined): string | null {
  if (ch.id === FIRST_CHANNEL_ID) return parseChannelStyle(current) ?? ch.editStyle ?? null;
  return ch.editStyle ?? null;
}

/**
 * v2.0.6 one-time (Settings.migratedChannelStyles): Krew's seeded channels that still have no editing style get theirs
 * (`seedEditStyle`). Only the seeded ids, only when still null, so a style Krew picked (or a channel he made) is never touched.
 */
export async function migrateChannelStyles(): Promise<string | null> {
  const s = await getSettings();
  if (s.migratedChannelStyles) return null;
  const set: string[] = [];
  for (const ch of CHANNEL_SEEDS) {
    const style = seedEditStyle(ch, s.editStyle);
    if (!style) continue;
    const r = await prisma.channel.updateMany({ where: { id: ch.id, editStyle: null }, data: { editStyle: style } });
    if (r.count) set.push(`${ch.id} ${style}`);
  }
  await prisma.settings.update({ where: { id: "main" }, data: { migratedChannelStyles: true } });
  return set.length ? `channel editing styles set: ${set.join(", ")}` : "channel editing styles kept";
}

/**
 * After an OAuth connect: an account with no channel goes into the channel Krew connected it from (its slot for that
 * platform), else the first channel whose slot for that platform is free. A slot taken by a connected account is never
 * overwritten; a by-hand account in the wanted slot is replaced (v2.0.3, its posts kept).
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
  // v2.0.3: connecting into a slot held by a BY-HAND account (Krew's seeded handles) replaces it: its posts move to the
  // connected account (so Upload/Posted keep them), then the by-hand row goes. A connected (api) account is never replaced.
  const held = wanted && channels.some((c) => c.id === wanted) ? slotAccount(accounts, wanted, a.platform) : null;
  if (held && held.mode === "manual" && a.mode === "api") {
    await prisma.post.updateMany({ where: { accountId: held.id }, data: { accountId: a.id } });
    await prisma.editPost.updateMany({ where: { accountId: held.id }, data: { accountId: a.id } });
    await prisma.account.delete({ where: { id: held.id } });
    accounts.splice(accounts.indexOf(held), 1);
  }
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
  const load = await channelLoad();
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

/**
 * v2.0.1/v2.0.6: clips each channel got recently (last 24h): ones on their way to review, waiting for review, approved or
 * posted. Used to spread clips fairly over all channels (balancedChannel) and shown to the Judge.
 */
export async function channelLoad(): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const counts = await prisma.clip.groupBy({
    by: ["channelId"], where: { channelId: { not: null }, status: { in: ["processing", "pending", "approved", "posted"] }, updatedAt: { gte: since } }, _count: { _all: true },
  });
  const load: Record<string, number> = {};
  for (const c of counts) if (c.channelId) load[c.channelId] = c._count._all;
  return load;
}

/**
 * v2.0.6 (Krew: "the judge just determines what channel it should go to"): the channel a clip goes to, decided BEFORE the cut
 * so it's cut in that channel's style. Krew's own pick (Clip.channelId) always stays. Else the Judge's pick when it passes the
 * routing rules (`validChannelPick`), else `balancedChannel` over the recent load so every channel gets a fair share.
 * Saved on Clip.channelId. Returns the channel (null = no channels / nothing fits) and how it was chosen.
 */
export async function pickClipChannel(clipId: string, judgePick?: string | null): Promise<{ channel: Awaited<ReturnType<typeof prisma.channel.findMany>>[number] | null; how: "krew" | "judge" | "balanced" | "none" }> {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: true } });
  const channels = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  if (!clip || !channels.length) return { channel: null, how: "none" };
  const kept = clip.channelId ? channels.find((c) => c.id === clip.channelId) : null;
  if (kept) return { channel: kept, how: "krew" };
  const info = { category: clip.category ?? clip.moment.category, gta: isGta6(momentGame(clip.moment)) };
  const judged = validChannelPick(channels, info, judgePick);
  const ch = judged ?? balancedChannel(channels, info, await channelLoad());
  if (!ch) return { channel: null, how: "none" };
  await prisma.clip.update({ where: { id: clipId }, data: { channelId: ch.id } });
  return { channel: ch, how: judged ? "judge" : "balanced" };
}

/** The channel list + recent load the Judge gets in its message (name, focus, types, a one-line description, clips today). */
export async function judgeChannelList() {
  const [channels, load] = await Promise.all([prisma.channel.findMany({ orderBy: { createdAt: "asc" } }), channelLoad()]);
  return channels.map((c) => ({ name: c.name, focus: parseFocus(c.focus), kinds: parseKinds(c.kinds).join(", "), about: channelBlurb(c), recent: load[c.id] ?? 0 }));
}

async function queueUpload(clipId: string, accountId: string) {
  await prisma.clip.update({ where: { id: clipId }, data: { stage: "post", stageAt: new Date(), postError: null } });
  await enqueuePost(clipId, accountId);
}

/**
 * v2.0.6: "Upload" = every connected account of the channel that doesn't have the clip yet (YouTube upload, TikTok
 * draft or direct post, Instagram Reel since v2.0.3; single attempt each; disabled accounts and broken logins skipped). By-hand accounts are listed
 * for the Download + copy caption checklist. Shared by the Upload button (v1.9.5 Post to all) and Approve when
 * Settings.approveUploads is on. A hard fail in the Platform check queues nothing: the button gets an error, an approve gets
 * it as Clip.postError (the clip stays approved).
 */
export async function uploadToChannel(clipId: string, channelId: string, via: "button" | "approve" = "button"): Promise<{ queued: string[]; byHand: string[]; blocked: string | null }> {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId }, include: { posts: true, moment: { include: { streamer: true } } } });
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Approve the clip first");
  const accounts = await prisma.account.findMany({ where: { homeChannelId: channelId, platform: { in: [...POST_PLATFORMS] } }, orderBy: { createdAt: "asc" } });
  const slots = POST_PLATFORMS.map((p) => slotAccount(accounts, channelId, p)).filter((a): a is (typeof accounts)[number] => Boolean(a));
  const queued: string[] = [], byHand: string[] = [], toQueue: string[] = [];
  for (const a of slots) {
    if (a.disabled || donePost(clip.posts, a.id)) continue; // disabled (e.g. Instagram banned it): skipped
    const label = `${PLATFORM_LABEL[a.platform]} ${a.handle ?? a.channelTitle ?? ""}`.trim();
    if (isAutoUploadAccount(a)) { toQueue.push(a.id); queued.push(label); } else byHand.push(label);
  }
  // v1.9.8: a hard fail in the Platform check blocks the upload (plain-English reasons; the Poster checks per platform too).
  const pc = platformCheck({ caption: clip.caption || clip.title || "", title: clip.title, creditOk: captionCredits(clip.caption || "", clip.moment.streamer), info: parsePlatformInfo(clip.platformInfo) });
  if (pc.fails && (via === "button" || toQueue.length)) {
    const why = `${pc.items.filter((i) => i.level === "fail").map((i) => i.text).join("; ")}`;
    if (via === "button") throw new Error(`Not posted. ${why}`);
    await prisma.clip.update({ where: { id: clipId }, data: { postError: `Not uploaded. Platform check failed: ${why}`.slice(0, 1000) } });
    return { queued: [], byHand, blocked: why };
  }
  for (const id of toQueue) await queueUpload(clipId, id);
  return { queued, byHand, blocked: null };
}

/** v2.0.6: short-lived cookie (next to cf_channel) holding "upload:<clipId>" while Krew connects YouTube from a clip's button. */
export const THEN_COOKIE = "cf_then";
export function parseThen(v: string | null | undefined): { clipId: string } | null {
  const m = /^upload:([A-Za-z0-9_-]{1,64})$/.exec(String(v ?? ""));
  return m ? { clipId: m[1] } : null;
}

/**
 * v2.0.6: after "Upload to YouTube (connect first)" / "Reconnect + upload" came back from Google: upload that clip to its
 * channel (the same `uploadToChannel` as the Upload button: approved only, single attempt, Platform check). Returns a plain
 * line for the Upload page. Never throws.
 */
export async function uploadAfterConnect(clipId: string, homeChannelId: string | null): Promise<string> {
  try {
    const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: true } });
    if (!clip) return "That clip is gone, so nothing was uploaded.";
    if (clip.status !== "approved" && clip.status !== "posted") return "The clip isn't approved yet, so nothing was uploaded. Approve it, then press Upload.";
    const channels = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
    const channel = channelForClip(channels, { channelId: clip.channelId, category: clip.category ?? clip.moment.category, gta: isGta6(momentGame(clip.moment)) });
    if (!channel) return "The clip has no channel, so nothing was uploaded. Use Move to… first.";
    if (homeChannelId !== channel.id) {
      const where = channels.find((c) => c.id === homeChannelId)?.name;
      return `That YouTube went into ${where ?? "no channel"} (${channel.name}'s YouTube slot is taken), so the clip wasn't uploaded. Check Settings → Channels.`;
    }
    const r = await uploadToChannel(clipId, channel.id, "button");
    return r.queued.length ? `Uploading to ${r.queued.join(", ")}…` : "Nothing left to upload on that channel.";
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * v2.0.6: what approving a clip uploads. Settings.approveUploads on → `uploadToChannel` for the clip's channel. Off → the
 * v1.9.7 per-account "Post when I approve" (only that channel's accounts). No channels at all → every auto account (old).
 */
export async function uploadOnApprove(clipId: string): Promise<{ queued: string[]; byHand: string[]; blocked: string | null }> {
  const s = await getSettings();
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId }, include: { moment: true } });
  const channels = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  const channel = channelForClip(channels, { channelId: clip.channelId, category: clip.category ?? clip.moment.category, gta: isGta6(momentGame(clip.moment)) });
  if (s.approveUploads && channel) return uploadToChannel(clipId, channel.id, "approve");
  const auto = await prisma.account.findMany({ where: { autoPost: true, error: null, disabled: false, mode: "api", platform: { in: [...POST_PLATFORMS] } } }); // v2.0.3: + Instagram
  const targets = autoPostTargets(auto, channels.length ? channel?.id ?? null : undefined);
  for (const a of targets) await queueUpload(clipId, a.id);
  return { queued: targets.map((a) => `${PLATFORM_LABEL[a.platform]} ${a.handle ?? a.channelTitle ?? ""}`.trim()), byHand: [], blocked: null };
}
