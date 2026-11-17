import { prisma, getSettings } from "../lib/db";
import { judgeClip, judgeConfigured } from "../lib/judge";
import { buildLessons } from "../lib/learning";
import { enqueueCut } from "../lib/queues";
import { cleanHashtags, judgedCaption, momentGame } from "../lib/social";
import { categoryOff, offReason } from "../lib/category";

/** Step 2 — Judge: Claude scores the clip and writes the hook, title and hashtags. Never blocks the line. */
export async function runJudge(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
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

  const lessons = settings.judgeLearns ? await buildLessons().catch(() => null) : null;
  let verdict;
  try {
    verdict = await judgeClip({
      streamer: streamer.name, game, durationSec: clip.duration ?? 0, source: moment.source === "chat" ? "chat" : moment.source === "youtube" ? "youtube" : "twitch_clip",
      replayScore: moment.source === "youtube" ? moment.spikeScore : undefined,
      sourceTitle: moment.sourceTitle, sourceViews: moment.sourceViews, transcript: clip.transcript, stats, minScore: settings.minScore,
      category: clip.category ?? moment.category,
    }, lessons?.text ?? null);
  } catch (e) {
    return skip(`Judge error: ${(e as Error).message}`.slice(0, 300));
  }
  if (!verdict) return skip("The Judge declined to score this clip");

  const tags = cleanHashtags(verdict.hashtags, streamer.login, game);
  const fresh = clip.status === "processing"; // don't overwrite text Krew already edited
  // The Judge's label replaces the first guess. A kind that's off in Settings → auto-rejected by the Cutter.
  const category = verdict.category;
  const off = categoryOff(settings, category);
  await prisma.clip.update({
    where: { id: clipId },
    data: {
      score: verdict.score, hookText: verdict.hook_text || null, hashtags: tags.join(" "), stage: "cut", stageAt: new Date(), category,
      judgeReason: off ? `${offReason(category)} (Judge: ${verdict.reason})` : verdict.reason,
      ...(fresh && verdict.title ? { title: verdict.title, caption: judgedCaption(verdict.title, tags, streamer) } : {}),
    },
  });
  const rejected = verdict.score < settings.minScore || off;
  await enqueueCut(clipId, rejected ? 10 : 1);
  return `${streamer.name}: ${verdict.score}/10 ${category}${off ? ` (${offReason(category).toLowerCase()})` : verdict.score < settings.minScore ? " (below cut-off)" : ""}`;
}
