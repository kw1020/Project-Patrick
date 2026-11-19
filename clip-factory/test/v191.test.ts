import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  brandedCaption, captionCredits, captionHashtags, checkCampaignCaption, cleanExtras, defaultExtras, shortHook,
} from "../src/lib/social";
import { buildAss } from "../src/lib/media";
import { buildStyledAss } from "../src/lib/edit";
import { overlayPlace, watermarkPlace, watermarkText } from "../src/lib/layout";
import { parseCampaignForm, parseChannelName, parseLink } from "../src/lib/campaigns";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV190Schema } from "./schema-v173";

// v1.9.1: ViceCityClips captions + watermark, Campaign mode (Whop Content Rewards).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v191-"));
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
let mock: Mock;

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/13", WHISPER_ENGINE: "off",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  try { const { redis } = await import("../src/lib/queues"); redis().disconnect(); } catch { /* never connected */ }
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const kai = { platform: "twitch", login: "kaicenat", name: "Kai Cenat" };

// ---------- brandedCaption ----------
test("brandedCaption: exact ViceCityClips format (hook, 🎥 @login, #GTA6 #GTAVI #ViceCity + extras)", () => {
  assert.equal(
    brandedCaption({ hook: "He was sure the cops didn't see him", streamer: kai, extras: ["GTA6Clips"] }),
    "He was sure the cops didn't see him\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #GTA6Clips",
  );
  assert.equal(
    brandedCaption({ hook: "No way", streamer: kai, extras: ["GTA6Funny", "#StreamerMoments"] }),
    "No way\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #GTA6Funny #StreamerMoments",
  );
  // YouTube creator: their @handle.
  assert.equal(brandedCaption({ hook: "Wait", streamer: { platform: "youtube", login: "GoodChan", name: "Good" }, extras: ["Gaming"] }).split("\n")[2], "🎥 @GoodChan");
});

test("brandedCaption: extras validated (known only, deduped, max 2, min 1 with the category/game fallback)", () => {
  const tags = (c: string) => c.split("\n")[4];
  assert.deepEqual(cleanExtras(["gta6clips", "GTA6Clips", "#gaming", "StreamerMoments"]), ["GTA6Clips", "Gaming"]);
  assert.deepEqual(cleanExtras(["Fortnite", "fyp"], []), []);
  assert.equal(tags(brandedCaption({ hook: "x", streamer: kai, extras: ["Fortnite", "fyp"], category: "funny", game: "Grand Theft Auto VI" })), "#GTA6 #GTAVI #ViceCity #GTA6Funny #GTA6Clips");
  assert.equal(tags(brandedCaption({ hook: "x", streamer: kai, extras: [], category: "gaming", game: "Grand Theft Auto VI" })), "#GTA6 #GTAVI #ViceCity #GTA6Clips");
  assert.equal(tags(brandedCaption({ hook: "x", streamer: kai, category: "gaming", game: "Fortnite" })), "#GTA6 #GTAVI #ViceCity #StreamerMoments");
  assert.equal(tags(brandedCaption({ hook: "x", streamer: kai, extras: ["Gaming", "GTA6Clips", "GTA6Funny"] })), "#GTA6 #GTAVI #ViceCity #Gaming #GTA6Clips");
  assert.deepEqual(defaultExtras("funny", "Just Chatting"), ["GTA6Funny"]);
  assert.deepEqual(defaultExtras(null, null), ["StreamerMoments"]);
  for (const c of [brandedCaption({ hook: "a", streamer: kai }), brandedCaption({ hook: "a", streamer: kai, extras: ["Gaming", "GTA6Funny"] })]) {
    const n = tags(c).split(" ").length;
    assert.ok(n >= 4 && n <= 5, c);
  }
});

test("brandedCaption: hook is short (<= 60), one line, no hashtags or emoji; empty → fallback", () => {
  const long = "This is a really long hook that goes on and on about the cops and the bridge and the car #GTA6 😂";
  const h = shortHook(long);
  assert.ok([...h].length <= 60, h);
  assert.doesNotMatch(h, /#|😂/);
  assert.equal(brandedCaption({ hook: long, streamer: kai }).split("\n")[0], h);
  assert.equal(brandedCaption({ hook: "  ", fallbackHook: "Kai in GTA 6", streamer: kai }).split("\n")[0], "Kai in GTA 6");
});

const camp = { name: "Kai", requiredText: "@kaicenat\n#ad\n#KaiCenatClips\nLink in bio", bannedWords: "free, giveaway", maxCaptionChars: 140, active: true };

test("brandedCaption + campaign: required lines/hashtags added once, banned words removed, max length kept", () => {
  const c = brandedCaption({ hook: "FREE giveaway gone wrong in Vice City", streamer: kai, extras: ["GTA6Clips"], campaign: camp });
  const lines = c.split("\n");
  assert.equal(lines[0], "gone wrong in Vice City");
  assert.equal(lines[2], "🎥 @kaicenat", "@kaicenat is already there via the credit, not repeated");
  assert.equal(lines[4], "#GTA6 #GTAVI #ViceCity #GTA6Clips #ad #KaiCenatClips", "brand tags first, campaign tags may go past 5");
  assert.equal(lines[5], "Link in bio");
  assert.equal(lines.length, 6);
  assert.ok(checkCampaignCaption(c, camp).every((r) => r.ok), JSON.stringify(checkCampaignCaption(c, camp)));
  // Hook fully banned → fallback hook.
  assert.equal(brandedCaption({ hook: "Free giveaway", fallbackHook: "Kai in GTA 6", streamer: kai, campaign: camp }).split("\n")[0], "Kai in GTA 6");
  // Tight max length: the hook is trimmed (at a word) so the caption fits.
  const tight = { ...camp, maxCaptionChars: 100 };
  const t = brandedCaption({ hook: "He was absolutely sure the cops did not see him jump", streamer: kai, extras: ["GTA6Clips"], campaign: tight });
  assert.ok([...t].length <= 100, `${[...t].length}: ${t}`);
  assert.ok(t.split("\n")[0].length > 0 && "He was absolutely sure the cops did not see him jump".startsWith(t.split("\n")[0]));
  // An inactive campaign is ignored.
  assert.equal(brandedCaption({ hook: "free", streamer: kai, campaign: { ...camp, active: false } }).split("\n").length, 5);
  // Required hashtag that is already a brand tag isn't duplicated.
  assert.equal(brandedCaption({ hook: "x", streamer: kai, extras: ["Gaming"], campaign: { requiredText: "#gta6 #Sponsored" } }).split("\n")[4], "#GTA6 #GTAVI #ViceCity #Gaming #Sponsored");
});

test("checkCampaignCaption: one ✅/⚠️ line per rule, never blocks", () => {
  const r = checkCampaignCaption("Free stuff\n\n🎥 @kaicenat\n\n#GTA6 #ad", camp);
  const by = Object.fromEntries(r.map((x) => [x.rule, x.ok]));
  assert.equal(by["Has “@kaicenat”"], true);
  assert.equal(by["Has #ad"], true);
  assert.equal(by["Has #KaiCenatClips"], false);
  assert.equal(by["Has “Link in bio”"], false);
  assert.equal(by["No “free”"], false);
  assert.equal(by["No “giveaway”"], true);
  assert.ok(r.some((x) => /^At most 140 characters/.test(x.rule) && x.ok));
  assert.deepEqual(checkCampaignCaption("x", null), []);
  // "#ad" isn't satisfied by "#adventure"; "@kai" not by "@kaicenat".
  assert.equal(checkCampaignCaption("#adventure", { requiredText: "#ad" })[0].ok, false);
  assert.equal(checkCampaignCaption("@kaicenat", { requiredText: "@kai" })[0].ok, false);
});

test("captionCredits: the @login line or the old link both count (ClipCard warning + YouTube poster)", () => {
  assert.ok(captionCredits("hi\n\n🎥 @kaicenat\n\n#GTA6", kai));
  assert.ok(captionCredits("old\n🎥 Credit: Kai — https://twitch.tv/kaicenat", kai));
  assert.ok(!captionCredits("hi @kaicenat2", kai));
  assert.equal(captionHashtags("a\n\n🎥 @k\n\n#GTA6 #GTAVI #ViceCity #Gaming"), "#GTA6 #GTAVI #ViceCity #Gaming");
});

// ---------- Judge ----------
test("Judge schema has extra_hashtags (enum of the 4 extras) and the prompt keeps its opening + mentions the caption", async () => {
  const { VerdictSchema, JUDGE_SYSTEM } = await import("../src/lib/judge");
  const base = { observations: "o", payoff: "p", hook_lands: true, payoff_in_window: true, payoff_at: null, score: 7, hook_text: "h", title: "t", hashtags: [], reason: "r", category: "gaming", best_start: null, best_end: null };
  assert.ok(VerdictSchema.safeParse({ ...base, extra_hashtags: ["GTA6Clips", "Gaming"] }).success);
  assert.ok(!VerdictSchema.safeParse({ ...base, extra_hashtags: ["fyp"] }).success);
  assert.ok(JUDGE_SYSTEM.startsWith("You score short clips from streamers and YouTubers"));
  assert.match(JUDGE_SYSTEM, /extra_hashtags/);
  assert.match(JUDGE_SYSTEM, /GTA6Funny/);
  assert.match(JUDGE_SYSTEM, /Campaign caption rules/);
});

async function reset() {
  const { prisma } = await import("../src/lib/db");
  await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany(); await prisma.streamer.deleteMany(); await prisma.campaign.deleteMany();
  await prisma.settings.deleteMany();
  return prisma;
}

test("Judge worker: caption = hook + 🎥 @login + brand tags + its extras, title = hook, campaign rules sent and followed", async () => {
  const prisma = await reset();
  const { runJudge } = await import("../src/workers/judge");
  const c = await prisma.campaign.create({ data: { name: "Kai", rules: "Mention the stream schedule. Keep it PG.", requiredText: "#KaiCenatClips", bannedWords: "bridge" } });
  const s = await prisma.streamer.create({ data: { twitchId: "v191-1", login: "kaicenat", name: "Kai Cenat", approved: true, campaignId: c.id } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", sourceTitle: "x", sourceViews: 900, gameName: "Grand Theft Auto VI" } });
  const clip = await prisma.clip.create({ data: { momentId: m.id, status: "processing", stage: "judge", transcript: "hi", duration: 20, winStart: 0, words: "[]", title: "old" } });
  mock.requests.length = 0;
  mock.verdict = { ...mock.verdict, hook_text: "He jumped the bridge?!", extra_hashtags: ["GTA6Clips", "GTA6Clips", "GTA6Funny", "Gaming"] };
  await runJudge(clip.id);
  const req = mock.requests.find((r) => r.path.startsWith("/v1/messages"));
  assert.ok(req, "the Judge was called");
  const body = JSON.parse(req!.body.toString());
  assert.match(body.messages[0].content, /Campaign caption rules: Mention the stream schedule\. Keep it PG\./);
  assert.match(body.messages[0].content, /Campaign banned words \(never in the hook\): bridge/);
  assert.match(JSON.stringify(body.output_config ?? body), /extra_hashtags/);
  const after = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
  assert.equal(after.caption, "He jumped the?!\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #GTA6Clips #GTA6Funny #KaiCenatClips");
  assert.equal(after.title, "He jumped the?!");
  assert.equal(after.hashtags, "#GTA6 #GTAVI #ViceCity #GTA6Clips #GTA6Funny #KaiCenatClips");
  assert.equal(after.hookText, "He jumped the bridge?!", "the on-screen hook is the Judge's own");

  // No extras from the Judge → the fallback by category/game.
  await prisma.campaign.update({ where: { id: c.id }, data: { active: false } });
  const clip2 = await prisma.clip.create({ data: { momentId: m.id, status: "processing", stage: "judge", transcript: "hi", duration: 20, winStart: 0, words: "[]", title: "old" } });
  mock.verdict = { ...mock.verdict, hook_text: "He was sure", extra_hashtags: [], category: "funny" };
  mock.requests.length = 0;
  await runJudge(clip2.id);
  assert.doesNotMatch(JSON.parse(mock.requests.find((r) => r.path.startsWith("/v1/messages"))!.body.toString()).messages[0].content, /Campaign caption rules/, "inactive campaign: no rules sent");
  mock.verdict = { ...mock.verdict, hook_text: "He jumped the bridge?!", extra_hashtags: ["GTA6Clips"], category: "gaming" };
  assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: clip2.id } })).caption, "He was sure\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #GTA6Funny #GTA6Clips");
});

test("Without the Judge (no key): the default caption is branded, hook from the default title, extras by category/game", async () => {
  const prisma = await reset();
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { runJudge } = await import("../src/workers/judge");
    const s = await prisma.streamer.create({ data: { twitchId: "v191-2", login: "kaicenat", name: "Kai Cenat", approved: true } });
    const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "chat", gameName: "Grand Theft Auto VI", category: "funny" } });
    const { defaultTitle } = await import("../src/lib/social");
    const title = defaultTitle(null, s.name, m.gameName);
    const caption = brandedCaption({ hook: title, streamer: s, category: "funny", game: m.gameName });
    assert.equal(caption, "Kai Cenat in GTA 6\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #GTA6Funny #GTA6Clips");
    const clip = await prisma.clip.create({ data: { momentId: m.id, status: "processing", stage: "judge", title, caption } });
    assert.match(String(await runJudge(clip.id)), /unscored/);
    assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } })).caption, caption, "kept as made at moment creation");
  } finally {
    process.env.ANTHROPIC_API_KEY = key;
  }
  // The three moment makers use brandedCaption.
  for (const f of ["clips", "spike", "youtube"]) {
    const src = fs.readFileSync(path.join(ROOT, "src", "workers", `${f}.ts`), "utf8");
    assert.match(src, /caption: brandedCaption\(\{ hook: title, streamer: \w+, category/, f);
    assert.match(src, /include: \{ campaign: true \}/, f);
  }
});

// ---------- Watermark ----------
test("watermark: in the ASS of both render paths (styled + plain), every layout, bottom right, clear of the credit", () => {
  assert.equal(watermarkText("ViceCityClips"), "@ViceCityClips");
  assert.equal(watermarkText("@Vice{x}"), "@Vicex");
  assert.equal(watermarkText(""), "");
  for (const layout of ["blur", "split", "fullcam"] as const) {
    for (const face of [null, { x: 400, y: 60, w: 200, h: 200 }]) {
      const place = layout === "blur" ? null : overlayPlace(layout, face);
      const plain = buildAss({ words: [], credit: "twitch.tv/kai", duration: 20, layout, hook: "Hook", place, watermark: "ViceCityClips" });
      const styled = buildStyledAss({ words: [], credit: "twitch.tv/kai", duration: 20, layout, hook: "Hook", style: "hype", place, watermark: "ViceCityClips" });
      for (const ass of [plain, styled]) {
        assert.match(ass, /^Style: Mark,[^,]+,34,&H80FFFFFF/m, "small, semi-transparent");
        const line = ass.split("\n").find((l) => l.includes(",Mark,,"));
        assert.ok(line, `${layout}: watermark dialogue`);
        const y = Number(/\\pos\(890,(\d+)\)/.exec(line!)![1]); // v1.9.8: inside the safe box, left of the apps' buttons
        assert.match(line!, /\\an3/);
        assert.match(line!, /@ViceCityClips$/);
        const p = place ?? overlayPlace("blur", null);
        if (p.creditAlign === 2) assert.ok(y <= p.creditY - 50, "above a bottom credit");
        assert.ok(y < p.capY - 62 || y - 34 > p.capY + 62, "never on the captions");
        assert.ok(y <= 1440 && y - 34 >= 290, "inside the apps' safe zone (v1.9.8)");
      }
    }
  }
  // Off → no watermark line.
  assert.doesNotMatch(buildAss({ words: [], credit: "c", duration: 5, layout: "blur" }), /,Mark,,/);
  assert.doesNotMatch(buildStyledAss({ words: [], credit: "c", duration: 5, layout: "blur", style: "clean" }), /,Mark,,/);
  // A low hook: the watermark waits until it's gone.
  assert.equal(watermarkPlace({ capY: 1190, hookY: 1250, hookAlign: 8, creditY: 290, creditAlign: 8 }).start, 4.5);
  assert.equal(watermarkPlace(null).start, 0);
  // The cutter passes Settings.watermark/channelName to both paths.
  const cutter = fs.readFileSync(path.join(ROOT, "src", "workers", "cutter.ts"), "utf8");
  assert.match(cutter, /settings\.watermark \? settings\.channelName : null/);
  assert.equal((cutter.match(/buildAss\(\{[^}]*watermark \}\)/g) ?? []).length, 2);
  assert.match(cutter, /hook: clip\.hookText \|\| clip\.title, watermark,/);
});

// ---------- Actions ----------
test("Campaign actions: create/save/delete, streamer assignment (incl. + New), post campaign link, settings branding", async () => {
  const prisma = await reset();
  const actions = await import("../app/actions");
  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const id = await actions.createCampaign(fd({ name: "Kai clips", link: "whop.com/kai", rules: "PG", requiredText: "@kaicenat\r\n#ad", bannedWords: "free", maxCaptionChars: "150", active: "on" }));
  let c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
  assert.deepEqual({ ...c, id: undefined, createdAt: undefined, updatedAt: undefined }, {
    id: undefined, createdAt: undefined, updatedAt: undefined, name: "Kai clips", source: "whop", link: "https://whop.com/kai", rules: "PG", requiredText: "@kaicenat\n#ad", bannedWords: "free", maxCaptionChars: 150, active: true,
  });
  await actions.saveCampaign(id, fd({ name: "Kai", maxCaptionChars: "" }));
  c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
  assert.equal(c.name, "Kai"); assert.equal(c.maxCaptionChars, null); assert.equal(c.active, false); assert.equal(c.rules, null);

  const s = await prisma.streamer.create({ data: { twitchId: "v191-3", login: "kaicenat", name: "Kai Cenat", approved: true } });
  assert.equal(await actions.setStreamerCampaign(s.id, id), id);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: s.id } })).campaignId, id);
  const created = await actions.setStreamerCampaign(s.id, "new");
  const nc = await prisma.campaign.findUniqueOrThrow({ where: { id: created! } });
  assert.equal(nc.name, "Kai Cenat campaign"); assert.equal(nc.requiredText, "@kaicenat");
  assert.equal(await actions.setStreamerCampaign(s.id, ""), null);
  await assert.rejects(actions.setStreamerCampaign(s.id, "nope"));

  // Manual "Posted" with a campaign link: tagged with the creator's campaign.
  await actions.setStreamerCampaign(s.id, id);
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip" } });
  const clip = await prisma.clip.create({ data: { momentId: m.id, status: "approved", title: "t", hookText: "Wild jump", caption: "x", hashtags: "#GTA6 #GTAVI #ViceCity #Gaming" } });
  await actions.markPosted(clip.id, fd({ platform: "tiktok", url: "", campaignLink: "whop.com/sub/1" }));
  const post = await prisma.post.findFirstOrThrow({ where: { clipId: clip.id } });
  assert.equal(post.campaignLink, "https://whop.com/sub/1"); assert.equal(post.campaignId, id);
  await actions.updatePost(post.id, fd({ views: "1,200", url: "https://tiktok.com/x", campaignLink: "", campaignId: "" }));
  const p2 = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
  assert.equal(p2.views, 1200); assert.equal(p2.campaignLink, null); assert.equal(p2.campaignId, null);
  await actions.updatePost(post.id, fd({ views: "", url: "", campaignLink: "https://whop.com/sub/2", campaignId: id }));
  assert.equal((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).campaignId, id);

  // Rebuild caption: ViceCityClips format with the campaign's rules (inactive campaign → ignored).
  await prisma.campaign.update({ where: { id }, data: { active: true, requiredText: "#ad" } });
  assert.equal(await actions.rebuildCaption(clip.id), "Wild jump\n\n🎥 @kaicenat\n\n#GTA6 #GTAVI #ViceCity #Gaming #ad");

  // Deleting a campaign: its creators go back to none, posts keep their link.
  await actions.deleteCampaign(id);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: s.id } })).campaignId, null);
  assert.equal((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).campaignLink, "https://whop.com/sub/2");

  // Settings: channel name + watermark.
  const { getSettings } = await import("../src/lib/db");
  assert.equal((await getSettings()).channelName, "ViceCityClips");
  assert.equal((await getSettings()).watermark, true);
  await actions.saveSettings(fd({ channelName: "@My Clips!", captions: "on" }));
  assert.equal((await getSettings()).channelName, "MyClips");
  assert.equal((await getSettings()).watermark, false);
  assert.equal(parseChannelName(""), "ViceCityClips");
  assert.equal(parseLink(" "), null);
  assert.equal(parseCampaignForm(fd({ maxCaptionChars: "5" })).maxCaptionChars, 20);
});

// ---------- db push upgrade ----------
test("db push upgrade from the v1.9.0 schema (028c1be) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV190Schema(now);
  const git = spawnSync("git", ["show", "028c1be:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 028c1be one");
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
  sql(`INSERT INTO Clip (id, momentId, status, caption, createdAt, updatedAt) VALUES ('c1', 'm1', 'posted', 'old caption', 0, 0)`);
  sql(`INSERT INTO Post (id, clipId, platform, postedAt) VALUES ('p1', 'c1', 'tiktok', 0)`);
  sql(`INSERT INTO Settings (id, layout) VALUES ('main', 'auto')`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, caption FROM Clip")), [{ id: "c1", caption: "old caption" }]);
  assert.deepEqual(JSON.parse(sql("SELECT campaignId FROM Streamer")), [{ campaignId: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT campaignLink, campaignId FROM Post")), [{ campaignLink: null, campaignId: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT channelName, watermark, layout FROM Settings")), [{ channelName: "ViceCityClips", watermark: true, layout: "auto" }]);
  assert.deepEqual(JSON.parse(sql("SELECT COUNT(*) AS n FROM Campaign")), [{ n: 0 }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
