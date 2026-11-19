import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV205Schema } from "./schema-v173";
import { balancedChannel, channelBlurb, channelPool, cutChoices, uploadSummary, validChannelPick } from "../src/lib/channels";
import { buildStyledAss } from "../src/lib/edit";
import { buildAss } from "../src/lib/media";
import { enforcePicks, type ChannelContext, type ClipSummary } from "../src/lib/supreme";
import { parseQueueParams, queueHref, queueWhere } from "../src/lib/queue-filter";

// v2.0.6: the Judge picks the channel before the cut, each channel has its own editing + watermark, Approve = Upload everywhere
// on that channel, an Upload button.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v206-"));
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
let mock: Mock;
let RAW = "";

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/2", WHISPER_ENGINE: "off",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  RAW = path.join(dir, "raw.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=10", "-f", "lavfi", "-i", "sine=f=300:d=10", "-shortest",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", RAW]);
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const t = (n: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, n));
const CHANNELS = [
  { id: "main", name: "ViceCityClips", kinds: "gaming,funny,edits", focus: "gta", createdAt: t(0) },
  { id: "streamheist", name: "StreamHeistClips", kinds: "funny", focus: "any", createdAt: t(1) },
  { id: "wantedlevel", name: "WantedLevelClips", kinds: "gaming", focus: "any", createdAt: t(2) },
  { id: "clipfactorygg", name: "ClipFactoryGG", kinds: "edits", focus: "any", createdAt: t(3) },
];

async function reset() {
  const { prisma } = await import("../src/lib/db");
  await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany(); await prisma.streamer.deleteMany();
  await prisma.account.deleteMany(); await prisma.channel.deleteMany(); await prisma.settings.deleteMany();
  await prisma.settings.create({ data: { id: "main", migratedChannels: true } });
  for (const c of CHANNELS) await prisma.channel.create({ data: c });
  const { queue } = await import("../src/lib/queues");
  for (const q of ["post", "cut"] as const) await queue(q).obliterate({ force: true });
  const s = await prisma.streamer.create({ data: { twitchId: `v202-${Date.now()}`, login: "kaicenat", name: "Kai Cenat", approved: true } });
  const mk = async (o: { game?: string; category?: string; status?: string; extra?: Record<string, unknown> } = {}) => {
    const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", gameName: o.game ?? "Grand Theft Auto VI", category: o.category ?? "gaming", spikeScore: 3, sourceViews: 900 } });
    return prisma.clip.create({ data: { momentId: m.id, status: o.status ?? "processing", category: o.category ?? "gaming", title: "Hook", hookText: "He was sure", caption: "He was sure\n\n🎥 @kaicenat\n\n#GTA6", duration: 6, ...o.extra } });
  };
  return { prisma, s, mk };
}
const jobs = async (name: "post" | "cut") => (await (await import("../src/lib/queues")).queue(name).getJobs(["waiting", "prioritized", "delayed"])).map((j) => j.data);

// ---------- routing ----------
test("routing: the Judge's channel pick is only kept when it fits the rules (GTA channel = GTA only, edits-only never a plain clip)", () => {
  const gtaGaming = { category: "gaming", gta: true }, otherFunny = { category: "funny", gta: false };
  assert.equal(validChannelPick(CHANNELS, gtaGaming, "WantedLevelClips")?.id, "wantedlevel");
  assert.equal(validChannelPick(CHANNELS, gtaGaming, "vicecityclips")?.id, "main", "case / spacing don't matter");
  assert.equal(validChannelPick(CHANNELS, gtaGaming, "@ViceCity Clips")?.id, "main");
  assert.equal(validChannelPick(CHANNELS, gtaGaming, "wantedlevel")?.id, "wantedlevel", "an id works too");
  assert.equal(validChannelPick(CHANNELS, otherFunny, "ViceCityClips"), null, "a non-GTA clip never goes to the GTA channel");
  assert.equal(validChannelPick(CHANNELS, gtaGaming, "ClipFactoryGG"), null, "edits-only channels never get plain clips");
  assert.equal(validChannelPick(CHANNELS, otherFunny, "ClipFactoryGG"), null);
  assert.equal(validChannelPick(CHANNELS, gtaGaming, "StreamHeistClips"), null, "StreamHeistClips only takes funny");
  assert.equal(validChannelPick(CHANNELS, otherFunny, "Nope"), null);
  assert.equal(validChannelPick(CHANNELS, otherFunny, ""), null);
  assert.deepEqual(channelPool(CHANNELS, gtaGaming).map((c) => c.id), ["main", "wantedlevel"]);
  assert.deepEqual(channelPool(CHANNELS, otherFunny).map((c) => c.id), ["streamheist"]);
  // The balanced fallback keeps the same rules and spreads by load.
  for (const clip of [gtaGaming, otherFunny, { category: "funny", gta: true }]) {
    for (const load of [{}, { main: 9 }, { streamheist: 9, wantedlevel: 9 }] as Record<string, number>[]) assert.notEqual(balancedChannel(CHANNELS, clip, load)?.id, "clipfactorygg");
  }
  assert.equal(balancedChannel(CHANNELS, gtaGaming, { main: 4, wantedlevel: 0 })?.id, "wantedlevel");
  assert.match(channelBlurb(CHANNELS[0]), /GTA 6 anything/);
  assert.match(channelBlurb(CHANNELS[1]), /funny streamer moments/);
  assert.match(channelBlurb(CHANNELS[2]), /big plays and clutches/);
  assert.match(channelBlurb(CHANNELS[3]), /edits only.*never give it a plain clip/);
});

test("Judge: the channel list is in the message, `channel` is in the structured output, the pick is saved before the cut", async () => {
  const w = await reset();
  const { VerdictSchema } = await import("../src/lib/judge");
  assert.ok("channel" in VerdictSchema.shape);
  const { runJudge } = await import("../src/workers/judge");
  // Valid pick: a GTA gaming clip to WantedLevelClips.
  mock.verdict = { ...mock.verdict, channel: "WantedLevelClips", category: "gaming" };
  mock.requests.length = 0;
  const a = await w.mk();
  assert.match(await runJudge(a.id), /→ WantedLevelClips$/);
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: a.id } })).channelId, "wantedlevel");
  const body = JSON.parse(mock.requests.find((r) => r.path.includes("/messages"))!.body.toString());
  assert.equal(body.messages.length, 1, "same call shape: one user message");
  const text = JSON.stringify(body.messages[0].content);
  assert.match(text, /Krew's channels/);
  for (const re of [/- ViceCityClips: GTA 6 anything/, /- StreamHeistClips: funny streamer moments/, /- WantedLevelClips: big plays/, /- ClipFactoryGG: edits only/, /fair share/]) assert.match(text, re);
  assert.match(JSON.stringify(body.output_config), /"channel"/);

  // Invalid pick (edits-only channel for a plain clip) → balanced: ViceCityClips (WantedLevelClips already has one).
  mock.verdict = { ...mock.verdict, channel: "ClipFactoryGG" };
  const b = await w.mk();
  assert.match(await runJudge(b.id), /→ ViceCityClips \(balanced: "ClipFactoryGG" didn't fit\)/);
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: b.id } })).channelId, "main");
  // A non-GTA funny clip picked for the GTA channel → StreamHeistClips (the only one that fits).
  mock.verdict = { ...mock.verdict, channel: "ViceCityClips", category: "funny" };
  const c = await w.mk({ game: "Just Chatting", category: "funny" });
  await runJudge(c.id);
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } })).channelId, "streamheist");
  // Krew already picked one: never replaced, and the Judge isn't asked.
  mock.requests.length = 0;
  const d = await w.mk({ extra: { channelId: "main" } });
  mock.verdict = { ...mock.verdict, channel: "WantedLevelClips", category: "gaming" };
  assert.match(await runJudge(d.id), /→ ViceCityClips \(your pick\)/);
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: d.id } })).channelId, "main");
  assert.doesNotMatch(JSON.stringify(JSON.parse(mock.requests.find((r) => r.path.includes("/messages"))!.body.toString()).messages), /Krew.s channels/);
  // Below the cut-off (auto-rejected): no channel needed.
  mock.verdict = { ...mock.verdict, score: 3, channel: "WantedLevelClips" };
  const e = await w.mk();
  await runJudge(e.id);
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: e.id } })).channelId, null);
  mock.verdict = { ...mock.verdict, score: 8.4, channel: "" };
  // Every judged clip went to the cutter.
  assert.equal((await jobs("cut")).length, 5);
});

// ---------- per-channel editing ----------
test("render plan: the clip's channel style + layout, its name as the watermark (in the ASS), Re-cut choices win", () => {
  const S = { editStyle: "hype", layout: "auto", watermark: true, channelName: "ViceCityClips" };
  const heist = { name: "StreamHeistClips", editStyle: "meme", layout: "fullcam", captionStyle: null };
  assert.deepEqual(cutChoices(heist, S), { style: "meme", captionStyle: null, layout: "fullcam", watermark: "StreamHeistClips" });
  assert.deepEqual(cutChoices({ name: "WantedLevelClips", editStyle: "clean", layout: null, captionStyle: "hype" }, S), { style: "clean", captionStyle: "hype", layout: "auto", watermark: "WantedLevelClips" });
  assert.deepEqual(cutChoices({ name: "NewChannel", editStyle: null, layout: null }, S), { style: "hype", captionStyle: null, layout: "auto", watermark: "NewChannel" }, "null = the Settings values");
  assert.deepEqual(cutChoices(null, S), { style: "hype", captionStyle: null, layout: "auto", watermark: "ViceCityClips" }, "no channel: Settings.channelName");
  assert.equal(cutChoices(heist, { ...S, watermark: false }).watermark, null);
  assert.deepEqual(cutChoices({ ...heist, captionStyle: "clean" }, S, { style: "hype", layout: "blur" }), { style: "hype", captionStyle: null, layout: "blur", watermark: "StreamHeistClips" });

  const words = [{ start: 0.5, end: 0.9, word: "no" }, { start: 1, end: 1.4, word: "way" }];
  const c = cutChoices(heist, S);
  const ass = buildStyledAss({ words, credit: "twitch.tv/kaicenat", duration: 8, layout: "blur", hook: "He was sure", style: c.style, watermark: c.watermark, captionStyle: c.captionStyle });
  assert.match(ass, /,Mark,,0,0,0,,\{[^}]*\}@StreamHeistClips\n/);
  assert.doesNotMatch(ass, /@ViceCityClips/);
  const plain = buildAss({ words, credit: "twitch.tv/kaicenat", duration: 8, layout: "blur", hook: "He was sure", watermark: cutChoices({ name: "WantedLevelClips" }, S).watermark });
  assert.match(plain, /@WantedLevelClips/);
  assert.doesNotMatch(plain, /@ViceCityClips/);
  // Caption look: meme captions are upper-case and tilted, clean ones aren't; a channel can put meme captions on a clean edit.
  const clean = buildStyledAss({ words, credit: "x", duration: 8, layout: "blur", style: "clean" });
  const cleanMemeCaps = buildStyledAss({ words, credit: "x", duration: 8, layout: "blur", style: "clean", captionStyle: "meme" });
  assert.doesNotMatch(clean, /,Cap,.*WAY/);
  assert.match(cleanMemeCaps, /,Cap,.*\\frz-?\d.*WAY/);
});

test("cutter: a StreamHeistClips clip is rendered in its channel's style + layout with @StreamHeistClips burned in (real ffmpeg)", { timeout: 300_000 }, async () => {
  const w = await reset();
  await w.prisma.channel.update({ where: { id: "streamheist" }, data: { editStyle: "meme", layout: "blur" } });
  fs.copyFileSync(RAW, path.join(process.env.STORAGE_DIR!, "raw", "heist.mp4"));
  const c = await w.mk({ category: "funny", game: "Just Chatting", extra: { channelId: "streamheist", score: 8, rawPath: "raw/heist.mp4", winStart: 1, winLength: 6, wordsFull: true, words: "[]" } });
  const { runCut } = await import("../src/workers/cutter");
  assert.match(await runCut(c.id), /cut [\d.]+s meme blur/);
  const done = await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(done.editStyle, "meme");
  assert.equal(done.layout, "blur");
  assert.equal(JSON.parse(done.platformInfo!).render.watermark, "@StreamHeistClips");
  assert.equal(done.status, "pending");
  // A clip on its way to review with no channel yet gets one before the cut (balanced), so it's cut in that channel's look.
  await w.prisma.channel.update({ where: { id: "wantedlevel" }, data: { editStyle: "clean", layout: "blur" } });
  fs.copyFileSync(RAW, path.join(process.env.STORAGE_DIR!, "raw", "nochan.mp4"));
  const d = await w.mk({ category: "gaming", game: "Fortnite", extra: { score: 8, rawPath: "raw/nochan.mp4", winStart: 1, winLength: 6, wordsFull: true, words: "[]" } });
  assert.match(await runCut(d.id), /cut [\d.]+s clean blur/);
  const d2 = await w.prisma.clip.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(d2.channelId, "wantedlevel");
  assert.equal(JSON.parse(d2.platformInfo!).render.watermark, "@WantedLevelClips");

  // Move to… after the cut, with the raw still there: Krew says yes to the re-cut → cut again with NO style override, so
  // the new channel's style + watermark are used; no = just moved.
  const actions = await import("../app/actions");
  await w.prisma.clip.update({ where: { id: c.id }, data: { status: "approved" } });
  assert.deepEqual(await actions.setClipChannel(c.id, "main", false), { recut: false });
  assert.equal((await jobs("cut")).length, 0);
  assert.deepEqual(await actions.setClipChannel(c.id, "main", true), { recut: true });
  assert.deepEqual(await jobs("cut"), [{ clipId: c.id }]);
  const moved = await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(moved.channelId, "main");
  assert.equal(moved.stage, "cut");
  assert.equal(moved.status, "approved", "review status kept");
  await w.prisma.settings.update({ where: { id: "main" }, data: { layout: "blur" } }); // no face check in this test
  assert.match(await runCut(c.id), /cut [\d.]+s hype blur/, "ViceCityClips has no own style here → the Settings style + layout");
  assert.equal(JSON.parse((await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } })).platformInfo!).render.watermark, "@ViceCityClips");
});

// ---------- approve = upload everywhere on that channel ----------
async function channelAccounts(prisma: Awaited<ReturnType<typeof reset>>["prisma"]) {
  const yt = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-wl", channelTitle: "WantedLevelClips", refreshToken: "r", homeChannelId: "wantedlevel", createdAt: t(1) } });
  const tt = await prisma.account.create({ data: { platform: "tiktok", channelId: "tt-wl", channelTitle: "wantedlevelclips02", refreshToken: "r", homeChannelId: "wantedlevel", createdAt: t(2) } });
  const ig = await prisma.account.create({ data: { platform: "instagram", mode: "manual", handle: "@wantedlevelig", refreshToken: "", homeChannelId: "wantedlevel", createdAt: t(3) } });
  const other = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-vcc", channelTitle: "ViceCityClips", refreshToken: "r", homeChannelId: "main", autoPost: true, createdAt: t(4) } });
  return { yt, tt, ig, other };
}

test("approve: queues every connected account of the clip's channel (single attempt), by-hand ones wait, other channels untouched", async () => {
  const w = await reset();
  const a = await channelAccounts(w.prisma);
  const actions = await import("../app/actions");
  const c = await w.mk({ status: "pending", extra: { channelId: "wantedlevel" } });
  await actions.setClipStatus(c.id, "approved");
  const q = await jobs("post");
  assert.deepEqual(q.map((j) => j.accountId).sort(), [a.yt.id, a.tt.id].sort(), "its YouTube + TikTok, not ViceCityClips' auto account");
  const all = await (await import("../src/lib/queues")).queue("post").getJobs(["waiting", "prioritized", "delayed"]);
  assert.ok(all.every((j) => j.opts.attempts === 1), "uploads are single-attempt");
  const after = await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.status, "approved");
  assert.equal(after.stage, "post");
  // The Upload page still lists it for the by-hand Instagram.
  const { toPostItems } = await import("../src/lib/to-post");
  const item = (await toPostItems()).items.find((x) => x.clip.id === c.id)!;
  assert.deepEqual(item.rows.map((r) => r.account.platform), ["youtube", "tiktok", "instagram"]);
  // The Queue button text says what will happen.
  assert.equal(uploadSummary([{ platform: "youtube", auto: true }, { platform: "tiktok", auto: true }, { platform: "instagram", auto: false }]), "YouTube + TikTok now, Instagram by hand");
  assert.equal(uploadSummary([{ platform: "instagram", auto: false }]), "Instagram by hand");
  assert.equal(uploadSummary([]), "no accounts yet");

  // A disabled or broken account is skipped; the "Upload" button (Post to all) uses the same code.
  await (await import("../src/lib/queues")).queue("post").obliterate({ force: true });
  await w.prisma.account.update({ where: { id: a.tt.id }, data: { error: "login expired" } });
  const c2 = await w.mk({ status: "pending", extra: { channelId: "wantedlevel" } });
  await actions.setClipStatus(c2.id, "approved");
  assert.deepEqual((await jobs("post")).map((j) => j.accountId), [a.yt.id]);
  await (await import("../src/lib/queues")).queue("post").obliterate({ force: true });
  await w.prisma.clip.update({ where: { id: c2.id }, data: { stage: null } });
  const r = await actions.postToAll(c2.id, "wantedlevel");
  assert.deepEqual(r, { queued: ["YouTube WantedLevelClips"], byHand: ["TikTok wantedlevelclips02", "Instagram @wantedlevelig"] });

  // v2.0.3 connected Instagram is part of "every connected account": approve queues it too.
  await (await import("../src/lib/queues")).queue("post").obliterate({ force: true });
  await w.prisma.account.update({ where: { id: a.tt.id }, data: { error: null } });
  await w.prisma.account.update({ where: { id: a.ig.id }, data: { mode: "api", refreshToken: "ig-token", channelId: "ig-wl" } });
  const c3 = await w.mk({ status: "pending", extra: { channelId: "wantedlevel" } });
  await actions.setClipStatus(c3.id, "approved");
  assert.deepEqual((await jobs("post")).map((j) => j.accountId).sort(), [a.yt.id, a.tt.id, a.ig.id].sort());
});

test("approve: a Platform check hard fail uploads nothing and shows as Posting failed; the setting off = the old per-account rule", async () => {
  const w = await reset();
  const a = await channelAccounts(w.prisma);
  const actions = await import("../app/actions");
  const leak = await w.mk({ status: "pending", extra: { channelId: "wantedlevel", caption: "The GTA 6 leak\n\n🎥 @kaicenat" } });
  await actions.setClipStatus(leak.id, "approved");
  assert.equal((await jobs("post")).length, 0);
  const l = await w.prisma.clip.findUniqueOrThrow({ where: { id: leak.id } });
  assert.equal(l.status, "approved", "still approved: fix it and press Upload");
  assert.match(l.postError ?? "", /^Not uploaded\. Platform check failed: .*leak/);
  await assert.rejects(actions.postToAll(leak.id, "wantedlevel"), /Not posted\. Caption\/title says "leak"/);

  // Settings "Approve uploads" off: only accounts ticked "Post when I approve" of the clip's channel (v1.9.7).
  await w.prisma.settings.update({ where: { id: "main" }, data: { approveUploads: false } });
  const c = await w.mk({ status: "pending", extra: { channelId: "wantedlevel" } });
  await actions.setClipStatus(c.id, "approved");
  assert.equal((await jobs("post")).length, 0, "no WantedLevelClips account is ticked");
  await w.prisma.account.update({ where: { id: a.tt.id }, data: { autoPost: true } });
  const c2 = await w.mk({ status: "pending", extra: { channelId: "wantedlevel" } });
  await actions.setClipStatus(c2.id, "approved");
  assert.deepEqual((await jobs("post")).map((j) => j.accountId), [a.tt.id]);
  // The Settings form only changes it when the Upload card is on the form.
  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  await actions.saveSettings(fd({ approveUploadsShown: "1", approveUploads: "on" }));
  assert.equal((await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } })).approveUploads, true);
  await actions.saveSettings(fd({}));
  assert.equal((await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } })).approveUploads, true, "an older form leaves it alone");
});

test("Channels card: each channel's style / layout / captions are saved ('' = Settings default); older forms keep them", async () => {
  const w = await reset();
  const actions = await import("../app/actions");
  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  await actions.saveChannel("streamheist", fd({ name: "StreamHeistClips", focus: "any", kind_funny: "on", editStyle: "meme", layout: "fullcam", captionStyle: "hype" }));
  let ch = await w.prisma.channel.findUniqueOrThrow({ where: { id: "streamheist" } });
  assert.deepEqual([ch.editStyle, ch.layout, ch.captionStyle], ["meme", "fullcam", "hype"]);
  await actions.saveChannel("streamheist", fd({ name: "StreamHeistClips", focus: "any", kind_funny: "on" }));
  ch = await w.prisma.channel.findUniqueOrThrow({ where: { id: "streamheist" } });
  assert.deepEqual([ch.editStyle, ch.layout, ch.captionStyle], ["meme", "fullcam", "hype"]);
  await actions.saveChannel("streamheist", fd({ name: "StreamHeistClips", focus: "any", kind_funny: "on", editStyle: "", layout: "bogus", captionStyle: "" }));
  ch = await w.prisma.channel.findUniqueOrThrow({ where: { id: "streamheist" } });
  assert.deepEqual([ch.editStyle, ch.layout, ch.captionStyle], [null, null, null]);
});

// ---------- settings migration ----------
test("migration: seeded channels get their own style once (only if still null); Krew's picks and his own channels are left alone", async () => {
  const w = await reset();
  await w.prisma.channel.update({ where: { id: "wantedlevel" }, data: { editStyle: "hype" } }); // Krew already chose
  await w.prisma.channel.create({ data: { id: "mine", name: "MyChannel", kinds: "funny", focus: "any" } });
  await w.prisma.settings.update({ where: { id: "main" }, data: { editStyle: "clean" } }); // Krew's global style
  const { migrateChannelStyles } = await import("../src/lib/to-post");
  assert.match((await migrateChannelStyles())!, /main clean, streamheist meme/);
  const styles = Object.fromEntries((await w.prisma.channel.findMany()).map((c) => [c.id, c.editStyle]));
  assert.deepEqual(styles, { main: "clean", streamheist: "meme", wantedlevel: "hype", clipfactorygg: null, mine: null });
  assert.equal((await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } })).migratedChannelStyles, true);
  // Runs once: a later change sticks.
  await w.prisma.channel.update({ where: { id: "streamheist" }, data: { editStyle: null } });
  assert.equal(await migrateChannelStyles(), null);
  assert.equal((await w.prisma.channel.findUniqueOrThrow({ where: { id: "streamheist" } })).editStyle, null);

  // A fresh install: the seeded brands are made with their styles (ViceCityClips = Settings' style, hype by default).
  await w.prisma.post.deleteMany(); await w.prisma.clip.deleteMany(); await w.prisma.account.deleteMany(); await w.prisma.channel.deleteMany();
  await w.prisma.settings.deleteMany();
  await w.prisma.settings.create({ data: { id: "main" } });
  const { ensureChannels } = await import("../src/lib/to-post");
  await ensureChannels();
  assert.match((await migrateChannelStyles())!, /kept/);
  assert.deepEqual(Object.fromEntries((await w.prisma.channel.findMany()).map((c) => [c.id, c.editStyle])), { main: "hype", streamheist: "meme", wantedlevel: "clean", clipfactorygg: null });
});

// ---------- Queue + Supreme ----------
test("Queue: channel filter chips (?channel=<id>|none), and the Supreme Judge keeps a clip on the channel it was given", () => {
  const f = parseQueueParams({ channel: "streamheist" });
  assert.equal(f.channel, "streamheist");
  assert.deepEqual(queueWhere(f), { status: "pending", channelId: "streamheist" });
  assert.deepEqual(queueWhere(parseQueueParams({ channel: "none" })), { status: "pending", channelId: null });
  assert.deepEqual(queueWhere(f, "channel"), { status: "pending" });
  assert.equal(queueHref(f, { tab: "approved" }), "/queue?tab=approved&channel=streamheist");
  assert.equal(queueHref(f, { channel: null }), "/queue");
  assert.deepEqual(parseQueueParams({ channel: "all" }), { tab: "pending", cat: "all", creator: null });

  const ctx = (id: string): ChannelContext => ({ id, name: id, focus: "any", kinds: "gaming,funny", postsToday: 0, want: 5, creatorsToday: {}, performance: [] });
  const k: ClipSummary = { id: "k1", creator: "Kai", creatorId: "s1", category: "funny", game: "GTA", score: 8, reason: "r", hook: "h", standout: 2, ageHours: 1, length: 20, campaign: null, layout: "split", style: "hype", status: "approved", autoChannelId: "streamheist", qa: "ok", channelSet: true };
  const r = enforcePicks({ channels: [{ channel_id: "main", picks: [{ clip_id: "k1", reason: "x" }] }, { channel_id: "streamheist", picks: [{ clip_id: "k1", reason: "y" }] }] }, [ctx("main"), ctx("streamheist")], [k], 5);
  assert.deepEqual(r.picks.map((p) => p.channelId), ["streamheist"]);
  assert.match(r.dropped.join(" "), /belongs to channel streamheist/);
});

// ---------- the always-visible Upload button (Krew: "a button for YouTube that says upload and just uploads it") ----------
test("Upload button: upload / connect first / reconnect / keys missing / blocked, with the plain-English reason", async () => {
  const { uploadButton } = await import("../src/lib/channels");
  const ch = { id: "wantedlevel", name: "WantedLevelClips" };
  const base = { clipId: "c1", status: "approved", channel: ch, ytKeysMissing: [] as string[], platformFail: null };
  const yt = (o: Record<string, unknown> = {}) => ({ platform: "youtube", mode: "api", error: null, disabled: false, done: false, ...o });
  const tt = { platform: "tiktok", mode: "api", error: null, disabled: false, done: false };
  assert.deepEqual(uploadButton({ ...base, slots: [yt(), tt] }), { kind: "upload", label: "Upload", why: null, restNow: 1 });
  assert.equal(uploadButton({ ...base, slots: [yt()], uploading: true }).label, "Uploading…");
  const c = uploadButton({ ...base, slots: [yt({ mode: "manual" }), tt] });
  assert.equal(c.kind, "connect");
  assert.equal(c.label, "Upload to YouTube (connect first)");
  assert.equal(c.href, "/api/youtube/connect?channel=wantedlevel&then=upload%3Ac1");
  assert.equal(c.restNow, 1, "TikTok can still go now");
  assert.match(c.why!, /WantedLevelClips's YouTube isn't connected yet.*then uploads/);
  assert.equal(uploadButton({ ...base, slots: [] }).kind, "connect", "no YouTube slot at all: connect it");
  const re = uploadButton({ ...base, slots: [yt({ error: "Token expired. Reconnect" })] });
  assert.deepEqual([re.kind, re.label], ["connect", "Reconnect + upload"]);
  assert.match(re.why!, /login stopped working \(Token expired/);
  const keys = uploadButton({ ...base, ytKeysMissing: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"], slots: [] });
  assert.deepEqual([keys.kind, keys.why], ["keys", "YouTube isn't set up: add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env, then restart Clip Factory."]);
  assert.deepEqual(uploadButton({ ...base, status: "pending", slots: [yt()] }), { kind: "blocked", label: "Upload", why: "Approve it first.", restNow: 0 });
  assert.match(uploadButton({ ...base, channel: null, slots: [] }).why!, /no channel yet/);
  assert.match(uploadButton({ ...base, platformFail: 'Caption says "leak"', slots: [yt()] }).why!, /^The Platform check failed: Caption says "leak"/);
  assert.match(uploadButton({ ...base, slots: [yt({ disabled: true })] }).why!, /switched off/);
  assert.equal(uploadButton({ ...base, slots: [yt({ done: true })] }).kind, "done");
  // Both cards always render it.
  for (const f of ["src/components/ClipCard.tsx", "src/components/ToPostCard.tsx"]) assert.match(fs.readFileSync(path.join(ROOT, f), "utf8"), /<UploadButton /);
  assert.match(fs.readFileSync(path.join(ROOT, "src/components/UploadButton.tsx"), "utf8"), /Why can&apos;t I upload\?/);
});

test("Upload button flow: connect YouTube from the clip → Google → back to Upload, the slot is filled and the clip uploads (mocks)", async () => {
  const w = await reset();
  const { prisma } = w;
  const hand = await prisma.account.create({ data: { platform: "youtube", mode: "manual", handle: "@WantedLevelClips-k1e", refreshToken: "", homeChannelId: "wantedlevel" } });
  fs.mkdirSync(path.join(process.env.STORAGE_DIR!, "final"), { recursive: true });
  const c = await w.mk({ status: "approved", extra: { channelId: "wantedlevel", finalPath: "final/up1.mp4" } });
  fs.writeFileSync(path.join(process.env.STORAGE_DIR!, "final", "up1.mp4"), Buffer.alloc(2048, 7));
  const { GET: connect } = await import("../app/api/youtube/connect/route");
  const { GET: callback } = await import("../app/api/youtube/callback/route");
  const { NextRequest } = await import("next/server");
  const start = connect(new Request(`http://localhost:3000/api/youtube/connect?channel=wantedlevel&then=upload:${c.id}`));
  const loc = new URL(start.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, `${mock.url}/auth`);
  const set = start.headers.getSetCookie();
  const val = (name: string) => set.find((x) => x.startsWith(`${name}=`))!.split(";")[0];
  assert.match(decodeURIComponent(val("cf_then")), new RegExp(`^cf_then=upload:${c.id}$`));
  assert.match(set.find((x) => x.startsWith("cf_then="))!, /Max-Age=600/i, "short-lived");
  const cookie = [val("yt_state"), val("cf_channel"), val("cf_then")].join("; ");
  const state = loc.searchParams.get("state")!;
  const back = await callback(new NextRequest(`http://localhost:3000/api/youtube/callback?code=abc&state=${state}`, { headers: { cookie } }));
  const to = new URL(back.headers.get("location")!);
  assert.equal(to.pathname, "/upload");
  assert.match(to.searchParams.get("msg")!, /^Connected Krew Clips \(mock\)\. Uploading to YouTube Krew Clips \(mock\)…$/);
  const acct = await prisma.account.findFirstOrThrow({ where: { platform: "youtube", mode: "api" } });
  assert.equal(acct.homeChannelId, "wantedlevel", "it took the channel's YouTube slot");
  assert.equal(await prisma.account.findUnique({ where: { id: hand.id } }), null, "the by-hand handle was replaced (v2.0.3)");
  assert.deepEqual(await jobs("post"), [{ clipId: c.id, accountId: acct.id }]);
  assert.match(back.headers.getSetCookie().join("\n"), /cf_then=;/, "the cookie is cleared");
  // The worker uploads it (single attempt) → Live on YouTube with the link.
  const { runPost } = await import("../src/workers/poster");
  assert.match(await runPost(c.id, acct.id), /uploaded/);
  const post = await prisma.post.findFirstOrThrow({ where: { clipId: c.id } });
  assert.equal(post.url, "https://youtube.com/shorts/vid123");
  const { uploadButton } = await import("../src/lib/channels");
  assert.equal(uploadButton({ clipId: c.id, status: "posted", channel: { id: "wantedlevel", name: "WantedLevelClips" }, ytKeysMissing: [], platformFail: null, slots: [{ platform: "youtube", mode: "api", error: null, disabled: false, done: true }] }).label, "Live on YouTube ✓");

  // The rules still apply: a clip that isn't approved is not uploaded after connecting.
  await (await import("../src/lib/queues")).queue("post").obliterate({ force: true });
  const p = await w.mk({ status: "pending", extra: { channelId: "wantedlevel" } });
  const s2 = connect(new Request(`http://localhost:3000/api/youtube/connect?channel=wantedlevel&then=upload:${p.id}`));
  const v2 = (name: string) => s2.headers.getSetCookie().find((x) => x.startsWith(`${name}=`))!.split(";")[0];
  const st2 = new URL(s2.headers.get("location")!).searchParams.get("state")!;
  const b2 = await callback(new NextRequest(`http://localhost:3000/api/youtube/callback?code=abc&state=${st2}`, { headers: { cookie: [v2("yt_state"), v2("cf_channel"), v2("cf_then")].join("; ") } }));
  assert.match(new URL(b2.headers.get("location")!).searchParams.get("msg")!, /isn't approved yet, so nothing was uploaded/);
  assert.equal((await jobs("post")).length, 0);

  // Keys missing: the connect link explains which .env lines, on the Upload page.
  const id = process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_ID;
  try {
    const r = connect(new Request(`http://localhost:3000/api/youtube/connect?channel=wantedlevel&then=upload:${c.id}`));
    const u = new URL(r.headers.get("location")!);
    assert.equal(u.pathname, "/upload");
    assert.match(u.searchParams.get("msg")!, /^Add YOUTUBE_CLIENT_ID to \.env first/);
  } finally { process.env.YOUTUBE_CLIENT_ID = id; }
});

// ---------- queue clean-up (Krew: "so many queued piled up, it's just a bunch of random clips") ----------
test("clean-up: the one-time migration rejects pending clips below the min score or never scored; approved / posted / good ones stay", async () => {
  const w = await reset();
  await w.prisma.settings.update({ where: { id: "main" }, data: { minScore: 7 } });
  const low = await w.mk({ status: "pending", extra: { score: 6.5 } });
  const none = await w.mk({ status: "pending" });
  const good = await w.mk({ status: "pending", extra: { score: 7 } });
  const okLow = await w.mk({ status: "approved", extra: { score: 3 } });
  const posted = await w.mk({ status: "posted", extra: { score: 2 } });
  const busy = await w.mk({ status: "processing" });
  const { migrateV206Settings, CLEANUP_REASON } = await import("../src/lib/queue-clean");
  assert.match((await migrateV206Settings())!, /queue cleaned up: 2 pending clips below 7 or unscored rejected/);
  const st = async (id: string) => (await w.prisma.clip.findUniqueOrThrow({ where: { id } }));
  for (const c of [low, none]) { const x = await st(c.id); assert.equal(x.status, "rejected"); assert.equal(x.judgeReason, CLEANUP_REASON); }
  assert.equal((await st(good.id)).status, "pending");
  assert.equal((await st(okLow.id)).status, "approved");
  assert.equal((await st(posted.id)).status, "posted");
  assert.equal((await st(busy.id)).status, "processing");
  const s = await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.equal(s.migratedQueueCleanup, true);
  // Runs once: a new low clip waits for the button.
  const later = await w.mk({ status: "pending", extra: { score: 4 } });
  assert.equal(await migrateV206Settings(), null);
  assert.equal((await st(later.id)).status, "pending");
  // The rejected ones' files go with the v1.9.4 rejected window (6h after the change).
  const { retentionWindows } = await import("../src/workers/retention");
  assert.equal(retentionWindows(s).rejected, 6 * 3600_000);
});

test("clean-up: the Queue's Clean up queue button does the same on demand and says how many", async () => {
  const w = await reset();
  await w.mk({ status: "pending", extra: { score: 5 } });
  await w.mk({ status: "pending", extra: { score: 9 } });
  await w.mk({ status: "pending" });
  const actions = await import("../app/actions");
  assert.equal(await actions.cleanUpQueueNow(), 2);
  assert.equal(await actions.cleanUpQueueNow(), 0);
  assert.equal(await w.prisma.clip.count({ where: { status: "pending" } }), 1);
  const page = fs.readFileSync(path.join(ROOT, "app", "queue", "page.tsx"), "utf8");
  assert.match(page, /<CleanUpQueue minScore=\{settings\.minScore\} count=\{belowBar\} \/>/);
});

test("clips nobody reviewed: 48h -> 24h once, only if still 48 (and the new default is 24); To review is sorted best first", async () => {
  const w = await reset();
  const { migrateV206Settings } = await import("../src/lib/queue-clean");
  await w.prisma.settings.update({ where: { id: "main" }, data: { retainPendingHrs: 48 } });
  assert.match((await migrateV206Settings())!, /48h -> 24h/);
  assert.equal((await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } })).retainPendingHrs, 24);
  await w.prisma.settings.update({ where: { id: "main" }, data: { retainPendingHrs: 48 } }); // Krew sets it back: sticks
  assert.equal(await migrateV206Settings(), null);
  assert.equal((await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } })).retainPendingHrs, 48);
  // Krew's own value is never moved.
  await w.prisma.settings.update({ where: { id: "main" }, data: { retainPendingHrs: 36, migratedPending24: false } });
  assert.match((await migrateV206Settings())!, /kept at 36h/);
  assert.equal((await w.prisma.settings.findUniqueOrThrow({ where: { id: "main" } })).retainPendingHrs, 36);
  // Fresh installs start at 24h.
  await w.prisma.settings.deleteMany();
  assert.equal((await w.prisma.settings.create({ data: { id: "main" } })).retainPendingHrs, 24);

  // (d) To review: Supreme picks, then score (unscored last), then newest.
  const { QUEUE_REVIEW_ORDER } = await import("../src/lib/queue-filter");
  const mk = (score: number | null, n: number, extra: Record<string, unknown> = {}) => w.mk({ status: "pending", extra: { score, createdAt: new Date(Date.UTC(2026, 10, 19, 1, n)), title: `s${score}-n${n}`, ...extra } });
  await mk(8, 1); await mk(8, 2); await mk(null, 3); await mk(6, 4); await mk(5, 0, { supremePick: true });
  const rows = await w.prisma.clip.findMany({ where: { status: "pending" }, orderBy: QUEUE_REVIEW_ORDER });
  assert.deepEqual(rows.map((r) => r.title), ["s5-n0", "s8-n2", "s8-n1", "s6-n4", "snull-n3"]);
});

// ---------- db push upgrade ----------
test("db push upgrade from the v2.0.5 schema (adfefea) with rows: no prompt, rows kept, new columns null / defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV205Schema(now);
  const git = spawnSync("git", ["show", "adfefea:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the adfefea one");
  const uniques = (s: string) => (s.match(/@unique|@@unique|@@id/g) ?? []).length;
  assert.equal(uniques(now), uniques(old), "no new unique constraints");
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
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'twitch_clip', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, channelId, editStyle, createdAt, updatedAt) VALUES ('c1', 'm1', 'approved', 'streamheist', 'hype', 0, 0)`);
  sql(`INSERT INTO Channel (id, name, kinds, focus, createdAt) VALUES ('streamheist', 'StreamHeistClips', 'funny', 'any', 0)`);
  sql(`INSERT INTO Settings (id, editStyle, migratedChannels) VALUES ('main', 'meme', 1)`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, status, channelId, editStyle FROM Clip")), [{ id: "c1", status: "approved", channelId: "streamheist", editStyle: "hype" }]);
  assert.deepEqual(JSON.parse(sql("SELECT name, editStyle, layout, captionStyle FROM Channel")), [{ name: "StreamHeistClips", editStyle: null, layout: null, captionStyle: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT editStyle, approveUploads, migratedChannelStyles, migratedQueueCleanup, migratedPending24, retainPendingHrs FROM Settings")),
    [{ editStyle: "meme", approveUploads: true, migratedChannelStyles: false, migratedQueueCleanup: false, migratedPending24: false, retainPendingHrs: 48 }], "the 48h row is moved by the worker migration, not by db push");
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
