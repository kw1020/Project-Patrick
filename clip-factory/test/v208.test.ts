import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toV207Schema } from "./schema-v173";
import { captionPeaks, captionSignals, parseVtt, skipZones } from "../src/lib/yt-captions";
import { BIG_SUBS, bioYouTubeLinks, linksBackToTwitch, matchConfidence } from "../src/lib/yt-match";
import { creatorLinks } from "../src/lib/creators";

// v2.0.8 YouTube scout: find approved Twitch creators' YouTube channels (sure -> approved row, maybe -> Suggestions) and clip
// normal videos from their auto-captions when there is no "most replayed" heatmap yet. Fake yt-dlp (env YTDLP) + fetch stubs.
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const VTT = path.join(__dirname, "fixtures", "yt-captions.vtt");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v208-"));
const fixtures = path.join(dir, "fixtures.json");
const calls = path.join(dir, "calls.log");
const realFetch = globalThis.fetch;
const now = () => Math.floor(Date.now() / 1000);

const id = (s: string) => ("UC" + s + "0".repeat(22)).slice(0, 24);
const UC = { kai: id("kailive"), fan: id("kaifan"), big: id("bigname"), small: id("smallguy"), clip: id("clipper"), clips: id("clipperclips"), nokey: id("nokey") };
const API: Record<string, { customUrl: string; title: string; subs: number | null; description: string }> = {
  [UC.kai]: { customUrl: "@kaicenatlive", title: "Kai Cenat Live", subs: 1000, description: "my live channel" },
  [UC.fan]: { customUrl: "@kaicenatfan", title: "Kai Cenat Fan", subs: 50_000, description: "fan page" },
  [UC.big]: { customUrl: "@bigname", title: "Big Name", subs: 5_000_000, description: "videos every week" },
  [UC.small]: { customUrl: "@smallguy", title: "Small Guy", subs: 2_000, description: "hi" },
  [UC.clip]: { customUrl: "@clipper", title: "Clipper", subs: 50_000, description: "Live every day on twitch.tv/clipper !" },
  [UC.clips]: { customUrl: "@clipperclips", title: "Clipper Clips", subs: 20_000, description: "Best of https://www.twitch.tv/Clipper" },
};
const SEARCH: Record<string, string[]> = { "Kai Cenat": [UC.fan, UC.kai], Clipper: [UC.clips], "Big Name": [UC.big], "Small Guy": [] };
const BIOS: Record<string, string> = { "101": "Main YT: https://youtube.com/@KaiCenatLive and IG", "102": "", "103": "", "104": "", "105": "paused guy", "107": "" };
let apiCalls: string[] = [];

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (u.host === "tw.test" && u.pathname === "/token") return json({ access_token: "t", expires_in: 3600 });
    if (u.host === "tw.test" && u.pathname === "/helix/users") {
      return json({ data: u.searchParams.getAll("id").map((i) => ({ id: i, login: "x", display_name: "x", profile_image_url: "", description: BIOS[i] ?? "" })) });
    }
    if (u.host === "yt.test") {
      apiCalls.push(u.pathname + "?" + [...u.searchParams].filter(([k]) => k !== "key").map(([k, v]) => `${k}=${v}`).join("&"));
      const item = (cid: string) => ({ id: cid, snippet: { title: API[cid].title, customUrl: API[cid].customUrl, description: API[cid].description, thumbnails: { default: { url: `http://img/${cid}` } } },
        statistics: API[cid].subs == null ? { hiddenSubscriberCount: true } : { subscriberCount: String(API[cid].subs) } });
      if (u.pathname.endsWith("/channels")) {
        const h = u.searchParams.get("forHandle");
        if (h) return json({ items: Object.keys(API).filter((c) => API[c].customUrl === h.toLowerCase()).map(item) });
        return json({ items: (u.searchParams.get("id") ?? "").split(",").filter((c) => API[c]).map(item) });
      }
      if (u.pathname.endsWith("/search")) return json({ items: (SEARCH[u.searchParams.get("q") ?? ""] ?? []).map((c) => ({ id: { channelId: c } })) });
      if (u.pathname.endsWith("/videos")) return json({ items: [] }); // trending charts: empty
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

before(async () => {
  fs.writeFileSync(fixtures, JSON.stringify({
    lists: {
      "/@nokey/videos": { id: UC.nokey, channel_id: UC.nokey, channel: "NoKey", uploader_id: "@NoKey", title: "NoKey - Videos", channel_follower_count: 300_000, description: "gaming", entries: [] },
      "ytsearch5:": { id: "NoKey", entries: [] },
      [`/channel/${UC.kai}/videos`]: { id: UC.kai, entries: [{ id: "vidCAP", title: "We robbed the bank", duration: 290 }] },
      [`/channel/${UC.clip}/videos`]: { id: UC.clip, entries: [{ id: "vidH2", title: "Heist part 2", duration: 600 }] },
      [`/channel/${UC.clips}/videos`]: { id: UC.clips, entries: [{ id: "vidH3", title: "Best clips", duration: 600 }] },
    },
    videos: {
      vidCAP: { id: "vidCAP", title: "We robbed the bank", duration: 290, view_count: 5000, timestamp: now() - 7200, heatmap: null, categories: ["Gaming"] },
      vidH2: { id: "vidH2", title: "Heist part 2", duration: 600, view_count: 9000, timestamp: now() - 86400, categories: ["Gaming"],
        heatmap: Array.from({ length: 100 }, (_, i) => ({ start_time: i * 6, end_time: i * 6 + 6, value: [20, 50, 80].includes(i) ? 0.9 : 0.1 })) },
      vidH3: { id: "vidH3", title: "Best clips", duration: 600, view_count: 9000, timestamp: now() - 86400, categories: ["Gaming"],
        heatmap: Array.from({ length: 100 }, (_, i) => ({ start_time: i * 6, end_time: i * 6 + 6, value: i === 40 ? 0.9 : 0.1 })) },
    },
    captions: { vidCAP: VTT },
  }));
  const fake = path.join(dir, "fake-ytdlp.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixtures)}, "utf8"));
const url = a[a.length - 1];
if (a.includes("--write-auto-subs")) {
  const id = new URL(url).searchParams.get("v");
  const o = a[a.indexOf("-o") + 1];
  if (fx.captions[id]) fs.copyFileSync(fx.captions[id], o.replace("%(id)s", id).replace("%(ext)s", "en.vtt"));
  process.exit(0);
}
if (a.includes("--flat-playlist")) {
  const key = Object.keys(fx.lists).find((k) => url.includes(k));
  if (!key) { console.error("ERROR: [youtube:tab] This channel does not exist."); process.exit(1); }
  const j = fx.lists[key]; const n = a.includes("--playlist-end") ? Number(a[a.indexOf("--playlist-end") + 1]) : 99;
  console.log(JSON.stringify({ ...j, entries: j.entries.slice(0, n) }));
} else if (a.includes("--skip-download")) {
  const id = new URL(url).searchParams.get("v");
  if (!fx.videos[id]) { console.error("ERROR: [youtube] " + id + ": Video unavailable"); process.exit(1); }
  console.log(JSON.stringify(fx.videos[id]));
} else { process.exit(1); }
`);
  fs.chmodSync(fake, 0o755);
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/1",
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_API_URL: "http://tw.test/helix", TWITCH_AUTH_URL: "http://tw.test/token",
    YOUTUBE_API_URL: "http://yt.test/youtube/v3", YOUTUBE_API_KEY: "k", MAX_BACKLOG: "12", MIN_FREE_GB: "0", YTDLP: fake,
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
});
afterEach(() => { globalThis.fetch = realFetch; });
after(async () => {
  const { prisma } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
const readCalls = (): string[][] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------- captions (pure) ----------
test("parseVtt: YouTube's rolling lines once each, 10ms repeat cues dropped, a line said twice in a row kept twice", () => {
  const lines = parseVtt(fs.readFileSync(VTT, "utf8"));
  assert.equal(lines.length, 40);
  assert.deepEqual(lines.slice(0, 3).map((l) => [l.start, l.text]), [[0.2, "[Music]"], [3.1, "what is up guys welcome back to the channel"], [6.4, "OH MY GOD LOOK AT THIS"]]);
  assert.equal(lines.filter((l) => l.text === "[Music]").length, 6);
  assert.equal(lines.find((l) => l.start === 166)!.text, "LET'S GO WE GOT IT"); // entities + inline <00:..><c> tags removed
  assert.equal(new Set(lines.map((l) => `${l.start}|${l.text}`)).size, lines.length);
  assert.deepEqual(parseVtt("WEBVTT\n\nnothing here"), []);
});

test("captionPeaks: laughter / screaming / reaction words / ALL CAPS; no intro, sponsor read or outro; 45s apart; snippet for the Judge", () => {
  const lines = parseVtt(fs.readFileSync(VTT, "utf8"));
  const peaks = captionPeaks(lines, 290, 3);
  assert.deepEqual(peaks.map((p) => p.center), [168, 61]); // the heist scream, then the car flip laugh
  assert.match(peaks[0].snippet, /LET'S GO WE GOT IT \/ \[Screaming\]/);
  assert.ok(peaks[0].signals.some((s) => s.includes("shouting")) && peaks[0].signals.includes("[screaming]"));
  assert.ok(peaks[1].signals.includes("[laughter] x2"));
  assert.ok(peaks.every((p) => p.value > 0 && p.value <= 1));
  assert.deepEqual(captionPeaks(lines, 290, 1).map((p) => p.center), [168]);
  // 6.4s "OH MY GOD" is the intro (first 20s), 109s is inside the sponsor read, 270s is the outro: never moments.
  const zones = skipZones(lines, 290);
  assert.ok(zones.some(([a, b]) => a <= 109 && b >= 121), "sponsor read zone");
  assert.ok(zones.some(([a, b]) => a <= 270 && b >= 290), "outro zone");
  assert.ok(captionSignals(lines).some((s) => s.at === 270.5 && s.label === "[laughter]"), "the outro laugh is a signal, only its zone blocks it");
  // 192s ([Laughter] bro) is a real signal but 24s from 168s: deduped (45s apart). Music alone never makes a moment.
  assert.ok(!peaks.some((p) => Math.abs(p.center - 192) < 5));
  assert.deepEqual(captionPeaks(parseVtt("WEBVTT\n\n00:01:00.000 --> 00:01:05.000\n[Music]\n\n00:01:05.000 --> 00:01:09.000\n[Music]\n\n00:01:09.000 --> 00:01:12.000\n[Music]\n"), 600, 3), []);
  assert.deepEqual(captionPeaks([], 600, 3), []);
});

// ---------- matching (pure) ----------
test("matchConfidence: sure only by a link either way or the exact name + a big channel", () => {
  const tw = { login: "kaicenat", name: "Kai Cenat", bio: "YT: youtube.com/@KaiCenatLive" };
  const cand = (o: Partial<{ channelId: string; handle: string; title: string; subscribers: number | null; description: string }>) =>
    ({ channelId: UC.big, handle: "x", title: "x", subscribers: null, description: "", ...o });
  assert.deepEqual(bioYouTubeLinks("a youtube.com/@Foo_Bar. b https://www.youtube.com/channel/" + UC.big + " c youtube.com/c/Thing"),
    { handles: ["foo_bar"], ids: [UC.big], other: ["https://www.youtube.com/c/Thing"] });
  assert.equal(linksBackToTwitch("watch me at https://www.TWITCH.tv/KaiCenat!", "kaicenat"), true);
  assert.equal(linksBackToTwitch("twitch.tv/kaicenatfan", "kaicenat"), false);

  // 1. The Twitch bio links it (even a small channel with another name).
  assert.equal(matchConfidence(tw, cand({ handle: "kaicenatlive", title: "Kai Cenat Live", subscribers: 10 }))?.confident, true);
  // 2. It links back to twitch.tv/<login>; a clips channel counts this way and is labelled "second".
  const back = matchConfidence({ login: "clipper", name: "Clipper" }, cand({ handle: "clipperclips", title: "Clipper Clips", subscribers: 5, description: "twitch.tv/clipper" }));
  assert.deepEqual(back, { confident: true, reason: "the channel links back to twitch.tv/clipper", kind: "second" });
  // 3. Exact name + big channel; exact name + small/hidden = only a maybe.
  assert.equal(matchConfidence(tw, cand({ handle: "kai_cenat", title: "Someone", subscribers: BIG_SUBS }))?.confident, true);
  assert.equal(matchConfidence(tw, cand({ handle: "kaicenat", title: "Kai Cenat", subscribers: BIG_SUBS - 1 }))?.confident, false);
  assert.equal(matchConfidence(tw, cand({ handle: "kaicenat", title: "Kai Cenat", subscribers: null }))?.confident, false);
  // A clips channel by name alone, however big, is only a maybe.
  const clips = matchConfidence(tw, cand({ handle: "kaicenatclips", title: "Kai Cenat Clips", subscribers: 9_000_000 }));
  assert.deepEqual([clips?.confident, clips?.kind], [false, "second"]);
  // Somebody else.
  assert.equal(matchConfidence(tw, cand({ handle: "mrbeast", title: "MrBeast", subscribers: 300_000_000 })), null);
});

test("creatorLinks: a Twitch row shows its approved YouTube channels (main first), a YouTube row its Twitch", () => {
  const rows = [
    { id: "t1", login: "clipper", name: "Clipper", platform: "twitch", approved: true, youtubeId: "y2", linkedFromId: null },
    { id: "y1", login: "clipperclips", name: "Clipper Clips", platform: "youtube", approved: true, youtubeId: null, linkedFromId: "t1" },
    { id: "y2", login: "clipper", name: "Clipper", platform: "youtube", approved: true, youtubeId: null, linkedFromId: "t1" },
    { id: "y3", login: "removed", name: "Removed", platform: "youtube", approved: false, youtubeId: null, linkedFromId: "t1" },
  ];
  const m = creatorLinks(rows);
  assert.deepEqual(m.get("t1")!.map((x) => x.id), ["y2", "y1"]);
  assert.deepEqual(m.get("y1")!.map((x) => x.login), ["clipper"]);
});

// ---------- the scout against stubs ----------
test("scout: sure matches become approved YouTube rows linked to the Twitch creator; maybes go to Suggestions; paused/unapproved never looked up", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runYouTubeScout, autoNote } = await import("../src/workers/yt-scout");
  const tw = (twitchId: string, login: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.streamer.create({ data: { twitchId, login, name, platform: "twitch", approved: true, approvedAt: new Date(), ...extra } });
  const kai = await tw("101", "kaicenat", "Kai Cenat", { followers: 9 });
  const big = await tw("102", "bigname", "Big Name");
  const small = await tw("103", "smallguy", "Small Guy");
  const clipper = await tw("104", "clipper", "Clipper");
  const paused = await tw("105", "pausedguy", "Paused Guy", { paused: true });
  const notApproved = await prisma.streamer.create({ data: { twitchId: "106", login: "random", name: "Random", platform: "twitch" } });
  stubFetch();
  apiCalls = [];
  const msg = await runYouTubeScout({ manual: true });
  assert.match(msg, /checked 4 creators: 4 YouTube channels linked, 1 in Suggestions/);

  const yt = async (cid: string) => prisma.streamer.findUnique({ where: { twitchId: `yt:${cid}` } });
  const kaiYt = (await yt(UC.kai))!;
  assert.deepEqual({ a: kaiYt.approved, p: kaiYt.platform, l: kaiYt.login, n: kaiYt.approvalNote, f: kaiYt.linkedFromId },
    { a: true, p: "youtube", l: "kaicenatlive", n: "Same creator as approved Twitch @kaicenat (linked automatically)", f: kai.id });
  assert.equal(autoNote("kaicenat"), kaiYt.approvalNote);
  assert.equal(await yt(UC.fan), null, "a fan channel found by search is not even suggested once the real one is sure");
  assert.equal((await yt(UC.big))!.approved, true);
  // Clipper: the main channel AND the clips channel (both link back); the Twitch row points at the main one.
  assert.equal((await yt(UC.clips))!.linkedFromId, clipper.id);
  const rows = Object.fromEntries((await prisma.streamer.findMany({ where: { platform: "twitch" } })).map((s) => [s.login, s]));
  assert.equal(rows.kaicenat.youtubeId, kaiYt.id);
  assert.equal(rows.clipper.youtubeId, (await yt(UC.clip))!.id);
  assert.equal(rows.bigname.youtubeId, (await yt(UC.big))!.id);
  assert.match(rows.kaicenat.ytLookupNote!, /found @kaicenatlive \(their Twitch bio links/);
  // Small Guy: exact name but 2K subs -> a maybe card on the YouTube tab, nothing approved.
  const smallYt = (await yt(UC.small))!;
  assert.equal(smallYt.approved, false);
  const sg = await prisma.suggestion.findUniqueOrThrow({ where: { streamerId: smallYt.id } });
  assert.deepEqual({ p: sg.platform, s: sg.status, l: sg.linkedFromId }, { p: "youtube", s: "pending", l: small.id });
  assert.match(sg.reasons, /maybe the YouTube of Twitch @smallguy/);
  assert.equal(rows.smallguy.youtubeId, null);
  assert.match(rows.smallguy.ytLookupNote!, /maybe @smallguy \(in Suggestions\)/);
  assert.equal(rows.pausedguy.ytLookupAt, null);
  assert.equal(rows.random.ytLookupAt, null);
  void paused; void notApproved; void big;
  // forHandle first (1 unit each), one search.list per creator.
  assert.equal(apiCalls.filter((c) => c.startsWith("/youtube/v3/search")).length, 4);
  assert.ok(apiCalls.some((c) => c.includes("forHandle=@kaicenatlive")), "the bio link is looked up by its handle");

  // Run again: everyone was just checked -> nothing looked up, no API calls.
  apiCalls = [];
  assert.match(await runYouTubeScout({ manual: true }), /has been checked/);
  assert.equal(apiCalls.length, 0);

  // The hourly trending scan never wipes the scout's cards.
  const { runYouTubeSuggestScan } = await import("../src/workers/suggest-youtube");
  await runYouTubeSuggestScan("US");
  assert.equal((await prisma.suggestion.findUniqueOrThrow({ where: { id: sg.id } })).status, "pending");

  // One click on the card: approved like any suggestion, and linked to the Twitch creator.
  const { approveSuggestion } = await import("../app/actions");
  assert.match((await approveSuggestion(sg.id, null)).ok!, /Small Guy approved/);
  assert.equal((await yt(UC.small))!.linkedFromId, small.id);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: small.id } })).youtubeId, smallYt.id);

  // Creators page: both sides shown.
  const { creatorStats } = await import("../src/lib/creators");
  const cs = Object.fromEntries((await creatorStats()).map((c) => [`${c.platform}:${c.login}`, c]));
  assert.deepEqual(cs["twitch:kaicenat"].linked!.map((l) => l.login), ["kaicenatlive"]);
  assert.deepEqual(cs["twitch:clipper"].linked!.map((l) => l.login).sort(), ["clipper", "clipperclips"]);
  assert.deepEqual(cs["youtube:kaicenatlive"].linked!.map((l) => `${l.platform}:${l.login}`), ["twitch:kaicenat"]);

  // Krew removes the auto-linked Big Name channel: a later look-up never approves it again.
  const { removeStreamer } = await import("../app/actions");
  await removeStreamer((await yt(UC.big))!.id);
  await prisma.streamer.update({ where: { id: big.id }, data: { youtubeId: null, ytLookupAt: null } });
  stubFetch();
  assert.match(await runYouTubeScout({ manual: true }), /checked 1 creator: 0 YouTube channels linked/);
  assert.equal((await yt(UC.big))!.approved, false);
  assert.match((await prisma.streamer.findUniqueOrThrow({ where: { id: big.id } })).ytLookupNote!, /you removed this channel before/);
});

test("scout without a YouTube key: yt-dlp @handle + ytsearch; the daily limit holds", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runYouTubeScout, SCOUT_DAILY } = await import("../src/workers/yt-scout");
  const { redis } = await import("../src/lib/queues");
  delete process.env.YOUTUBE_API_KEY;
  const nk = await prisma.streamer.create({ data: { twitchId: "107", login: "nokey", name: "NoKey", platform: "twitch", approved: true } });
  stubFetch();
  fs.rmSync(calls, { force: true });
  apiCalls = [];
  assert.match(await runYouTubeScout({ manual: true }), /1 YouTube channel linked/);
  const row = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${UC.nokey}` } });
  assert.deepEqual([row.approved, row.login, row.linkedFromId], [true, "nokey", nk.id]); // same name + 300K subscribers
  assert.equal(apiCalls.length, 0);
  const args = readCalls().map((a) => a.at(-1));
  assert.ok(args.includes("https://www.youtube.com/@nokey/videos"));
  assert.ok(args.includes("ytsearch5:NoKey"));
  process.env.YOUTUBE_API_KEY = "k";

  // Daily limit: the schedule stops at SCOUT_DAILY creators a day.
  await prisma.streamer.create({ data: { twitchId: "108", login: "later", name: "Later", platform: "twitch", approved: true } });
  await redis().set(`cf:ytscout:creators:${new Date().toISOString().slice(0, 10)}`, String(SCOUT_DAILY));
  assert.match(await runYouTubeScout(), /daily limit reached \(15 creators a day\), 1 left for tomorrow/);
});

// ---------- the scanner's captions route ----------
test("scanner: no heatmap -> captions route (moments carry the caption snippet), heatmap still first; per-creator cap shared by linked channels", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runYouTubeScan } = await import("../src/workers/youtube");
  await prisma.settings.upsert({ where: { id: "main" }, update: { maxPerCreatorPerRun: 1 }, create: { id: "main", maxPerCreatorPerRun: 1 } });
  fs.rmSync(calls, { force: true });
  const msg1 = await runYouTubeScan();
  assert.match(msg1, /1 from captions \(no most-replayed data yet\)/);
  const kaiYt = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${UC.kai}` } });
  let cap = await prisma.moment.findMany({ where: { streamerId: kaiYt.id }, include: { clips: true }, orderBy: { vodOffset: "asc" } });
  assert.deepEqual(cap.map((m) => m.vodOffset), [168]); // the best caption peak first; cap 1
  const st = JSON.parse(cap[0].stats!);
  assert.equal(st.kind, "captions");
  assert.match(st.captions, /\[Screaming\]/);
  assert.equal(cap[0].source, "youtube");
  assert.equal(cap[0].sourceUrl, "https://www.youtube.com/watch?v=vidCAP");
  assert.equal(cap[0].clips[0].status, "processing");
  assert.equal((await prisma.youTubeVideo.findUniqueOrThrow({ where: { id: "vidCAP" } })).status, "partial");
  const subCall = readCalls().find((a) => a.includes("--write-auto-subs"))!;
  assert.deepEqual(subCall.slice(0, 7), ["--skip-download", "--write-auto-subs", "--sub-langs", "en", "--sub-format", "vtt", "--no-warnings"]);
  // Heatmap videos never read captions.
  assert.ok(!readCalls().some((a) => a.includes("--write-auto-subs") && /vidH[23]/.test(a.at(-1)!)));
  // Clipper's two channels are one creator: 1 moment in total this scan.
  const clipperIds = (await prisma.streamer.findMany({ where: { twitchId: { in: [`yt:${UC.clip}`, `yt:${UC.clips}`] } } })).map((s) => s.id);
  assert.equal(await prisma.moment.count({ where: { streamerId: { in: clipperIds } } }), 1);

  // Next scan with cap 2: the second caption peak (45s+ away) is added, nothing twice.
  await prisma.settings.update({ where: { id: "main" }, data: { maxPerCreatorPerRun: 2 } });
  await runYouTubeScan();
  cap = await prisma.moment.findMany({ where: { streamerId: kaiYt.id }, include: { clips: true }, orderBy: { vodOffset: "asc" } });
  assert.deepEqual(cap.map((m) => m.vodOffset), [61, 168]);
  assert.match((await prisma.youTubeVideo.findUniqueOrThrow({ where: { id: "vidCAP" } })).note!, /2 caption peaks, 2 clipped/);

  // The Judge is told where the moment came from and what was said.
  const { judgeContent } = await import("../src/lib/judge");
  const text = judgeContent({ streamer: "Kai Cenat Live", durationSec: 30, source: "youtube", sourceTitle: "We robbed the bank", sourceViews: 5000, transcript: "x", stats: st, minScore: 7 }) as string;
  assert.match(text, /Found as: a reaction in a new YouTube video's auto-captions/);
  assert.match(text, /What the captions say around it: ".*\[Screaming\]/);

  // Streamers page line.
  const { ytScoutLine, ytScoutSummary } = await import("../src/lib/yt-scout-status");
  assert.match(ytScoutLine(await ytScoutSummary()), /^\d+ YouTube channels found \(\d+ of \d+ Twitch creators checked\) · \d+ videos checked · \d+ moments sent \(2 from captions\) in the last 24h$/);
});

// ---------- db push upgrade ----------
test("db push upgrade from the v2.0.7 schema (02b6d06) with rows: no prompt, rows kept, new columns null", () => {
  const nowSchema = fs.readFileSync(SCHEMA, "utf8");
  const old = toV207Schema(nowSchema);
  const git = spawnSync("git", ["show", "02b6d06:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 02b6d06 one");
  const uniques = (s: string) => (s.match(/@unique|@@unique|@@id/g) ?? []).length;
  assert.equal(uniques(nowSchema), uniques(old), "no new unique constraints");
  const up = path.join(dir, "upgrade");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "old.prisma"), old);
  const env = { ...process.env, DATABASE_URL: `file:${path.join(up, "krew.db")}` };
  const push = (schema: string) => spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schema], { env, encoding: "utf8" });
  const first = push(path.join(up, "old.prisma"));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const sql = (q: string) => execFileSync(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(env.DATABASE_URL)} } } });
    p.$queryRawUnsafe(${JSON.stringify(q)}).then((r) => { console.log(JSON.stringify(r, (k, v) => typeof v === "bigint" ? Number(v) : v)); return p.$disconnect(); });
  `], { encoding: "utf8", cwd: ROOT });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, 0, 0)`);
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('b', 'yt:UCx', 'kai', 'Kai', 'youtube', 0, 0, 0)`);
  sql(`INSERT INTO Suggestion (id, streamerId, platform, score, reasons, createdAt, updatedAt) VALUES ('s1', 'b', 'youtube', 5, '[]', 0, 0)`);
  sql(`INSERT INTO YouTubeVideo (id, streamerId, status, checkedAt) VALUES ('v1', 'b', 'no_heatmap', 0)`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, login, youtubeId, linkedFromId, ytLookupAt, ytLookupNote FROM Streamer ORDER BY id")), [
    { id: "a", login: "kai", youtubeId: null, linkedFromId: null, ytLookupAt: null, ytLookupNote: null },
    { id: "b", login: "kai", youtubeId: null, linkedFromId: null, ytLookupAt: null, ytLookupNote: null },
  ]);
  assert.deepEqual(JSON.parse(sql("SELECT id, linkedFromId FROM Suggestion")), [{ id: "s1", linkedFromId: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT id, status FROM YouTubeVideo")), [{ id: "v1", status: "no_heatmap" }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
