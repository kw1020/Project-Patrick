import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHeat } from "../src/lib/chat";

// YouTube scanner against a FAKE yt-dlp (env YTDLP): canned JSON for listings / -J, a real small mp4 for downloads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-yt-"));
const storage = path.join(dir, "storage");
const fixtures = path.join(dir, "fixtures.json");
const calls = path.join(dir, "calls.log");
const sample = path.join(dir, "sample.mp4");
const realFetch = globalThis.fetch;
const GOOD = "UCgood0000000000000000aa", OTHER = "UCother000000000000000bb";
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

/** Heatmap of a 600s video: 100 segments of 6s. Peaks at the very start/end must be ignored. */
function heatmap() {
  const v = new Map<number, number>([[0, 1.0], [594, 0.99], [120, 0.9], [126, 0.85], [300, 0.8], [450, 0.7], [198, 0.6]]);
  return Array.from({ length: 100 }, (_, i) => ({ start_time: i * 6, end_time: i * 6 + 6, value: v.get(i * 6) ?? 0.1 }));
}
const video = (id: string, title: string, ts: number, heat: unknown) => ({ id, title, duration: 600, view_count: 123456, timestamp: ts, heatmap: heat, channel_id: GOOD });

before(async () => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sample]);
  fs.writeFileSync(fixtures, JSON.stringify({
    // flat listing / channel resolve, keyed by a URL substring
    lists: {
      "/@GoodChan/videos": { id: GOOD, channel_id: GOOD, channel: "Good Channel", uploader_id: "@GoodChan", uploader_url: "https://www.youtube.com/@GoodChan", title: "Good Channel - Videos",
        thumbnails: [{ id: "0", url: "http://banner", width: 1060, height: 175 }, { id: "7", url: "http://avatar", width: 900, height: 900 }], entries: [] },
      [`/channel/${GOOD}/videos`]: { id: GOOD, entries: [
        { id: "vidHEAT", url: "https://www.youtube.com/watch?v=vidHEAT", title: "Heat video", duration: 600 },
        { id: "vidNOHEAT", url: "https://www.youtube.com/watch?v=vidNOHEAT", title: "Fresh video", duration: 600 },
        { id: "vidOLD", url: "https://www.youtube.com/watch?v=vidOLD", title: "Old video", duration: 600 },
      ] },
      [`/channel/${OTHER}/videos`]: { id: OTHER, entries: [{ id: "vidOTHER", title: "Not approved", duration: 600 }] },
    },
    videos: {
      vidHEAT: video("vidHEAT", "Heat video", now() - 2 * DAY, heatmap()),
      vidNOHEAT: video("vidNOHEAT", "Fresh video", now() - 3600, null),
      vidOLD: video("vidOLD", "Old video", now() - 40 * DAY, heatmap()),
      vidOTHER: video("vidOTHER", "Not approved", now() - DAY, heatmap()),
    },
  }));
  const fake = path.join(dir, "fake-ytdlp.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixtures)}, "utf8"));
const url = a[a.length - 1];
if (a.includes("--flat-playlist")) {
  const key = Object.keys(fx.lists).find((k) => url.includes(k));
  if (!key) { console.error("ERROR: [youtube:tab] This channel does not exist."); process.exit(1); }
  const j = fx.lists[key]; const n = Number(a[a.indexOf("--playlist-end") + 1]);
  console.log(JSON.stringify({ ...j, entries: j.entries.slice(0, n) }));
} else if (a.includes("--skip-download")) {
  const id = new URL(url).searchParams.get("v");
  if (!fx.videos[id]) { console.error("ERROR: [youtube] " + id + ": Video unavailable"); process.exit(1); }
  console.log(JSON.stringify(fx.videos[id]));
} else {
  const o = a[a.indexOf("-o") + 1].replace("%(ext)s", "mp4");
  fs.copyFileSync(${JSON.stringify(sample)}, o); console.log(o);
}
`);
  fs.chmodSync(fake, 0o755);
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, REDIS_URL: "redis://localhost:6379/9",
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: "gta6-id",
    MAX_BACKLOG: "12", MIN_FREE_GB: "0", YTDLP: fake,
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
const clearCalls = () => fs.rmSync(calls, { force: true });
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

test("pickPeaks: top-N by value, ≥60s apart, first 15s / last 20s ignored", async () => {
  const { pickPeaks } = await import("../src/lib/ytdlp");
  const peaks = pickPeaks(heatmap(), 600, 3);
  assert.deepEqual(peaks.map((p) => p.center), [123, 303, 453]); // 129 is too close to 123; 3 and 597 are edges
  assert.deepEqual(peaks.map((p) => p.value), [0.9, 0.8, 0.7]);
  assert.deepEqual(pickPeaks(heatmap(), 600, 5).map((p) => p.center), [123, 303, 453, 201, 15]);
  assert.deepEqual(pickPeaks([], 600, 3), []);
});

test("channelPageUrl understands @handles and channel links", async () => {
  const { channelPageUrl } = await import("../src/lib/ytdlp");
  assert.equal(channelPageUrl("@MrBeast"), "https://www.youtube.com/@MrBeast");
  assert.equal(channelPageUrl("MrBeast"), "https://www.youtube.com/@MrBeast");
  assert.equal(channelPageUrl("https://www.youtube.com/@MrBeast/videos"), "https://www.youtube.com/@MrBeast");
  assert.equal(channelPageUrl(`youtube.com/channel/${GOOD}`), `https://www.youtube.com/channel/${GOOD}`);
  assert.equal(channelPageUrl("https://twitch.tv/someone"), null);
});

test("approving a channel by @handle stores an approved youtube Streamer; errors are plain", async () => {
  const { prisma } = await import("../src/lib/db");
  const { addYouTubeChannel } = await import("../app/actions");
  const bad = await addYouTubeChannel(null, form({ channel: "@NoSuchChan", note: "x" }));
  assert.match(bad.error!, /couldn't find that channel \(\[youtube:tab\] This channel does not exist\.\)/);

  // One click, no note: approved with the default note.
  assert.match((await addYouTubeChannel(null, form({ channel: "@GoodChan", note: "" }))).ok!, /Good Channel/);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${GOOD}` } })).approvalNote, "Approved by Krew");

  const r = await addYouTubeChannel(null, form({ channel: "@GoodChan", note: "Runs a clipping campaign" }));
  assert.match(r.ok!, /Good Channel \(youtube\.com\/@GoodChan\) approved/);
  const s = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${GOOD}` } });
  assert.deepEqual({ platform: s.platform, login: s.login, name: s.name, approved: s.approved, note: s.approvalNote, img: s.profileImage },
    { platform: "youtube", login: "GoodChan", name: "Good Channel", approved: true, note: "Runs a clipping campaign", img: "http://avatar" });
  const resolve = readCalls().find((a) => a.at(-1)!.includes("@GoodChan"))!;
  assert.deepEqual(resolve.slice(0, 5), ["-J", "--no-warnings", "--flat-playlist", "--playlist-end", "1"]);
  assert.equal(resolve.at(-1), "https://www.youtube.com/@GoodChan/videos");
  // An unapproved channel that's in the table must never be scanned.
  await prisma.streamer.create({ data: { twitchId: `yt:${OTHER}`, platform: "youtube", login: "OtherChan", name: "Other", approved: false } });
});

test("scan: peaks from the heatmap video, backlog respected, rest next scan without duplicates", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runYouTubeScan } = await import("../src/workers/youtube");
  clearCalls();
  process.env.MAX_BACKLOG = "2"; // room for 2 of the 3 peaks
  const msg1 = await runYouTubeScan();
  assert.match(msg1, /1 channel, 1 videos checked, 2 peaks sent/);
  assert.match(msg1, /rest next scan/);
  let ms = await prisma.moment.findMany({ where: { source: "youtube" }, include: { clips: true }, orderBy: { vodOffset: "asc" } });
  assert.deepEqual(ms.map((m) => m.vodOffset), [123, 303]);
  const m0 = ms[0];
  assert.equal(m0.sourceUrl, "https://www.youtube.com/watch?v=vidHEAT");
  assert.equal(m0.sourceTitle, "Heat video");
  assert.equal(m0.sourceViews, 123456);
  assert.equal(m0.spikeScore, 0.9);
  assert.equal(m0.clips[0].status, "processing");
  assert.equal(m0.clips[0].title, "Heat video");
  assert.match(m0.clips[0].caption!, /Credit: Good Channel — https:\/\/youtube\.com\/@GoodChan/);
  assert.doesNotMatch(m0.clips[0].caption!, /twitch|GTA/i);
  assert.equal((await prisma.youTubeVideo.findUniqueOrThrow({ where: { id: "vidHEAT" } })).status, "partial");

  // The line frees up: only the missing peak is added; the no-heatmap video gets its turn and is skipped with a note.
  process.env.MAX_BACKLOG = "12";
  const msg2 = await runYouTubeScan();
  assert.match(msg2, /1 peaks sent/);
  assert.match(msg2, /"Fresh video" has no most-replayed data yet, skipped/);
  ms = await prisma.moment.findMany({ where: { source: "youtube" }, include: { clips: true }, orderBy: { vodOffset: "asc" } });
  assert.deepEqual(ms.map((m) => m.vodOffset), [123, 303, 453]);
  const vids = Object.fromEntries((await prisma.youTubeVideo.findMany()).map((v) => [v.id, v.status]));
  assert.deepEqual(vids, { vidHEAT: "done", vidNOHEAT: "no_heatmap", vidOLD: "old" });

  // Third scan: everything seen → no new moments, no new -J calls for them.
  clearCalls();
  assert.match(await runYouTubeScan(), /0 videos checked, 0 peaks/);
  assert.ok(!readCalls().some((a) => a.includes("--skip-download")));

  // Even if the "seen" record is lost, the same peaks are never clipped twice (sourceUrl + 30s dedupe).
  await prisma.youTubeVideo.deleteMany({ where: { id: "vidHEAT" } });
  assert.match(await runYouTubeScan(), /0 peaks sent/);
  assert.equal(await prisma.moment.count({ where: { source: "youtube" } }), 3);

  // The unapproved channel was never listed or fetched.
  const all = readCalls().flat().join(" ");
  assert.ok(!all.includes(OTHER) && !all.includes("vidOTHER"));
  assert.equal(await prisma.youTubeVideo.count({ where: { id: "vidOTHER" } }), 0);
});

test("scan: line full → nothing fetched; scanner off → nothing", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runYouTubeScan } = await import("../src/workers/youtube");
  await prisma.youTubeVideo.deleteMany({ where: { id: "vidNOHEAT" } });
  process.env.MAX_BACKLOG = "0";
  clearCalls();
  assert.match(await runYouTubeScan(), /line full/);
  assert.ok(!readCalls().some((a) => a.includes("--skip-download")));
  process.env.MAX_BACKLOG = "12";
  await prisma.settings.upsert({ where: { id: "main" }, update: { ytScanEnabled: false }, create: { id: "main", ytScanEnabled: false } });
  assert.match(await runYouTubeScan(), /^off/);
  await prisma.settings.update({ where: { id: "main" }, data: { ytScanEnabled: true } });
});

test("grabber downloads a 45s section around the peak; cutter burns youtube.com/@handle; Judge sees the source", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runGrab } = await import("../src/workers/grabber");
  const m = await prisma.moment.findFirstOrThrow({ where: { source: "youtube", vodOffset: 123 }, include: { clips: true, streamer: true } });
  clearCalls();
  assert.match(await runGrab(m.clips[0].id), /downloaded raw\//);
  const dl = readCalls().find((a) => a.includes("--download-sections"))!;
  assert.equal(dl[dl.indexOf("--download-sections") + 1], "*98-143");
  assert.equal(dl[dl.indexOf("-f") + 1], "bv*[height<=1080]+ba/b[height<=1080]");
  assert.ok(dl.includes("--force-keyframes-at-cuts"));
  assert.equal(dl.at(-1), "https://www.youtube.com/watch?v=vidHEAT");
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: m.clips[0].id } });
  assert.ok(clip.rawPath && fs.existsSync(path.join(storage, clip.rawPath)));

  const { buildAss } = await import("../src/lib/media");
  const { creatorCreditText } = await import("../src/lib/social");
  assert.equal(creatorCreditText(m.streamer), "youtube.com/@GoodChan");
  assert.match(buildAss({ words: [], credit: creatorCreditText(m.streamer), duration: 3, layout: "blur" }), /youtube\.com\/@GoodChan/);
  const cutterSrc = fs.readFileSync(path.join(__dirname, "..", "src", "workers", "cutter.ts"), "utf8");
  assert.match(cutterSrc, /credit: creatorCreditText\(streamer\)/);

  // Real render of the downloaded section (blur layout), credit from the helper.
  const { runCut } = await import("../src/workers/cutter");
  await prisma.clip.update({ where: { id: clip.id }, data: { words: "[]" } });
  assert.match(await runCut(clip.id), /^cut /);
  assert.ok(fs.existsSync(path.join(storage, `final/${clip.id}.mp4`)));

  const { judgeClip } = await import("../src/lib/judge");
  let sent = "";
  const client = { beta: { messages: { parse: async (req: any) => { sent = req.messages[0].content; return { stop_reason: "end_turn", parsed_output: { score: 7, hook_text: "h", title: "t", hashtags: [], reason: "r" } }; } } } } as any;
  await judgeClip({ streamer: "Good Channel", durationSec: 30, source: "youtube", sourceTitle: "Heat video", sourceViews: 123456, replayScore: 0.9, transcript: null, minScore: 6 }, null, client);
  assert.match(sent, /Found as: the most-replayed part of a YouTube video \(123456 views, replay score 0\.9\)\nVideo title: Heat video/);
  assert.doesNotMatch(sent, /^Game:/m);
});

test("poster credit check and judged caption use the YouTube link", async () => {
  const { judgedCaption, creditLine } = await import("../src/lib/social");
  const yt = { platform: "youtube", login: "GoodChan", name: "Good Channel" };
  assert.match(judgedCaption("T", ["#a"], yt), /Credit: Good Channel — https:\/\/youtube\.com\/@GoodChan/);
  assert.equal(creditLine({ login: "kai", name: "Kai" }), "🎥 Credit: Kai — https://twitch.tv/kai");
});

test("Twitch Scout and Clips poller never touch YouTube rows", async () => {
  const { prisma } = await import("../src/lib/db");
  const helixCalls: URL[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    helixCalls.push(u);
    if (u.pathname.endsWith("/streams") && u.searchParams.get("game_id"))
      // A Twitch streamer whose login equals the YouTube handle gets its own Twitch row (v1.7.1: no longer skipped).
      return json({ data: [{ id: "s1", user_id: "tw1", user_login: "GoodChan", user_name: "GoodChan", game_id: "gta6-id", game_name: "Grand Theft Auto VI", title: "t", viewer_count: 5, started_at: new Date().toISOString(), thumbnail_url: "" }], pagination: {} });
    return json({ data: [], pagination: {} });
  }) as typeof fetch;
  await prisma.streamer.create({ data: { twitchId: "tw-approved", login: "twguy", name: "TwGuy", approved: true, approvalNote: "ok" } });
  const channels: string[][] = [];
  await (await import("../src/workers/scout")).runScout({ setChannels: (l: string[]) => channels.push(l) } as unknown as ChatHeat);
  await (await import("../src/workers/clips")).runClipsPoll();

  const ids = helixCalls.flatMap((u) => [...u.searchParams.getAll("user_id"), ...u.searchParams.getAll("broadcaster_id"), ...u.searchParams.getAll("id")]);
  assert.ok(ids.includes("tw-approved"));
  assert.ok(!ids.some((id) => id.startsWith("yt:")), `YouTube ids sent to Twitch: ${ids}`);
  const yt = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${GOOD}` } });
  assert.equal(yt.isLive, false);
  assert.equal(yt.platform, "youtube");
  const tw = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "tw1" } });
  assert.deepEqual({ login: tw.login, platform: tw.platform, approved: tw.approved, isLive: tw.isLive }, { login: yt.login, platform: "twitch", approved: false, isLive: true });
  assert.equal(yt.approved, true, "YouTube row untouched");
  assert.ok(!channels.flat().includes("GoodChan"));
});

test("bulk add without a YouTube key: names are resolved with yt-dlp (@NameWithoutSpaces); unknown ones are 'not found'", async () => {
  delete process.env.YOUTUBE_API_KEY;
  const saved = { id: process.env.TWITCH_CLIENT_ID, secret: process.env.TWITCH_CLIENT_SECRET };
  delete process.env.TWITCH_CLIENT_ID; delete process.env.TWITCH_CLIENT_SECRET;
  try {
    const { resolveCreators } = await import("../src/lib/creator-lookup");
    const r = await resolveCreators(["Good Chan", "No Such Chan", "  ", "good chan"]);
    assert.deepEqual(r.rows.map((x) => x.name), ["Good Chan", "No Such Chan"], "blank + repeated names dropped");
    const good = r.rows[0].youtube;
    assert.equal(good.status, "found");
    if (good.status === "found") assert.deepEqual({ id: good.match.channelId, handle: good.match.handle, approved: good.match.approved }, { id: GOOD, handle: "goodchan", approved: true });
    assert.equal(r.rows[1].youtube.status, "none");
    assert.deepEqual(r.rows.map((x) => x.twitch), [{ status: "error", reason: "no Twitch keys" }, { status: "error", reason: "no Twitch keys" }]);
    assert.match(r.notes.join(" "), /Twitch keys are missing/);
    assert.ok(readCalls().some((a) => a.at(-1) === "https://www.youtube.com/@GoodChan/videos"));
  } finally {
    if (saved.id) process.env.TWITCH_CLIENT_ID = saved.id;
    if (saved.secret) process.env.TWITCH_CLIENT_SECRET = saved.secret;
  }
});
