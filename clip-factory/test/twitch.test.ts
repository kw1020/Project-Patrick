import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHeat } from "../src/lib/chat";

const GTA = "gta6-id";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-twitch-"));
const realFetch = globalThis.fetch;
const sleeps: number[] = [];

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"),
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: GTA,
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const tw = await import("../src/lib/twitch");
  tw.setSleep(async (ms) => { sleeps.push(ms); });
});
afterEach(() => { globalThis.fetch = realFetch; sleeps.length = 0; });
after(async () => {
  globalThis.fetch = realFetch;
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Handler = (url: URL) => Response;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Stub fetch: the token endpoint always succeeds; Helix calls go to `helix` (and are recorded). */
function stubFetch(helix: Handler) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    calls.push(url);
    return helix(url);
  }) as typeof fetch;
  return calls;
}
function sequence(responses: (() => Response)[]): Handler {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)]();
}

const stream = (user_id: string, login: string, game_id: string, viewers = 10) => ({
  id: "s-" + user_id, user_id, user_login: login, user_name: login.toUpperCase(), game_id,
  title: "t", viewer_count: viewers, started_at: new Date().toISOString(), thumbnail_url: "",
});

test("helix: 429 waits until Ratelimit-Reset, then retries and succeeds", async () => {
  const { helix } = await import("../src/lib/twitch");
  const reset = String(Math.floor(Date.now() / 1000) + 10);
  const calls = stubFetch(sequence([() => json({ message: "slow down" }, 429, { "Ratelimit-Reset": reset }), () => json({ data: [{ id: "1" }] })]));
  const r = await helix("/users", { id: "1" });
  assert.deepEqual(r.data, [{ id: "1" }]);
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 5_000 && sleeps[0] <= 10_000, `waited ${sleeps[0]}ms`);
});

test("helix: missing Ratelimit-Reset waits 5s; far-off reset is capped at 60s", async () => {
  const { helix, rateLimitWait } = await import("../src/lib/twitch");
  stubFetch(sequence([() => json({}, 429), () => json({ data: [] })]));
  await helix("/users");
  assert.deepEqual(sleeps, [5000]);
  assert.equal(rateLimitWait(String(Math.floor(Date.now() / 1000) + 3600)), 60_000);
  assert.equal(rateLimitWait(String(Math.floor(Date.now() / 1000) - 5)), 0);
});

test("helix: three 429s in a row throws after 2 retries", async () => {
  const { helix } = await import("../src/lib/twitch");
  const calls = stubFetch(() => json({ message: "slow down" }, 429, { "Ratelimit-Reset": String(Math.floor(Date.now() / 1000) + 1) }));
  await assert.rejects(helix("/users"), /429/);
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test("helix: 500 then 200 retries once after 2s; two 5xx throws", async () => {
  const { helix } = await import("../src/lib/twitch");
  const calls = stubFetch(sequence([() => json({}, 500), () => json({ data: [{ id: "ok" }] })]));
  const r = await helix("/users");
  assert.deepEqual(r.data, [{ id: "ok" }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);

  const calls2 = stubFetch(() => json({}, 503));
  await assert.rejects(helix("/users"), /503/);
  assert.equal(calls2.length, 2);
});

test("helix: 401 refreshes the token and retries once", async () => {
  const { helix } = await import("../src/lib/twitch");
  const calls = stubFetch(sequence([() => json({}, 401), () => json({ data: [{ id: "x" }] })]));
  assert.deepEqual((await helix("/users")).data, [{ id: "x" }]);
  assert.equal(calls.length, 2);
});

test("getStreamsByUserIds: 100 ids per call, type live", async () => {
  const { getStreamsByUserIds } = await import("../src/lib/twitch");
  const calls = stubFetch((u) => json({ data: u.searchParams.getAll("user_id").map((id) => stream(id, "l" + id, GTA)) }));
  const ids = Array.from({ length: 150 }, (_, i) => String(i));
  const r = await getStreamsByUserIds(ids);
  assert.equal(r.length, 150);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.getAll("user_id").length, 100);
  assert.equal(calls[1].searchParams.getAll("user_id").length, 50);
  assert.equal(calls[0].searchParams.get("type"), "live");
});

/** Game pages hold one big streamer; the user_id lookup answers with `approvedStream` for the approved one. */
function scoutFetch(approvedStream: ReturnType<typeof stream> | null) {
  return stubFetch((u) => {
    if (u.pathname.endsWith("/streams") && u.searchParams.get("game_id")) return json({ data: [stream("big1", "bigstreamer", GTA, 50_000)], pagination: {} });
    if (u.pathname.endsWith("/streams") && u.searchParams.has("user_id")) {
      const ids = new Set(u.searchParams.getAll("user_id"));
      return json({ data: approvedStream && ids.has(approvedStream.user_id) ? [approvedStream] : [] });
    }
    if (u.pathname.endsWith("/users")) return json({ data: u.searchParams.getAll("id").map((id) => ({ id, login: "u" + id, display_name: "U", profile_image_url: "http://img/" + id })) });
    return json({ message: "unexpected " + u.pathname }, 404);
  });
}
function stubChat() {
  const channels: string[][] = [];
  return { chat: { setChannels: (l: string[]) => { channels.push(l); } } as unknown as ChatHeat, channels };
}

test("scout: approved streamer outside the top 500 but playing GTA 6 is marked live", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runScout } = await import("../src/workers/scout");
  await prisma.streamer.create({ data: { twitchId: "small1", login: "smallguy", name: "SmallGuy", approved: true } });
  const calls = scoutFetch(stream("small1", "smallguy", GTA, 12));
  const { chat, channels } = stubChat();
  await runScout(chat);

  const small = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "small1" } });
  assert.equal(small.isLive, true);
  assert.equal(small.viewers, 12);
  assert.equal(small.streamId, "s-small1");
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "big1" } })).isLive, true);
  assert.deepEqual(channels.at(-1), ["smallguy"]);
  const lookup = calls.find((u) => u.searchParams.has("user_id"))!;
  assert.deepEqual(lookup.searchParams.getAll("user_id"), ["small1"]);
});

test("scout: approved streamer live in another game is ignored (not live)", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runScout } = await import("../src/workers/scout");
  await prisma.streamer.create({ data: { twitchId: "other1", login: "otherguy", name: "OtherGuy", approved: true, isLive: true } });
  scoutFetch(stream("other1", "otherguy", "just-chatting", 900));
  const { chat, channels } = stubChat();
  await runScout(chat);

  const other = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "other1" } });
  assert.equal(other.isLive, false);
  assert.equal(other.viewers, 0);
  assert.ok(!channels.at(-1)!.includes("otherguy"));
});
