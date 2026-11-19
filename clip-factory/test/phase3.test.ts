import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMocks, mockEnv, type Mock } from "./mocks";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf3-"));
let mock: Mock;

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), { DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage") });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function approvedClip(login: string, extra: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  fs.mkdirSync(path.join(dir, "storage/final"), { recursive: true });
  const s = await prisma.streamer.upsert({ where: { twitchId: "t-" + login }, update: {}, create: { twitchId: "t-" + login, login, name: login.toUpperCase(), approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip" } });
  const c = await prisma.clip.create({ data: { momentId: m.id, title: "T", caption: `c\n\n🎥 @${login}`, status: "approved", ...extra } });
  fs.writeFileSync(path.join(dir, `storage/final/${c.id}.mp4`), Buffer.alloc(3000, 1));
  return prisma.clip.update({ where: { id: c.id }, data: { finalPath: `final/${c.id}.mp4` } });
}

test("tiktok: PKCE challenge is hex SHA-256 of the verifier; authorize URL has the right params", async () => {
  const tt = await import("../src/lib/tiktok");
  const { verifier, challenge } = tt.pkce();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("hex"));
  const u = new URL(tt.tiktokAuthUrl("st", challenge));
  assert.equal(u.searchParams.get("client_key"), "mock-key");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:3000/api/tiktok/callback");
  assert.match(u.searchParams.get("scope")!, /video\.upload/);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

test("tiktok: chunk plan follows TikTok's rules", async () => {
  const { chunkPlan } = await import("../src/lib/tiktok");
  const MB = 1024 * 1024;
  assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1 });
  assert.deepEqual(chunkPlan(60 * MB), { chunkSize: 60 * MB, count: 1 });
  assert.deepEqual(chunkPlan(105 * MB), { chunkSize: 10 * MB, count: 10 }); // last chunk carries the extra 5 MB
});

test("tiktok: connect, send draft, follow it until posted, pull stats, rotate refresh token", async () => {
  const { prisma } = await import("../src/lib/db");
  const tt = await import("../src/lib/tiktok");
  const { runPost, runStatsSync } = await import("../src/workers/poster");

  const acct = await tt.connectTikTok("code", "verifier-xyz");
  assert.equal(acct.channelTitle, "@krewclips");
  assert.equal(acct.error, null);
  const tokenReq = mock.requests.find((r) => r.path.startsWith("/v2/oauth/token/"))!;
  assert.equal(new URLSearchParams(tokenReq.body.toString()).get("code_verifier"), "verifier-xyz");

  const clip = await approvedClip("kai");
  mock.requests.length = 0;
  assert.match(await runPost(clip.id, acct.id), /TikTok inbox/);
  const put = mock.requests.find((r) => r.path.startsWith("/tt-upload/"))!;
  assert.equal(put.headers["content-range"], "bytes 0-2999/3000");
  const init = JSON.parse(mock.requests.find((r) => r.path.includes("/inbox/video/init/"))!.body.toString());
  assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: 3000, chunk_size: 3000, total_chunk_count: 1 });

  let post = await prisma.post.findFirstOrThrow({ where: { accountId: acct.id } });
  assert.equal(post.status, "draft");
  await runStatsSync();
  assert.equal((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status, "draft", "still waiting in the inbox");

  // Krew posts it in the TikTok app.
  mock.tiktokStatus = { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7300000000000000001n.toString()] };
  await prisma.account.update({ where: { id: acct.id }, data: { expiresAt: new Date(0) } }); // force a refresh
  assert.match(await runStatsSync(), /1 drafts went live, 1 updated/);
  post = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
  assert.equal(post.status, "live");
  assert.equal(post.url, "https://www.tiktok.com/@krewclips/video/7300000000000000001");
  assert.equal(post.views, 12000);
  assert.equal(post.likes, 900);
  assert.equal(await prisma.postStat.count({ where: { postId: post.id } }), 1);
  const after = await prisma.account.findUniqueOrThrow({ where: { id: acct.id } });
  assert.match(after.refreshToken, /^rft\.mock[1-9]/, "rotated refresh token is saved");
});

test("tiktok: refuses a 6th waiting draft and never posts unapproved clips", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runPost } = await import("../src/workers/poster");
  const acct = await prisma.account.findFirstOrThrow({ where: { platform: "tiktok" } });
  for (let i = 0; i < 5; i++) {
    const c = await approvedClip("kai");
    await prisma.post.create({ data: { clipId: c.id, platform: "tiktok", accountId: acct.id, status: "draft", publishId: "p" + i } });
  }
  const c = await approvedClip("kai");
  await assert.rejects(runPost(c.id, acct.id), /5 drafts waiting/);
  const pending = await approvedClip("kai", { status: "pending" });
  await assert.rejects(runPost(pending.id, acct.id), /isn't approved/);
});

test("multi-account: one clip goes to two YouTube channels, once each", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runPost } = await import("../src/workers/poster");
  const a = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-a", channelTitle: "Main", refreshToken: "r", accessToken: "x", expiresAt: new Date(Date.now() + 3600_000) } });
  const b = await prisma.account.create({ data: { platform: "youtube", channelId: "UC-b", channelTitle: "Second", refreshToken: "r", accessToken: "x", expiresAt: new Date(Date.now() + 3600_000), privacy: "unlisted" } });
  const clip = await approvedClip("mia");
  assert.match(await runPost(clip.id, a.id), /to Main \(public\)/);
  assert.match(await runPost(clip.id, b.id), /to Second \(unlisted\)/);
  assert.match(await runPost(clip.id, a.id), /already sent/);
  assert.equal(await prisma.post.count({ where: { clipId: clip.id } }), 2);
});

test("learning: lessons appear after 6 settled posts and reach the Judge's instructions", async () => {
  const { prisma } = await import("../src/lib/db");
  const { buildLessons } = await import("../src/lib/learning");
  const { judgeCorrelation, performance } = await import("../src/lib/analytics");
  const { judgeClip } = await import("../src/lib/judge");
  await prisma.postStat.deleteMany(); await prisma.post.deleteMany();
  assert.equal(await buildLessons(), null, "nothing to learn yet");

  const acct = await prisma.account.findFirstOrThrow({ where: { channelId: "UC-a" } });
  const old = new Date(Date.now() - 3 * 86400_000);
  const data = [
    { score: 9, views: 50000, hook: "He jumped the bridge?!", src: "chat" }, { score: 8, views: 30000, hook: "Cops lost him", src: "chat" },
    { score: 7, views: 9000, hook: null, src: "twitch_clip" }, { score: 6, views: 8000, hook: null, src: "twitch_clip" },
    { score: 6, views: 7000, hook: "ok", src: "twitch_clip" }, { score: 5, views: 1000, hook: null, src: "twitch_clip" },
  ];
  for (const [i, d] of data.entries()) {
    const c = await approvedClip("kai", { score: d.score, hookText: d.hook, title: `Clip ${i}`, transcript: `line ${i}`, duration: 30 });
    await prisma.moment.update({ where: { id: c.momentId }, data: { source: d.src } });
    await prisma.post.create({ data: { clipId: c.id, platform: "youtube", accountId: acct.id, views: d.views, postedAt: old } });
  }
  const rows = await performance(24);
  assert.equal(rows.length, 6);
  assert.ok(judgeCorrelation(rows)! >= 0.95, "scores lined up with views here (one tie at 6)");
  const lessons = await buildLessons();
  assert.ok(lessons);
  assert.match(lessons.text, /Best performers:\n- 5.88x typical views \(50,000 on Main\), chat spike/);
  assert.match(lessons.text, /Weakest performers:\n- 0.12x/);
  assert.match(lessons.text, /Hook on video: with hook 3.41x \(3 posts\), no hook 0.71x \(3 posts\)/);
  assert.doesNotMatch(lessons.text, /- Source:/, "chat spikes have only 2 posts, so no source comparison");

  mock.requests.length = 0;
  await judgeClip({ streamer: "Kai", durationSec: 30, source: "chat", transcript: "x", minScore: 6 }, lessons.text);
  const req = JSON.parse(mock.requests.find((r) => r.path.startsWith("/v1/messages"))!.body.toString());
  assert.equal(req.system.length, 2);
  assert.match(req.system[1].text, /^<results_from_krews_accounts>\nResults so far/);
  assert.deepEqual(req.system[1].cache_control, { type: "ephemeral" });
  assert.equal(req.system[0].cache_control, undefined, "one cache breakpoint, at the end of the system prompt");
});
