import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// YouTube suggestions: big trending YouTube channels Krew could approve. Never approves anyone itself.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-suggest-yt-"));
const realFetch = globalThis.fetch;
const DAY = 86_400_000;

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"),
    REDIS_URL: "redis://localhost:6379/11", // own Redis db: don't touch other tests' queues
    YOUTUBE_API_URL: "https://yt.test/youtube/v3",
  });
  delete process.env.TWITCH_CLIENT_ID;
  delete process.env.TWITCH_CLIENT_SECRET;
  delete process.env.YOUTUBE_API_KEY;
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  (await import("../src/lib/twitch")).setSleep(async () => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.YOUTUBE_API_KEY;
  delete process.env.TWITCH_CLIENT_ID;
  delete process.env.TWITCH_CLIENT_SECRET;
});
after(async () => {
  globalThis.fetch = realFetch;
  const { prisma } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const vid = (id: string, channelId: string, title: string, views: number) => ({ id, snippet: { channelId, title }, statistics: { viewCount: String(views) } });

// Trending charts by category ("" = overall). trend1 is on two charts: it must count once.
const CHARTS: Record<string, unknown[]> = {
  "": [vid("trend1", "UCbig", "I survived 100 days in GTA 6 and this is what happened at the end", 8_100_000), vid("trend2", "UCbig", "GTA 6 map tour", 2_000_000)],
  "20": [vid("trend1", "UCbig", "I survived 100 days in GTA 6 and this is what happened at the end", 8_100_000), vid("mid1", "UCmid", "Vice City speedrun", 450_000)],
  "24": [vid("nh1", "UCnohandle", "No handle", 5_000_000), vid("ap1", "UCappr", "Approved one", 9_000_000), vid("cl1", "UCclash", "Clash", 3_000_000)],
  "23": [vid("sn1", "UCsnooze", "Snoozed", 1_000_000), vid("no1", "UCnope", "Nope", 700_000), vid("hd1", "UChidden", "Hidden subs", 6_000_000)],
};
const ch = (id: string, title: string, customUrl: string | undefined, description: string, stats: Record<string, unknown>) =>
  ({ id, snippet: { title, customUrl, description, thumbnails: { default: { url: `https://yt3/${id}-s.jpg` }, medium: { url: `https://yt3/${id}.jpg` } } }, statistics: stats });
const CHANNELS: Record<string, unknown> = {
  UCbig: ch("UCbig", "Big Channel", "@BigChannel", "Daily GTA videos.\nClips welcome! Tag me on Shorts\nBusiness: a@b.com", { subscriberCount: "12400000", viewCount: "3000000000", videoCount: "800" }),
  UCmid: ch("UCmid", "Mid Channel", "@midchannel", "You can clip my videos and post them anywhere, just credit me", { subscriberCount: "250000", viewCount: "40000000", videoCount: "300" }),
  UCnohandle: ch("UCnohandle", "No Handle", undefined, "Clips welcome", { subscriberCount: "9000000", viewCount: "1", videoCount: "1" }),
  UCappr: ch("UCappr", "Approved", "@approvedyt", "", { subscriberCount: "1", viewCount: "1", videoCount: "1" }),
  UCclash: ch("UCclash", "Clash", "@twitchguy", "", { subscriberCount: "7000000", viewCount: "1", videoCount: "1" }),
  UCsnooze: ch("UCsnooze", "Snoozed", "@snoozed", "", { subscriberCount: "1", viewCount: "1", videoCount: "1" }),
  UCnope: ch("UCnope", "Nope", "@nope", "No clips please. Clips welcome on my Patreon only", { subscriberCount: "5000000", viewCount: "1", videoCount: "1" }),
  UChidden: ch("UChidden", "Hidden", "@hidden", "Variety", { hiddenSubscriberCount: true, viewCount: "2000000000", videoCount: "50" }),
};

function stubYouTube(opts: { error?: { status: number; body: unknown } } = {}) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname !== "yt.test") return realFetch(input as string);
    calls.push(u);
    assert.equal(u.searchParams.get("key"), "yt-key");
    if (opts.error) return json(opts.error.body, opts.error.status);
    if (u.pathname.endsWith("/videos")) {
      assert.equal(u.searchParams.get("chart"), "mostPopular");
      assert.equal(u.searchParams.get("regionCode"), "US");
      assert.equal(u.searchParams.get("maxResults"), "50");
      return json({ items: CHARTS[u.searchParams.get("videoCategoryId") ?? ""] ?? [] });
    }
    if (u.pathname.endsWith("/channels")) {
      const ids = u.searchParams.get("id")!.split(",");
      assert.ok(ids.length <= 50);
      return json({ items: ids.map((id) => CHANNELS[id]).filter(Boolean) });
    }
    return json({ error: { message: "not found" } }, 404);
  }) as typeof fetch;
  return calls;
}

async function seed() {
  const { prisma } = await import("../src/lib/db");
  await prisma.suggestion.deleteMany({});
  await prisma.streamer.deleteMany({});
  await prisma.settings.upsert({ where: { id: "main" }, update: { scoutPaused: false, ytSuggestRegion: "US" }, create: { id: "main" } });
  await prisma.streamer.create({ data: { twitchId: "yt:UCappr", platform: "youtube", login: "approvedyt", name: "Approved", approved: true, approvalNote: "campaign" } });
  // A Twitch streamer already owns the login "twitchguy" → the YouTube @twitchguy must be skipped, not crash.
  const tw = await prisma.streamer.create({ data: { twitchId: "tw1", login: "twitchguy", name: "TwitchGuy" } });
  await prisma.suggestion.create({ data: { streamerId: tw.id, score: 5, reasons: "[]" } }); // a pending Twitch suggestion
  const sn = await prisma.streamer.create({ data: { twitchId: "yt:UCsnooze", platform: "youtube", login: "snoozed", name: "Snoozed" } });
  await prisma.suggestion.create({ data: { streamerId: sn.id, platform: "youtube", score: 99, reasons: "[]", status: "dismissed", dismissedUntil: new Date(Date.now() + 20 * DAY) } });
}

test("YouTube score formula", async () => {
  const { youtubeSuggestionScore } = await import("../src/workers/suggest-youtube");
  assert.equal(youtubeSuggestionScore({ subscribers: 0, trendingViews: 0, trendingCount: 0, evidence: false }), 0);
  assert.ok(Math.abs(youtubeSuggestionScore({ subscribers: 99, trendingViews: 999, trendingCount: 9, evidence: true }) - (4 + 4.5 + 3 + 2)) < 1e-9);
});

test("permission: YouTube description wording", async () => {
  const { findDescriptionEvidence, approvalReasonFromEvidence } = await import("../src/lib/permission");
  for (const t of ["clips allowed", "Join our clipping program", "Clippers program on Whop", "you can clip my videos", "Clip my videos and post them"]) {
    assert.ok(findDescriptionEvidence(t), t);
  }
  for (const t of ["You can't clip my videos", "you cannot clip my content", "don't clip my videos", "no clips. clipping program soon"]) {
    assert.equal(findDescriptionEvidence(t), null, t);
  }
  assert.equal(approvalReasonFromEvidence({ evidence: "Clips welcome!", evidenceSource: "description" }), 'Channel description says: "Clips welcome!"');
});

test("scan: ranked, exclusions, no-handle and clash skipped, evidence, reasons, Twitch rows untouched", async () => {
  await seed();
  process.env.YOUTUBE_API_KEY = "yt-key";
  const { prisma } = await import("../src/lib/db");
  const { runSuggestScan } = await import("../src/workers/suggest");
  const { youtubeSuggestionScore } = await import("../src/workers/suggest-youtube");
  const calls = stubYouTube();
  const msg = await runSuggestScan();
  assert.match(msg, /^Twitch: keys missing \(skipped\) · YouTube: 4 suggestions \(4 new\)/);
  assert.match(msg, /1 without an @handle skipped/);
  assert.match(msg, /1 name clash skipped/);
  assert.equal(calls.filter((u) => u.pathname.endsWith("/videos")).length, 4);
  const chCalls = calls.filter((u) => u.pathname.endsWith("/channels"));
  assert.equal(chCalls.length, 1);
  const asked = chCalls[0].searchParams.get("id")!.split(",");
  assert.ok(!asked.includes("UCappr") && !asked.includes("UCsnooze"), "approved + snoozed not even looked up");

  const pending = await prisma.suggestion.findMany({ where: { status: "pending", platform: "youtube" }, orderBy: { score: "desc" }, include: { streamer: true } });
  assert.deepEqual(pending.map((p) => p.streamer.login), ["bigchannel", "hidden", "nope", "midchannel"]);
  const [big, hidden, nope, mid] = pending;

  assert.equal(big.streamer.platform, "youtube");
  assert.equal(big.streamer.twitchId, "yt:UCbig");
  assert.equal(big.streamer.name, "Big Channel");
  assert.equal(big.streamer.profileImage, "https://yt3/UCbig.jpg");
  assert.equal(big.streamer.approved, false);
  assert.equal(big.evidence, "Clips welcome! Tag me on Shorts");
  assert.equal(big.evidenceSource, "description");
  assert.equal(big.subscribers, 12_400_000);
  assert.equal(big.videoId, "trend1");
  assert.equal(big.videoViews, 8_100_000);
  assert.ok(Math.abs(big.score - youtubeSuggestionScore({ subscribers: 12_400_000, trendingViews: 8_100_000, trendingCount: 2, evidence: true })) < 1e-9);
  assert.deepEqual(JSON.parse(big.reasons), [
    "12.4M subscribers", "trending now: 'I survived 100 days in GTA 6 and this is what hap…' (8.1M views)", "2 videos trending", "description: 'Clips welcome'",
  ]);

  assert.equal(hidden.subscribers, null);
  assert.deepEqual(JSON.parse(hidden.reasons), ["subscribers hidden (scored on 2B channel views)", "trending now: 'Hidden subs' (6M views)"]);
  assert.ok(Math.abs(hidden.score - youtubeSuggestionScore({ subscribers: 2_000_000, trendingViews: 6_000_000, trendingCount: 1, evidence: false })) < 1e-9);
  assert.equal(nope.evidence, null, "a 'no clips' in the description cancels");
  assert.equal(mid.evidence, "You can clip my videos and post them anywhere, just credit me");

  // Excluded / skipped.
  assert.equal(await prisma.streamer.count({ where: { twitchId: { in: ["yt:UCnohandle", "yt:UCclash"] } } }), 0);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { login: "twitchguy" } })).platform, "twitch");
  assert.equal((await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "yt:UCsnooze" } } })).status, "dismissed");
  assert.equal(await prisma.suggestion.count({ where: { streamer: { twitchId: "yt:UCappr" } } }), 0);
  assert.equal(await prisma.suggestion.count({ where: { platform: "twitch", status: "pending" } }), 1, "Twitch suggestion left alone");
  assert.deepEqual((await prisma.streamer.findMany({ where: { approved: true } })).map((s) => s.login), ["approvedyt"]);

  // Status for the YouTube tab.
  const { getStatuses } = await import("../src/lib/queues");
  const st = await getStatuses();
  assert.equal(st.suggest_youtube.ok, true);
  assert.match(st.suggest_youtube.msg, /^4 suggestions/);

  // Rerun at once: fresh ones aren't re-looked-up or duplicated.
  const calls2 = stubYouTube();
  await runSuggestScan();
  const again = calls2.filter((u) => u.pathname.endsWith("/channels")).flatMap((u) => u.searchParams.get("id")!.split(","));
  assert.deepEqual(again.sort(), ["UCclash", "UCnohandle"], "only the skipped ones are looked up again");
  assert.equal(await prisma.suggestion.count({ where: { platform: "youtube", status: "pending" } }), 4);
});

test("approving a YouTube suggestion is one click (no reason), uses the normal approve path and pokes the YouTube scanner", async () => {
  await seed();
  process.env.YOUTUBE_API_KEY = "yt-key";
  const { prisma } = await import("../src/lib/db");
  const { queue } = await import("../src/lib/queues");
  stubYouTube();
  await (await import("../src/workers/suggest")).runSuggestScan();
  const actions = await import("../app/actions");
  const big = await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "yt:UCbig" } } });
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "yt:UCbig" } })).approved, false);

  await queue("youtube").drain();
  // No form at all (the card's Approve button): the description quote is stored as the note.
  const r = await actions.approveSuggestion(big.id, null);
  assert.match(r.ok!, /Big Channel approved/);
  const s = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "yt:UCbig" } });
  assert.equal(s.approved, true);
  assert.equal(s.platform, "youtube");
  assert.equal(s.approvalNote, 'Channel description says: "Clips welcome! Tag me on Shorts"');
  assert.equal((await prisma.suggestion.findUniqueOrThrow({ where: { id: big.id } })).status, "approved");
  assert.ok((await queue("youtube").getWaitingCount()) >= 1, "YouTube scanner poked");

  const mid = await prisma.suggestion.findFirstOrThrow({ where: { streamer: { twitchId: "yt:UCmid" } } });
  await actions.dismissSuggestion(mid.id);
  await prisma.$executeRawUnsafe(`UPDATE "Suggestion" SET "updatedAt" = ${Date.now() - 2 * 3600_000}`);
  stubYouTube();
  await (await import("../src/workers/suggest")).runSuggestScan();
  const logins = (await prisma.suggestion.findMany({ where: { status: "pending", platform: "youtube" }, include: { streamer: true } })).map((p) => p.streamer.login);
  assert.ok(!logins.includes("bigchannel") && !logins.includes("midchannel"), logins.join());
  assert.ok(logins.includes("hidden"));
});

test("no YouTube key: Twitch part still runs, YouTube skipped with a status note", async () => {
  await seed();
  Object.assign(process.env, { TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret" });
  const { prisma } = await import("../src/lib/db");
  const ytCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "yt.test") { ytCalls.push(u.href); return json({}); }
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname.endsWith("/streams")) return json({ data: [{ id: "s1", user_id: "tbig", user_login: "tbig", user_name: "TBig", game_id: "1", game_name: "Just Chatting", title: "hi", viewer_count: 30_000, started_at: new Date().toISOString(), thumbnail_url: "" }], pagination: {} });
    if (u.pathname.endsWith("/users")) return json({ data: [{ id: "tbig", login: "tbig", display_name: "TBig", profile_image_url: "", description: "" }] });
    return json({ data: [], pagination: {} });
  }) as typeof fetch;
  const msg = await (await import("../src/workers/suggest")).runSuggestScan();
  assert.match(msg, /^Twitch: 2 suggestions \(1 new\).* · YouTube: no API key \(skipped\)/);
  assert.equal(ytCalls.length, 0);
  assert.equal(await prisma.suggestion.count({ where: { platform: "twitch", status: "pending", streamer: { twitchId: "tbig" } } }), 1);
  const { getStatuses } = await import("../src/lib/queues");
  assert.match((await getStatuses()).suggest_youtube.msg, /no API key/);
});

test("YouTube errors: quota / bad key are plain messages; an unexpected error doesn't stop the Twitch part", async () => {
  await seed();
  process.env.YOUTUBE_API_KEY = "yt-key";
  const { prisma } = await import("../src/lib/db");
  const { runSuggestScan } = await import("../src/workers/suggest");

  stubYouTube({ error: { status: 403, body: { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }] } } } });
  assert.match(await runSuggestScan(), /YouTube: daily API quota used up — it resets at midnight Pacific$/);
  assert.equal((await (await import("../src/lib/queues")).getStatuses()).suggest_youtube.ok, true);

  stubYouTube({ error: { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } } } });
  assert.match(await runSuggestScan(), /YouTube: the API key was rejected — check YOUTUBE_API_KEY in \.env$/);

  // A 500 on every chart is unexpected: the job fails (red status), but the Twitch part ran first.
  Object.assign(process.env, { TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "yt.test") return json({ error: { message: "backend error" } }, 500);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname.endsWith("/streams")) return json({ data: [{ id: "s1", user_id: "tbig", user_login: "tbig", user_name: "TBig", game_id: "1", game_name: "Just Chatting", title: "hi", viewer_count: 30_000, started_at: new Date().toISOString(), thumbnail_url: "" }], pagination: {} });
    if (u.pathname.endsWith("/users")) return json({ data: [{ id: "tbig", login: "tbig", display_name: "TBig", profile_image_url: "", description: "" }] });
    return json({ data: [], pagination: {} });
  }) as typeof fetch;
  await assert.rejects(runSuggestScan(), /Twitch: 2 suggestions.* · YouTube: failed: no YouTube chart loaded/);
  assert.equal(await prisma.suggestion.count({ where: { streamer: { twitchId: "tbig" } } }), 1);
  const st = await (await import("../src/lib/queues")).getStatuses();
  assert.equal(st.suggest_twitch.ok, true);
  assert.equal(st.suggest_youtube.ok, false);
});
