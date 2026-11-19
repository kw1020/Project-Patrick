import { Worker, type Job } from "bullmq";
import { ChatHeat } from "../lib/chat";
import { prisma, ensureSqliteTuned } from "../lib/db";
import { run } from "../lib/media";
import { ensureStorage } from "../lib/paths";
import { queue, redis, setStatus, QUEUES } from "../lib/queues";
import { twitchConfigured } from "../lib/twitch";
import { runScout, flushChatHeat } from "./scout";
import { runClipsPoll } from "./clips";
import { runGrab } from "./grabber";
import { runCut, runTranscribe } from "./cutter";
import { runJudge } from "./judge";
import { migrateLegacySettings, runPost, runStatsSync } from "./poster";
import { runSpikeCheck } from "./spike";
import { runYouTubeScan } from "./youtube";
import { runSuggestScan } from "./suggest";
import { runQa, runSupreme } from "./supreme";
import { migrateV180Settings, migrateV190Settings } from "./migrate";
import { startRetention } from "./retention";
import { judgeConfigured } from "../lib/judge";
import { ensureChannels } from "../lib/to-post";

const chat = new ChatHeat();

async function checkTools() {
  for (const [cmd, args] of [["ffmpeg", ["-version"]], [process.env.YTDLP || "yt-dlp", ["--version"]]] as const) {
    try { await run(cmd, [...args]); } catch { console.error(`!! ${cmd} is not installed — the pipeline will fail until it is.`); }
  }
  if (!judgeConfigured()) console.warn("-- ANTHROPIC_API_KEY is empty: clips will go to review unscored (no Judge).");
  if (!twitchConfigured()) console.error("!! TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are empty in .env — Scout can't run.");
}

function worker(name: keyof typeof QUEUES, concurrency: number, fn: (job: Job) => Promise<string>) {
  const w = new Worker(QUEUES[name], async (job) => {
    const msg = await fn(job);
    console.log(`[${name}] ${msg}`);
    if (name === "scout" || name === "clips" || name === "judge" || name === "youtube" || name === "suggest" || name === "supreme" || name === "qa") await setStatus(name, true, msg);
    if (name === "post") await setStatus(job.name === "views" ? "stats" : "post", true, msg);
    return msg;
  }, { connection: redis(), concurrency });
  w.on("failed", async (job, err) => {
    console.error(`[${name}] failed:`, err.message);
    if (name === "scout" || name === "clips" || name === "youtube" || name === "suggest" || name === "supreme" || name === "qa") await setStatus(name, false, err.message);
    if (name === "supreme" || name === "qa") return; // a failed pick or video check never fails the clip
    const clipId = job?.data?.clipId;
    if (name === "post" && job?.name === "views") { await setStatus("stats", false, err.message); return; }
    if (name === "post") {
      // A failed upload leaves the clip approved, with the reason shown on its card.
      await setStatus("post", false, err.message);
      if (clipId) await prisma.clip.update({ where: { id: clipId }, data: { stage: null, stageAt: new Date(), postError: err.message.slice(0, 1000) } }).catch(() => {});
      return;
    }
    const finalAttempt = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (clipId && finalAttempt) {
      await prisma.clip.update({ where: { id: clipId }, data: { status: "failed", error: `${name}: ${err.message}`.slice(0, 2000) } }).catch(() => {});
    }
  });
  return w;
}

// One bad promise (a dropped socket, a flaky API) must not take the whole line down on launch day.
process.on("unhandledRejection", (e) => console.error("[unhandled]", e instanceof Error ? e.message : e));
process.on("uncaughtException", (e) => console.error("[uncaught]", e.message));

async function main() {
  await ensureSqliteTuned(); // WAL + busy timeout: web and worker write the same SQLite file
  ensureStorage();
  await checkTools();
  await migrateLegacySettings().catch((e) => console.error("[migrate]", e.message));
  await migrateV180Settings().then((m) => m && console.log(`[migrate] ${m}`)).catch((e) => console.error("[migrate]", e.message));
  await migrateV190Settings().then((m) => m && console.log(`[migrate] ${m}`)).catch((e) => console.error("[migrate]", e.message));
  await ensureChannels().then((m) => m && console.log(`[migrate] ${m}`)).catch((e) => console.error("[migrate]", e.message));

  const workers = [
    worker("scout", 1, () => runScout(chat)),
    worker("clips", 1, () => runClipsPoll()),
    worker("grab", 2, (job) => runGrab(job.data.clipId)),
    worker("transcribe", 1, (job) => runTranscribe(job.data.clipId)),
    worker("judge", 3, (job) => runJudge(job.data.clipId)),
    worker("cut", Number(process.env.CUT_CONCURRENCY || 1), (job) => runCut(job.data.clipId, job.data.style, job.data.jumpCuts, job.data.layout, Boolean(job.data.qaAfter))), // ffmpeg is CPU-heavy: one at a time
    worker("youtube", 1, () => runYouTubeScan()),
    worker("suggest", 1, () => runSuggestScan()),
    worker("supreme", 1, () => runSupreme()), // v1.9.6 Supreme Judge
    worker("qa", 1, (job) => runQa(job.data.clipId)), // v1.9.6 video check
    worker("post", 1, (job) => (job.name === "views" ? runStatsSync() : runPost(job.data.clipId, job.data.accountId))),
  ];

  // Scout + Clips poll every 2 minutes (and once right now).
  const every = Number(process.env.SCOUT_INTERVAL_MS || 120_000);
  await queue("scout").upsertJobScheduler("scout-every", { every }, { name: "scout", opts: { attempts: 1 } });
  await queue("clips").upsertJobScheduler("clips-every", { every }, { name: "clips", opts: { attempts: 1 } });

  // YouTube scanner every 30 minutes (and once right now).
  await queue("youtube").upsertJobScheduler("youtube-every", { every: Number(process.env.YOUTUBE_INTERVAL_MS || 30 * 60_000) }, { name: "youtube", opts: { attempts: 1 } });

  // Suggestions scan every hour, and once about a minute after startup (after the Scout's first pass).
  // startDate only applies when the scheduler is first created; on later restarts it keeps its hourly slot.
  const suggestEvery = Number(process.env.SUGGEST_INTERVAL_MS || 60 * 60_000);
  await queue("suggest").upsertJobScheduler("suggest-every", { every: suggestEvery, startDate: Date.now() + suggestEvery }, { name: "suggest", opts: { attempts: 1 } });
  await queue("suggest").add("suggest", {}, { delay: 60_000, attempts: 1, removeOnComplete: true });

  // v1.9.6 Supreme Judge: 3 times a day (every 8h; the first run 8h after the scheduler is first made), plus "Pick now".
  const supremeEvery = Number(process.env.SUPREME_INTERVAL_MS || 8 * 3600_000);
  await queue("supreme").upsertJobScheduler("supreme-every", { every: supremeEvery, startDate: Date.now() + 10 * 60_000 }, { name: "supreme", opts: { attempts: 1 } });

  await queue("post").upsertJobScheduler("views-every", { every: 15 * 60_000 }, { name: "views", opts: { attempts: 1 } });
  const stopRetention = startRetention(); // disk retention: now, then hourly

  // Spike detector: checks the chat the Scout is reading, every 5 seconds.
  let checking = false;
  const spikes = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const msg = await runSpikeCheck(chat);
      if (msg) { console.log(`[spike] ${msg}`); await setStatus("spike", true, msg); }
    } catch (e) { console.error("[spike]", (e as Error).message); }
    finally { checking = false; }
  }, 5_000);

  const heat = setInterval(() => flushChatHeat(chat).catch((e) => console.error("[chat]", e.message)), 10_000);
  console.log(`Clip Factory workers up: scout + clips every ${every / 1000}s, YouTube scan every 30 min, suggestions hourly, spike check every 5s, grab x2, transcribe, judge x3, cut, post`);

  const shutdown = async () => {
    clearInterval(heat);
    clearInterval(spikes);
    stopRetention();
    chat.stop();
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
