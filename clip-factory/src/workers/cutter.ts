import fs from "node:fs";
import { prisma, getSettings } from "../lib/db";
import { buildAss, extractAudio, hasAudio, parseFacecam, pickWindow, probeDuration, renderVertical, type Word } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { enqueueJudge } from "../lib/queues";
import { transcribe } from "../lib/transcribe";
import { creatorCreditText } from "../lib/social";
import { categoryOff, isCategory, offReason } from "../lib/category";
import { parseEditStyle, renderOrFallback, renderStyled } from "../lib/edit";

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
    data: { winStart: win.start, winLength: win.length, duration: win.length, transcript, words: JSON.stringify(words), stage: "judge", stageAt: new Date(), error: null },
  });
  await enqueueJudge(clipId);
  return `transcribed ${win.length}s, ${words.length} words`;
}

/** Step 3 — Cutter: make it 9:16, burn captions + hook + streamer credit, in an editing style (v1.7.3). */
export async function runCut(clipId: string, styleOverride?: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  if (!clip.rawPath) throw new Error("No raw video to cut (grab step didn't finish)");
  const settings = await getSettings();
  const streamer = clip.moment.streamer;
  const raw = resolveStored(clip.rawPath);

  // winLength = the window; duration became the edited length in v1.7.3 (older rows only have duration).
  let start = clip.winStart, length = clip.winLength ?? clip.duration;
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
    const finalRel = `final/${clipId}.mp4`;
    const style = parseEditStyle(styleOverride ?? settings.editStyle);
    // Never lose a clip to a fancy effect: if the styled render fails, the plain v1.7.1 edit is made instead.
    const audio = await hasAudio(raw);
    const r = await renderOrFallback(style, () => renderStyled({
      input: raw, output: storagePath(finalRel), start, length, facecam, style, words, credit: creatorCreditText(streamer), hook: clip.hookText || clip.title,
      minSec: settings.clipMinSec, hasAudio: audio, workDir: storagePath("work"), id: clipId,
      peakHint: { source: clip.moment.source, vodOffset: clip.moment.vodOffset, vodId: clip.moment.vodId },
    }), async () => {
      fs.writeFileSync(assPath, buildAss({ words, credit: creatorCreditText(streamer), duration: length, layout, hook: clip.hookText }));
      await renderVertical({ input: raw, output: storagePath(finalRel), start, length, facecam, assPath });
    });
    if (r.note) console.warn(`[cut] ${clipId}: ${r.note}`);
    const outLen = r.result?.duration ?? length, editNote = r.note, cutWith = r.result ? style : null;

    // First time through: the Judge's score decides review vs auto-reject. Re-cuts keep Krew's decision.
    const fresh = clip.status === "processing" || clip.status === "failed";
    // Settings → "What to clip": a clip whose kind (the Judge's label, else the first guess) is switched off is set aside too.
    const kindOff = isCategory(clip.category) && categoryOff(settings, clip.category);
    const autoReject = kindOff || (settings.judgeEnabled && clip.score != null && clip.score < settings.minScore);
    const kindReason = kindOff && isCategory(clip.category) && !(clip.judgeReason ?? "").startsWith(offReason(clip.category))
      ? { judgeReason: clip.judgeReason ? `${offReason(clip.category)} (${clip.judgeReason})` : offReason(clip.category) } : {};
    await prisma.clip.update({
      where: { id: clipId },
      data: {
        finalPath: finalRel, duration: outLen, winLength: length, editStyle: cutWith, editNote, stage: null, stageAt: new Date(), error: null, status: fresh ? (autoReject ? "rejected" : "pending") : clip.status,
        ...(fresh ? kindReason : {}),
      },
    });
    return `cut ${outLen}s ${cutWith ?? "plain"} ${layout}${words.length ? " + captions" : ""}${clip.hookText ? " + hook" : ""}${fresh && autoReject ? " (auto-rejected)" : ""}`;
  } finally {
    fs.rmSync(assPath, { force: true });
  }
}
