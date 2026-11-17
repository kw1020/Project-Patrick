"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { enqueueCut, enqueueGrab, enqueuePost, enqueueTranscribe, pokeScout, pokeYouTube } from "@/lib/queues";
import { resolveChannel } from "@/lib/ytdlp";
import { getUsers, twitchConfigured } from "@/lib/twitch";
import { parseFacecam } from "@/lib/media";

function refreshAll() {
  try {
    for (const p of ["/", "/queue", "/posted", "/analytics", "/streamers", "/settings"]) revalidatePath(p);
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
  if (!note) return { error: "Add a note on why they're approved (opted in, paid campaign, allows clippers…)." };
  if (!twitchConfigured()) return { error: "Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env first." };
  const [u] = await getUsers({ logins: [login] });
  if (!u) return { error: `No Twitch user called "${login}".` };
  if (await prisma.streamer.findFirst({ where: { login: u.login, platform: { not: "twitch" } }, select: { id: true } }))
    return { error: `"${u.login}" is already in the list as a YouTube channel.` };
  await prisma.streamer.upsert({
    where: { twitchId: u.id },
    update: { approved: true, approvalNote: note, login: u.login, name: u.display_name, profileImage: u.profile_image_url },
    create: { twitchId: u.id, login: u.login, name: u.display_name, profileImage: u.profile_image_url, approved: true, approvalNote: note },
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
  if (!note) return { error: "Add a note on why they're approved (runs a clipping campaign, allows clippers…)." };
  let ch;
  try {
    ch = await resolveChannel(input);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const twitchId = `yt:${ch.channelId}`;
  const clash = await prisma.streamer.findFirst({ where: { login: ch.handle, twitchId: { not: twitchId } }, select: { platform: true } });
  if (clash) return { error: `A ${clash.platform === "youtube" ? "YouTube channel" : "Twitch streamer"} called "${ch.handle}" is already in the list.` };
  await prisma.streamer.upsert({
    where: { twitchId },
    update: { approved: true, approvalNote: note, login: ch.handle, name: ch.title, profileImage: ch.avatar, platform: "youtube" },
    create: { twitchId, platform: "youtube", login: ch.handle, name: ch.title, profileImage: ch.avatar, approved: true, approvalNote: note },
  });
  await pokeYouTube().catch(() => {});
  refreshAll();
  return { ok: `${ch.title} (youtube.com/@${ch.handle}) approved. Scanning their newest videos now.` };
}

export async function setApproved(id: string, approved: boolean, note?: string) {
  const data: { approved: boolean; approvalNote?: string } = { approved };
  if (note !== undefined) data.approvalNote = note;
  const s = await prisma.streamer.update({ where: { id }, data });
  if (approved) await (s.platform === "youtube" ? pokeYouTube() : pokeScout()).catch(() => {});
  refreshAll();
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
  await prisma.streamer.update({ where: { id }, data: { approved: false, approvalNote: null } });
  refreshAll();
}

// ---------- Clips ----------
export async function updateClipText(id: string, title: string, caption: string) {
  await prisma.clip.update({ where: { id }, data: { title: title.slice(0, 100), caption: caption.slice(0, 2200) } });
  revalidatePath("/queue");
}

export async function setClipStatus(id: string, status: "pending" | "approved" | "rejected") {
  await prisma.clip.update({ where: { id }, data: { status } });
  // Approving is the human sign-off. Accounts set to "post when I approve" get it now.
  if (status === "approved") {
    const auto = await prisma.account.findMany({ where: { autoPost: true, error: null } });
    for (const a of auto) await queueUpload(id, a.id);
  }
  refreshAll();
}

async function queueUpload(clipId: string, accountId: string) {
  await prisma.clip.update({ where: { id: clipId }, data: { stage: "post", postError: null } });
  await enqueuePost(clipId, accountId);
}

/** Manual "send to <account>" on an approved clip. */
export async function postToAccount(clipId: string, accountId: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId } });
  if (clip.status !== "approved" && clip.status !== "posted") throw new Error("Approve the clip first");
  await queueUpload(clipId, accountId);
  refreshAll();
}

export async function retryClip(id: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id } });
  const stage = !clip.rawPath ? "grab" : clip.words == null ? "transcribe" : "cut";
  await prisma.clip.update({ where: { id }, data: { status: "processing", error: null, stage } });
  if (stage === "grab") await enqueueGrab(clip.momentId, id);
  else if (stage === "transcribe") await enqueueTranscribe(id);
  else await enqueueCut(id);
  refreshAll();
}

export async function markPosted(id: string, form: FormData) {
  const platform = String(form.get("platform") || "tiktok");
  const url = String(form.get("url") || "").trim() || null;
  await prisma.post.create({ data: { clipId: id, platform, url } });
  await prisma.clip.update({ where: { id }, data: { status: "posted" } });
  refreshAll();
}

export async function updatePost(id: string, form: FormData) {
  const v = String(form.get("views") || "").replace(/[^0-9]/g, "");
  const url = String(form.get("url") || "").trim();
  await prisma.post.update({ where: { id }, data: { views: v ? parseInt(v) : null, url: url || null } });
  revalidatePath("/posted");
}

// ---------- Settings / control ----------
export async function saveSettings(form: FormData) {
  const n = (k: string, min: number, max: number, def: number) => {
    const v = Number(form.get(k));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  const clipMinSec = Math.round(n("clipMinSec", 5, 59, 15));
  const clipMaxSec = Math.max(clipMinSec, Math.round(n("clipMaxSec", 10, 59, 45)));
  await prisma.settings.upsert({
    where: { id: "main" },
    create: { id: "main" },
    update: {
      spikeMultiplier: n("spikeMultiplier", 1.5, 10, 3),
      minScore: n("minScore", 1, 10, 6),
      clipMinSec, clipMaxSec,
      minClipViews: Math.round(n("minClipViews", 0, 100000, 25)),
      clipLookbackHrs: Math.round(n("clipLookbackHrs", 1, 168, 24)),
      layout: form.get("layout") === "facecam" ? "facecam" : "blur",
      captions: form.get("captions") === "on",
      scoutPaused: form.get("scoutPaused") === "on",
      gameMode: form.get("gameMode") === "any" ? "any" : "gta6",
      ytScanEnabled: form.get("ytScanEnabled") === "on",
      ytVideosPerChannel: Math.round(n("ytVideosPerChannel", 1, 15, 3)),
      ytMomentsPerVideo: Math.round(n("ytMomentsPerVideo", 1, 10, 3)),
      ytMaxVideoAgeDays: Math.round(n("ytMaxVideoAgeDays", 1, 365, 14)),
      spikeEnabled: form.get("spikeEnabled") === "on",
      judgeEnabled: form.get("judgeEnabled") === "on",
      judgeLearns: form.get("judgeLearns") === "on",
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
    data: { autoPost: form.get("autoPost") === "on", privacy: ["public", "unlisted", "private"].includes(privacy) ? privacy : "public" },
  });
  refreshAll();
}

/** Posts made through this account stay on the Posted page; they just stop syncing. */
export async function disconnectAccount(id: string) {
  await prisma.account.delete({ where: { id } });
  refreshAll();
}
