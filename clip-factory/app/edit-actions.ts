"use server";
// v2.0.0 Edits: server actions for the Edits page, the Queue card's "Make an edit from this clip", and Settings.
import { revalidatePath } from "next/cache";
import { getSettings, prisma } from "@/lib/db";
import { enqueueEdit, enqueuePostEdit } from "@/lib/queues";
import { musicPath } from "@/lib/beats";
import { parseBpm, parseFormat, parseLength, parseTheme, parseVibe, themeLabel } from "@/lib/edit-vibes";
import { createTop5Edit } from "../src/workers/top5";
import { PLATFORM_LABEL, POST_PLATFORMS, donePost, isApiPostingAccount, isPostingAccount, parseKinds, slotAccount } from "@/lib/channels";
import { parseLink } from "@/lib/campaigns";
import { editsChannelOf } from "../src/workers/poster";
import { createEdit } from "../src/workers/edit";

function refresh() {
  try { for (const p of ["/edits", "/upload", "/workroom", "/queue", "/posted", "/settings"]) revalidatePath(p); } catch { /* outside a request */ }
}

export type MakeEditResult = { ok?: string; error?: string };

/** "Make edit" on the Edits page. */
export async function makeEdit(_prev: MakeEditResult | null, form: FormData): Promise<MakeEditResult> {
  const format = parseFormat(form.get("format") ?? "top5");
  if (format === "top5") {
    // v2.0.5 Top 5 countdown: the moments are picked now, so "not enough moments" shows up right here
    const theme = parseTheme(form.get("theme"));
    try {
      await createTop5Edit({ theme, creatorId: theme === "creator" ? String(form.get("streamerId") || "") || null : null });
    } catch (e) { return { error: (e as Error).message }; }
    refresh();
    return { ok: `Making "${themeLabel(theme)}". It shows up below in a minute or two.` };
  }
  const streamerId = String(form.get("streamerId") || "");
  const s = await prisma.streamer.findUnique({ where: { id: streamerId } });
  if (!s || !s.approved) return { error: "Pick an approved creator." };
  const tempo = String(form.get("tempo") || "steady");
  const song = tempo === "song" ? String(form.get("song") || "") : "";
  if (tempo === "song" && !musicPath(song)) return { error: "Pick a song from the music folder (or use a steady beat)." };
  await createEdit({
    streamerId, vibe: parseVibe(form.get("vibe")), lengthSec: parseLength(form.get("length")), bpm: parseBpm(form.get("bpm")),
    timingTrack: song || null, creatorAudio: form.get("creatorAudio") === "on", format,
    captions: form.get("captions") === "on", endText: form.get("endText") === "on" ? "follow for more" : null,
    sourceClipId: format === "clipedit" ? String(form.get("clipId") || "") || null : null,
  });
  refresh();
  return { ok: `Making a ${parseVibe(form.get("vibe"))} edit of ${s.name}. It shows up below in a few minutes.` };
}

/** Queue card: "Make an edit from this clip" (Clip -> Edit, Settings' vibe/tempo/length). */
export async function makeEditFromClip(clipId: string) {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip.moment.streamer.approved) throw new Error("That creator isn't approved.");
  const st = await getSettings();
  await createEdit({
    streamerId: clip.moment.streamerId, vibe: parseVibe(st.editVibe), lengthSec: st.editLength, bpm: st.editBpm, creatorAudio: st.editCreatorAudio,
    format: "clipedit", sourceClipId: clipId, endText: "follow for more",
  });
  refresh();
}

/** Re-make: same settings, new picks (the worker picks other moments than the creator's last edits first). */
export async function remakeEdit(id: string) {
  const e = await prisma.edit.findUniqueOrThrow({ where: { id } });
  if (e.format === "top5") {
    const theme = parseTheme(e.theme);
    await createTop5Edit({ theme, creatorId: theme === "creator" ? e.streamerId : null });
    refresh();
    return;
  }
  await createEdit({
    streamerId: e.streamerId, vibe: parseVibe(e.vibe), lengthSec: e.lengthSec, bpm: e.bpm, timingTrack: e.timingTrack,
    creatorAudio: e.creatorAudio, format: parseFormat(e.format), sourceClipId: e.sourceClipId, captions: e.captions, endText: e.endText,
  });
  refresh();
}

export async function retryEdit(id: string) {
  await prisma.edit.update({ where: { id }, data: { status: "processing", stage: "picking", stageAt: new Date(), error: null } });
  await enqueueEdit(id);
  refresh();
}

/** Approve / Reject / back to review. Approving never posts on its own (the sound is added by hand in TikTok/Reels). */
export async function setEditStatus(id: string, status: "pending" | "approved" | "rejected") {
  const e = await prisma.edit.findUniqueOrThrow({ where: { id } });
  if (e.status === "processing" || e.status === "failed") throw new Error("This edit isn't finished.");
  await prisma.edit.update({ where: { id }, data: { status } });
  refresh();
}

export async function updateEditText(id: string, title: string, caption: string) {
  await prisma.edit.update({ where: { id }, data: { title: title.slice(0, 100), caption: caption.slice(0, 2200) } });
  refresh();
}

// ---------- Upload page (v1.9.5 channels): edits go to the channel whose types include Edits (ClipFactoryGG) ----------
async function editAndAccount(id: string, accountId: string) {
  const [e, a] = await Promise.all([prisma.edit.findUniqueOrThrow({ where: { id }, include: { posts: true } }), prisma.account.findUnique({ where: { id: accountId } })]);
  if (e.status !== "approved" && e.status !== "posted") throw new Error("Approve the edit first");
  if (!a || !isPostingAccount(a)) throw new Error("That account was removed");
  if (!(await editsChannelOf(a))) throw new Error(`${a.handle ?? a.channelTitle ?? "That account"} isn't in a channel that takes Edits (Settings -> Channels).`);
  return { e, a };
}

/** "Post one" on an edit: connected YouTube/TikTok/Instagram of the Edits channel only. Single attempt; Krew's click only. */
export async function postEditToAccount(id: string, accountId: string) {
  const { a } = await editAndAccount(id, accountId);
  if (!isApiPostingAccount(a)) throw new Error("That account is posted to by hand: use Download + copy caption, then Mark posted");
  await prisma.edit.update({ where: { id }, data: { stage: "post", stageAt: new Date(), postError: null } });
  await enqueuePostEdit(id, accountId);
  refresh();
}

/** Upload "Post to all" on an edit: every connected slot account of the Edits channel; by-hand ones are listed back. */
export async function postEditToAll(id: string, channelId: string): Promise<{ queued: string[]; byHand: string[] }> {
  const e = await prisma.edit.findUniqueOrThrow({ where: { id }, include: { posts: true } });
  if (e.status !== "approved" && e.status !== "posted") throw new Error("Approve the edit first");
  const ch = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!ch || !parseKinds(ch.kinds).includes("edits")) throw new Error("That channel doesn't take Edits (Settings -> Channels).");
  const accounts = await prisma.account.findMany({ where: { homeChannelId: channelId, platform: { in: [...POST_PLATFORMS] } }, orderBy: { createdAt: "asc" } });
  const slots = POST_PLATFORMS.map((p) => slotAccount(accounts, channelId, p)).filter((a): a is (typeof accounts)[number] => Boolean(a));
  const queued: string[] = [], byHand: string[] = [];
  for (const a of slots) {
    if (a.disabled || donePost(e.posts, a.id)) continue;
    const label = `${PLATFORM_LABEL[a.platform]} ${a.handle ?? a.channelTitle ?? ""}`.trim();
    if (isApiPostingAccount(a) && !a.error) {
      await prisma.edit.update({ where: { id }, data: { stage: "post", stageAt: new Date(), postError: null } });
      await enqueuePostEdit(id, a.id);
      queued.push(label);
    } else byHand.push(label);
  }
  refresh();
  return { queued, byHand };
}

/** Upload "Mark posted" for one account of the Edits channel (by hand, or Krew posted it himself). Marking again updates it. */
export async function markEditPostedToAccount(id: string, accountId: string, form: FormData) {
  const { e, a } = await editAndAccount(id, accountId);
  const url = parseLink(form.get("url"));
  const existing = donePost(e.posts, a.id);
  if (existing) { if (url) await prisma.editPost.update({ where: { id: existing.id }, data: { url } }); }
  else await prisma.editPost.create({ data: { editId: id, platform: a.platform, accountId: a.id, channelId: a.homeChannelId ?? null, status: "live", url } });
  await prisma.edit.update({ where: { id }, data: { status: "posted" } });
  refresh();
}

export async function deleteEdit(id: string) {
  await prisma.edit.delete({ where: { id } }).catch(() => {});
  refresh(); // files go with the next retention pass (folders of deleted edits after the orphan window)
}
