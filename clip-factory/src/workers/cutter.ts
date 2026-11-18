import fs from "node:fs";
import { prisma, getSettings } from "../lib/db";
import { buildAss, extractAudio, hasAudio, parseFacecam, pickWindow, probeDuration, renderVertical, type Word } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { enqueueJudge } from "../lib/queues";
import { transcribe } from "../lib/transcribe";
import { creatorCreditText } from "../lib/social";
import { categoryOff, isCategory, offReason } from "../lib/category";
import { measureLevels, parseEditStyle, parseJumpCuts, renderOrFallback, renderStyled } from "../lib/edit";
import { findPayoff, pickSmartWindow, windowWords } from "../lib/window";

/** Longest stretch of source we transcribe (Twitch clips are <= 60s, VOD/YouTube sections 45s). */
export const MAX_SOURCE_SEC = 180;

/** Where the payoff is known in advance (seconds into the raw file): chat spike = the reaction point, YouTube = replay peak. */
export function payoffHint(m: { source: string; vodOffset: number | null; vodId?: string | null }): number | null {
  if (m.vodOffset == null) return null;
  if (m.source === "chat" && m.vodId) return Math.min(30, m.vodOffset); // the VOD section starts 30s before the moment
  if (m.source === "youtube") return Math.min(25, m.vodOffset); // the section starts 25s before the most-replayed center
  return null;
}

/**
 * Step 1 — transcribe the WHOLE source (words timed in the raw file), find the payoff, pick the window around it (v1.8.0).
 * The Judge reads the full transcript next and may move the window; the Cutter renders whichever window is stored.
 */
export async function runTranscribe(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: true } });
  if (!clip) return "clip deleted";
  if (!clip.rawPath) throw new Error("No raw video to cut (grab step didn't finish)");
  const settings = await getSettings();
  const raw = resolveStored(clip.rawPath);
  const duration = await probeDuration(raw);
  const span = Math.min(duration, MAX_SOURCE_SEC);

  const wav = storagePath("work", `${clipId}.wav`);
  let words: Word[] = [];
  let levels: number[] = [];
  try {
    if (await hasAudio(raw)) {
      levels = await measureLevels(raw, 0, span).catch(() => []);
      await extractAudio(raw, wav, 0, span);
      const t = await transcribe(wav);
      if (t) words = t.words;
    }
  } finally {
    fs.rmSync(wav, { force: true });
  }
  const payoff = findPayoff({ source: clip.moment.source, duration: span, levels, words, hint: payoffHint(clip.moment) });
  const win = pickSmartWindow({ duration: span, payoff: payoff.at, words, minSec: settings.clipMinSec, maxSec: settings.clipMaxSec });
  const inWin = windowWords(words, win.start, win.length);
  await prisma.clip.update({
    where: { id: clipId },
    data: {
      winStart: win.start, winLength: win.length, duration: win.length, payoffAt: payoff.at, wordsFull: true,
      transcript: inWin.length ? inWin.map((w) => w.word.trim()).join(" ") : null, words: JSON.stringify(words),
      stage: "judge", stageAt: new Date(), error: null,
    },
  });
  await enqueueJudge(clipId);
  return `transcribed ${Math.round(span)}s (${words.length} words), payoff at ${payoff.at}s (${payoff.why}), keeping ${win.start}-${Math.round((win.start + win.length) * 10) / 10}s`;
}

/** Step 3 — Cutter: make it 9:16, burn captions + hook + streamer credit, in an editing style (v1.7.3). */
export async function runCut(clipId: string, styleOverride?: string, jumpOverride?: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  if (!clip.rawPath) throw new Error("No raw video to cut (grab step didn't finish)");
  const settings = await getSettings();
  const streamer = clip.moment.streamer;
  const raw = resolveStored(clip.rawPath);

  // winLength = the window (heuristic or the Judge's pick); duration became the edited length in v1.7.3 (older rows only
  // have duration). Re-cuts always use this stored window.
  let start = clip.winStart, length = clip.winLength ?? clip.duration;
  if (start == null || length == null) {
    const win = pickWindow(await probeDuration(raw), settings.clipMinSec, settings.clipMaxSec);
    start = win.start; length = win.length;
  }
  const facecam = settings.layout === "facecam" ? parseFacecam(streamer.facecam) : null;
  const layout = facecam ? "facecam" : "blur";
  let words: Word[] = [];
  if (settings.captions && clip.words) {
    try {
      const all: Word[] = JSON.parse(clip.words);
      // v1.8.0 rows hold the whole source's words; older rows only the window's.
      words = clip.wordsFull ? windowWords(all, start, length) : all;
    } catch { /* no captions */ }
  }
  // The payoff found by runTranscribe is the punch-in moment (no recomputing).
  const peakAt = clip.payoffAt != null ? clip.payoffAt - start : null;

  const assPath = storagePath("work", `${clipId}.ass`);
  try {
    const finalRel = `final/${clipId}.mp4`;
    const style = parseEditStyle(styleOverride ?? settings.editStyle);
    const jumpCuts = parseJumpCuts(jumpOverride ?? settings.jumpCuts);
    // Never lose a clip to a fancy effect: if the styled render fails, the plain v1.7.1 edit is made instead.
    const audio = await hasAudio(raw);
    const r = await renderOrFallback(style, () => renderStyled({
      input: raw, output: storagePath(finalRel), start, length, facecam, style, words, credit: creatorCreditText(streamer), hook: clip.hookText || clip.title,
      minSec: settings.clipMinSec, hasAudio: audio, workDir: storagePath("work"), id: clipId,
      peakHint: { source: clip.moment.source, vodOffset: clip.moment.vodOffset, vodId: clip.moment.vodId }, peakAt, jumpCuts,
    }), async () => {
      fs.writeFileSync(assPath, buildAss({ words, credit: creatorCreditText(streamer), duration: length, layout, hook: clip.hookText }));
      await renderVertical({ input: raw, output: storagePath(finalRel), start, length, facecam, assPath });
    });
    if (r.note) console.warn(`[cut] ${clipId}: ${r.note}`);
    const outLen = r.result?.duration ?? length, editNote = r.note, cutWith = r.result ? style : null;
    const cuts = r.result ? r.result.segs.length - 1 : 0;

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
    return `cut ${outLen}s ${cutWith ?? "plain"} ${layout}${cuts ? ` (${cuts} jump cut${cuts === 1 ? "" : "s"})` : ""}${words.length ? " + captions" : ""}${clip.hookText ? " + hook" : ""}${fresh && autoReject ? " (auto-rejected)" : ""}`;
  } finally {
    fs.rmSync(assPath, { force: true });
  }
}
