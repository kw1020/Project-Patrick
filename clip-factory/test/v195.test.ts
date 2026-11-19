import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV194Schema } from "./schema-v173";
import { accountAction, channelForClip, donePost, downloadUrl, isFullyPosted, parseFocus, parseHandle, parseKinds, slotAccount } from "../src/lib/channels";
import { filterSuggestions, followerTier, followersText, rankSuggestions, tierLabel, top21Index } from "../src/lib/suggest-rank";
import { youtubeIdFromUrl } from "../src/lib/youtube";
import { twitchReturnRedirect } from "../src/lib/twitch-user";
import { isGta6 } from "../src/lib/social";

// v1.9.5 (was built as 1.9.2): Channels, To post, Posted/Analytics per channel, YouTube views from the link, Suggestions by followers.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v192-"));
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const realFetch = globalThis.fetch;
let mock: Mock;

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/6", WHISPER_ENGINE: "off",
    APP_URL: "http://localhost:3000", TWITCH_AUTHORIZE_URL: `${mock.url}/oauth2/authorize`,
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  (await import("../src/lib/twitch")).setSleep(async () => {});
});
afterEach(() => { globalThis.fetch = realFetch; });
after(async () => {
  globalThis.fetch = realFetch;
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function reset() {
  const { prisma } = await import("../src/lib/db");
  await prisma.postStat.deleteMany(); await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany();
  await prisma.suggestion.deleteMany(); await prisma.streamer.deleteMany(); await prisma.account.deleteMany(); await prisma.channel.deleteMany();
  await prisma.campaign.deleteMany(); await prisma.settings.deleteMany();
  return prisma;
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

// ---------- pure ----------
test("channels: kinds/focus/handle parsing, account actions, done/fully posted, download link", () => {
  assert.deepEqual(parseKinds("Funny, gaming,x,funny"), ["gaming", "funny"]);
  assert.deepEqual(parseKinds(""), []);
  assert.equal(parseFocus("GTA6"), "gta"); assert.equal(parseFocus(""), "any"); assert.equal(parseFocus("Racing!"), "racing");
  assert.equal(parseHandle("vicecityclips"), "@vicecityclips");
  assert.equal(parseHandle("https://www.tiktok.com/@ViceCity.Clips?lang=en"), "@ViceCity.Clips");
  assert.equal(parseHandle("not a handle"), null);
  assert.equal(accountAction({ platform: "youtube", mode: "api" }), "post");
  assert.equal(accountAction({ platform: "tiktok", mode: "api" }), "tiktok");
  assert.equal(accountAction({ platform: "tiktok", mode: "manual" }), "manual");
  assert.equal(accountAction({ platform: "instagram", mode: "api" }), "manual", "Instagram is always by hand");
  const posts = [{ accountId: "a", status: "live" }, { accountId: "b", status: "failed" }, { accountId: "c", status: "draft" }];
  assert.ok(donePost(posts, "a")); assert.equal(donePost(posts, "b"), null); assert.ok(donePost(posts, "c"), "a TikTok draft counts as sent");
  assert.equal(isFullyPosted(posts, [{ id: "a" }, { id: "c" }]), true);
  assert.equal(isFullyPosted(posts, [{ id: "a" }, { id: "b" }]), false);
  assert.equal(isFullyPosted([], []), false, "a channel without accounts never counts as done");
  assert.equal(downloadUrl("abc"), "/api/media/abc?download=1");
  const accs = [{ id: "1", platform: "tiktok", homeChannelId: "c1", createdAt: new Date(2) }, { id: "2", platform: "tiktok", homeChannelId: "c1", createdAt: new Date(1) }];
  assert.equal(slotAccount(accs, "c1", "tiktok")!.id, "2"); assert.equal(slotAccount(accs, "c1", "youtube"), null);
});

test("routing: GTA 6 clips → the gta channel (any type); other games → an 'any' channel that takes the type; picked channel wins", () => {
  const vcc = { id: "vcc", name: "ViceCityClips", focus: "gta", kinds: "gaming,funny,edits", createdAt: new Date(1) };
  const funny = { id: "fun", name: "FunnyStreams", focus: "any", kinds: "funny", createdAt: new Date(2) };
  const games = { id: "gam", name: "GamingClips", focus: "any", kinds: "gaming", createdAt: new Date(3) };
  const all = [games, funny, vcc];
  assert.equal(channelForClip(all, { category: "funny", gta: true })!.id, "vcc");
  assert.equal(channelForClip(all, { category: "gaming", gta: true })!.id, "vcc");
  assert.equal(channelForClip(all, { category: "funny", gta: false })!.id, "fun");
  assert.equal(channelForClip(all, { category: "gaming", gta: false })!.id, "gam");
  assert.equal(channelForClip(all, { category: null, gta: false })!.id, "gam", "no type = gaming");
  assert.equal(channelForClip([vcc], { category: "funny", gta: false }), null, "a Fortnite clip never lands on a GTA-only channel");
  assert.equal(channelForClip([vcc], { channelId: "vcc", category: "funny", gta: false })!.id, "vcc", "Krew's pick wins");
  assert.equal(channelForClip([funny], { category: "funny", gta: true })!.id, "fun", "no gta channel: GTA clip goes where its type fits");
  assert.equal(channelForClip(all, { channelId: "deleted", category: "gaming", gta: true })!.id, "vcc");
  assert.equal(channelForClip([], { category: "gaming" }), null);
});

test("Krew's seeded brands route like he asked: GTA 6 → ViceCityClips, funny → StreamHeistClips, gaming → WantedLevelClips, edits → ClipFactoryGG", async () => {
  const { CHANNEL_SEEDS } = await import("../src/lib/channel-seeds");
  const chans = CHANNEL_SEEDS.map((c, i) => ({ ...c, createdAt: new Date(i) }));
  const to = (category: string, gta: boolean) => channelForClip(chans, { category, gta })!.name;
  assert.equal(to("funny", true), "ViceCityClips"); assert.equal(to("gaming", true), "ViceCityClips");
  assert.equal(to("funny", false), "StreamHeistClips"); assert.equal(to("gaming", false), "WantedLevelClips");
  assert.equal(to("edits", false), "ClipFactoryGG");
  assert.doesNotMatch(JSON.stringify(CHANNEL_SEEDS), /@[\w.-]+\.(com|net|org)\b/, "no email addresses in the repo");
});

test("Upload page: right after Queue in the nav, one column per channel, /to-post redirects, Move to… on each card", () => {
  const nav = fs.readFileSync(path.join(ROOT, "src", "components", "Nav.tsx"), "utf8");
  assert.match(nav, /\{ href: "\/queue", label: "Queue" \},\n {2}\{ href: "\/upload", label: "Upload" \},/);
  const page = fs.readFileSync(path.join(ROOT, "app", "upload", "page.tsx"), "utf8");
  assert.match(page, /data-testid="upload-columns"/);
  assert.match(page, /\{col\.items\.length\} waiting/);
  assert.match(fs.readFileSync(path.join(ROOT, "app", "to-post", "page.tsx"), "utf8"), /redirect\("\/upload"\)/);
  const card = fs.readFileSync(path.join(ROOT, "src", "components", "ToPostCard.tsx"), "utf8");
  assert.match(card, /<option value="">Move to…<\/option>/);
  assert.match(card, /postToAccount\(clip\.id, r\.accountId\)/, "per-platform post buttons");
});

test("suggestion ranking: Krew's top 21 pinned, then 5M+ / 2M+ tiers, then score; Big only filter; fallback by viewers", () => {
  assert.equal(followerTier(6_200_000), 2); assert.equal(followerTier(2_000_000), 1); assert.equal(followerTier(1_999_999), 0); assert.equal(followerTier(null), 0);
  assert.equal(tierLabel(5_000_000), "5M+"); assert.equal(tierLabel(2_500_000), "2M+"); assert.equal(tierLabel(10), null);
  assert.equal(followersText(6_200_000), "6.2M followers"); assert.equal(followersText(18_200), "18.2K followers");
  assert.equal(top21Index("Kai Cenat", "kaicenat"), 0); assert.equal(top21Index("x", "caseoh_"), 5); assert.equal(top21Index("Fanum", "fanum"), 20); assert.equal(top21Index("Mira", "mira"), -1);
  const r = (name: string, followers: number | null, score: number, viewers = 100, gameName: string | null = null) => ({ name, login: name.toLowerCase().replace(/ /g, ""), followers, score, viewers, gameName });
  const rows = [r("Small", 50_000, 30), r("Two", 2_400_000, 10), r("Five", 7_000_000, 5), r("Five B", 5_100_000, 9), r("Sketch", 900_000, 1), r("Kai Cenat", 15_000_000, 2)];
  assert.deepEqual(rankSuggestions(rows, true).map((x) => x.name), ["Kai Cenat", "Sketch", "Five B", "Five", "Two", "Small"]);
  const big = filterSuggestions(rankSuggestions(rows, true), { bigOnly: true, gtaNow: false, byFollowers: true, isGta6 });
  assert.deepEqual(big.map((x) => x.name), ["Kai Cenat", "Sketch", "Five B", "Five", "Two"], "top 21 always shown, under-2M hidden");
  assert.equal(filterSuggestions(rows, { bigOnly: true, gtaNow: false, byFollowers: false, isGta6 }).length, rows.length, "no follower counts: filter can't apply");
  const gta = [r("A", 3e6, 1, 10, "Grand Theft Auto VI"), r("B", 3e6, 1, 10, "Just Chatting")];
  assert.deepEqual(filterSuggestions(gta, { bigOnly: false, gtaNow: true, byFollowers: true, isGta6 }).map((x) => x.name), ["A"]);
  // Without the Twitch token: peak viewers, then score.
  assert.deepEqual(rankSuggestions([r("X", null, 9, 100), r("Y", null, 1, 5000)], false).map((x) => x.name), ["Y", "X"]);
});

test("YouTube links: ids from Shorts/watch/youtu.be links", () => {
  assert.equal(youtubeIdFromUrl("https://youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(youtubeIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3"), "dQw4w9WgXcQ");
  assert.equal(youtubeIdFromUrl("youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeIdFromUrl("https://m.youtube.com/shorts/abcDEF12345?feature=share"), "abcDEF12345");
  assert.equal(youtubeIdFromUrl("https://www.tiktok.com/@x/video/1"), null);
  assert.equal(youtubeIdFromUrl(null), null);
});

// ---------- channel migration ----------
test("channel migration: seeds Krew's 4 brands + handles once, connected accounts take their seeded slot, the disabled Instagram is off", async () => {
  const prisma = await reset();
  const { ensureChannels } = await import("../src/lib/to-post");
  await prisma.settings.create({ data: { id: "main", channelName: "ViceCityClips" } });
  const yt = await prisma.account.create({ data: { platform: "youtube", channelId: "UC1", channelTitle: "ViceCityClips", refreshToken: "r", createdAt: new Date(1) } });
  const tt = await prisma.account.create({ data: { platform: "tiktok", channelId: "o1", channelTitle: "@vicecityclips997", username: "vicecityclips997", refreshToken: "r", createdAt: new Date(2) } });
  const tt2 = await prisma.account.create({ data: { platform: "tiktok", channelId: "o2", channelTitle: "@other", refreshToken: "r", createdAt: new Date(3) } });
  const wl = await prisma.account.create({ data: { platform: "youtube", channelId: "UCqnlrJu2A_P-OLH2zvT_IBg", channelTitle: "Wanted Level", refreshToken: "r", createdAt: new Date(4) } });
  const tw = await prisma.account.create({ data: { platform: "twitch", channelId: "t1", channelTitle: "Krew", refreshToken: "r" } });
  assert.match(String(await ensureChannels()), /made 4 channels \(ViceCityClips, StreamHeistClips, WantedLevelClips, ClipFactoryGG\) with 8 by-hand accounts, 3 connected accounts matched/);
  const ch = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  assert.deepEqual(ch.map((c) => [c.id, c.name, c.focus, c.kinds]), [
    ["main", "ViceCityClips", "gta", "gaming,funny,edits"], ["streamheist", "StreamHeistClips", "any", "funny"],
    ["wantedlevel", "WantedLevelClips", "any", "gaming"], ["clipfactorygg", "ClipFactoryGG", "any", "edits"],
  ]);
  const home = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).homeChannelId;
  assert.equal(await home(yt.id), "main", "the connected ViceCityClips YouTube takes its slot");
  assert.equal(await home(tt.id), "main");
  assert.equal(await home(wl.id), "wantedlevel", "matched by its YouTube channel id");
  assert.equal(await home(tt2.id), null, "an unknown TikTok: the slots are taken, Krew places it");
  assert.equal(await home(tw.id), null, "the Twitch login is never a posting account");
  const slots = async (id: string) => (await prisma.account.findMany({ where: { homeChannelId: id }, orderBy: { platform: "asc" } })).map((a) => `${a.platform}:${a.handle}:${a.mode}${a.disabled ? ":off" : ""}`);
  assert.deepEqual(await slots("main"), ["instagram:@vicecityclips116:manual", "tiktok:@vicecityclips997:api", "youtube:@ViceCityClips1-r2c:api"]);
  assert.deepEqual(await slots("streamheist"), ["instagram:@streamheistclips3:manual", "tiktok:@streamheistclips0:manual", "youtube:@StreamHeistClips-k4f:manual"]);
  assert.deepEqual(await slots("wantedlevel"), ["tiktok:@wantedlevelclips02:manual", "youtube:@WantedLevelClips-k1e:api"]);
  assert.deepEqual(await slots("clipfactorygg"), ["instagram:@clipfactorygg:manual:off", "tiktok:@clipfactorygg1:manual", "youtube:@ClipFactoryGG-b9l:manual"]);
  assert.equal((await prisma.account.findFirstOrThrow({ where: { handle: "@clipfactorygg", platform: "instagram" } })).error, "Instagram disabled this account, appeal in the app");
  assert.equal(await ensureChannels(), null, "runs once");
  await prisma.channel.deleteMany();
  assert.equal(await ensureChannels(), null, "flag stops it re-making Krew's deleted channels");
  // A channel Krew already has: nothing is seeded, his accounts go into its free slots.
  await prisma.account.deleteMany(); await prisma.settings.update({ where: { id: "main" }, data: { migratedChannels: false } });
  await prisma.channel.create({ data: { id: "mine", name: "Mine", focus: "any" } });
  const solo = await prisma.account.create({ data: { platform: "youtube", channelId: "UCz", channelTitle: "Solo", refreshToken: "r" } });
  assert.match(String(await ensureChannels()), /channels already there, 1 more put in Mine/);
  assert.equal(await prisma.channel.count(), 1);
  assert.equal(await home(solo.id), "mine");
  // assignHomeChannel after a connect: the wanted channel's free slot.
  await prisma.channel.create({ data: { id: "c2", name: "Second", focus: "any" } });
  const { assignHomeChannel } = await import("../src/lib/to-post");
  const t3 = await prisma.account.create({ data: { platform: "tiktok", channelId: "o3", channelTitle: "@x", refreshToken: "r" } });
  assert.equal(await assignHomeChannel(t3.id, "c2"), "c2");
});

test("a disabled account is skipped by Post to all and not waited for on To post", async () => {
  const w = await world();
  await w.prisma.account.update({ where: { id: w.ig.id }, data: { disabled: true, error: "Instagram disabled this account, appeal in the app" } });
  const c = await w.mk(w.gtaM.id, "approved");
  const actions = await import("../app/actions");
  const r = await actions.postToAll(c.id, "vcc");
  assert.deepEqual(r.byHand, ["TikTok @vicecityclips"], "Instagram skipped");
  await w.prisma.post.create({ data: { clipId: c.id, platform: "youtube", accountId: w.yt.id, channelId: "vcc" } });
  await actions.markPostedToAccount(c.id, w.tt.id, fd({}));
  const { toPostItems } = await import("../src/lib/to-post");
  assert.ok(!(await toPostItems()).items.some((x) => x.clip.id === c.id), "done without the disabled Instagram");
  await actions.setAccountDisabled(w.ig.id, false);
  assert.ok((await toPostItems()).items.some((x) => x.clip.id === c.id), "turned back on: it waits for Instagram again");
  assert.equal((await w.prisma.account.findUniqueOrThrow({ where: { id: w.ig.id } })).error, null);
});

// ---------- To post ----------
async function world() {
  const prisma = await reset();
  await prisma.settings.create({ data: { id: "main", migratedChannels: true } });
  const vcc = await prisma.channel.create({ data: { id: "vcc", name: "ViceCityClips", focus: "gta", kinds: "gaming,funny,edits", createdAt: new Date(1) } });
  const fun = await prisma.channel.create({ data: { id: "fun", name: "FunnyStreams", focus: "any", kinds: "funny", createdAt: new Date(2) } });
  const yt = await prisma.account.create({ data: { platform: "youtube", channelId: "UCv", channelTitle: "ViceCityClips YT", refreshToken: "1//r", accessToken: "ya29.x", expiresAt: new Date(Date.now() + 3600_000), homeChannelId: vcc.id } });
  const tt = await prisma.account.create({ data: { platform: "tiktok", mode: "manual", handle: "@vicecityclips", channelTitle: "@vicecityclips", refreshToken: "", homeChannelId: vcc.id } });
  const ig = await prisma.account.create({ data: { platform: "instagram", mode: "manual", handle: "@vicecityclips", channelTitle: "@vicecityclips", refreshToken: "", homeChannelId: vcc.id } });
  const s = await prisma.streamer.create({ data: { twitchId: "v192-kai", login: "kaicenat", name: "Kai Cenat", approved: true } });
  const gtaM = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", gameName: "Grand Theft Auto VI", category: "funny" } });
  const fnM = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", gameName: "Fortnite", category: "funny" } });
  fs.mkdirSync(path.join(process.env.STORAGE_DIR!, "final"), { recursive: true });
  const mk = async (momentId: string, status: string, extra: Record<string, unknown> = {}) => {
    const c = await prisma.clip.create({ data: { momentId, status, title: "Hook", caption: "Hook\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #GTA6Funny", category: "funny", score: 8, ...extra } });
    fs.writeFileSync(path.join(process.env.STORAGE_DIR!, "final", `${c.id}.mp4`), "fake mp4");
    return prisma.clip.update({ where: { id: c.id }, data: { finalPath: `final/${c.id}.mp4` } });
  };
  return { prisma, vcc, fun, yt, tt, ig, s, gtaM, fnM, mk };
}

test("To post list: approved clips by channel, one row per platform slot, leaves when every account has it", async () => {
  const w = await world();
  const { toPostItems, toPostCount } = await import("../src/lib/to-post");
  const a = await w.mk(w.gtaM.id, "approved");
  const b = await w.mk(w.fnM.id, "approved", { score: 9 });
  await w.mk(w.gtaM.id, "pending");
  const old = await w.mk(w.gtaM.id, "posted");
  await w.prisma.post.create({ data: { clipId: old.id, platform: "tiktok" } }); // posted by hand before v1.9.5: no channel
  let { items } = await toPostItems();
  assert.deepEqual(items.map((x) => x.clip.id), [b.id, a.id], "approved only, best score first; old posts don't come back");
  const ia = items.find((x) => x.clip.id === a.id)!;
  assert.equal(ia.channel!.id, "vcc");
  assert.deepEqual(ia.rows.map((r) => r.account.platform), ["youtube", "tiktok", "instagram"]);
  assert.equal(items.find((x) => x.clip.id === b.id)!.channel!.id, "fun", "the Fortnite funny clip goes to the 'any' funny channel");
  assert.equal(await toPostCount(), 2);

  const actions = await import("../app/actions");
  await actions.markPostedToAccount(a.id, w.tt.id, fd({ url: "tiktok.com/@vicecityclips/video/1" }));
  await actions.markPostedToAccount(a.id, w.ig.id, fd({ url: "" }));
  items = (await toPostItems()).items;
  const still = items.find((x) => x.clip.id === a.id)!;
  assert.ok(still, "YouTube still missing → stays");
  assert.equal(still.rows.find((r) => r.account.id === w.tt.id)!.post!.url, "https://tiktok.com/@vicecityclips/video/1");
  await w.prisma.post.create({ data: { clipId: a.id, platform: "youtube", accountId: w.yt.id, channelId: "vcc", url: "https://youtube.com/shorts/x" } });
  assert.ok(!(await toPostItems()).items.some((x) => x.clip.id === a.id), "every account done → gone");

  // Krew moves the Fortnite clip to ViceCityClips by hand; "" = back to automatic.
  await actions.setClipChannel(b.id, "vcc");
  assert.equal((await toPostItems()).items.find((x) => x.clip.id === b.id)!.channel!.id, "vcc");
  await actions.setClipChannel(b.id, "");
  assert.equal((await toPostItems()).items.find((x) => x.clip.id === b.id)!.channel!.id, "fun");
  // A channel with no accounts: the clip waits (never counted as done).
  assert.deepEqual((await toPostItems()).items.find((x) => x.clip.id === b.id)!.rows, []);
});

test("To post actions: Post to all queues the API accounts (single attempt), lists by-hand ones; refuses unapproved; manual Mark posted", async () => {
  const w = await world();
  const actions = await import("../app/actions");
  const { queue } = await import("../src/lib/queues");
  await queue("post").obliterate({ force: true });
  const pending = await w.mk(w.gtaM.id, "pending");
  await assert.rejects(actions.postToAll(pending.id, "vcc"), /Approve the clip first/);
  await assert.rejects(actions.markPostedToAccount(pending.id, w.ig.id, fd({})), /Approve the clip first/);
  await assert.rejects(actions.postToAccount(pending.id, w.yt.id), /Approve the clip first/);

  // v1.9.8: a hard fail in the Platform check blocks Post to all, in plain English, and queues nothing.
  const leak = await w.mk(w.gtaM.id, "approved", { caption: "The GTA 6 leak\n\n🎥 @kaicenat" });
  await assert.rejects(actions.postToAll(leak.id, "vcc"), /Not posted\. Caption\/title says "leak"/);
  assert.equal((await queue("post").getJobs(["waiting", "prioritized", "delayed"])).length, 0);
  await w.prisma.clip.delete({ where: { id: leak.id } });

  const c = await w.mk(w.gtaM.id, "approved");
  const r = await actions.postToAll(c.id, "vcc");
  assert.deepEqual(r.queued, ["YouTube ViceCityClips YT"]);
  assert.deepEqual(r.byHand, ["TikTok @vicecityclips", "Instagram @vicecityclips"]);
  const jobs = await queue("post").getJobs(["waiting", "prioritized", "delayed"]);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].data, { clipId: c.id, accountId: w.yt.id });
  assert.equal(jobs[0].opts.attempts, 1, "uploads are single-attempt");
  await assert.rejects(actions.postToAccount(c.id, w.ig.id), /by hand/, "a by-hand account is never uploaded to");

  // The Poster itself: upload to the YouTube account (stand-in Google) tags the post with the account's channel.
  const { runPost } = await import("../src/workers/poster");
  assert.match(await runPost(c.id, w.yt.id), /uploaded/);
  const up = await w.prisma.post.findFirstOrThrow({ where: { clipId: c.id, accountId: w.yt.id } });
  assert.equal(up.channelId, "vcc");
  await assert.rejects(runPost(c.id, w.tt.id), /posted to by hand/);

  // Mark posted (by hand) with a campaign link: tagged with account + channel + the creator's campaign; again = same post.
  const camp = await w.prisma.campaign.create({ data: { name: "Kai" } });
  await w.prisma.streamer.update({ where: { id: w.s.id }, data: { campaignId: camp.id } });
  await actions.markPostedToAccount(c.id, w.ig.id, fd({ url: "instagram.com/reel/abc", campaignLink: "whop.com/sub/9" }));
  await actions.markPostedToAccount(c.id, w.ig.id, fd({ url: "", campaignLink: "" }));
  const ig = await w.prisma.post.findMany({ where: { clipId: c.id, accountId: w.ig.id } });
  assert.equal(ig.length, 1);
  assert.deepEqual({ platform: ig[0].platform, channelId: ig[0].channelId, url: ig[0].url, campaignLink: ig[0].campaignLink, campaignId: ig[0].campaignId },
    { platform: "instagram", channelId: "vcc", url: "https://instagram.com/reel/abc", campaignLink: "https://whop.com/sub/9", campaignId: camp.id });
  assert.equal((await w.prisma.clip.findUniqueOrThrow({ where: { id: c.id } })).status, "posted");
  // Queue's auto-post on Approve only uses API YouTube/TikTok accounts.
  await w.prisma.account.update({ where: { id: w.tt.id }, data: { autoPost: true } });
  await queue("post").obliterate({ force: true });
  const c2 = await w.mk(w.gtaM.id, "pending");
  await actions.setClipStatus(c2.id, "approved");
  assert.equal((await queue("post").getJobs(["waiting", "prioritized", "delayed"])).length, 0, "manual account with autoPost is ignored");
});

test("Download + copy caption: one click copies the caption and downloads via the media route (attachment)", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "components", "ToPostCard.tsx"), "utf8");
  const fn = src.slice(src.indexOf("export async function downloadAndCopy"), src.indexOf("export function ToPostCard"));
  assert.match(fn, /navigator\.clipboard\.writeText\(caption\)/);
  assert.match(fn, /a\.href = downloadUrl\(clipId\)/);
  assert.match(fn, /a\.click\(\)/);
  assert.match(src, /data-testid="download-copy" onClick=\{async \(\) => \{ await downloadAndCopy\(clipId, caption\)/);
  assert.match(src, /markPostedToAccount\(clipId, row\.accountId, fd\)/);
  const w = await world();
  const c = await w.mk(w.gtaM.id, "approved");
  const { GET } = await import("../app/api/media/[id]/route");
  const res = await GET(new Request(`http://localhost${downloadUrl(c.id)}`), { params: Promise.resolve({ id: c.id }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="kaicenat-hook\.mp4"$/);
});

test("Channels card actions: one form per handle (Add another), one slot per platform, move/remove, new channel with focus", async () => {
  const w = await world();
  const a = await import("../app/actions");
  let r = await a.addManualAccount(null, fd({ platform: "tiktok", handle: "@funnystreams", channelId: "fun" }));
  assert.match(r.ok!, /Added @funnystreams \(TikTok\) to FunnyStreams/);
  r = await a.addManualAccount(null, fd({ platform: "instagram", handle: "funnystreams", channelId: "fun" }));
  assert.ok(r.ok);
  r = await a.addManualAccount(null, fd({ platform: "tiktok", handle: "@another", channelId: "fun" }));
  assert.match(r.error!, /already has a TikTok account \(@funnystreams\)/);
  r = await a.addManualAccount(null, fd({ platform: "tiktok", handle: "@@bad handle", channelId: "fun" }));
  assert.match(r.error!, /handle/);
  r = await a.addManualAccount(null, fd({ platform: "snapchat", handle: "@x" }));
  assert.match(r.error!, /Pick/);
  const fn = await w.prisma.account.findFirstOrThrow({ where: { platform: "tiktok", handle: "@funnystreams" } });
  assert.deepEqual({ mode: fn.mode, refreshToken: fn.refreshToken, username: fn.username }, { mode: "manual", refreshToken: "", username: "funnystreams" });
  await assert.rejects(a.setAccountChannel(fn.id, "vcc"), /already has a TikTok/);
  await a.setAccountChannel(w.tt.id, "");
  await a.setAccountChannel(fn.id, "vcc");
  assert.equal((await w.prisma.account.findUniqueOrThrow({ where: { id: fn.id } })).homeChannelId, "vcc");
  const made = await a.createChannel(null, fd({ name: "EditsHub", focus: "any", kind_edits: "on" }));
  const ch = await w.prisma.channel.findUniqueOrThrow({ where: { id: made.id! } });
  assert.deepEqual({ name: ch.name, focus: ch.focus, kinds: ch.kinds }, { name: "EditsHub", focus: "any", kinds: "edits" });
  const gta = await a.createChannel(null, fd({ name: "GTA Two", focus: "gta" }));
  assert.equal((await w.prisma.channel.findUniqueOrThrow({ where: { id: gta.id! } })).kinds, "gaming,funny,edits", "a GTA channel takes every type by default");
  assert.match((await a.createChannel(null, fd({ name: " " }))).error!, /name/);
  await a.saveChannel(ch.id, fd({ name: "Edits Hub", focus: "gta", kind_funny: "on" }));
  assert.deepEqual(await w.prisma.channel.findUniqueOrThrow({ where: { id: ch.id }, select: { name: true, focus: true, kinds: true } }), { name: "Edits Hub", focus: "gta", kinds: "funny" });
  await a.deleteChannel("fun");
  assert.equal((await w.prisma.account.findFirstOrThrow({ where: { platform: "instagram", handle: "@funnystreams" } })).homeChannelId, null, "its accounts wait to be placed");
  // The Settings page renders the card (source check: slots + connect per channel).
  const card = fs.readFileSync(path.join(ROOT, "src", "components", "ChannelsCard.tsx"), "utf8");
  assert.match(card, /\/api\/\$\{platform\}\/connect\?channel=\$\{channelId\}/);
  assert.match(fs.readFileSync(path.join(ROOT, "app", "settings", "page.tsx"), "utf8"), /<ChannelsCard /);
});

// ---------- YouTube views from the link ----------
test("stats sync: manual YouTube posts get public views with the API key (no OAuth); TikTok/Instagram manual stay typed", async () => {
  const w = await world();
  const c = await w.mk(w.gtaM.id, "posted");
  const ytManual = await w.prisma.account.create({ data: { platform: "youtube", mode: "manual", handle: "@vccshorts", refreshToken: "", homeChannelId: "fun" } });
  const p1 = await w.prisma.post.create({ data: { clipId: c.id, platform: "youtube", accountId: ytManual.id, url: "https://youtube.com/shorts/AAAAAAAAAAA" } });
  const p2 = await w.prisma.post.create({ data: { clipId: c.id, platform: "youtube", url: "https://www.youtube.com/watch?v=BBBBBBBBBBB" } });
  const p3 = await w.prisma.post.create({ data: { clipId: c.id, platform: "tiktok", accountId: w.tt.id, url: "https://tiktok.com/@x/video/1", views: 77 } });
  await w.prisma.account.deleteMany({ where: { id: w.yt.id } }); // no OAuth accounts at all
  const seen: { url: URL; auth: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    if (u.pathname.endsWith("/videos")) return new Response(JSON.stringify({ items: u.searchParams.get("id")!.split(",").map((id) => ({ id, statistics: { viewCount: id.startsWith("A") ? "1000" : "2000", likeCount: "5" } })) }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { runStatsSync } = await import("../src/workers/poster");
  assert.match(await runStatsSync(), /YouTube links: 2 checked, 2 updated/);
  assert.equal(seen.length, 1, "one call for both ids");
  assert.equal(seen[0].url.searchParams.get("part"), "statistics");
  assert.equal(seen[0].url.searchParams.get("key"), "mock-yt-key");
  assert.deepEqual(seen[0].url.searchParams.get("id")!.split(",").sort(), ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  assert.equal(seen[0].auth, null, "no OAuth token");
  assert.equal((await w.prisma.post.findUniqueOrThrow({ where: { id: p1.id } })).views, 1000);
  assert.equal((await w.prisma.post.findUniqueOrThrow({ where: { id: p2.id } })).views, 2000);
  assert.equal((await w.prisma.post.findUniqueOrThrow({ where: { id: p3.id } })).views, 77);
  assert.equal(await w.prisma.postStat.count({ where: { postId: p1.id } }), 1);
  // updatePost without a views field (synced posts on the Posted page) keeps the views.
  const actions = await import("../app/actions");
  await actions.updatePost(p1.id, fd({ url: "https://youtube.com/shorts/AAAAAAAAAAA" }));
  assert.equal((await w.prisma.post.findUniqueOrThrow({ where: { id: p1.id } })).views, 1000);
  const key = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  try { assert.equal(await (await import("../src/workers/poster")).syncManualYouTube(), null); } finally { process.env.YOUTUBE_API_KEY = key; }
});

// ---------- Twitch user token ----------
test("Twitch connect: redirect_uri exactly http://localhost:3000, the Live page forwards ?code= to the callback, state checked, user saved", async () => {
  const prisma = await reset();
  await prisma.settings.create({ data: { id: "main", migratedChannels: true } });
  const { GET: connect } = await import("../app/api/twitch/connect/route");
  const res = connect();
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.searchParams.get("redirect_uri"), "http://localhost:3000");
  assert.equal(loc.searchParams.get("scope"), "moderator:read:followers");
  assert.equal(loc.searchParams.get("response_type"), "code");
  const state = loc.searchParams.get("state")!;
  assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`tw_state=${state}`));

  assert.equal(twitchReturnRedirect({ code: "abc", state, scope: "moderator:read:followers" }), `/api/twitch/callback?state=${state}&code=abc`);
  assert.equal(twitchReturnRedirect({ error: "access_denied", error_description: "The user denied you access", state: "s" }), "/api/twitch/callback?state=s&error=access_denied&error_description=The+user+denied+you+access");
  assert.equal(twitchReturnRedirect({ code: "abc" }), null, "no state: not an OAuth return");
  assert.equal(twitchReturnRedirect({ all: "1" }), null);
  const page = fs.readFileSync(path.join(ROOT, "app", "page.tsx"), "utf8");
  assert.match(page, /const twitchReturn = twitchReturnRedirect\(sp\);\n\s+if \(twitchReturn\) redirect\(twitchReturn\);/);

  const { NextRequest } = await import("next/server");
  const { GET: callback } = await import("../app/api/twitch/callback/route");
  const bad = await callback(new NextRequest(`http://localhost:3000/api/twitch/callback?code=abc&state=wrong`, { headers: { cookie: `tw_state=${state}` } }));
  assert.match(decodeURIComponent(bad.headers.get("location")!), /sign-in check failed/);
  assert.equal(await prisma.account.count({ where: { platform: "twitch" } }), 0);
  const ok = await callback(new NextRequest(`http://localhost:3000/api/twitch/callback?code=abc&state=${state}`, { headers: { cookie: `tw_state=${state}` } }));
  assert.match(decodeURIComponent(ok.headers.get("location")!), /\/settings\?msg=connected:Twitch \(KrewClips\)/);
  const acct = await prisma.account.findFirstOrThrow({ where: { platform: "twitch" } });
  assert.deepEqual({ channelId: acct.channelId, refreshToken: acct.refreshToken, accessToken: acct.accessToken, mode: acct.mode, home: acct.homeChannelId }, { channelId: "krew-tw-1", refreshToken: "twitch-user-refresh", accessToken: "twitch-user-token", mode: "api", home: null });
  const tokenReq = mock.requests.filter((r) => r.path.startsWith("/oauth2/token")).map((r) => new URLSearchParams(r.body.toString())).find((f) => f.get("grant_type") === "authorization_code")!;
  assert.equal(tokenReq.get("redirect_uri"), "http://localhost:3000");
  assert.equal(tokenReq.get("code"), "abc");
  const denied = await callback(new NextRequest(`http://localhost:3000/api/twitch/callback?error=access_denied&state=${state}`, { headers: { cookie: `tw_state=${state}` } }));
  assert.match(decodeURIComponent(denied.headers.get("location")!), /Twitch said: access_denied/);

  // Followers for any broadcaster with the user token; an expired token is refreshed first.
  const { fetchFollowers, fetchFollowersMany } = await import("../src/lib/twitch-user");
  mock.followers = { b1: 6_200_000, b2: 2_100_000 };
  assert.equal(await fetchFollowers(acct, "b1"), 6_200_000);
  const req = mock.requests.filter((r) => r.path.startsWith("/helix/channels/followers")).pop()!;
  assert.match(req.path, /broadcaster_id=b1&first=1/);
  assert.equal(req.headers["client-id"], "mock-twitch-id");
  await prisma.account.update({ where: { id: acct.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const stale = await prisma.account.findUniqueOrThrow({ where: { id: acct.id } });
  const many = await fetchFollowersMany(stale, ["b1", "b2", "b3", "b1"]);
  assert.deepEqual([...many.entries()].sort(), [["b1", 6_200_000], ["b2", 2_100_000], ["b3", 1000]]);
  assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: acct.id } })).refreshToken, "twitch-user-refresh2", "rotated refresh token saved");
});

test("suggestion scan with the Twitch token: followers stored on the streamer (daily), approved creators too, status says ranked by followers", async () => {
  const prisma = await reset();
  await prisma.settings.create({ data: { id: "main", migratedChannels: true } });
  await prisma.account.create({ data: { platform: "twitch", channelId: "krew-tw-1", channelTitle: "KrewClips", refreshToken: "twitch-user-refresh", accessToken: "twitch-user-token", expiresAt: new Date(Date.now() + 3600_000) } });
  const approved = await prisma.streamer.create({ data: { twitchId: "appr1", login: "approvedone", name: "ApprovedOne", approved: true } });
  mock.followers = { u1: 6_200_000, u2: 40_000, appr1: 2_300_000 };
  const { runSuggestScan } = await import("../src/workers/suggest");
  const msg = await runSuggestScan();
  assert.match(msg, /ranked by followers/);
  const sugs = await prisma.suggestion.findMany({ where: { platform: "twitch" }, include: { streamer: true } });
  const byTw = Object.fromEntries(sugs.map((s) => [s.streamer.twitchId, s.streamer.followers]));
  assert.equal(byTw.u1, 6_200_000);
  assert.equal(byTw.u2, 40_000);
  assert.ok((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "u1" } })).followersAt);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: approved.id } })).followers, 2_300_000, "approved creators' followers refreshed (Creators page)");
  // A second scan within a day doesn't look the same streamers up again.
  const before = mock.requests.filter((r) => r.path.startsWith("/helix/channels/followers")).length;
  await prisma.suggestion.updateMany({ data: { updatedAt: new Date(Date.now() - 3600_000) } });
  await runSuggestScan();
  assert.equal(mock.requests.filter((r) => r.path.startsWith("/helix/channels/followers")).length, before, "cached for a day");
  // Without the token: viewers, with the note.
  await prisma.account.deleteMany({ where: { platform: "twitch" } });
  assert.match(await runSuggestScan(), /Connect Twitch in Settings to rank by followers/);
});

// ---------- db push upgrade ----------
test("db push upgrade from the v1.9.4 schema (de19280) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV194Schema(now);
  const git = spawnSync("git", ["show", "de19280:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the de19280 one");
  const uniques = (s: string) => (s.match(/@unique|@@unique/g) ?? []).length;
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
  sql(`INSERT INTO Clip (id, momentId, status, caption, createdAt, updatedAt) VALUES ('c1', 'm1', 'approved', 'cap', 0, 0)`);
  sql(`INSERT INTO Account (id, platform, channelId, refreshToken, createdAt) VALUES ('acc1', 'youtube', 'UC1', 'r', 0)`);
  sql(`INSERT INTO Post (id, clipId, platform, accountId, postedAt) VALUES ('p1', 'c1', 'youtube', 'acc1', 0)`);
  sql(`INSERT INTO Settings (id, channelName) VALUES ('main', 'ViceCityClips')`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, caption, channelId FROM Clip")), [{ id: "c1", caption: "cap", channelId: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT mode, handle, homeChannelId, refreshToken FROM Account")), [{ mode: "api", handle: null, homeChannelId: null, refreshToken: "r" }]);
  assert.deepEqual(JSON.parse(sql("SELECT channelId FROM Post")), [{ channelId: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT followers, followersAt FROM Streamer")), [{ followers: null, followersAt: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT migratedChannels FROM Settings")), [{ migratedChannels: false }]);
  assert.deepEqual(JSON.parse(sql("SELECT COUNT(*) AS n FROM Channel")), [{ n: 0 }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
