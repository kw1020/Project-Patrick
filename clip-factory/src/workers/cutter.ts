import fs from "node:fs";
import { prisma, getSettings } from "../lib/db";
import { buildAss, extractAudio, hasAudio, parseFacecam, pickWindow, probeDuration, renderVertical, type Word } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { enqueueJudge } from "../lib/queues";
import { transcribe } from "../lib/transcribe";
import { creatorCreditText } from "../lib/social";

/** Step 1 — pick the 15–45s window and transcribe it (the Judge reads the transcript before we spend CPU rendering). */
export async function runTranscribe(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId } });
  if (!clip) return "clip deleted";
  if (!clip.rawPath) throw new Error("No raw video to cut (grab step didn't finish)");
  const settings = await getSettings();
  const raw = resolveStored(clip.rawPath);
  const win = pickWindow(await probeDuration(raw), settings.clipMinSec, settings.clipMaxSec);

  const wav = storagePath("work", `${clipId}.wav`);
  let transcript: string | null = null;
  let words: Word[] = [];
  try {
    if (await hasAudio(raw)) {
      await extractAudio(raw, wav, win.start, win.length);
      const t = await transcribe(wav);
      if (t) { transcript = t.text; words = t.words; }
    }
  } finally {
    fs.rmSync(wav, { force: true });
  }
  await prisma.clip.update({
    where: { id: clipId },
    data: { winStart: win.start, duration: win.length, transcript, words: JSON.stringify(words), stage: "judge", error: null },
  });
  await enqueueJudge(clipId);
  return `transcribed ${win.length}s, ${words.length} words`;
}

/** Step 3 — Cutter: make it 9:16, burn captions + hook + streamer credit. */
export async function runCut(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  if (!clip.rawPath) throw new Error("No raw video to cut (grab step didn't finish)");
  const settings = await getSettings();
  const streamer = clip.moment.streamer;
  const raw = resolveStored(clip.rawPath);

  let start = clip.winStart, length = clip.duration;
  if (start == null || length == null) {
    const win = pickWindow(await probeDuration(raw), settings.clipMinSec, settings.clipMaxSec);
    start = win.start; length = win.length;
  }
  const facecam = settings.layout === "facecam" ? parseFacecam(streamer.facecam) : null;
  const layout = facecam ? "facecam" : "blur";
  let words: Word[] = [];
  if (settings.captions && clip.words) { try { words = JSON.parse(clip.words); } catch { /* no captions */ } }

  const assPath = storagePath("work", `${clipId}.ass`);
  try {
    fs.writeFileSync(assPath, buildAss({ words, credit: creatorCreditText(streamer), duration: length, layout, hook: clip.hookText }));
    const finalRel = `final/${clipId}.mp4`;
    await renderVertical({ input: raw, output: storagePath(finalRel), start, length, facecam, assPath });

    // First time through: the Judge's score decides review vs auto-reject. Re-cuts keep Krew's decision.
    const fresh = clip.status === "processing" || clip.status === "failed";
    const autoReject = settings.judgeEnabled && clip.score != null && clip.score < settings.minScore;
    await prisma.clip.update({
      where: { id: clipId },
      data: { finalPath: finalRel, duration: length, stage: null, error: null, status: fresh ? (autoReject ? "rejected" : "pending") : clip.status },
    });
    return `cut ${length}s ${layout}${words.length ? " + captions" : ""}${clip.hookText ? " + hook" : ""}${fresh && autoReject ? " (auto-rejected)" : ""}`;
  } finally {
    fs.rmSync(assPath, { force: true });
  }
}
