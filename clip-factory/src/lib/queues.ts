import { Queue } from "bullmq";
import IORedis from "ioredis";

// One queue per production-line stage.
export const QUEUES = { scout: "scout", clips: "clips", grab: "grab", transcribe: "transcribe", judge: "judge", cut: "cut", post: "post", youtube: "youtube" } as const;
export type QueueName = keyof typeof QUEUES;

let conn: IORedis | null = null;
export function redis() {
  if (!conn) conn = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
  return conn;
}

const cache = new Map<string, Queue>();
export function queue(name: QueueName) {
  let q = cache.get(name);
  if (!q) {
    q = new Queue(QUEUES[name], {
      connection: redis(),
      defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500, attempts: 2, backoff: { type: "exponential", delay: 15_000 } },
    });
    cache.set(name, q);
  }
  return q;
}

/** delayMs: chat-spike grabs wait for the live VOD to catch up, then retry once a minute. */
export async function enqueueGrab(momentId: string, clipId: string, opts: { delayMs?: number } = {}) {
  await queue("grab").add("grab", { momentId, clipId }, opts.delayMs
    ? { jobId: `grab-${clipId}`, delay: opts.delayMs, attempts: 4, backoff: { type: "fixed", delay: 60_000 } }
    : { jobId: `grab-${clipId}-${Date.now()}` });
}
export async function enqueueTranscribe(clipId: string) {
  await queue("transcribe").add("transcribe", { clipId }, { jobId: `tr-${clipId}-${Date.now()}` });
}
export async function enqueueJudge(clipId: string) {
  await queue("judge").add("judge", { clipId }, { jobId: `judge-${clipId}-${Date.now()}`, attempts: 1 });
}
/** priority 1 = render first (clips headed for review); 10 = when idle (auto-rejected clips). */
export async function enqueueCut(clipId: string, priority = 1) {
  await queue("cut").add("cut", { clipId }, { jobId: `cut-${clipId}-${Date.now()}`, priority });
}
/** One attempt only: a retried upload could post the same video twice. */
export async function enqueuePost(clipId: string, accountId: string) {
  await queue("post").add("post", { clipId, accountId }, { jobId: `post-${clipId}-${accountId}-${Date.now()}`, attempts: 1 });
}
/** Ask the worker to run the scout + clips poll right now (e.g. after approving a streamer). */
export async function pokeScout() {
  await queue("scout").add("scout", {}, { removeOnComplete: true });
  await queue("clips").add("clips", {}, { removeOnComplete: true });
}

/** Ask the worker to run the YouTube scanner now (e.g. after approving a channel). */
export async function pokeYouTube() {
  await queue("youtube").add("youtube", {}, { removeOnComplete: true });
}

// Last-run status per agent, shown on the dashboard ("Scout ran 40s ago: 37 streams").
export type AgentStatus = { at: string; ok: boolean; msg: string };
export async function setStatus(agent: string, ok: boolean, msg: string) {
  const v: AgentStatus = { at: new Date().toISOString(), ok, msg };
  await redis().hset("cf:status", agent, JSON.stringify(v));
}
export async function getStatuses(): Promise<Record<string, AgentStatus>> {
  const all = await redis().hgetall("cf:status");
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, JSON.parse(v)]));
}

/** For the web app: never let a down Redis hang a page. Resolves to `fallback` after `ms`. */
export function soft<T>(p: Promise<T>, fallback: T, ms = 1500): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}
