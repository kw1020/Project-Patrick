import fs from "node:fs";
import { prisma, getSettings } from "../lib/db";
import { buildAss, extractAudio, hasAudio, parseFacecam, pickWindow, probeDuration, renderVertical, type Word } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { enqueueJudge, enqueueQa } from "../lib/queues";
import { transcribe } from "../lib/transcribe";
import { creatorCreditText } from "../lib/social";
import { categoryOff, isCategory, offReason } from "../lib/category";
import { measureLevels, parseEditStyle, parseJumpCuts, probeSize, renderOrFallback, renderStyled } from "../lib/edit";
import { isNonGame } from "../lib/category";
import { detectCam } from "../lib/camdetect";
import { boxToRemember, camInfoFits, chooseLayout, needsDetect, overlayPlace, parseCamInfo, parseLayoutSetting, planLayout, watermarkText, type CamInfo, type LayoutPlan } from "../lib/layout";
import { audioCues, findPayoff, pickSmartWindow, tightenWindow, windowWords } from "../lib/window";
import { audioSummary, chatInSource, chatPeak } from "../lib/audio-summary";
import { FINDER_PREFIX, candidateScore, gateInputs, judgePriority } from "../lib/rank";
import { probeFinal, renderFacts } from "../lib/platform-file";
import { keepBest, vodSpan, type KeepClip } from "../lib/funnel";
import { cutChoices } from "../lib/channels";
import { pickClipChannel } from "../lib/to-post";

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
  // v1.9.8: then tightened: open 1-3s before the setup, end right after the reaction, no dead air at either end.
  const win = tightenWindow(pickSmartWindow({ duration: span, payoff: payoff.at, words, levels, minSec: settings.clipMinSec, maxSec: settings.clipMaxSec }), { payoff: payoff.at, words, levels, minSec: settings.clipMinSec, maxSec: settings.clipMaxSec, duration: span });
  const inWin = windowWords(words, win.start, win.length);
  await prisma.clip.update({
    where: { id: clipId },
    data: {
      winStart: win.start, winLength: win.length, duration: win.length, payoffAt: payoff.at, wordsFull: true,
      transcript: inWin.length ? inWin.map((w) => w.word.trim()).join(" ") : null, words: JSON.stringify(words),
      stage: "judge", stageAt: new Date(), error: null,
    },
  });
  // v1.9.8: judge the most promising clips first (chat + sound spiking together, little silence; src/lib/rank.ts).
  const pr = judgeRank(clip.moment, levels, words, win, payoff.at);
  await enqueueJudge(clipId, judgePriority(pr));
  return `transcribed ${Math.round(span)}s (${words.length} words), payoff at ${payoff.at}s (${payoff.why}), keeping ${win.start}-${Math.round((win.start + win.length) * 10) / 10}s, finder score ${pr}`;
}

/** v1.9.8: keepBest (src/lib/funnel.ts) against this creator's clips from the last 3 hours that are in review. */
async function keepBestFor(clip: { id: string; score: number | null; createdAt: Date; moment: { streamerId: string; source: string; vodId: string | null; vodOffset: number | null; timestamp: Date } }, start: number, length: number, cap: number) {
  const rows = await prisma.clip.findMany({
    where: { id: { not: clip.id }, status: { in: ["pending", "approved", "posted"] }, createdAt: { gte: new Date(Date.now() - 3 * 3600_000) }, moment: { streamerId: clip.moment.streamerId } },
    select: { id: true, score: true, status: true, createdAt: true, winStart: true, winLength: true, duration: true, moment: { select: { streamerId: true, source: true, vodId: true, vodOffset: true, timestamp: true } } },
  });
  const toKeep = (c: { id: string; score: number | null; status: string; createdAt: Date; moment: { streamerId: string; source: string; vodId: string | null; vodOffset: number | null; timestamp: Date } }, s: number | null, l: number | null): KeepClip =>
    ({ id: c.id, streamerId: c.moment.streamerId, score: c.score, status: c.status, createdAt: c.createdAt.getTime(), at: c.moment.timestamp.getTime(), ...vodSpan(c.moment, s, l) });
  return keepBest(toKeep({ ...clip, status: "pending" }, start, length), rows.map((r) => toKeep(r, r.winStart, r.winLength ?? r.duration)), cap);
}

/** v1.9.8: the clip finder's score for a transcribed clip (src/lib/rank.ts candidateScore) from what was just measured. */
export function judgeRank(m: { source: string; spikeScore: number; sourceViews: number; stats: string | null; vodOffset: number | null; vodId: string | null }, levels: number[], words: Word[], win: { start: number; length: number }, peak: number | null = null): number {
  let stats: { heat?: number[]; heatStep?: number; heatEnd?: number } | null = null;
  try { stats = m.stats ? JSON.parse(m.stats) : null; } catch { /* none */ }
  const chat = stats?.heat ? chatInSource({ heat: stats.heat, step: stats.heatStep ?? 5, endAt: stats.heatEnd ?? 0 }, payoffHint(m)) : [];
  const a = audioSummary({ levels, words, window: { start: win.start, end: win.start + win.length }, chat });
  const w = { start: win.start, end: win.start + win.length };
  const cp = chatPeak(chat.filter((c) => c.at >= w.start - 5 && c.at <= w.end + 5));
  const g = levels.length ? gateInputs({ levels, words, win: w, peak, silenceShare: a.silenceShare, speechShare: a.speechShare, chatX: chat.length ? (cp?.x ?? 1) : null, sceneChanges: null, jumps: audioCues(levels, undefined, 8).jumps }) : null;
  const source = m.source === "chat" ? "chat" : m.source === "youtube" ? "youtube" : "twitch_clip";
  return candidateScore({
    id: "", streamer: "", source, chatRatio: m.spikeScore, replay: m.spikeScore, views: m.sourceViews, base: Math.max(1, m.sourceViews / Math.max(1, m.spikeScore)), ageHours: 0,
    audioJumpDb: g ? g.audioJumpDb : null, coincide: a.coincide, silenceShare: g ? a.silenceShare : null, speechShare: g ? a.speechShare : null,
    wordCount: g?.wordCount ?? null, sceneChanges: null, chatX: g?.chatX ?? null, reactNear: g?.reactNear ?? null, wordsNear: g?.wordsNear ?? null,
  });
}

/** Step 3 — Cutter: make it 9:16, burn captions + hook + streamer credit, in an editing style (v1.7.3). */
/**
 * v1.9.0: which layout this clip gets (Settings.layout or the Re-cut choice), running the face/webcam check when needed
 * (cached on Clip.camInfo per window, skipped when the creator has a webcam box) and remembering a confidently found webcam
 * spot on the Twitch creator (Streamer.facecamAuto; a typed-in Streamer.facecam always wins).
 */
export async function resolveLayout(o: {
  raw: string; start: number; length: number; mode: string | null | undefined; category: string | null; gameName: string | null; camInfo: string | null;
  streamer: { id: string; platform: string; facecam: string | null; facecamAuto: string | null };
}): Promise<{ plan: LayoutPlan; det: CamInfo | null; why: string; remembered: string | null }> {
  const mode = parseLayoutSetting(o.mode);
  const manual = parseFacecam(o.streamer.facecam), remembered = parseFacecam(o.streamer.facecamAuto);
  const cached = parseCamInfo(o.camInfo);
  let det: CamInfo | null = camInfoFits(cached, o.start, o.length) ? cached : null;
  if (!det && needsDetect({ mode, cached, winStart: o.start, winLength: o.length, manual, remembered, nonGame: isNonGame(o.gameName) })) {
    det = await detectCam(o.raw, o.start, o.length);
  }
  const choice = chooseLayout({ mode, det, category: o.category, manual, remembered });
  const src = choice.layout === "blur" ? { w: 1920, h: 1080 } : await probeSize(o.raw);
  const plan = planLayout({ choice, det, src, category: o.category });
  const keep = boxToRemember({ choice, det, platform: o.streamer.platform, manual: o.streamer.facecam, remembered: o.streamer.facecamAuto });
  if (keep) await prisma.streamer.update({ where: { id: o.streamer.id }, data: { facecamAuto: keep } });
  return { plan, det, why: choice.why, remembered: keep };
}

export async function runCut(clipId: string, styleOverride?: string, jumpOverride?: string, layoutOverride?: string, qaAfter = false) {
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
  // v2.0.6: cut in the style of the clip's channel (the Judge picked it before the cut; Krew's pick wins). A clip on its way to
  // review that still has none (judged before v2.0.6, or the pick failed) gets one now. Re-cut choices win over the channel.
  let channel = clip.channelId ? await prisma.channel.findUnique({ where: { id: clip.channelId } }) : null;
  const toReview = (clip.status === "processing" || clip.status === "failed") && !(clip.judgeReason ?? "").startsWith(FINDER_PREFIX)
    && !(settings.judgeEnabled && clip.score != null && clip.score < settings.minScore);
  if (!channel && toReview) channel = (await pickClipChannel(clipId).catch(() => null))?.channel ?? null;
  const choice = cutChoices(channel, settings, { style: styleOverride, layout: layoutOverride });
  const lay = await resolveLayout({
    raw, start, length, mode: choice.layout, category: clip.category, gameName: clip.moment.gameName, camInfo: clip.camInfo, streamer,
  });
  const plan = lay.plan, layout = plan.kind;
  const facecam = plan.kind === "split" ? plan.cam : null;
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
  // v1.9.1: Settings watermark on = "@<name>" burned in (styled and plain edits; re-cuts too). v2.0.6: the clip's CHANNEL name
  // ("@StreamHeistClips" on a StreamHeistClips clip), Settings.channelName only for a clip with no channel.
  const watermark = choice.watermark;
  let usedLayout: string = layout;
  try {
    const finalRel = `final/${clipId}.mp4`;
    const style = parseEditStyle(choice.style);
    const jumpCuts = parseJumpCuts(jumpOverride ?? settings.jumpCuts);
    // Never lose a clip to a fancy effect: if the styled render fails, the plain v1.7.1 edit is made instead.
    const audio = await hasAudio(raw);
    const r = await renderOrFallback(style, () => renderStyled({
      input: raw, output: storagePath(finalRel), start, length, facecam, plan, style, words, credit: creatorCreditText(streamer), hook: clip.hookText || clip.title, watermark, captionStyle: choice.captionStyle,
      minSec: settings.clipMinSec, hasAudio: audio, workDir: storagePath("work"), id: clipId,
      peakHint: { source: clip.moment.source, vodOffset: clip.moment.vodOffset, vodId: clip.moment.vodId }, peakAt, jumpCuts,
    }), async () => {
      // The plain edit supports every layout; if even that fails in a cam layout, the plain blur edit is the last resort.
      const credit = creatorCreditText(streamer);
      try {
        fs.writeFileSync(assPath, buildAss({ words, credit, duration: length, layout, hook: clip.hookText, place: plan.place, watermark }));
        await renderVertical({ input: raw, output: storagePath(finalRel), start, length, facecam, plan, assPath });
      } catch (e) {
        if (layout === "blur") throw e;
        console.warn(`[cut] ${clipId}: plain ${layout} edit failed, using blur:`, (e as Error).message);
        fs.writeFileSync(assPath, buildAss({ words, credit, duration: length, layout: "blur", hook: clip.hookText, watermark }));
        await renderVertical({ input: raw, output: storagePath(finalRel), start, length, facecam: null, plan: null, assPath });
        usedLayout = "blur";
      }
    });
    if (r.note) console.warn(`[cut] ${clipId}: ${r.note}`);
    const outLen = r.result?.duration ?? length, editNote = r.note, cutWith = r.result ? style : null;
    const cuts = r.result ? r.result.segs.length - 1 : 0;

    // First time through: the Judge's score decides review vs auto-reject. Re-cuts keep Krew's decision.
    const fresh = clip.status === "processing" || clip.status === "failed";
    // Settings → "What to clip": a clip whose kind (the Judge's label, else the first guess) is switched off is set aside too.
    const kindOff = isCategory(clip.category) && categoryOff(settings, clip.category);
    let autoReject = kindOff || (settings.judgeEnabled && clip.score != null && clip.score < settings.minScore);
    let kindReason: { judgeReason?: string } = kindOff && isCategory(clip.category) && !(clip.judgeReason ?? "").startsWith(offReason(clip.category))
      ? { judgeReason: clip.judgeReason ? `${offReason(clip.category)} (${clip.judgeReason})` : offReason(clip.category) } : {};
    // v1.9.8 quality over quantity: near-duplicates and more than Settings.maxPerCreatorPerHour clips of one creator in an hour
    // don't reach review; the best ones are kept (a better new clip replaces a worse pending one).
    if (fresh && !autoReject) {
      const k = await keepBestFor(clip, start, length, settings.maxPerCreatorPerHour);
      if (!k.keep) { autoReject = true; kindReason = { judgeReason: `${k.reason}${clip.judgeReason ? ` (Judge: ${clip.judgeReason})` : ""}` }; }
      for (const d of k.demote) {
        await prisma.clip.updateMany({ where: { id: d.id, status: "pending" }, data: { status: "rejected", judgeReason: d.reason } });
      }
    }
    // v1.9.8 Platform check: what the file is (ffprobe) + what the render put in; the Queue card and the Poster read it.
    const file = await probeFinal(storagePath(finalRel)).catch((e) => { console.warn(`[cut] ${clipId}: ffprobe failed:`, (e as Error).message); return null; });
    const render = renderFacts({
      captions: words.length > 0, hook: Boolean(r.result ? clip.hookText || clip.title : clip.hookText), watermark: watermarkText(watermark) || null, styled: Boolean(r.result),
      layout: usedLayout, place: usedLayout === plan.kind ? plan.place : overlayPlace("blur", null), sourceUrl: clip.moment.sourceUrl,
    });
    await prisma.clip.update({
      where: { id: clipId },
      data: {
        platformInfo: JSON.stringify({ file, render, at: new Date().toISOString() }),
        finalPath: finalRel, duration: outLen, winLength: length, editStyle: cutWith, editNote, layout: usedLayout,
        // v1.9.6: the edit as rendered (for the video check's cut checks); a new video is unchecked until checked again.
        cutPlan: JSON.stringify(r.result ? { segs: r.result.segs, punchStart: r.result.punchStart, duration: r.result.duration } : { segs: [{ start: 0, end: length }], punchStart: null, duration: length }),
        qa: null, qaAt: null,
        ...(lay.det && !lay.det.error ? { camInfo: JSON.stringify(lay.det) } : {}), stage: null, stageAt: new Date(), error: null, status: fresh ? (autoReject ? "rejected" : "pending") : clip.status,
        ...(fresh ? kindReason : {}),
      },
    });
    if (qaAfter) await enqueueQa(clipId).catch(() => {}); // v1.9.6 "Fix it": watch the new version
    return `cut ${outLen}s ${cutWith ?? "plain"} ${usedLayout} (${lay.why}${lay.det?.ms != null ? `, face check ${(lay.det.ms / 1000).toFixed(1)}s` : ""}${lay.remembered ? ", webcam spot remembered" : ""})${cuts ? ` (${cuts} jump cut${cuts === 1 ? "" : "s"})` : ""}${words.length ? " + captions" : ""}${clip.hookText ? " + hook" : ""}${fresh && autoReject ? " (auto-rejected)" : ""}`;
  } finally {
    fs.rmSync(assPath, { force: true });
  }
}
