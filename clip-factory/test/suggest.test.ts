import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Suggestions scanner: big + clippable streamers Krew could approve. It must never approve anyone itself.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-suggest-"));
const realFetch = globalThis.fetch;
const DAY = 86_400_000;

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"),
    REDIS_URL: "redis://localhost:6379/10", // own Redis db: don't touch other tests' queues
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: "gta6-id",
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
const stream = (user_id: string, login: string, viewers: number, game_name: string, title = "hello") => ({
  id: "s-" + user_id, user_id, user_login: login, user_name: login.toUpperCase(), game_id: "g-" + game_name, game_name,
  title, viewer_count: viewers, started_at: new Date().toISOString(), thumbnail_url: "",
});
const clips = (broadcaster: string, n: number, top: number) => Array.from({ length: n }, (_, i) => ({
  id: `${broadcaster}-c${i}`, url: "", broadcaster_id: broadcaster, broadcaster_name: "B", creator_name: "x", video_id: "",
  game_id: "", title: "", view_count: i === 0 ? top : 10, created_at: new Date().toISOString(), thumbnail_url: "", duration: 30, vod_offset: null,
}));

// Top of all Twitch, over two pages. "approved1" is approved, "ytchan" is also a YouTube login (fine since v1.7.1), "snoozed" was dismissed.
const PAGE1 = [stream("big1", "bigone", 50_000, "Just Chatting"), stream("approved1", "approvedguy", 40_000, "GTA"), stream("snoozed", "snoozedguy", 30_000, "Valorant")];
const PAGE2 = [stream("big2", "bigtwo", 18_200, "Fortnite"), stream("ytc", "ytchan", 15_000, "Minecraft"), stream("nope", "nopeguy", 12_000, "Chess"), stream("woke", "wokeguy", 9_000, "Art")];
const BIOS: Record<string, string> = {
  big1: "Daily streams.\nClips welcome! Tag me on TikTok\nBusiness: x@y.com",
  big2: "Variety streamer",
  nope: "No clips please. Clips welcome on my own channel only",
};
const CLIPS: Record<string, [number, number, boolean]> = { big1: [100, 52_000, true], big2: [3, 900, false], nope: [1, 50, false] };

function stubTwitch() {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    calls.push(u);
    if (u.pathname.endsWith("/streams")) {
      assert.equal(u.searchParams.get("game_id"), null); // all of Twitch, no game filter
      assert.equal(u.searchParams.get("first"), "100");
      return u.searchParams.get("after") === "p2" ? json({ data: PAGE2, pagination: {} }) : json({ data: PAGE1, pagination: { cursor: "p2" } });
    }
    if (u.pathname.endsWith("/users")) {
      return json({ data: u.searchParams.getAll("id").map((id) => ({ id, login: id, display_name: id.toUpperCase() + "_TV", profile_image_url: `https://img/${id}.png`, description: BIOS[id] ?? "" })) });
    }
    if (u.pathname.endsWith("/clips")) {
      const b = u.searchParams.get("broadcaster_id")!;
      assert.ok(u.searchParams.get("started_at"));
      const [n, top, more] = CLIPS[b] ?? [0, 0, false];
      return json({ data: clips(b, n, top), pagination: more ? { cursor: "next" } : {} });
    }
    return json({ data: [] });
  }) as typeof fetch;
  return calls;
}

async function seed() {
  const { prisma } = await import("../src/lib/db");
  await prisma.streamer.deleteMany({});
  await prisma.settings.upsert({ where: { id: "main" }, update: { scoutPaused: false }, create: { id: "main" } });
  await prisma.streamer.create({ data: { twitchId: "approved1", login: "approvedguy", name: "ApprovedGuy", approved: true, approvalNote: "paid campaign" } });
  await prisma.streamer.create({ data: { twitchId: "yt:UC1", platform: "youtube", login: "ytchan", name: "YT Chan", approved: true, approvalNote: "yt" } });
  // Seen by the GTA Scout: live in GTA 6 right now, not in the all-Twitch top list.
  await prisma.streamer.create({ data: { twitchId: "gta1", login: "gtaguy", name: "GtaGuy", isLive: true, viewers: 500, peakViewers: 800, gameName: "Grand Theft Auto VI", streamTitle: "GTA 6 day one", lastSeenAt: new Date() } });
  const sn = await prisma.streamer.create({ data: { twitchId: "snoozed", login: "snoozedguy", name: "Snoozed" } });
  await prisma.suggestion.create({ data: { streamerId: sn.id, score: 99, reasons: "[]", status: "dismissed", dismissedUntil: new Date(Date.now() + 20 * DAY) } });
  const wk = await prisma.streamer.create({ data: { twitchId: "woke", login: "wokeguy", name: "Woke" } });
  await prisma.suggestion.create({ data: { streamerId: wk.id, score: 1, reasons: "[]", status: "dismissed", dismissedUntil: new Date(Date.now() - DAY) } });
}

test("score formula", async () => {
  const { suggestionScore } = await import("../src/workers/suggest");
  assert.equal(suggestionScore({ viewers: 0, clipCount: 0, topClipViews: 0, evidence: false }), 0);
  assert.ok(Math.abs(suggestionScore({ viewers: 99, clipCount: 9, topClipViews: 999, evidence: true }) - (4 + 1.5 + 4.5 + 2)) < 1e-9);
});

test("scan: ranked pending suggestions, exclusions, evidence bonus, reasons, no duplicates, Scout's live state untouched", async () => {
  await seed();
  const { prisma } = await import("../src/lib/db");
  const { runSuggestScan, suggestionScore } = await import("../src/workers/suggest");
  const calls = stubTwitch();
  const msg = await runSuggestScan();
  assert.match(msg, /6 suggestions \(6 new\)/);
  assert.equal(calls.filter((u) => u.pathname.endsWith("/streams")).length, 2);
  assert.equal(calls.filter((u) => u.pathname.endsWith("/users")).length, 1);

  const pending = await prisma.suggestion.findMany({ where: { status: "pending" }, orderBy: { score: "desc" }, include: { streamer: true } });
  assert.deepEqual(pending.map((p) => p.streamer.twitchId), ["big1", "big2", "nope", "ytc", "woke", "gta1"]);

  const [b1, b2, nope, ytc, , gta] = pending;
  // Same login as the approved YouTube channel "ytchan": its own Twitch row, suggested (v1.7.1).
  assert.deepEqual({ login: ytc.streamer.login, platform: ytc.streamer.platform, approved: ytc.streamer.approved }, { login: "ytchan", platform: "twitch", approved: false });
  assert.equal(b1.evidence, "Clips welcome! Tag me on TikTok");
  assert.equal(b1.evidenceSource, "bio");
  assert.ok(Math.abs(b1.score - suggestionScore({ viewers: 50_000, clipCount: 100, topClipViews: 52_000, evidence: false }) - 2) < 1e-9);
  assert.deepEqual(JSON.parse(b1.reasons), ["50K watching now (Just Chatting)", "viewers made 100+ clips this week", "top clip 52K views", "bio: 'Clips welcome'"]);
  assert.equal(b1.viewers, 50_000);
  assert.equal(b1.streamer.name, "BIG1_TV");
  assert.equal(b1.streamer.profileImage, "https://img/big1.png");
  assert.equal(b1.streamer.platform, "twitch");

  assert.equal(b2.evidence, null);
  assert.deepEqual(JSON.parse(b2.reasons), ["18.2K watching now (Fortnite)", "viewers made 3 clips this week", "top clip 900 views"]);
  assert.equal(nope.evidence, null, "a 'no clips' in the bio cancels");
  assert.deepEqual(JSON.parse(gta.reasons), ["500 watching now (Grand Theft Auto VI)"]);

  // Excluded: approved, dismissed inside 30 days (still dismissed, not re-suggested).
  const snoozed = await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "snoozed" } } });
  assert.equal(snoozed.status, "dismissed");
  assert.equal(await prisma.suggestion.count({ where: { streamer: { twitchId: { in: ["approved1", "yt:UC1"] } } } }), 0);
  assert.equal(await prisma.streamer.count({ where: { login: "ytchan" } }), 2, "Twitch + YouTube row, same name");

  // Never approves; never marks anyone offline or live.
  assert.deepEqual((await prisma.streamer.findMany({ where: { approved: true }, orderBy: { login: "asc" } })).map((s) => s.login), ["approvedguy", "ytchan"]);
  const g = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "gta1" } });
  assert.equal(g.isLive, true);
  assert.equal(g.viewers, 500);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "big1" } })).isLive, false);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "big1" } })).approved, false);

  // Rerun right away: fresh suggestions aren't re-fetched or duplicated.
  const calls2 = stubTwitch();
  await runSuggestScan();
  assert.equal(await prisma.suggestion.count({ where: { status: "pending" } }), 6);
  assert.equal(calls2.filter((u) => u.pathname.endsWith("/clips")).length, 0);
  assert.equal((await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "big1" } } })).score, b1.score);

  // An hour later they're re-scored in place (same rows, no duplicates).
  await prisma.$executeRawUnsafe(`UPDATE "Suggestion" SET "updatedAt" = ${Date.now() - 2 * 3600_000}`);
  const calls3 = stubTwitch();
  await runSuggestScan();
  assert.ok(calls3.filter((u) => u.pathname.endsWith("/clips")).length >= 5, "re-scored after an hour");
  assert.equal(await prisma.suggestion.count(), 7);
  assert.deepEqual((await prisma.suggestion.findMany({ where: { status: "pending" } })).map((s) => s.id).sort(), pending.map((p) => p.id).sort());
});

test("approving a suggestion is one click (no reason) and goes through the normal approve flow; Not now hides it for 30 days", async () => {
  await seed();
  const { prisma } = await import("../src/lib/db");
  stubTwitch();
  await (await import("../src/workers/suggest")).runSuggestScan();
  const actions = await import("../app/actions");
  const b1 = await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "big1" } } });
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "big1" } })).approved, false);

  // The card's Approve button sends no note: the bio quote becomes the stored note.
  const empty = new FormData();
  empty.set("note", "   ");
  assert.ok((await actions.approveSuggestion(b1.id, null, empty)).ok);
  const s = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "big1" } });
  assert.equal(s.approved, true);
  assert.equal(s.approvalNote, 'Bio says: "Clips welcome! Tag me on TikTok"');
  assert.equal((await prisma.suggestion.findUniqueOrThrow({ where: { id: b1.id } })).status, "approved");

  const b2 = await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "big2" } } });
  await actions.dismissSuggestion(b2.id);
  const d = await prisma.suggestion.findUniqueOrThrow({ where: { id: b2.id } });
  assert.equal(d.status, "dismissed");
  assert.ok(Math.abs(d.dismissedUntil!.getTime() - (Date.now() + 30 * DAY)) < 60_000);

  // Next scan (an hour later): approved and dismissed ones stay out.
  await prisma.$executeRawUnsafe(`UPDATE "Suggestion" SET "updatedAt" = ${Date.now() - 2 * 3600_000}`);
  stubTwitch();
  await (await import("../src/workers/suggest")).runSuggestScan();
  const ids = (await prisma.suggestion.findMany({ where: { status: "pending" }, include: { streamer: true } })).map((p) => p.streamer.twitchId);
  assert.ok(!ids.includes("big1") && !ids.includes("big2"), ids.join());
});

test("scan is skipped when paused or without Twitch keys", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runSuggestScan } = await import("../src/workers/suggest");
  await prisma.settings.update({ where: { id: "main" }, data: { scoutPaused: true } });
  assert.equal(await runSuggestScan(), "paused");
  await prisma.settings.update({ where: { id: "main" }, data: { scoutPaused: false } });
  const id = process.env.TWITCH_CLIENT_ID;
  delete process.env.TWITCH_CLIENT_ID;
  try { assert.match(await runSuggestScan(), /^Twitch: keys missing/); } finally { process.env.TWITCH_CLIENT_ID = id; }
});
