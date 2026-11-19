// v2.0.0 Edits worker (queue "edit", one at a time): picking -> downloading -> beats -> rendering -> pending (Krew reviews).
// Never posts anything; never puts music in the video (the timing track only gives the beat, and goes into the preview).
import fs from "node:fs";
import path from "node:path";
import type { Streamer } from "@prisma/client";
import { getSettings, prisma } from "../lib/db";
import { hasAudio, probeDuration, type Word } from "../lib/media";
import { resolveStored, storageDir, storagePath } from "../lib/paths";
import { enqueueEdit } from "../lib/queues";
import { backlogRoom, freeGb, minFreeGb } from "../lib/guards";
import { creatorCreditText } from "../lib/social";
import { AUTO_MIN_MOMENTS, MIN_MOMENTS, parseFormat, parseVibe, type EditFormat, type Vibe } from "../lib/edit-vibes";
import { pickMoments, rankCandidates, usableCount, wantedSlices, type Candidate, type Ranked } from "../lib/edit-pick";
import { buildPlan, clipBarsFor, describePlan, steadyGrid, trackGrid, FPS, type BeatGrid, type PlanSource } from "../lib/edit-plan";
import { findTrackBeats, metronomeWav, musicPath } from "../lib/beats";
import { renderEdit, type RenderSource } from "../lib/edit-render";
import { editLayout } from "../lib/edit-layout";
import { editCaption, editTitle } from "../lib/edit-text";
import { ytdlpDownload } from "./grabber";
import { probeFinal, renderFacts } from "../lib/platform-file";
import { watermarkText } from "../lib/layout";
import { channelForClip } from "../lib/channels";
import { EDIT_PLACE } from "../lib/edit-plan";

const r3 = (t: number) => Math.round(t * 1000) / 1000;

type MomentRow = Awaited<ReturnType<typeof loadMoments>>[number];
async function loadMoments(streamerId: string) {
  return prisma.moment.findMany({
    where: { streamerId },
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { clips: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
}

/** A creator's moments as edit candidates (the newest clip of each moment carries the score / payoff / raw file). */
export function toCandidates(rows: MomentRow[]): Candidate[] {
  return rows.map((m) => {
    const c = m.clips[0];
    let hasRaw = false;
    if (c?.rawPath) { try { hasRaw = fs.existsSync(resolveStored(c.rawPath)); } catch { hasRaw = false; } }
    return {
      momentId: m.id, clipId: c?.id ?? null, source: m.source, status: c?.status ?? null, score: c?.score ?? null, sourceViews: m.sourceViews,
      category: c?.category ?? m.category, createdAt: m.createdAt, payoffAt: c?.payoffAt ?? null, hasRaw, sourceUrl: m.sourceUrl,
      vodId: m.vodId, vodOffset: m.vodOffset, twitchClipId: m.twitchClipId,
    };
  });
}

export async function loadCandidates(streamerId: string) {
  return toCandidates(await loadMoments(streamerId));
}

/** Usable moments per approved creator (Edits page picker + the daily auto edit). */
export async function usableByCreator(): Promise<Map<string, number>> {
  const creators = await prisma.streamer.findMany({ where: { approved: true }, select: { id: true } });
  const out = new Map<string, number>();
  for (const c of creators) out.set(c.id, usableCount(await loadCandidates(c.id)));
  return out;
}

async function setStage(id: string, stage: string) {
  await prisma.edit.update({ where: { id }, data: { stage, stageAt: new Date() } });
}

// ---------- Getting the video ----------
export type EditSource = { file: string; payoff: number; dur: number; words: Word[]; cand: Ranked | Candidate; reused: boolean };

/**
 * Seconds in the original VOD / video where the payoff is, and where the clip's raw file started in it (words are timed in the
 * raw file). Twitch clips are downloaded whole, so no offset.
 */
export function sourceTiming(c: Candidate): { rawStart: number; payoffAbs: number | null } {
  if (c.source === "youtube" && c.vodOffset != null) {
    const rawStart = Math.max(0, c.vodOffset - 25);
    return { rawStart, payoffAbs: rawStart + (c.payoffAt ?? Math.min(25, c.vodOffset)) };
  }
  if (c.source !== "twitch_clip" && c.vodOffset != null) {
    const rawStart = Math.max(0, c.vodOffset - 30);
    return { rawStart, payoffAbs: rawStart + (c.payoffAt ?? Math.min(30, c.vodOffset)) };
  }
  return { rawStart: 0, payoffAbs: c.payoffAt };
}

/** Hard-link (or copy) the clip's raw file into the edit's folder, so retention deleting the raw can't break a render. */
function keepCopy(src: string, dst: string) {
  fs.rmSync(dst, { force: true });
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}

/** One moment's video for the edit: the raw file when it's still there, else a short download (~10s around the payoff). */
export async function getSource(editId: string, n: number, c: Candidate, words: Word[], o: { before: number; after: number }): Promise<EditSource> {
  const dir = storagePath("edits", editId);
  fs.mkdirSync(dir, { recursive: true });
  const t = sourceTiming(c);
  if (c.hasRaw && c.clipId) {
    const clip = await prisma.clip.findUnique({ where: { id: c.clipId }, select: { rawPath: true } });
    if (clip?.rawPath) {
      const dst = path.join(dir, `src-${n}${path.extname(clip.rawPath) || ".mp4"}`);
      keepCopy(resolveStored(clip.rawPath), dst);
      const dur = await probeDuration(dst);
      return { file: dst, payoff: Math.min(dur - 0.2, c.payoffAt ?? dur * 0.7), dur, words, cand: c, reused: true };
    }
  }
  let range: { from: number; to: number } | undefined, shift = 0;
  if (c.source !== "twitch_clip" && t.payoffAbs != null) {
    const from = Math.max(0, t.payoffAbs - o.before);
    range = { from, to: t.payoffAbs + o.after };
    shift = t.rawStart - from; // raw-file time + shift = time in the downloaded section
  }
  const file = await ytdlpDownload({ source: c.source, sourceUrl: c.sourceUrl, vodId: c.vodId, vodOffset: c.vodOffset }, path.join(dir, `src-${n}`), range);
  const dur = await probeDuration(file);
  const payoff = range && t.payoffAbs != null ? t.payoffAbs - range.from : (c.payoffAt ?? dur * 0.7);
  const ws = words.map((w) => ({ ...w, start: r3(w.start + shift), end: r3(w.end + shift) })).filter((w) => w.start >= 0 && w.end <= dur);
  return { file, payoff: Math.max(0, Math.min(dur - 0.2, payoff)), dur, words: ws, cand: c, reused: false };
}

export async function clipWords(clipId: string | null): Promise<Word[]> {
  if (!clipId) return [];
  const c = await prisma.clip.findUnique({ where: { id: clipId }, select: { words: true, wordsFull: true, winStart: true } });
  if (!c?.words) return [];
  try {
    const all: Word[] = JSON.parse(c.words);
    return c.wordsFull ? all : all.map((w) => ({ ...w, start: w.start + (c.winStart ?? 0), end: w.end + (c.winStart ?? 0) }));
  } catch { return []; }
}

/** Moments used in this creator's last 3 edits (a new edit / Re-make picks others first). */
async function recentlyUsed(streamerId: string, notId: string): Promise<string[]> {
  const prev = await prisma.edit.findMany({ where: { streamerId, id: { not: notId } }, orderBy: { createdAt: "desc" }, take: 3, select: { slices: true } });
  const ids: string[] = [];
  for (const p of prev) { try { for (const m of JSON.parse(p.slices ?? "{}").picks ?? []) if (m.momentId) ids.push(m.momentId); } catch { /* old row */ } }
  return ids;
}

// ---------- The job ----------
export async function runEdit(editId: string): Promise<string> {
  const edit = await prisma.edit.findUnique({ where: { id: editId }, include: { streamer: { include: { campaign: true } } } });
  if (!edit) return "edit deleted";
  if (edit.status !== "processing") return `edit is ${edit.status}, nothing to do`;
  if (edit.format === "top5") return (await import("./top5")).runTop5(editId); // v2.0.5 countdown compilation
  const streamer = edit.streamer;
  if (!streamer.approved) {
    await prisma.edit.update({ where: { id: editId }, data: { status: "failed", stage: null, error: "This creator is not approved any more." } });
    return "skipped: creator not approved";
  }
  const free = await freeGb(storageDir()).catch(() => Infinity);
  if (free < minFreeGb()) throw new Error(`Only ${free.toFixed(1)} GB free on the disk. Free some space, then press Retry.`);
  const vibe = parseVibe(edit.vibe), format = parseFormat(edit.format);
  const t0 = Date.now();
  const settings = await getSettings();
  // v1.9.1 watermark on edits too; v2.0.6: the name of the channel that gets edits (ClipFactoryGG), not Settings.channelName.
  const editChannel = channelForClip(await prisma.channel.findMany({ orderBy: { createdAt: "asc" } }), { category: "edits" });
  const watermark = settings.watermark ? editChannel?.name ?? settings.channelName : null;
  const dir = storagePath("edits", editId), work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });

  // 1) picking
  await setStage(editId, "picking");
  const cands = await loadCandidates(streamer.id);
  let main: Candidate | null = null;
  let picks: Ranked[];
  if (format === "clipedit") {
    if (edit.sourceClipId) {
      const clip = await prisma.clip.findUnique({ where: { id: edit.sourceClipId }, select: { momentId: true } });
      main = cands.find((c) => c.momentId === clip?.momentId) ?? null;
      if (!main) throw new Error("The clip this edit was made from is gone.");
    } else {
      // Edits page: the creator's best moment (with a known payoff first) that wasn't the main clip of their last edits
      const ranked = pickMoments(cands, { vibe, want: 1, spares: 20, avoid: await recentlyUsed(streamer.id, editId) });
      main = ranked.find((c) => c.payoffAt != null) ?? ranked[0] ?? null;
      if (!main) throw new Error(`${streamer.name} has no usable clips yet.`);
    }
    if (!main.hasRaw && !main.sourceUrl && !main.vodId) throw new Error("That clip's video can't be downloaded again.");
    picks = pickMoments(cands.filter((c) => c.momentId !== main!.momentId), { vibe, want: 3, spares: 1, avoid: [] });
  } else {
    const want = wantedSlices(edit.lengthSec, vibe);
    picks = pickMoments(cands, { vibe, want: Math.min(want, 8), spares: 2, avoid: await recentlyUsed(streamer.id, editId) });
    if (picks.length < MIN_MOMENTS) throw new Error(`${streamer.name} has only ${picks.length} usable moment${picks.length === 1 ? "" : "s"} (an edit needs ${MIN_MOMENTS}). Approve more of their clips first.`);
  }

  // 2) downloading
  await setStage(editId, "downloading");
  const sources: EditSource[] = [];
  const problems: string[] = [];
  const target = format === "clipedit" ? 1 + Math.min(3, picks.length) : Math.min(picks.length, wantedSlices(edit.lengthSec, vibe), 8);
  const queue: (Candidate | Ranked)[] = format === "clipedit" ? [main!, ...picks] : picks;
  for (let i = 0; i < queue.length && sources.length < target; i++) {
    const c = queue[i];
    const isMain = format === "clipedit" && i === 0;
    try {
      sources.push(await getSource(editId, i, c, await clipWords(c.clipId), isMain ? { before: 10, after: 8 } : { before: 5, after: 5 }));
    } catch (e) {
      if (isMain) throw new Error(`Couldn't get the clip's video: ${(e as Error).message}`);
      problems.push(`${c.momentId}: ${(e as Error).message.split("\n").pop()}`);
    }
  }
  if (format === "montage" && sources.length < MIN_MOMENTS) throw new Error(`Only ${sources.length} of the moments could be downloaded (an edit needs ${MIN_MOMENTS}). ${problems[0] ?? ""}`.trim());

  // 3) beats
  await setStage(editId, "beats");
  let grid: BeatGrid;
  let clipBars: number | undefined;
  const song = edit.timingTrack ? musicPath(edit.timingTrack) : null;
  if (edit.timingTrack && !song) throw new Error(`The song "${edit.timingTrack}" isn't in the music folder any more.`);
  const trackBeats = song ? await findTrackBeats(song, work) : null;
  const bpm = trackBeats ? trackBeats.tempo : edit.bpm;
  if (format === "clipedit") clipBars = clipBarsFor(bpm, sources[0].payoff, Math.round(edit.lengthSec / (240 / bpm)));
  grid = trackBeats ? trackGrid(trackBeats, edit.lengthSec, clipBars) : steadyGrid(edit.bpm, edit.lengthSec, clipBars);

  // 4) rendering
  await setStage(editId, "rendering");
  const rsources: RenderSource[] = [];
  const psources: PlanSource[] = [];
  const layoutNotes: string[] = [];
  for (const s of sources) {
    const clip = s.cand.clipId ? await prisma.clip.findUnique({ where: { id: s.cand.clipId }, select: { camInfo: true } }) : null;
    const lay = await editLayout({ file: s.file, payoff: s.payoff, dur: s.dur, camInfo: clip?.camInfo ?? null, category: s.cand.category, funny: vibe === "funny" || format === "clipedit", streamer });
    rsources.push({ file: s.file, hasAudio: await hasAudio(s.file).catch(() => false), layout: lay.layout });
    psources.push({ dur: s.dur, payoff: s.payoff, strength: "strength" in s.cand ? (s.cand as Ranked).strength : 1, category: s.cand.category,
      focus: vibe === "hype" && format === "montage" ? null : lay.focus, words: s.words });
    layoutNotes.push(`${lay.layout.kind} (${lay.why})`);
  }
  const plan = buildPlan({ format, vibe, grid, sources: psources, title: streamer.name, endText: edit.endText, captions: edit.captions, creatorAudio: edit.creatorAudio });
  let beat: { file: string; offset: number };
  if (song) beat = { file: song, offset: grid.offset };
  else { const wav = path.join(work, "click.wav"); metronomeWav(grid.beats, plan.duration + 1, wav); beat = { file: wav, offset: 0 }; }
  const finalRel = `edits/${editId}/final.mp4`, beatRel = `edits/${editId}/beat.mp4`;
  const r = await renderEdit({ plan, sources: rsources, credit: creatorCreditText(streamer), workDir: work, final: storagePath(finalRel), beatPreview: storagePath(beatRel), beat, creatorAudio: edit.creatorAudio, watermark });

  // v1.9.8 Platform check facts (the Upload card and the Poster read them, like for clips)
  const file = await probeFinal(storagePath(finalRel)).catch(() => null);
  const kinds = rsources.map((s) => s.layout.kind);
  const render = renderFacts({
    captions: plan.captions.length > 0, hook: true /* the name title + end text */, watermark: watermarkText(watermark) || null, styled: true,
    layout: kinds.includes("split") ? "split" : kinds.includes("fullcam") ? "fullcam" : "blur", place: EDIT_PLACE,
    sourceUrl: sources[0]?.cand.sourceUrl ?? null,
  });
  const clipTitle = format === "clipedit" && edit.sourceClipId ? (await prisma.clip.findUnique({ where: { id: edit.sourceClipId }, select: { title: true } }))?.title : null;
  const title = edit.title ?? editTitle(streamer, vibe, format, clipTitle);
  const report = {
    picks: sources.map((s, i) => ({ momentId: s.cand.momentId, clipId: s.cand.clipId, payoff: r3(s.payoff), dur: r3(s.dur), reused: s.reused, layout: layoutNotes[i] })),
    grid: { bpm: grid.bpm, source: grid.source, offset: grid.offset, beats: grid.beats.length - 1, dropBeat: grid.dropBeat, drops: grid.drops ?? [] },
    slices: describePlan(plan), plan: { frames: plan.frames, slices: plan.slices, fx: plan.fx },
    renderMs: r.ms, sliceMs: r.sliceMs, totalMs: Date.now() - t0, problems,
  };
  // only the finals stay: downloads and work files go now (retention cleans anything left after 24h)
  for (const name of fs.readdirSync(dir)) if (name.startsWith("src-")) fs.rmSync(path.join(dir, name), { force: true });
  fs.rmSync(work, { recursive: true, force: true });
  await prisma.edit.update({
    where: { id: editId },
    data: {
      status: "pending", stage: null, stageAt: new Date(), error: null, finalPath: finalRel, finalWithBeatPath: beatRel,
      bpm: grid.bpm, beatOffset: grid.offset, duration: r3(r.duration), platformInfo: JSON.stringify({ file, render, at: new Date().toISOString() }), slices: JSON.stringify(report), title,
      caption: edit.caption ?? editCaption(title, streamer, { vibe, campaign: streamer.campaign, game: streamer.gameName }),
    },
  });
  return `${format} ${vibe} edit of ${streamer.name}: ${plan.slices.length} slices from ${sources.length} moments, ${r3(r.duration)}s at ${grid.bpm} BPM (${grid.source}), rendered in ${(r.ms / 1000).toFixed(1)}s`;
}

// ---------- Making edits (Edits page, Queue card, daily) ----------
export type NewEdit = {
  streamerId: string; vibe: Vibe; lengthSec: number; bpm: number; timingTrack?: string | null; creatorAudio: boolean;
  format?: EditFormat; sourceClipId?: string | null; captions?: boolean; endText?: string | null;
};

export async function createEdit(o: NewEdit) {
  const e = await prisma.edit.create({
    data: {
      streamerId: o.streamerId, vibe: o.vibe, lengthSec: o.lengthSec, bpm: o.bpm, timingTrack: o.timingTrack || null, creatorAudio: o.creatorAudio,
      format: o.format ?? "montage", sourceClipId: o.sourceClipId ?? null, captions: o.captions ?? false, endText: o.endText ?? null,
      status: "processing", stage: "picking", stageAt: new Date(),
    },
  });
  await enqueueEdit(e.id);
  return e;
}

/** Daily (Settings "Make a daily edit of each creator"): one edit per approved, not-paused creator with >= 8 usable moments and no edit in 24h. */
export async function runEditAuto(now = new Date()): Promise<string> {
  const s = await getSettings();
  if (!s.editAuto) return "daily edits are off";
  const creators: Streamer[] = await prisma.streamer.findMany({ where: { approved: true, paused: false } });
  let made = 0, few = 0, recent = 0, full = false;
  for (const c of creators) {
    const last = await prisma.edit.findFirst({ where: { streamerId: c.id, createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) } } });
    if (last) { recent++; continue; }
    if (usableCount(await loadCandidates(c.id)) < AUTO_MIN_MOMENTS) { few++; continue; }
    if ((await backlogRoom()) <= 0) { full = true; break; }
    // v2.0.5: the daily edit is that creator's Top 5 (the new default format), not a beat montage
    try { await (await import("./top5")).createTop5Edit({ theme: "creator", creatorId: c.id }); made++; }
    catch { few++; }
  }
  return `daily edits: made ${made}${recent ? `, ${recent} had one today` : ""}${few ? `, ${few} without ${AUTO_MIN_MOMENTS}+ good moments` : ""}${full ? ", line full (rest tomorrow)" : ""}`;
}

export { rankCandidates, FPS };
