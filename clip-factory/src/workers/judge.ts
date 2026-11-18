import { prisma, getSettings } from "../lib/db";
import { judgeClip, judgeConfigured } from "../lib/judge";
import { buildLessons } from "../lib/learning";
import { enqueueCut } from "../lib/queues";
import { brandedCaption, captionHashtags, cleanExtras, defaultExtras, momentGame } from "../lib/social";
import { categoryOff, offReason } from "../lib/category";
import { audioCues, findPayoff, snapWindowToWords, timedTranscript, validJudgeWindow, windowWords } from "../lib/window";
import { measureLevels } from "../lib/edit";
import { probeDuration, type Word } from "../lib/media";
import { resolveStored } from "../lib/paths";
import { MAX_SOURCE_SEC } from "./cutter";

/** Step 2 — Judge: Claude scores the clip and writes the hook, title and hashtags. Never blocks the line. */
export async function runJudge(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: { include: { campaign: true } } } } } });
  if (!clip) return "clip deleted";
  const settings = await getSettings();
  const { moment } = clip, streamer = moment.streamer;
  const game = momentGame(moment);

  const skip = async (why: string) => {
    await prisma.clip.update({ where: { id: clipId }, data: { stage: "cut", stageAt: new Date(), judgeReason: why } });
    await enqueueCut(clipId);
    return `unscored (${why})`;
  };
  if (!settings.judgeEnabled) return skip("Judge is switched off in Settings");
  if (!judgeConfigured()) return skip("No ANTHROPIC_API_KEY in .env, so this clip wasn't scored");

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

  const lessons = settings.judgeLearns ? await buildLessons().catch(() => null) : null;
  let verdict;
  try {
    verdict = await judgeClip({
      streamer: streamer.name, game, durationSec: clip.duration ?? 0, source: moment.source === "chat" ? "chat" : moment.source === "youtube" ? "youtube" : "twitch_clip",
      replayScore: moment.source === "youtube" ? moment.spikeScore : undefined,
      sourceTitle: moment.sourceTitle, sourceViews: moment.sourceViews, transcript: clip.transcript, stats, minScore: settings.minScore,
      category: clip.category ?? moment.category,
      ...(streamer.campaign?.active ? { campaignRules: streamer.campaign.rules, bannedWords: streamer.campaign.bannedWords } : {}),
      ...(sourceLength && win ? { sourceLength, window: win, timedTranscript: timedTranscript(words, 80, marks), lengthRange: { min: settings.clipMinSec, max: settings.clipMaxSec } } : {}),
    }, lessons?.text ?? null);
  } catch (e) {
    return skip(`Judge error: ${(e as Error).message}`.slice(0, 300));
  }
  if (!verdict) return skip("The Judge declined to score this clip");

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
  const valid = sourceLength ? validJudgeWindow({ start: verdict.best_start, end: verdict.best_end }, { duration: sourceLength, minSec: settings.clipMinSec, maxSec: settings.clipMaxSec }) : null;
  // Its times come from a transcript: don't open or end mid-word.
  const picked = valid && sourceLength ? snapWindowToWords(valid, words, { duration: sourceLength, maxSec: settings.clipMaxSec }) : null;
  const moved = picked && win && (Math.abs(picked.start - win.start) > 0.05 || Math.abs(picked.start + picked.length - win.end) > 0.05) ? picked : null;
  const winData = moved ? (() => {
    const inWin = windowWords(words, moved.start, moved.length);
    // The punch-in must be inside the clip: if the Judge's stretch leaves the payoff out, find the payoff inside it.
    const inside = clip.payoffAt != null && clip.payoffAt > moved.start + 0.5 && clip.payoffAt < moved.start + moved.length - 0.5;
    const payoffAt = inside ? clip.payoffAt : findPayoff({ source: "window", duration: sourceLength!, levels, words, range: { from: moved.start + 0.5, to: moved.start + moved.length } }).at;
    return { winStart: moved.start, winLength: moved.length, duration: moved.length, payoffAt, transcript: inWin.length ? inWin.map((w) => w.word.trim()).join(" ") : null };
  })() : {};
  await prisma.clip.update({
    where: { id: clipId },
    data: {
      ...winData,
      score: verdict.score, hookText: verdict.hook_text || null, hashtags: tags, stage: "cut", stageAt: new Date(), category,
      judgeReason: off ? `${offReason(category)} (Judge: ${verdict.reason})` : verdict.reason,
      ...(fresh ? { title: hook, caption } : {}),
    },
  });
  const rejected = verdict.score < settings.minScore || off;
  await enqueueCut(clipId, rejected ? 10 : 1);
  return `${streamer.name}: ${verdict.score}/10 ${category}${moved ? ` (Judge picked ${moved.start}-${Math.round((moved.start + moved.length) * 10) / 10}s)` : ""}${off ? ` (${offReason(category).toLowerCase()})` : verdict.score < settings.minScore ? " (below cut-off)" : ""}`;
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
