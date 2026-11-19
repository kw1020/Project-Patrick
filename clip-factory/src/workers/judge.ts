import { prisma, getSettings } from "../lib/db";
import { judgeClip, judgeConfigured } from "../lib/judge";
import { buildLessons } from "../lib/learning";
import { enqueueCut } from "../lib/queues";
import { brandedCaption, captionHashtags, cleanExtras, defaultExtras, momentGame } from "../lib/social";
import { categoryOff, offReason } from "../lib/category";
import { audioCues, findPayoff, snapWindowToWords, timedTranscript, validJudgeWindow, windowFromJudgeFlags, windowWords } from "../lib/window";
import { audioSummary, chatInSource, chatPeak } from "../lib/audio-summary";
import { FINDER_PREFIX, eventGate, gateInputs } from "../lib/rank";
import { measureLevels } from "../lib/edit";
import { probeDuration, type Word } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { redis, soft } from "../lib/queues";
import { detectScenes, extractFrames, pickFrameTimes, type JudgeFrame } from "../lib/frames";
import { CALIBRATION_WINDOW, calibrationNudge } from "../lib/judge-stats";
import { MAX_SOURCE_SEC, payoffHint } from "./cutter";
import { judgeChannelList, pickClipChannel } from "../lib/to-post";

/** v1.9.4: the last Judge scores, newest first (Redis list), for the calibration guard. */
export const RECENT_SCORES_KEY = "cf:judge:recent";
export async function recentScores(): Promise<number[]> {
  const raw = await soft(redis().lrange(RECENT_SCORES_KEY, 0, CALIBRATION_WINDOW - 1), [] as string[]);
  return raw.map(Number).filter((x) => Number.isFinite(x));
}
async function rememberScore(score: number) {
  await soft(redis().multi().lpush(RECENT_SCORES_KEY, String(score)).ltrim(RECENT_SCORES_KEY, 0, 99).exec(), null);
}

/**
 * v1.9.4: stills from the RAW source across the window the Judge is asked about (see pickFrameTimes), or null if ffmpeg
 * couldn't take them (then the Judge scores from text only; never blocks the clip). JUDGE_FRAMES=off skips them.
 */
export async function judgeFrames(clipId: string, raw: string | null, win: { start: number; end: number } | null, payoffAt: number | null, sourceLength: number | null, extra: { peaks?: number[]; scenes?: number[] } = {}): Promise<{ frames: JudgeFrame[] | null; failed: boolean }> {
  if ((process.env.JUDGE_FRAMES || "").toLowerCase() === "off" || !raw || !win || win.end - win.start <= 0) return { frames: null, failed: false };
  try {
    // v1.9.8: more frames around the loudness/chat peaks and at scene changes (max 12).
    const times = pickFrameTimes({ start: win.start, end: win.end, payoffAt, sourceLength, peaks: extra.peaks, scenes: extra.scenes });
    return { frames: await extractFrames(raw, times, storagePath("work"), clipId), failed: false };
  } catch (e) {
    console.warn(`[judge] ${clipId}: no frames, judging from text only:`, (e as Error).message.split("\n")[0]);
    return { frames: null, failed: true };
  }
}

/** Step 2 — Judge: Claude scores the clip and writes the hook, title and hashtags. Never blocks the line. */
export async function runJudge(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: { include: { campaign: true } } } } } });
  if (!clip) return "clip deleted";
  const settings = await getSettings();
  const { moment } = clip, streamer = moment.streamer;
  const game = momentGame(moment);

  const skip = async (why: string) => {
    await prisma.clip.update({ where: { id: clipId }, data: { stage: "cut", stageAt: new Date(), judgeReason: why } });
    // v2.0.6: an unscored clip still goes to review, so it gets its channel (balanced) before the cut, for that channel's style.
    const ch = await pickClipChannel(clipId).catch(() => null);
    await enqueueCut(clipId);
    return `unscored (${why})${ch?.channel ? ` → ${ch.channel.name}` : ""}`;
  };
  if (!settings.judgeEnabled) return skip("Judge is switched off in Settings");

  let stats = null;
  try { stats = moment.stats ? JSON.parse(moment.stats) : null; } catch { /* ignore */ }

  // v1.8.0: the whole source with word timings, so the Judge can choose the best stretch (best_start/best_end).
  let words: Word[] = [];
  if (clip.wordsFull && clip.words) { try { words = JSON.parse(clip.words); } catch { /* no words */ } }
  const sourceLength = clip.wordsFull && clip.winStart != null && clip.winLength != null ? await sourceSeconds(clip) : null;
  const win = clip.winStart != null && clip.winLength != null ? { start: clip.winStart, end: clip.winStart + clip.winLength } : null;
  // The Judge can't hear: loudness jumps and real silences go into its timeline (one cheap astats pass; none if it fails).
  const levels = sourceLength && clip.rawPath ? await measureLevels(resolveStored(clip.rawPath), 0, sourceLength).catch(() => [] as number[]) : [];
  const marks = sourceLength && win ? judgeMarks(levels, win, clip.payoffAt) : [];

  // v1.9.8: what it would HEAR (loudness per 0.5s, spikes, speech/silence, chat heat lined up with the source) and where the
  // picture changes (scene cuts), so the stills land on the moments that matter.
  const raw = clip.rawPath ? (() => { try { return resolveStored(clip.rawPath!); } catch { return null; } })() : null;
  const frameWin = win ?? (clip.duration ? { start: 0, end: clip.duration } : null);
  const chat = stats?.heat ? chatInSource({ heat: stats.heat, step: stats.heatStep ?? 5, endAt: stats.heatEnd ?? 0 }, payoffHint(moment)) : [];
  const heard = win && levels.length ? audioSummary({ levels, words, window: win, chat }) : null;
  const scenes = raw && frameWin && (process.env.JUDGE_FRAMES || "").toLowerCase() !== "off"
    ? await detectScenes(raw, frameWin.start, frameWin.end - frameWin.start).catch(() => null) : null;

  // v1.9.8 "is something actually happening" gate (Krew: "just random pieces taken out"): no real spike over this stream's own
  // baseline, nobody reacting, dead air or an AFK screen → set aside without paying the Judge. FINDER_GATE=off skips it.
  if (heard && win && (process.env.FINDER_GATE || "").toLowerCase() !== "off") {
    const cp = chatPeak(chat.filter((c) => c.at >= win.start - 5 && c.at <= win.end + 5));
    const gate = eventGate(gateInputs({
      levels, words, win, peak: clip.payoffAt, silenceShare: heard.silenceShare, speechShare: heard.speechShare,
      chatX: chat.length ? (cp?.x ?? 1) : null, sceneChanges: scenes ? scenes.length : null, jumps: audioCues(levels, undefined, 8).jumps,
    }));
    if (!gate.pass) {
      await prisma.clip.update({ where: { id: clipId }, data: { score: 2, stage: "cut", stageAt: new Date(), judgeReason: `${FINDER_PREFIX} ${gate.reason}`, judgeAudio: heard.text } });
      await enqueueCut(clipId, 10);
      return `${streamer.name}: set aside by the clip finder, no Judge call (${gate.reason})`;
    }
  }
  if (!judgeConfigured()) return skip("No ANTHROPIC_API_KEY in .env, so this clip wasn't scored");

  // v1.9.4: let it SEE the moment (8-12 stills over the proposed window; older clips: the whole clip), and nudge it when its
  // recent scores have all been the same.
  const shot = await judgeFrames(clipId, raw, frameWin, clip.payoffAt, sourceLength, { peaks: heard?.peaks, scenes: scenes ?? undefined });
  const calibration = calibrationNudge(await recentScores());

  const lessons = settings.judgeLearns ? await buildLessons().catch(() => null) : null;
  // v2.0.6: the Judge also picks the channel (checked in code after; Krew's own pick is never replaced).
  const channels = clip.channelId ? null : await judgeChannelList().catch(() => null);
  let verdict;
  try {
    verdict = await judgeClip({
      streamer: streamer.name, game, durationSec: clip.duration ?? 0, source: moment.source === "chat" ? "chat" : moment.source === "youtube" ? "youtube" : "twitch_clip",
      replayScore: moment.source === "youtube" ? moment.spikeScore : undefined,
      sourceTitle: moment.sourceTitle, sourceViews: moment.sourceViews, transcript: clip.transcript, stats, minScore: settings.minScore,
      category: clip.category ?? moment.category, frames: shot.frames, framesFailed: shot.failed, calibration, audioSummary: heard?.text ?? null, channels,
      ...(streamer.campaign?.active ? { campaignRules: streamer.campaign.rules, bannedWords: streamer.campaign.bannedWords } : {}),
      ...(sourceLength && win ? { sourceLength, window: win, timedTranscript: timedTranscript(words, 80, marks), lengthRange: { min: settings.clipMinSec, max: settings.clipMaxSec } } : {}),
    }, lessons?.text ?? null);
  } catch (e) {
    return skip(`Judge error: ${(e as Error).message}`.slice(0, 300));
  }
  if (!verdict) return skip("The Judge declined to score this clip");
  await rememberScore(verdict.score);

  const fresh = clip.status === "processing"; // don't overwrite text Krew already edited
  // The Judge's label replaces the first guess. A kind that's off in Settings → auto-rejected by the Cutter.
  const category = verdict.category;
  const off = categoryOff(settings, category);
  // v1.9.1: caption = the Judge's hook + "🎥 @login" + #GTA6 #GTAVI #ViceCity + the 1-2 extras it picked (fallback: by category/game),
  // following the creator's campaign rules. Clip.title = the hook too. Without a hook the old title is kept.
  const caption = brandedCaption({
    hook: verdict.hook_text, fallbackHook: clip.title, streamer, campaign: streamer.campaign,
    extras: cleanExtras(verdict.extra_hashtags, defaultExtras(category, game)), category, game,
  });
  const hook = caption.split("\n")[0];
  const tags = captionHashtags(caption);
  // The Judge's own window, only when it's a sane length inside the source (else the heuristic window stays).
  const own = sourceLength ? validJudgeWindow({ start: verdict.best_start, end: verdict.best_end }, { duration: sourceLength, minSec: settings.clipMinSec, maxSec: settings.clipMaxSec }) : null;
  // v1.9.8: no window of its own, but it said the payoff is outside / the opening doesn't hook → fix the window from that.
  const flagged = !own && sourceLength && win ? windowFromJudgeFlags({
    win, hookLands: verdict.hook_lands, payoffIn: verdict.payoff_in_window, payoffAt: verdict.payoff_at, currentPayoff: clip.payoffAt,
    duration: sourceLength, words, levels, minSec: settings.clipMinSec, maxSec: settings.clipMaxSec,
  }) : null;
  const valid = own ?? flagged?.window ?? null;
  // Its times come from a transcript: don't open or end mid-word.
  const picked = valid && sourceLength ? snapWindowToWords(valid, words, { duration: sourceLength, maxSec: settings.clipMaxSec }) : null;
  const moved = picked && win && (Math.abs(picked.start - win.start) > 0.05 || Math.abs(picked.start + picked.length - win.end) > 0.05) ? picked : null;
  const winData = moved ? (() => {
    const inWin = windowWords(words, moved.start, moved.length);
    // The punch-in must be inside the clip: if the Judge's stretch leaves the payoff out, find the payoff inside it.
    const within = (t: number | null | undefined): t is number => t != null && t > moved.start + 0.5 && t < moved.start + moved.length - 0.5;
    // v1.9.8: the Judge's own payoff time first (it watched the frames), then ours, then a fresh search inside the window.
    const payoffAt = within(verdict.payoff_at) ? verdict.payoff_at : within(clip.payoffAt) ? clip.payoffAt : findPayoff({ source: "window", duration: sourceLength!, levels, words, range: { from: moved.start + 0.5, to: moved.start + moved.length } }).at;
    return { winStart: moved.start, winLength: moved.length, duration: moved.length, payoffAt, transcript: inWin.length ? inWin.map((w) => w.word.trim()).join(" ") : null };
  })() : {};
  await prisma.clip.update({
    where: { id: clipId },
    data: {
      ...winData,
      score: verdict.score, hookText: verdict.hook_text || null, hashtags: tags, stage: "cut", stageAt: new Date(), category,
      judgeReason: off ? `${offReason(category)} (Judge: ${verdict.reason})` : verdict.reason,
      judgeObservations: verdict.observations || null, judgeFrames: shot.frames?.length ?? 0,
      judgeHookOk: verdict.hook_lands, judgePayoffIn: verdict.payoff_in_window, judgeAudio: heard?.text || null, judgePayoff: verdict.payoff || null,
      ...(verdict.usage ? { judgeTokensIn: verdict.usage.input, judgeTokensOut: verdict.usage.output } : {}),
      ...(fresh ? { title: hook, caption } : {}),
    },
  });
  const rejected = verdict.score < settings.minScore || off;
  // v2.0.6: clips going to review get their channel now, before the cut (the Judge's pick if it fits the rules, else balanced).
  const routed = rejected ? null : await pickClipChannel(clipId, verdict.channel).catch((e) => { console.warn(`[judge] ${clipId}: no channel:`, (e as Error).message); return null; });
  await enqueueCut(clipId, rejected ? 10 : 1);
  const routeNote = routed?.channel ? ` → ${routed.channel.name}${routed.how === "judge" ? "" : routed.how === "krew" ? " (your pick)" : verdict.channel ? ` (balanced: "${verdict.channel}" didn't fit)` : " (balanced)"}` : "";
  return `${streamer.name}: ${verdict.score}/10 ${category}${shot.frames ? ` (saw ${shot.frames.length} frames)` : shot.failed ? " (text only: no frames)" : ""}${calibration ? " (nudged: recent scores too similar)" : ""}${moved ? ` (${flagged && !own ? `window fixed: ${flagged.why}` : "Judge picked"} ${moved.start}-${Math.round((moved.start + moved.length) * 10) / 10}s)` : ""}${off ? ` (${offReason(category).toLowerCase()})` : verdict.score < settings.minScore ? " (below cut-off)" : ""}${routeNote}`;
}

/** Length of the source the words cover (seconds): the raw file's duration, never shorter than the window's end. */
async function sourceSeconds(clip: { rawPath: string | null; winStart: number | null; winLength: number | null }): Promise<number | null> {
  const end = (clip.winStart ?? 0) + (clip.winLength ?? 0);
  if (!clip.rawPath) return end || null;
  try {
    return Math.max(end, Math.min(MAX_SOURCE_SEC, await probeDuration(resolveStored(clip.rawPath))));
  } catch {
    return end || null;
  }
}

/** Lines put into the Judge's timed transcript: the proposed window's edges, the payoff, loudness jumps, real silences. */
export function judgeMarks(levels: number[], win: { start: number; end: number }, payoffAt: number | null): { at: number; text: string }[] {
  const cues = audioCues(levels);
  return [
    { at: win.start, text: "proposed window starts" },
    { at: win.end, text: "proposed window ends" },
    ...(payoffAt != null ? [{ at: payoffAt, text: "likely payoff / reaction" }] : []),
    ...cues.jumps.map((j) => ({ at: j.at, text: `sound: sudden loud burst, ${j.db} dB over the usual level` })),
    ...cues.silences.map((x) => ({ at: x.from, text: `sound: silence until ${x.to.toFixed(1)}s` })),
  ];
}
