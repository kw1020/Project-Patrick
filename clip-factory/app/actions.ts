"use server";

import fs from "node:fs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { enqueueCut, enqueueGrab, enqueuePost, enqueueQa, enqueueTranscribe, pokeScout, pokeSuggest, pokeSupreme, pokeYouTube, pokeYouTubeFind } from "@/lib/queues";
import { fixPlan, parseQa } from "@/lib/qa";
import { brokenVideo, probeDuration } from "@/lib/media";
import { resolveStored } from "@/lib/paths";
import { resolveChannel } from "@/lib/ytdlp";
import { getUsers, twitchConfigured } from "@/lib/twitch";
import { parseFacecam } from "@/lib/media";
import { parseEditStyle, parseJumpCuts, parseLayoutSetting } from "@/lib/edit-styles";
import { approvalReasonFromEvidence } from "@/lib/permission";
import { loginTakenBy } from "@/lib/streamers";
import { parseCampaignForm, parseChannelName, parseLink } from "@/lib/campaigns";
import { brandedCaption, captionHashtags, cleanExtras, defaultExtras, defaultTitle, momentGame } from "@/lib/social";
import { assignChannels, uploadOnApprove, uploadToChannel } from "@/lib/to-post";
import { cleanUpQueue } from "@/lib/queue-clean";
import { CHANNEL_KINDS, parseChannelLayout, parseChannelStyle, PLATFORM_LABEL, POST_PLATFORMS, donePost, isApiPostingAccount, isPostingAccount, kindsString, parseChannelLabel, parseFocus, parseHandle, slotAccount } from "@/lib/channels";
import { parseBpm, parseLength, parseVibe } from "@/lib/edit-vibes";
import { approveResolved, DEFAULT_APPROVAL_NOTE, resolveCreators, type ApprovePick, type ApproveResult, type ResolveResult } from "@/lib/creator-lookup";

function refreshAll() {
  try {
    for (const p of ["/", "/queue", "/upload", "/workroom", "/edits", "/posted", "/analytics", "/streamers", "/creators", "/settings"]) revalidatePath(p);
  } catch {
    /* called outside a Next.js request (tests, scripts): no pages to refresh */
  }
}

// ---------- Streamers ----------
export async function addStreamer(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const raw = String(form.get("login") || "").trim();
  const login = raw.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/[/?#].*$/, "").toLowerCase();
  const note = String(form.get("note") || "").trim();
  if (!/^[a-z0-9_]{3,25}$/.test(login)) return { error: "That doesn't look like a Twitch username." };
  if (!twitchConfigured()) return { error: "Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env first." };
  const [u] = await getUsers({ logins: [login] });
  if (!u) return { error: `No Twitch user called "${login}".` };
  // Only the same platform can clash: a YouTube channel with this name is fine (since v1.7.1).
  if (await loginTakenBy("twitch", u.login, u.id))
    return { error: `${u.display_name} not added: another Twitch account in Clip Factory already uses the name "${u.login}" (probably an old name change).` };
  await prisma.streamer.upsert({
    where: { twitchId: u.id },
    update: { approved: true, approvedAt: new Date(), approvalNote: note || DEFAULT_APPROVAL_NOTE, login: u.login, name: u.display_name, profileImage: u.profile_image_url },
    create: { twitchId: u.id, login: u.login, name: u.display_name, profileImage: u.profile_image_url, approved: true, approvedAt: new Date(), approvalNote: note || DEFAULT_APPROVAL_NOTE },
  });
  await pokeScout().catch(() => {});
  refreshAll();
  return { ok: `${u.display_name} approved. Looking for their clips now.` };
}

/** Approve a YouTube channel (@handle or channel link). Resolved with yt-dlp; no API key needed. */
export async function addYouTubeChannel(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const input = String(form.get("channel") || "").trim();
  const note = String(form.get("note") || "").trim();
  if (!input) return { error: "Paste the channel's @handle or link." };
  let ch;
  try {
    ch = await resolveChannel(input);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const twitchId = `yt:${ch.channelId}`;
  // Only another YouTube channel can clash: a Twitch streamer with the same name is fine (since v1.7.1).
  if (await loginTakenBy("youtube", ch.handle, twitchId)) return { error: `A YouTube channel called "${ch.handle}" is already in the list.` };
  await prisma.streamer.upsert({
    where: { twitchId },
    update: { approved: true, approvedAt: new Date(), approvalNote: note || DEFAULT_APPROVAL_NOTE, login: ch.handle, name: ch.title, profileImage: ch.avatar, platform: "youtube" },
    create: { twitchId, platform: "youtube", login: ch.handle, name: ch.title, profileImage: ch.avatar, approved: true, approvedAt: new Date(), approvalNote: note || DEFAULT_APPROVAL_NOTE },
  });
  await pokeYouTube().catch(() => {});
  refreshAll();
  return { ok: `${ch.title} (youtube.com/@${ch.handle}) approved. Scanning their newest videos now.` };
}

/**
 * The one approve/unapprove path. Approving needs no reason (Krew's call, 2026-11-17): the note stored is the typed one,
 * else the permission quote from their suggestion card when there was one, else "Approved by Krew".
 */
export async function setApproved(id: string, approved: boolean, note?: string) {
  const data: { approved: boolean; approvalNote?: string; approvedAt?: Date } = { approved, ...(approved ? { approvedAt: new Date() } : {}) };
  const typed = typeof note === "string" ? note.trim().slice(0, 500) : "";
  if (typed) data.approvalNote = typed;
  else if (approved) {
    const sug = await prisma.suggestion.findUnique({ where: { streamerId: id }, select: { evidence: true, evidenceSource: true } });
    data.approvalNote = (sug && approvalReasonFromEvidence(sug)) || DEFAULT_APPROVAL_NOTE;
  }
  const s = await prisma.streamer.update({ where: { id }, data });
  if (approved) await (s.platform === "youtube" ? pokeYouTube() : pokeScout()).catch(() => {});
  refreshAll();
}

/** One-click Approve (Live page, "Found by the Scout" list). */
export async function approveStreamer(id: string) {
  await setApproved(id, true);
}

// ---------- Add a list of creators ----------
/** Look up every name (one per line) on Twitch and YouTube. Never approves anything. */
export async function findCreators(text: string): Promise<ResolveResult> {
  return resolveCreators(String(text ?? "").split(/\r?\n/));
}

/** Approve the ticked matches from the "Add a list of creators" table (Krew's click). */
export async function approveCreators(picks: ApprovePick[], note?: string): Promise<ApproveResult> {
  const r = await approveResolved(Array.isArray(picks) ? picks : [], String(note ?? "").trim().slice(0, 500) || DEFAULT_APPROVAL_NOTE);
  if (r.twitchApproved) await pokeScout().catch(() => {});
  if (r.youtubeApproved) await pokeYouTube().catch(() => {});
  refreshAll();
  return r;
}

export async function saveStreamer(id: string, form: FormData) {
  const note = String(form.get("note") || "").trim();
  const facecamRaw = String(form.get("facecam") || "").trim();
  const facecam = facecamRaw ? parseFacecam(facecamRaw) : null;
  if (facecamRaw && !facecam) throw new Error("Facecam must be 4 numbers between 0 and 1: x,y,width,height");
  await prisma.streamer.update({ where: { id }, data: { approvalNote: note || null, facecam: facecam ? facecamRaw : null } });
  refreshAll();
}

export async function removeStreamer(id: string) {
  await prisma.streamer.update({ where: { id }, data: { approved: false, approvalNote: null, paused: false } });
  refreshAll();
}

/** Creators page: Pause keeps the creator approved but the clips poller, spike detector and YouTube scanner skip them. */
export async function setPaused(id: string, paused: boolean) {
  const s = await prisma.streamer.update({ where: { id }, data: { paused } });
  if (!paused && s.approved) await (s.platform === "youtube" ? pokeYouTube() : pokeScout()).catch(() => {});
  refreshAll();
}

// ---------- Suggestions ----------
// The scanner only suggests. Approving is Krew's click (a note is optional), through setApproved like any other approval.
// No note → setApproved stores the card's permission quote when there is one, else "Approved by Krew".
export async function approveSuggestion(id: string, _prev: { error?: string; ok?: string } | null, form?: FormData) {
  const note = String(form?.get("note") || "").trim();
  const sug = await prisma.suggestion.findUnique({ where: { id }, include: { streamer: true } });
  if (!sug) return { error: "That suggestion is gone (the list refreshed). Reload the page." };
  const yt = sug.streamer.platform === "youtube";
  if (!yt && sug.streamer.platform !== "twitch") return { error: "This kind of channel can't be approved from here." };
  if (yt && !sug.streamer.twitchId.startsWith("yt:")) return { error: "That YouTube channel's record looks wrong. Add it with “Add a YouTube channel” instead." };
  // Same path as every approval: setApproved pokes the Scout (Twitch) or the YouTube scanner (YouTube).
  await setApproved(sug.streamerId, true, note.slice(0, 500));
  await prisma.suggestion.update({ where: { id }, data: { status: "approved" } });
  // v2.0.8: a YouTube scout card ("maybe the YouTube of Twitch @x"): approving it links the two on the Creators page.
  if (yt && sug.linkedFromId) {
    const tw = await prisma.streamer.findUnique({ where: { id: sug.linkedFromId }, select: { id: true, platform: true, youtubeId: true } });
    if (tw?.platform === "twitch") {
      await prisma.streamer.update({ where: { id: sug.streamerId }, data: { linkedFromId: tw.id } });
      if (!tw.youtubeId) await prisma.streamer.update({ where: { id: tw.id }, data: { youtubeId: sug.streamerId } });
    }
  }
  refreshAll();
  return { ok: yt ? `${sug.streamer.name} approved. Scanning their newest videos now.` : `${sug.streamer.name} approved. Looking for their clips now.` };
}

export async function dismissSuggestion(id: string) {
  await prisma.suggestion.update({ where: { id }, data: { status: "dismissed", dismissedUntil: new Date(Date.now() + 30 * 86_400_000) } });
  refreshAll();
}

/** v2.0.8 Streamers page "Find YouTube channels now": the YouTube scout runs right away (then the YouTube scanner). */
export async function findYouTubeChannelsNow() {
  await pokeYouTubeFind();
  refreshAll();
}

export async function scanSuggestionsNow() {
  await pokeSuggest();
  refreshAll();
}

// ---------- Clips ----------
export async function updateClipText(id: string, title: string, caption: string) {
  await prisma.clip.update({ where: { id }, data: { title: title.slice(0, 100), caption: caption.slice(0, 2200) } });
  revalidatePath("/queue");
}

export async function setClipStatus(id: string, status: "pending" | "approved" | "rejected") {
  await prisma.clip.update({ where: { id }, data: { status } });
  // Approving is the human sign-off. v2.0.6: with Settings "Approve uploads" on (default) it uploads to every connected account
  // of the clip's channel (its YouTube + TikTok + Instagram; by-hand ones wait on Upload). Off = the per-account "Post when
  // I approve" ticks (v1.9.7: only accounts of THIS clip's channel, so a GTA clip never goes to all 4 YouTubes).
  if (status === "approved") {
    await assignChannels([id]); // v2.0.1: a clip that still has no channel gets one (saved on Clip.channelId)
    await uploadOnApprove(id);
  }
  refreshAll();
}

/** v2.0.6 Queue "Clean up queue": pending clips below the min score or never scored → rejected. Returns how many. */
export async function cleanUpQueueNow(): Promise<number> {
  const n = await cleanUpQueue();
  refreshAll();
  return n;
}

async function queueUpload(clipId: string, accountId: string) {
  await prisma.clip.update({ where: { id: clipId }, data: { stage: "post", stageAt: new Date(), postError: null } });
  await enqueuePost(clipId, accountId);
}

/** Manual "send to <account>" on an approved clip. */
export async function postToAccount(clipId: string, accountId: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId } });
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Approve the clip first");
  const acct = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acct) throw new Error("That account was disconnected");
  if (!isApiPostingAccount(acct)) throw new Error("That account is posted to by hand: use Download + copy caption, then Mark posted");
  await queueUpload(clipId, accountId);
  refreshAll();
}

export async function retryClip(id: string) {
  let clip = await prisma.clip.findUniqueOrThrow({ where: { id } });
  // v2.0.10: a broken raw (download cut off by a restart) is downloaded again instead of failing the same way forever.
  if (clip.rawPath) {
    const abs = (() => { try { return resolveStored(clip.rawPath!); } catch { return null; } })();
    if (!abs || !fs.existsSync(abs) || (await brokenVideo(abs))) {
      if (abs) fs.rmSync(abs, { force: true });
      clip = await prisma.clip.update({ where: { id }, data: { rawPath: null, words: null } });
    }
  }
  const stage = !clip.rawPath ? "grab" : clip.words == null ? "transcribe" : "cut";
  await prisma.clip.update({ where: { id }, data: { status: "processing", error: null, stage, stageAt: new Date() } });
  if (stage === "grab") await enqueueGrab(clip.momentId, id);
  else if (stage === "transcribe") await enqueueTranscribe(id);
  else await enqueueCut(id);
  refreshAll();
}

/**
 * Re-cut a clip in another editing style (Queue card "Re-cut"). Needs the raw video (deleted 12h after the cut).
 * The review status stays as it is (the cutter only decides review/auto-reject on a clip's first cut).
 */
/** Queue card "Re-cut": another editing style, optionally without jump cuts and/or in another layout (v1.9.0; "auto" = decide again). */
export async function recutClip(id: string, style: string, jumpCuts?: string, layout?: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id } });
  if (!clip.rawPath) throw new Error("The original video is gone (deleted to save space), so this clip can't be re-cut.");
  if (clip.words == null) return retryClip(id); // never transcribed: run the whole line again
  const s = parseEditStyle(style);
  await prisma.clip.update({ where: { id }, data: { stage: "cut", stageAt: new Date(), error: null, ...(clip.status === "failed" ? { status: "processing" } : {}) } });
  await enqueueCut(id, 1, s, jumpCuts ? parseJumpCuts(jumpCuts) : undefined, layout ? parseLayoutSetting(layout) : undefined);
  refreshAll();
}

/** Streamers / Creators: forget the webcam spot found automatically (the next clip looks for it again). */
export async function resetFacecamAuto(id: string) {
  await prisma.streamer.update({ where: { id }, data: { facecamAuto: null } });
  refreshAll();
}

export async function markPosted(id: string, form: FormData) {
  const platform = String(form.get("platform") || "tiktok");
  const url = String(form.get("url") || "").trim() || null;
  // v1.9.1: optional Whop campaign link; the post is tagged with the creator's campaign.
  const campaignLink = parseLink(form.get("campaignLink"));
  const clip = await prisma.clip.findUnique({ where: { id }, select: { moment: { select: { streamer: { select: { campaignId: true } } } } } });
  await prisma.post.create({ data: { clipId: id, platform, url, campaignLink, campaignId: clip?.moment.streamer.campaignId ?? null } });
  await prisma.clip.update({ where: { id }, data: { status: "posted" } });
  refreshAll();
}

export async function updatePost(id: string, form: FormData) {
  const v = String(form.get("views") || "").replace(/[^0-9]/g, "");
  const url = String(form.get("url") || "").trim();
  const extra: { campaignLink?: string | null; campaignId?: string | null } = {};
  if (form.get("campaignLink") != null) extra.campaignLink = parseLink(form.get("campaignLink"));
  if (form.get("campaignId") != null) {
    const cid = String(form.get("campaignId") || "");
    extra.campaignId = cid && (await prisma.campaign.findUnique({ where: { id: cid } })) ? cid : null;
  }
  // v1.9.5: views are only typed in for posts made by hand; the Posted page leaves the field out for synced ones.
  const views = form.get("views") != null ? { views: v ? parseInt(v) : null } : {};
  await prisma.post.update({ where: { id }, data: { ...views, url: url || null, ...extra } });
  try { revalidatePath("/posted"); } catch { /* outside a Next.js request (tests) */ }
}

// ---------- Campaigns (v1.9.1, Whop Content Rewards) ----------
export async function createCampaign(form: FormData) {
  const c = await prisma.campaign.create({ data: parseCampaignForm(form) });
  refreshAll();
  return c.id;
}

export async function saveCampaign(id: string, form: FormData) {
  await prisma.campaign.update({ where: { id }, data: parseCampaignForm(form) });
  refreshAll();
}

/** Creators on it go back to "None" (onDelete SetNull); posts keep their campaign link. */
export async function deleteCampaign(id: string) {
  await prisma.campaign.delete({ where: { id } });
  refreshAll();
}

/** Streamers / Creators "Campaign" select: an id, "" = none, "new" = a new campaign named after the creator. */
export async function setStreamerCampaign(streamerId: string, value: string) {
  let campaignId: string | null = value || null;
  if (value === "new") {
    const s = await prisma.streamer.findUniqueOrThrow({ where: { id: streamerId } });
    campaignId = (await prisma.campaign.create({ data: { name: `${s.name} campaign`, requiredText: `@${s.login}` } })).id;
  } else if (campaignId && !(await prisma.campaign.findUnique({ where: { id: campaignId } }))) {
    throw new Error("That campaign was deleted");
  }
  await prisma.streamer.update({ where: { id: streamerId }, data: { campaignId } });
  refreshAll();
  return campaignId;
}

/** Queue card "Rebuild caption": the ViceCityClips format again from the hook, with the creator's campaign rules now. */
export async function rebuildCaption(clipId: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId }, include: { moment: { include: { streamer: { include: { campaign: true } } } } } });
  const s = clip.moment.streamer, game = momentGame(clip.moment), category = clip.category ?? clip.moment.category;
  const caption = brandedCaption({
    hook: clip.hookText || clip.title, fallbackHook: defaultTitle(clip.moment.sourceTitle, s.name, game), streamer: s, campaign: s.campaign,
    extras: cleanExtras((clip.hashtags || "").split(/\s+/), defaultExtras(category, game)), category, game,
  });
  await prisma.clip.update({ where: { id: clipId }, data: { caption, hashtags: captionHashtags(caption) } });
  refreshAll();
  return caption;
}

// ---------- Settings / control ----------
export async function saveSettings(form: FormData) {
  const n = (k: string, min: number, max: number, def: number) => {
    const v = Number(form.get(k));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  const clipMinSec = Math.round(n("clipMinSec", 5, 59, 15));
  const clipMaxSec = Math.max(clipMinSec, Math.round(n("clipMaxSec", 10, 59, 35)));
  await prisma.settings.upsert({
    where: { id: "main" },
    create: { id: "main" },
    update: {
      spikeMultiplier: n("spikeMultiplier", 1.5, 10, 3),
      minScore: n("minScore", 1, 10, 7),
      clipMinSec, clipMaxSec,
      minClipViews: Math.round(n("minClipViews", 0, 100000, 25)),
      // Shown in days since v1.8.0 (1-30); an old form posting hours still works.
      clipLookbackHrs: form.get("clipLookbackDays") != null ? Math.round(n("clipLookbackDays", 1, 30, 7) * 24) : Math.round(n("clipLookbackHrs", 1, 720, 168)),
      standoutMin: Math.round(n("standoutMin", 1, 20, 2) * 10) / 10,
      maxPerCreatorPerRun: Math.round(n("maxPerCreatorPerRun", 1, 15, 2)),
      maxPerCreatorPerHour: Math.round(n("maxPerCreatorPerHour", 1, 30, 3)), // v1.9.8
      jumpCuts: parseJumpCuts(form.get("jumpCuts")),
      layout: parseLayoutSetting(form.get("layout")),
      captions: form.get("captions") === "on",
      scoutPaused: form.get("scoutPaused") === "on",
      gameMode: form.get("gameMode") === "gta6" ? "gta6" : "any",
      clipFunny: form.get("clipFunny") === "on",
      clipGaming: form.get("clipGaming") === "on",
      ytScanEnabled: form.get("ytScanEnabled") === "on",
      ytVideosPerChannel: Math.round(n("ytVideosPerChannel", 1, 15, 3)),
      ytMomentsPerVideo: Math.round(n("ytMomentsPerVideo", 1, 10, 3)),
      ytMaxVideoAgeDays: Math.round(n("ytMaxVideoAgeDays", 1, 365, 14)),
      ytSuggestRegion: /^[A-Za-z]{2}$/.test(String(form.get("ytSuggestRegion") || "").trim()) ? String(form.get("ytSuggestRegion")).trim().toUpperCase() : "US",
      spikeEnabled: form.get("spikeEnabled") === "on",
      judgeEnabled: form.get("judgeEnabled") === "on",
      judgeLearns: form.get("judgeLearns") === "on",
      editStyle: parseEditStyle(form.get("editStyle")),
      // v1.9.1 branding. An old form without the field keeps the name.
      ...(form.get("channelName") != null ? { channelName: parseChannelName(form.get("channelName")) } : {}),
      watermark: form.get("watermark") === "on",
      // v2.0.6: only when the form has the Upload card (an older form can't switch it off by leaving it out).
      ...(form.get("approveUploadsShown") != null ? { approveUploads: form.get("approveUploads") === "on" } : {}),
      // v1.9.6 Supreme Judge (an old form without the fields keeps the values).
      ...(form.get("supremePerChannel") != null ? { supremePerChannel: Math.round(n("supremePerChannel", 1, 20, 5)) } : {}),
      ...(form.get("supremeDailyDollars") != null ? { supremeDailyCents: Math.round(n("supremeDailyDollars", 0, 50, 0.25) * 100) } : {}),
      // v2.0.0 Edits card (only when the form has it, so an older form can't reset these)
      ...(form.get("editVibe") != null ? {
        editVibe: parseVibe(form.get("editVibe")), editBpm: parseBpm(form.get("editBpm")), editLength: parseLength(form.get("editLength")),
        editCreatorAudio: form.get("editCreatorAudio") === "on", editAuto: form.get("editAuto") === "on",
      } : {}),
    },
  });
  refreshAll();
}

export async function runScoutNow() {
  await pokeScout();
  refreshAll();
}

export async function saveAccount(id: string, form: FormData) {
  const privacy = String(form.get("privacy") || "public");
  await prisma.account.update({
    where: { id },
    data: { autoPost: form.get("autoPost") === "on", privacy: ["public", "unlisted", "private"].includes(privacy) ? privacy : "public", directPost: form.get("directPost") === "on" },
  });
  refreshAll();
}

/** Posts made through this account stay on the Posted page; they just stop syncing. */
export async function disconnectAccount(id: string) {
  await prisma.account.delete({ where: { id } });
  refreshAll();
}

// ---------- Channels + Upload (v1.9.5) ----------
function readKinds(form: FormData) {
  return kindsString(CHANNEL_KINDS.map((k) => k.key).filter((k) => form.get(`kind_${k}`) === "on"));
}

export async function createChannel(_prev: { error?: string; ok?: string } | null, form: FormData): Promise<{ error?: string; ok?: string; id?: string }> {
  const name = parseChannelLabel(form.get("name"));
  if (!name) return { error: "Give the channel a name" };
  const focus = parseFocus(form.get("focus"));
  const kinds = readKinds(form);
  // A GTA channel takes every type of GTA 6 clip unless Krew unticks some.
  const c = await prisma.channel.create({ data: { name, focus, kinds: kinds.length ? kinds.join(",") : focus === "gta" ? "gaming,funny,edits" : "gaming,funny" } });
  refreshAll();
  return { ok: `Made ${name}. Now connect or add its YouTube, TikTok and Instagram below.`, id: c.id };
}

export async function saveChannel(id: string, form: FormData) {
  const name = parseChannelLabel(form.get("name"));
  await prisma.channel.update({
    where: { id },
    data: {
      ...(name ? { name } : {}), ...(form.get("focus") != null ? { focus: parseFocus(form.get("focus")) } : {}), kinds: readKinds(form).join(","),
      // v2.0.6 per-channel editing ("" = use the Settings default). An older form without the fields keeps them.
      ...(form.get("editStyle") != null ? { editStyle: parseChannelStyle(form.get("editStyle")) } : {}),
      ...(form.get("layout") != null ? { layout: parseChannelLayout(form.get("layout")) } : {}),
      ...(form.get("captionStyle") != null ? { captionStyle: parseChannelStyle(form.get("captionStyle")) } : {}),
    },
  });
  refreshAll();
}

/** Its accounts become "not in a channel" (Krew places them again); posts keep their channel id. */
export async function deleteChannel(id: string) {
  const all = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  if (all.length <= 1) throw new Error("Keep at least one channel");
  await prisma.account.updateMany({ where: { homeChannelId: id }, data: { homeChannelId: null } });
  await prisma.clip.updateMany({ where: { channelId: id }, data: { channelId: null } });
  await prisma.channel.delete({ where: { id } });
  refreshAll();
}

/**
 * "Add handle" (one form: platform + handle + channel, then "Add another"). A by-hand account: Krew downloads the clip
 * and posts it himself, then presses Mark posted. A channel has one slot per platform: a taken slot is refused (remove that
 * account first). The same handle on the same platform is moved, not added twice.
 */
export async function addManualAccount(_prev: { error?: string; ok?: string } | null, form: FormData): Promise<{ error?: string; ok?: string }> {
  const platform = String(form.get("platform") || "");
  if (!(POST_PLATFORMS as readonly string[]).includes(platform)) return { error: "Pick YouTube, TikTok or Instagram" };
  const handle = parseHandle(form.get("handle"));
  if (!handle) return { error: "That doesn't look like a handle (letters, numbers, . _ -)" };
  const channelId = String(form.get("channelId") || "");
  const channel = channelId ? await prisma.channel.findUnique({ where: { id: channelId } }) : await prisma.channel.findFirst({ orderBy: { createdAt: "asc" } });
  if (!channel) return { error: "Make a channel first" };
  const accounts = await prisma.account.findMany({ where: { platform } });
  const same = accounts.find((a) => a.mode === "manual" && (a.handle ?? "").toLowerCase() === handle.toLowerCase());
  const taken = slotAccount(accounts.filter((a) => a.id !== same?.id), channel.id, platform);
  if (taken) return { error: `${channel.name} already has a ${PLATFORM_LABEL[platform]} account (${taken.handle ?? taken.channelTitle}). Remove it first.` };
  if (same) {
    await prisma.account.update({ where: { id: same.id }, data: { homeChannelId: channel.id } });
    refreshAll();
    return { ok: `${handle} (${PLATFORM_LABEL[platform]}) moved to ${channel.name}` };
  }
  await prisma.account.create({
    data: { platform, mode: "manual", handle, channelTitle: handle, username: handle.slice(1), refreshToken: "", homeChannelId: channel.id },
  });
  refreshAll();
  return { ok: `Added ${handle} (${PLATFORM_LABEL[platform]}) to ${channel.name}` };
}

/** Move an account to a channel ("" = not in a channel). Refused when that channel's slot for the platform is taken. */
export async function setAccountChannel(accountId: string, channelId: string) {
  const channel = channelId ? await prisma.channel.findUnique({ where: { id: channelId } }) : null;
  if (channelId && !channel) throw new Error("That channel was deleted");
  const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  if (channel) {
    const taken = slotAccount(await prisma.account.findMany({ where: { platform: acct.platform, id: { not: acct.id } } }), channel.id, acct.platform);
    if (taken) throw new Error(`${channel.name} already has a ${PLATFORM_LABEL[acct.platform]} account. Remove it first.`);
  }
  await prisma.account.update({ where: { id: accountId }, data: { homeChannelId: channel?.id ?? null } });
  refreshAll();
}

/**
 * Upload "Post to all" (Krew's rule: what goes on a channel's YouTube goes on its TikTok + Instagram too): uploads to every
 * API-connected account of the channel that doesn't have it yet (YouTube upload, TikTok inbox draft; single attempt each).
 * By-hand accounts are left for the Download + copy caption → Mark posted checklist. Refuses clips that aren't approved.
 */
export async function postToAll(clipId: string, channelId: string): Promise<{ queued: string[]; byHand: string[] }> {
  // v2.0.6: the "Upload" button; the same code as Approve + Upload (src/lib/to-post.ts uploadToChannel).
  const { queued, byHand } = await uploadToChannel(clipId, channelId, "button");
  refreshAll();
  return { queued, byHand };
}

/**
 * Upload / Queue "Move to…": send this clip to another channel ("" = back to automatic, by its category). v2.0.6: with
 * `recut` (Krew said yes to "re-cut it in <channel>'s style?") and the raw video still there, it is cut again with the new
 * channel's editing style + watermark (status kept). Returns whether a re-cut was queued.
 */
export async function setClipChannel(clipId: string, channelId: string, recut = false): Promise<{ recut: boolean }> {
  if (channelId && !(await prisma.channel.findUnique({ where: { id: channelId } }))) throw new Error("That channel was deleted");
  await prisma.clip.update({ where: { id: clipId }, data: { channelId: channelId || null } });
  let queued = false;
  if (recut) {
    const clip = await prisma.clip.findUnique({ where: { id: clipId } });
    if (clip?.rawPath && clip.words != null && clip.stage == null && clip.status !== "processing") {
      await prisma.clip.update({ where: { id: clipId }, data: { stage: "cut", stageAt: new Date(), error: null } });
      await enqueueCut(clipId, 1); // no style override: the cutter uses the clip's (new) channel style
      queued = true;
    }
  }
  refreshAll();
  return { recut: queued };
}

/**
 * Upload "Mark posted" for one account (by-hand accounts; also works for an API account Krew posted to himself).
 * Optional post link + campaign link. Refuses clips Krew hasn't approved. Marking again updates the same post.
 */
export async function markPostedToAccount(clipId: string, accountId: string, form: FormData) {
  const [clip, acct] = await Promise.all([
    prisma.clip.findUnique({ where: { id: clipId }, include: { posts: true, moment: { select: { streamer: { select: { campaignId: true } } } } } }),
    prisma.account.findUnique({ where: { id: accountId } }),
  ]);
  if (!clip) throw new Error("That clip is gone");
  if (!acct || !isPostingAccount(acct)) throw new Error("That account was removed");
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Approve the clip first");
  const url = parseLink(form.get("url"));
  const campaignLink = parseLink(form.get("campaignLink"));
  const existing = donePost(clip.posts, acct.id);
  if (existing) {
    await prisma.post.update({ where: { id: existing.id }, data: { ...(url ? { url } : {}), ...(campaignLink ? { campaignLink } : {}) } });
  } else {
    await prisma.post.create({
      data: { clipId, platform: acct.platform, accountId: acct.id, channelId: acct.homeChannelId ?? null, status: "live", url, campaignLink, campaignId: clip.moment.streamer.campaignId ?? null },
    });
  }
  await prisma.clip.update({ where: { id: clipId }, data: { status: "posted" } });
  refreshAll();
}

/** Settings Channels card: switch an account off (skipped by Post to all, not waited for) or back on. */
export async function setAccountDisabled(accountId: string, disabled: boolean) {
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  await prisma.account.update({ where: { id: accountId }, data: { disabled, ...(disabled ? { error: a.error ?? "Switched off in Settings" } : { error: null }) } });
  refreshAll();
}

// ---------- Supreme Judge (v1.9.6) ----------
/** Upload "Pick now". The worker runs it (budget + key checks there). */
export async function pickNow() {
  await pokeSupreme();
  refreshAll();
}

/** "Check video" on any clip card: free ffmpeg checks + the vision check (worker queue "qa"). */
export async function checkVideo(clipId: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId } });
  if (!clip.finalPath) throw new Error("There's no finished video to check");
  await enqueueQa(clipId);
  refreshAll();
}

/**
 * "Fix it": applies the check's suggested fixes in ONE re-cut (no jump cuts / another layout / clean style / +2s at the end)
 * through the normal re-cut path, then the check runs again by itself. The review status is kept.
 */
export async function fixClip(clipId: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId } });
  const qa = parseQa(clip.qa);
  const plan = qa ? fixPlan(qa.issues) : null;
  if (!plan) throw new Error("Nothing here can be fixed automatically: re-cut it by hand or reject it.");
  if (!clip.rawPath) throw new Error("The original video is gone (deleted to save space), so this clip can't be re-cut.");
  if (clip.words == null) throw new Error("This clip was never transcribed; use Retry instead.");
  const extra: { winLength?: number } = {};
  if (plan.extendSec && clip.winStart != null) {
    const len = clip.winLength ?? clip.duration ?? 0;
    const raw = await probeDuration(resolveStored(clip.rawPath)).catch(() => clip.winStart! + len);
    extra.winLength = Math.round(Math.max(len, Math.min(raw - clip.winStart, len + plan.extendSec)) * 100) / 100;
  }
  await prisma.clip.update({ where: { id: clipId }, data: { ...extra, stage: "cut", stageAt: new Date(), error: null, ...(clip.status === "failed" ? { status: "processing" } : {}) } });
  await enqueueCut(clipId, 1, parseEditStyle(plan.style ?? clip.editStyle), plan.jumpCuts, plan.layout ? parseLayoutSetting(plan.layout) : undefined, true);
  refreshAll();
  return plan.fixes;
}

/** Settings: forget the Twitch login used for follower counts. */
export async function disconnectTwitch() {
  await prisma.account.deleteMany({ where: { platform: "twitch" } });
  refreshAll();
}
