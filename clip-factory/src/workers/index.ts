import { Worker, type Job } from "bullmq";
import { ChatHeat } from "../lib/chat";
import { prisma } from "../lib/db";
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
import { startRetention } from "./retention";
import { judgeConfigured } from "../lib/judge";

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
    if (name === "scout" || name === "clips" || name === "judge") await setStatus(name, true, msg);
    if (name === "post") await setStatus(job.name === "views" ? "stats" : "post", true, msg);
    return msg;
  }, { connection: redis(), concurrency });
  w.on("failed", async (job, err) => {
    console.error(`[${name}] failed:`, err.message);
    if (name === "scout" || name === "clips") await setStatus(name, false, err.message);
    const clipId = job?.data?.clipId;
    if (name === "post" && job?.name === "views") { await setStatus("stats", false, err.message); return; }
    if (name === "post") {
      // A failed upload leaves the clip approved, with the reason shown on its card.
      await setStatus("post", false, err.message);
      if (clipId) await prisma.clip.update({ where: { id: clipId }, data: { stage: null, postError: err.message.slice(0, 1000) } }).catch(() => {});
      return;
    }
    const finalAttempt = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (clipId && finalAttempt) {
      await prisma.clip.update({ where: { id: clipId }, data: { status: "failed", error: `${name}: ${err.message}`.slice(0, 2000) } }).catch(() => {});
    }
  });
  return w;
}

async function main() {
  ensureStorage();
  await checkTools();
  await migrateLegacySettings().catch((e) => console.error("[migrate]", e.message));

  const workers = [
    worker("scout", 1, () => runScout(chat)),
    worker("clips", 1, () => runClipsPoll()),
    worker("grab", 2, (job) => runGrab(job.data.clipId)),
    worker("transcribe", 1, (job) => runTranscribe(job.data.clipId)),
    worker("judge", 3, (job) => runJudge(job.data.clipId)),
    worker("cut", 1, (job) => runCut(job.data.clipId)), // ffmpeg is CPU-heavy: one at a time
    worker("post", 1, (job) => (job.name === "views" ? runStatsSync() : runPost(job.data.clipId, job.data.accountId))),
  ];

  // Scout + Clips poll every 2 minutes (and once right now).
  const every = Number(process.env.SCOUT_INTERVAL_MS || 120_000);
  await queue("scout").upsertJobScheduler("scout-every", { every }, { name: "scout", opts: { attempts: 1 } });
  await queue("clips").upsertJobScheduler("clips-every", { every }, { name: "clips", opts: { attempts: 1 } });

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
  console.log(`Clip Factory workers up: scout + clips every ${every / 1000}s, spike check every 5s, grab x2, transcribe, judge x3, cut, post`);

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
