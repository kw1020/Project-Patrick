// v1.9.6 Supreme Judge worker: picks per channel (queue "supreme", every 8h + "Pick now") and the video check (queue "qa").
import fs from "node:fs";
import { getSettings, prisma } from "../lib/db";
import { judgeConfigured } from "../lib/judge";
import { breakdown, performance, platformLabel, typeLabel } from "../lib/analytics";
import { channelForClip } from "../lib/channels";
import { isGta6, momentGame } from "../lib/social";
import { hasAudio, probeDuration, type Word } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { enqueueQa } from "../lib/queues";
import { extractFrames } from "../lib/frames";

const QA_FRAME_WIDTH = 540;
import { askSupreme, enforcePicks, renderSupremeInput, type ChannelContext, type ClipSummary } from "../lib/supreme";
import { dollars, QA_MODEL, recordSpend, SUPREME_MODEL, todayCents } from "../lib/ai-spend";
import {
  buildQaContent, ffmpegIssues, frameTimes, parseCutPlan, parseQa, planIssues, runFfmpegChecks, transcriptAroundCuts, visionQa,
  type QaIssue, type QaResult,
} from "../lib/qa";

const MAX_CLIPS = 40;
const MAX_AGE_H = 72;

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

export async function runSupreme(): Promise<string> {
  const settings = await getSettings();
  if (!judgeConfigured()) return "skipped: no ANTHROPIC_API_KEY in .env";
  const spent = await todayCents();
  if (spent >= settings.supremeDailyCents) return `skipped: today's budget is used (${dollars(spent)} of ${dollars(settings.supremeDailyCents)}); next run tomorrow`;
  const channels = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  if (!channels.length) return "skipped: no channels yet (Settings → Channels)";

  const [clips, todays, rows] = await Promise.all([
    prisma.clip.findMany({
      where: { status: { in: ["approved", "pending"] }, finalPath: { not: null }, createdAt: { gte: new Date(Date.now() - MAX_AGE_H * 3600_000) } },
      include: { moment: { include: { streamer: { include: { campaign: true } } } } },
      orderBy: [{ score: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: MAX_CLIPS,
    }),
    prisma.post.findMany({ where: { postedAt: { gte: startOfToday() }, channelId: { not: null }, status: { not: "failed" } }, select: { channelId: true, clip: { select: { moment: { select: { streamerId: true } } } } } }),
    performance(24).catch(() => []),
  ]);
  if (!clips.length) return "nothing to pick from (no approved or waiting clips from the last 3 days)";
  const recent = rows.filter((r) => r.postedAt.getTime() > Date.now() - 14 * 86400_000);
  const ctx: ChannelContext[] = channels.map((c) => {
    const mine = todays.filter((p) => p.channelId === c.id);
    const creatorsToday: Record<string, number> = {};
    for (const p of mine) creatorsToday[p.clip.moment.streamerId] = (creatorsToday[p.clip.moment.streamerId] ?? 0) + 1;
    const r = recent.filter((x) => x.channelId === c.id);
    const line = (name: string, b: ReturnType<typeof breakdown>) => (b.length ? `${name}: ${b.slice(0, 6).map((g) => `${g.label} ${Math.round(g.views / g.posts)} avg views (${g.posts} posts, ${g.avgPerf}x typical)`).join("; ")}` : null);
    const perf = [line("By creator", breakdown(r, (x) => x.streamer)), line("By type", breakdown(r, typeLabel)), line("By platform", breakdown(r, platformLabel))].filter((x): x is string => Boolean(x));
    return { id: c.id, name: c.name, focus: c.focus, kinds: c.kinds, postsToday: mine.length, want: settings.supremePerChannel, creatorsToday, performance: perf };
  });
  const summaries: ClipSummary[] = clips.map((k) => {
    const s = k.moment.streamer, qa = parseQa(k.qa);
    return {
      id: k.id, creator: s.name, creatorId: s.id, category: k.category ?? k.moment.category, game: momentGame(k.moment), score: k.score, reason: k.judgeReason, hook: k.hookText ?? k.title,
      standout: k.moment.source === "twitch_clip" ? k.moment.spikeScore : null, ageHours: (Date.now() - k.createdAt.getTime()) / 3600_000, length: k.duration,
      campaign: s.campaign?.active ? s.campaign.name : null, layout: k.layout, style: k.editStyle, status: k.status,
      autoChannelId: channelForClip(channels, { channelId: k.channelId, category: k.category ?? k.moment.category, gta: isGta6(momentGame(k.moment)) })?.id ?? null,
      qa: !qa ? "unchecked" : qa.ok ? "ok" : "issues",
    };
  });

  const res = await askSupreme(renderSupremeInput(ctx, summaries));
  const cost = await recordSpend(SUPREME_MODEL, "supreme", res.usage);
  if (res.refused) return `the Supreme Judge declined this time (no picks) · ${dollars(cost)}`;
  const { picks, dropped } = enforcePicks(res.answer, ctx, summaries, settings.supremePerChannel);

  // The new line-up replaces the old one (clips already posted keep nothing to clear: they're not candidates).
  const now = new Date();
  await prisma.clip.updateMany({ where: { supremePick: true }, data: { supremePick: false, supremeRank: null } });
  for (const p of picks) {
    await prisma.clip.update({ where: { id: p.clipId }, data: { supremePick: true, supremeRank: p.rank, supremeReason: p.reason, supremeAt: now, supremeChannelId: p.channelId } });
  }
  // Watch each new pick that wasn't checked yet.
  const unchecked = summaries.filter((s) => s.qa === "unchecked" && picks.some((p) => p.clipId === s.id));
  for (const s of unchecked) await enqueueQa(s.id).catch(() => {});
  const per = channels.map((c) => `${c.name} ${picks.filter((p) => p.channelId === c.id).length}`).join(", ");
  return `picked ${picks.length} clips (${per}) from ${clips.length}${dropped.length ? ` · ${dropped.length} dropped by the rules` : ""}${unchecked.length ? ` · checking ${unchecked.length} videos` : ""} · ${dollars(cost)}`;
}

/** The window's words in WINDOW seconds, NOT clamped to the window (so an ending inside a word shows). */
function windowWordsRaw(clip: { words: string | null; wordsFull: boolean; winStart: number | null; winLength: number | null; duration: number | null }): Word[] {
  let all: Word[] = [];
  try { all = clip.words ? JSON.parse(clip.words) : []; } catch { return []; }
  if (!clip.wordsFull) return all;
  const start = clip.winStart ?? 0, len = clip.winLength ?? clip.duration ?? 0;
  return all.filter((w) => w.end > start && w.start < start + len).map((w) => ({ word: w.word, start: w.start - start, end: w.end - start }));
}

/** Watch the video: free ffmpeg + edit-plan checks, then (key + budget allowing) the vision check. Stores Clip.qa. */
export async function runQa(clipId: string): Promise<string> {
  const clip = await prisma.clip.findUnique({ where: { id: clipId } });
  if (!clip) return "clip deleted";
  if (!clip.finalPath) return "no video to check";
  const settings = await getSettings();
  const file = resolveStored(clip.finalPath);
  const duration = await probeDuration(file);
  const audio = await hasAudio(file);
  const free = ffmpegIssues(await runFfmpegChecks(file, audio, duration), { duration, planned: clip.duration, hasAudio: audio });
  const plan = parseCutPlan(clip.cutPlan);
  const words = windowWordsRaw(clip);
  const fromPlan = planIssues(plan, words, clip.winLength ?? null);
  const issues: QaIssue[] = [...free, ...fromPlan];
  const checks = ["black", "frozen", "silence", "loudness", "length", ...(plan ? ["cuts"] : []), ...(words.length ? ["ending"] : [])];

  let vision: QaResult["vision"] = "skipped", visionNote: string | null = null, frames = 0;
  const spent = await todayCents();
  if (!judgeConfigured()) visionNote = "no ANTHROPIC_API_KEY, so only the free checks ran";
  else if (spent >= settings.supremeDailyCents) visionNote = `today's Supreme budget is used (${dollars(spent)}), so only the free checks ran`;
  else {
    const dir = storagePath("work", `qa-${clipId}`);
    try {
      // The v1.9.4 frame grabber (one ffmpeg run), 540 wide = 540x960 from the 1080x1920 clip.
      const want = frameTimes(plan, duration);
      const got = await extractFrames(file, want.map((f) => f.t), dir, `qa-${clipId}`, 60_000, QA_FRAME_WIDTH);
      frames = got.length;
      const content = buildQaContent({
        frames: got.map((f, i) => ({ t: f.at, why: want[i].why, data: f.data })),
        plan, duration, layout: clip.layout, words: transcriptAroundCuts(words, plan), free: issues,
      });
      const r = await visionQa(content);
      await recordSpend(QA_MODEL, "qa", r.usage);
      if (r.refused) { vision = "refused"; visionNote = "the video check declined this clip"; }
      else if (r.verdict) {
        vision = "done";
        for (const i of r.verdict.issues) {
          // The free checks already measured black/frozen exactly: keep theirs, add the model's other findings.
          if ((i.type === "black" || i.type === "frozen") && issues.some((x) => x.type === i.type)) continue;
          issues.push({ ...i, detail: i.detail.slice(0, 200), source: "vision" });
        }
      } else { vision = "failed"; visionNote = "the video check returned nothing usable"; }
    } catch (e) {
      vision = "failed"; visionNote = `video check failed: ${(e as Error).message}`.slice(0, 300);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const result: QaResult = { ok: issues.length === 0, at: new Date().toISOString(), issues, checks, vision, visionNote, frames };
  await prisma.clip.update({ where: { id: clipId }, data: { qa: JSON.stringify(result), qaAt: new Date() } });
  return `${clipId}: ${result.ok ? "checked ✓" : `${issues.length} issue${issues.length === 1 ? "" : "s"} (${[...new Set(issues.map((i) => i.type))].join(", ")})`}${vision === "done" ? ` · ${frames} frames watched` : visionNote ? ` · ${visionNote}` : ""}`;
}
