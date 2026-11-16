import { Queue } from "bullmq";
import IORedis from "ioredis";

// One queue per production-line stage.
export const QUEUES = { scout: "scout", clips: "clips", grab: "grab", cut: "cut" } as const;
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

export async function enqueueGrab(momentId: string, clipId: string) {
  await queue("grab").add("grab", { momentId, clipId }, { jobId: `grab-${clipId}` });
}
export async function enqueueCut(clipId: string) {
  await queue("cut").add("cut", { clipId }, { jobId: `cut-${clipId}-${Date.now()}` });
}
/** Ask the worker to run the scout + clips poll right now (e.g. after approving a streamer). */
export async function pokeScout() {
  await queue("scout").add("scout", {}, { removeOnComplete: true });
  await queue("clips").add("clips", {}, { removeOnComplete: true });
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
