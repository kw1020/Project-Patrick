import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHeat } from "../src/lib/chat";

// "Any game" mode: approved streamers are tracked and clipped whatever they play; "gta6" mode keeps GTA only.
const GTA = "gta6-id", FORTNITE = "fortnite-id";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-anygame-"));
const realFetch = globalThis.fetch;

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"),
    REDIS_URL: "redis://localhost:6379/8",
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: GTA, MAX_BACKLOG: "12",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  (await import("../src/lib/twitch")).setSleep(async () => {});
});
afterEach(() => { globalThis.fetch = realFetch; });
after(async () => {
  globalThis.fetch = realFetch;
  const { prisma } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const stream = (user_id: string, login: string, game_id: string, game_name: string) => ({
  id: "s-" + user_id, user_id, user_login: login, user_name: login.toUpperCase(), game_id, game_name,
  title: "t", viewer_count: 77, started_at: new Date().toISOString(), thumbnail_url: "",
});
const clip = (id: string, broadcaster_id: string, game_id: string, title = "") => ({
  id, url: `https://clips.twitch.tv/${id}`, broadcaster_id, broadcaster_name: "B", creator_name: "x", video_id: "", game_id,
  title, view_count: 500, created_at: new Date().toISOString(), thumbnail_url: "", duration: 30, vod_offset: null,
});

/** Twitch stand-in: the approved streamer "fn1" plays Fortnite; game-wide GTA list holds one other streamer. */
function stubTwitch() {
  const gameLookups: string[][] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname.endsWith("/streams") && u.searchParams.get("game_id")) return json({ data: [stream("gta1", "gtaguy", GTA, "Grand Theft Auto VI")], pagination: {} });
    if (u.pathname.endsWith("/streams")) return json({ data: u.searchParams.getAll("user_id").includes("fn1") ? [stream("fn1", "fnguy", FORTNITE, "Fortnite")] : [] });
    if (u.pathname.endsWith("/users")) return json({ data: [] });
    if (u.pathname.endsWith("/games")) {
      gameLookups.push(u.searchParams.getAll("id"));
      return json({ data: u.searchParams.getAll("id").filter((id) => id === FORTNITE).map((id) => ({ id, name: "Fortnite" })) });
    }
    if (u.pathname.endsWith("/clips") && u.searchParams.get("game_id")) return json({ data: [clip("gta-clip", "fn1", GTA)], pagination: {} });
    if (u.pathname.endsWith("/clips")) return json({ data: u.searchParams.get("broadcaster_id") === "fn1" ? [clip("fn-clip", "fn1", FORTNITE)] : [], pagination: {} });
    return json({ data: [] });
  }) as typeof fetch;
  return { gameLookups };
}
const chat = () => { const ch: string[][] = []; return { chat: { setChannels: (l: string[]) => { ch.push(l); } } as unknown as ChatHeat, ch }; };

async function setup(mode: "gta6" | "any") {
  const { prisma } = await import("../src/lib/db");
  await prisma.streamer.deleteMany({});
  await prisma.settings.upsert({ where: { id: "main" }, update: { gameMode: mode }, create: { id: "main", gameMode: mode } });
  await prisma.streamer.create({ data: { twitchId: "fn1", login: "fnguy", name: "FnGuy", approved: true, approvalNote: "paid campaign" } });
}

test("gta6 mode: approved streamer playing Fortnite is not live and their Fortnite clips are skipped", async () => {
  await setup("gta6");
  const { prisma } = await import("../src/lib/db");
  stubTwitch();
  const c = chat();
  await (await import("../src/workers/scout")).runScout(c.chat);
  const fn = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "fn1" } });
  assert.equal(fn.isLive, false);
  assert.deepEqual(c.ch.at(-1), []);

  await (await import("../src/workers/clips")).runClipsPoll();
  const moments = await prisma.moment.findMany({ include: { clips: true } });
  assert.deepEqual(moments.map((m) => m.twitchClipId), ["gta-clip"]);
  assert.equal(moments[0].gameName, "Grand Theft Auto VI");
  assert.equal(moments[0].clips[0].title, "FnGuy in GTA 6");
  assert.match(moments[0].clips[0].caption!, /#GTA6 #GTAVI/);
});

test("any mode: approved streamer playing Fortnite is live (with game) and their Fortnite clip is accepted", async () => {
  await setup("any");
  const { prisma } = await import("../src/lib/db");
  const { gameLookups } = stubTwitch();
  const c = chat();
  const msg = await (await import("../src/workers/scout")).runScout(c.chat);
  const fn = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "fn1" } });
  assert.equal(fn.isLive, true);
  assert.equal(fn.gameName, "Fortnite");
  assert.deepEqual(c.ch.at(-1), ["fnguy"]);
  assert.match(msg, /1 in other games/);
  // Discovery is still GTA-only: the unapproved GTA streamer is tracked, nobody else.
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "gta1" } })).gameName, "Grand Theft Auto VI");

  await (await import("../src/workers/clips")).runClipsPoll();
  const moments = await prisma.moment.findMany({ include: { clips: true }, orderBy: { twitchClipId: "asc" } });
  assert.deepEqual(moments.map((m) => m.twitchClipId), ["fn-clip", "gta-clip"]);
  const fnm = moments[0];
  assert.equal(fnm.gameName, "Fortnite");
  assert.equal(fnm.clips[0].title, "FNGUY in Fortnite"); // name as Twitch reported it to the Scout
  assert.match(fnm.clips[0].caption!, /#Fortnite #fnguy #twitch/);
  assert.doesNotMatch(fnm.clips[0].caption!, /GTA/);
  assert.match(fnm.clips[0].caption!, /https:\/\/twitch\.tv\/fnguy/);
  assert.deepEqual(gameLookups, [[FORTNITE]]); // GTA's name isn't looked up
});

test("text helpers: hashtags and titles follow the game", async () => {
  const s = await import("../src/lib/social");
  assert.deepEqual(s.cleanHashtags(["funny", "gta6"], "fnguy", "Fortnite"), ["#Fortnite", "#funny", "#gta6", "#fnguy"]);
  assert.deepEqual(s.cleanHashtags(["funny"], "x"), ["#GTA6", "#funny", "#x"]);
  assert.deepEqual(s.cleanHashtags(["funny"], "x", "Grand Theft Auto VI"), ["#GTA6", "#funny", "#x"]);
  assert.equal(s.cleanHashtags(["a"], "x", "Call of Duty: Warzone")[0], "#CallOfDutyWarzone");
  assert.equal(s.defaultTitle("", "Bob", "Minecraft"), "Bob in Minecraft");
  assert.equal(s.defaultTitle(null, "Bob"), "Bob in GTA 6");
  assert.equal(s.momentGame({ gameName: null, source: "twitch_clip" }), "Grand Theft Auto VI"); // older rows
});

test("judge user message names the game", async () => {
  const { judgeClip } = await import("../src/lib/judge");
  let sent = "";
  const client = { beta: { messages: { parse: async (req: any) => { sent = req.messages[0].content; return { stop_reason: "end_turn", parsed_output: { score: 7, hook_text: "h", title: "t", hashtags: [], reason: "r" } }; } } } } as any;
  await judgeClip({ streamer: "FnGuy", game: "Fortnite", durationSec: 30, source: "twitch_clip", transcript: null, minScore: 6 }, null, client);
  assert.match(sent, /^Streamer: FnGuy\nGame: Fortnite\n/);
});
