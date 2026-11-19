import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMocks, mockEnv, type Mock } from "./mocks";
import { toV200Schema } from "./schema-v173";
import { accountAction, autoPostTargets, isApiPostingAccount } from "../src/lib/channels";
import { explainInstagram, instagramCaption, instagramRedirectUri, pastedCallbackPath } from "../src/lib/instagram";

// v2.0.3: Instagram Reels auto-post (Business Login for Instagram) + opt-in TikTok Direct Post, against the stand-ins.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v203-"));
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
let mock: Mock;

before(async () => {
  mock = await startMocks();
  Object.assign(process.env, mockEnv(mock.url), { DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/15" });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function resetIg() {
  Object.assign(mock.ig, { statuses: ["IN_PROGRESS", "FINISHED"], uploadHttp: 200, publishError: null, containerError: null, tokenError: false, accountType: "MEDIA_CREATOR",
    permissions: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights", insightsError: false, published: 0, resumableRefused: false });
  mock.requests.length = 0;
}

async function approvedClip(login: string, extra: Record<string, unknown> = {}) {
  const { prisma } = await import("../src/lib/db");
  fs.mkdirSync(path.join(dir, "storage/final"), { recursive: true });
  const s = await prisma.streamer.upsert({ where: { twitchId: "t-" + login }, update: {}, create: { twitchId: "t-" + login, login, name: login.toUpperCase(), approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip" } });
  const c = await prisma.clip.create({ data: { momentId: m.id, title: "Bridge jump", caption: `He jumped the bridge?!\n\n🎥 @${login}\n\n#GTA6 #GTAVI #ViceCity #GTA6Clips`, status: "approved", ...extra } });
  fs.writeFileSync(path.join(dir, `storage/final/${c.id}.mp4`), Buffer.alloc(4096, 7));
  return prisma.clip.update({ where: { id: c.id }, data: { finalPath: `final/${c.id}.mp4` } });
}

async function igAccount() {
  const { connectInstagram } = await import("../src/lib/instagram");
  return connectInstagram("good-code");
}

test("pure: Instagram is an API platform now; Upload row says Post to Instagram; by-hand stays by hand", () => {
  assert.equal(accountAction({ platform: "instagram", mode: "api" }), "instagram");
  assert.equal(accountAction({ platform: "instagram", mode: "manual" }), "manual");
  assert.equal(isApiPostingAccount({ platform: "instagram", mode: "api" }), true);
  assert.equal(isApiPostingAccount({ platform: "instagram", mode: "manual" }), false);
  assert.equal(isApiPostingAccount({ platform: "twitch", mode: "api" }), false, "the Twitch follower login never posts");
  const accts = [{ id: "ig-vcc", homeChannelId: "main" }, { id: "ig-heist", homeChannelId: "streamheist" }];
  assert.deepEqual(autoPostTargets(accts, "main").map((a) => a.id), ["ig-vcc"]);
});

test("pure: redirect URI is the https version of APP_URL (Meta wants https); a pasted address finds its way back", () => {
  assert.equal(instagramRedirectUri(), "https://localhost:3000/api/instagram/callback");
  assert.equal(pastedCallbackPath("https://localhost:3000/api/instagram/callback?code=AQB-x_1&state=abc#_"), "/api/instagram/callback?code=AQB-x_1&state=abc");
  assert.equal(pastedCallbackPath("  code=AQBz#_ "), "/api/instagram/callback?code=AQBz");
  assert.equal(pastedCallbackPath("https://localhost:3000/api/instagram/callback?error=access_denied&error_reason=user_denied"), "/api/instagram/callback?error=access_denied&error_reason=user_denied");
  assert.equal(pastedCallbackPath("https://example.com/nothing"), null);
  process.env.INSTAGRAM_REDIRECT_URI = "https://my-tunnel.example/api/instagram/callback";
  assert.equal(instagramRedirectUri(), "https://my-tunnel.example/api/instagram/callback");
  delete process.env.INSTAGRAM_REDIRECT_URI;
});

test("pure: caption keeps the first 30 hashtags and at most 2200 characters; errors in plain words", () => {
  const tags = Array.from({ length: 35 }, (_, i) => `#t${i}`).join(" ");
  const out = instagramCaption(`Hook\n\n🎥 @kai\n\n${tags}`);
  assert.equal((out.match(/#/g) ?? []).length, 30);
  assert.match(out, /#t29\b/); assert.doesNotMatch(out, /#t30\b/);
  assert.equal(instagramCaption("x".repeat(3000)).length, 2200);
  assert.match(explainInstagram({ code: 9, error_subcode: 2207042 }, 400), /100 posts a day/);
  assert.match(explainInstagram({ code: 190 }, 400), /Reconnect/);
  assert.match(explainInstagram({ code: 10 }, 403), /Business or Creator/);
  assert.match(explainInstagram({ code: 4 }, 400), /too many requests/);
  assert.match(explainInstagram({ code: 1, error_subcode: 2207026 }, 400), /video format/);
  assert.match(explainInstagram({ code: 999, message: "odd" }, 500), /Instagram error 999: odd/);
});

test("connect: code -> short-lived -> long-lived (60 days) token, professional account saved with its scopes", async () => {
  resetIg();
  const { instagramAuthUrl } = await import("../src/lib/instagram");
  const u = new URL(instagramAuthUrl("st8"));
  assert.equal(u.searchParams.get("client_id"), "mock-ig-id");
  assert.equal(u.searchParams.get("redirect_uri"), "https://localhost:3000/api/instagram/callback");
  assert.equal(u.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights");
  assert.equal(u.searchParams.get("state"), "st8");

  const a = await igAccount();
  assert.equal(a.platform, "instagram");
  assert.equal(a.mode, "api");
  assert.equal(a.channelId, "17841400001", "the professional account id (user_id) is what /media takes");
  assert.equal(a.channelTitle, "@vicecity.clips");
  assert.equal(a.accessToken, "IGlong");
  assert.equal(a.error, null);
  assert.match(a.scopes!, /instagram_business_content_publish/);
  assert.ok(a.expiresAt!.getTime() - Date.now() > 59 * 86400_000);
  const tok = mock.requests.find((r) => r.path.startsWith("/ig/oauth/access_token"))!;
  const f = new URLSearchParams(tok.body.toString());
  assert.equal(f.get("redirect_uri"), "https://localhost:3000/api/instagram/callback", "the same redirect URI as the authorize step");
  assert.equal(f.get("grant_type"), "authorization_code");
  assert.ok(mock.requests.some((r) => r.path.startsWith("/ig-graph/access_token?") && r.path.includes("ig_exchange_token")));

  // Reconnecting the same account updates it (no duplicate row).
  const again = await igAccount();
  assert.equal(again.id, a.id);
});

test("connect: personal account and missing permission are explained; a bad code fails in plain words", async () => {
  resetIg();
  const { connectInstagram } = await import("../src/lib/instagram");
  mock.ig.accountType = "PERSONAL";
  mock.ig.permissions = "instagram_business_basic";
  const a = await connectInstagram("good-code");
  assert.match(a.error!, /personal Instagram account/);
  assert.match(a.error!, /Missing permission: posting/);
  await assert.rejects(connectInstagram("bad"), /Instagram sign-in failed: Matching code was not found/);
  resetIg();
  await igAccount(); // back to a working account for the next tests
});

test("connecting into a channel slot replaces its by-hand Instagram and keeps that account's posts", async () => {
  resetIg();
  const { prisma } = await import("../src/lib/db");
  const { assignHomeChannel } = await import("../src/lib/to-post");
  await prisma.settings.upsert({ where: { id: "main" }, update: { migratedChannels: true }, create: { id: "main", migratedChannels: true } });
  await prisma.channel.upsert({ where: { id: "main" }, update: {}, create: { id: "main", name: "ViceCityClips", focus: "gta", kinds: "gaming,funny,edits" } });
  const manual = await prisma.account.create({ data: { platform: "instagram", mode: "manual", handle: "@vicecity.clips", channelTitle: "@vicecity.clips", refreshToken: "", homeChannelId: "main" } });
  const clip = await approvedClip("mira");
  await prisma.post.create({ data: { clipId: clip.id, platform: "instagram", accountId: manual.id, url: "https://www.instagram.com/reel/OLD/", channelId: "main" } });
  const a = await igAccount();
  await prisma.account.update({ where: { id: a.id }, data: { homeChannelId: null } });
  assert.equal(await assignHomeChannel(a.id, "main"), "main");
  assert.equal(await prisma.account.findUnique({ where: { id: manual.id } }), null, "by-hand row replaced");
  assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).homeChannelId, "main");
  const posts = await prisma.post.findMany({ where: { clipId: clip.id } });
  assert.deepEqual(posts.map((p) => [p.accountId, p.url]), [[a.id, "https://www.instagram.com/reel/OLD/"]], "its post now belongs to the connected account");

  // A slot held by a CONNECTED account is never taken over.
  const other = await prisma.account.create({ data: { platform: "instagram", mode: "api", channelId: "other-ig", channelTitle: "@other", refreshToken: "x" } });
  assert.notEqual(await assignHomeChannel(other.id, "main"), "main");
  assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).homeChannelId, "main");
  await prisma.account.delete({ where: { id: other.id } });
});

test("poster: Reel = resumable container -> local file to rupload -> wait for FINISHED -> publish -> permalink; never twice", async () => {
  resetIg();
  const { prisma } = await import("../src/lib/db");
  const { runPost } = await import("../src/workers/poster");
  const a = await igAccount();
  // v1.9.8 Platform check still rules: a caption whose credit was edited out is blocked before anything is uploaded.
  const nocredit = await approvedClip("kai", { caption: "He jumped the bridge?!\n\n#GTA6 #GTAVI #ViceCity" });
  await assert.rejects(runPost(nocredit.id, a.id), /Platform check failed: Caption doesn't credit/);
  assert.equal(mock.requests.filter((r) => r.path.includes("/17841400001/media")).length, 0, "nothing sent to Instagram");
  const clip = await approvedClip("kai");
  assert.match(await runPost(clip.id, a.id), /Instagram Reel/);
  const create = mock.requests.find((r) => r.path.includes("/17841400001/media") && !r.path.includes("publish"))!;
  const f = new URLSearchParams(create.body.toString());
  assert.equal(f.get("media_type"), "REELS");
  assert.equal(f.get("upload_type"), "resumable");
  assert.match(f.get("caption")!, /🎥 @kai/, "the caption (with its creator credit) goes on the Reel");
  const up = mock.requests.find((r) => r.path.startsWith("/ig-rupload/"))!;
  assert.equal(up.path, "/ig-rupload/ig-api-upload/v27.0/cont-1");
  assert.equal(up.headers.authorization, "OAuth IGlong");
  assert.equal(up.headers.offset, "0");
  assert.equal(up.headers.file_size, "4096");
  assert.equal(up.body.length, 4096, "the local final file itself is uploaded (no public URL needed)");
  assert.ok(mock.requests.filter((r) => r.path.includes("/cont-1?")).length >= 2, "container status polled until FINISHED");
  const post = await prisma.post.findFirstOrThrow({ where: { clipId: clip.id, accountId: a.id } });
  assert.deepEqual([post.status, post.externalId, post.url, post.publishId, post.platform], ["live", "reel-9", "https://www.instagram.com/reel/ABC123/", "cont-1", "instagram"]);
  assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } })).status, "posted");
  assert.match(await runPost(clip.id, a.id), /already sent/);
  assert.equal(mock.ig.published, 1, "published exactly once");
});

test("poster: rupload 400 is not final (Meta forum, Nov 2026): container FINISHED -> still published", async () => {
  resetIg();
  mock.ig.uploadHttp = 400;
  const { runPost } = await import("../src/workers/poster");
  const a = await igAccount();
  const clip = await approvedClip("kai");
  assert.match(await runPost(clip.id, a.id), /Instagram Reel/);
  assert.equal(mock.ig.published, 1);
});

test("poster: container ERROR / publish refused / resumable refused -> failed post, plain message, nothing published", async () => {
  const { prisma } = await import("../src/lib/db");
  const { runPost } = await import("../src/workers/poster");
  const a = await igAccount();

  resetIg();
  mock.ig.statuses = ["IN_PROGRESS", "ERROR"];
  const c1 = await approvedClip("kai");
  await assert.rejects(runPost(c1.id, a.id), /couldn't process the video \(Error: unsupported audio codec\)/);
  assert.equal((await prisma.post.findFirstOrThrow({ where: { clipId: c1.id } })).status, "failed");
  assert.equal(mock.ig.published, 0);

  resetIg();
  mock.ig.publishError = { message: "limit", code: 9, error_subcode: 2207042 };
  const c2 = await approvedClip("kai");
  await assert.rejects(runPost(c2.id, a.id), /100 posts a day/);
  const p2 = await prisma.post.findFirstOrThrow({ where: { clipId: c2.id } });
  assert.equal(p2.status, "failed", "container FINISHED but never published = safe to try again");
  // ...and a later Post works (the failed row doesn't block it).
  mock.ig.publishError = null;
  assert.match(await runPost(c2.id, a.id), /Instagram Reel/);

  resetIg();
  mock.ig.resumableRefused = true;
  const c3 = await approvedClip("kai");
  await assert.rejects(runPost(c3.id, a.id), /refused uploading the video file directly/);
  assert.equal(await prisma.post.count({ where: { clipId: c3.id } }), 0, "no container, no post row");

  resetIg();
  mock.ig.statuses = ["IN_PROGRESS"];
  const c4 = await approvedClip("kai");
  const { publishReel } = await import("../src/lib/instagram");
  const acct = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
  await assert.rejects(publishReel(acct, path.join(dir, `storage/${c4.finalPath}`), "cap", { pollMs: 5, maxWaitMs: 40 }), /still processing.*NOT published/);
  assert.equal(mock.ig.published, 0);
});

test("edits: a connected Instagram in the Edits channel posts the approved edit as a Reel (EditPost), once", async () => {
  resetIg();
  const { prisma } = await import("../src/lib/db");
  const { runPostEdit } = await import("../src/workers/poster");
  await prisma.channel.upsert({ where: { id: "gg" }, update: {}, create: { id: "gg", name: "ClipFactoryGG", kinds: "edits", focus: "any" } });
  const a = await igAccount();
  await prisma.account.update({ where: { id: a.id }, data: { homeChannelId: "gg" } });
  const st = await prisma.streamer.upsert({ where: { twitchId: "t-edity" }, update: {}, create: { twitchId: "t-edity", login: "edity", name: "EDITY", approved: true } });
  fs.mkdirSync(path.join(dir, "storage/edits/ig1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "storage/edits/ig1/final.mp4"), Buffer.alloc(2048, 3));
  const e = await prisma.edit.create({ data: { id: "ig1", streamerId: st.id, vibe: "hype", lengthSec: 20, bpm: 128, status: "pending", finalPath: "edits/ig1/final.mp4", title: "EDITY edit", caption: "EDITY edit\n\n🎥 @edity\n\n#edit" } });
  await assert.rejects(runPostEdit(e.id, a.id), /isn't approved/);
  await prisma.edit.update({ where: { id: e.id }, data: { status: "approved" } });
  assert.match(await runPostEdit(e.id, a.id), /EDITY edit to @vicecity\.clips as an Instagram Reel/);
  const ep = await prisma.editPost.findFirstOrThrow({ where: { editId: e.id } });
  assert.deepEqual([ep.platform, ep.status, ep.externalId, ep.url, ep.channelId], ["instagram", "live", "reel-9", "https://www.instagram.com/reel/ABC123/", "gg"]);
  assert.equal((await prisma.edit.findUniqueOrThrow({ where: { id: e.id } })).status, "posted");
  assert.match(await runPostEdit(e.id, a.id), /already sent/);
  assert.equal(mock.ig.published, 1);
  await prisma.account.update({ where: { id: a.id }, data: { homeChannelId: "main" } });
});

test("poster: refuses clips Krew hasn't approved and by-hand Instagram accounts", async () => {
  resetIg();
  const { prisma } = await import("../src/lib/db");
  const { runPost } = await import("../src/workers/poster");
  const a = await igAccount();
  const pending = await approvedClip("kai", { status: "pending" });
  await assert.rejects(runPost(pending.id, a.id), /isn't approved/);
  const hand = await prisma.account.create({ data: { platform: "instagram", mode: "manual", handle: "@byhand", refreshToken: "" } });
  const ok = await approvedClip("kai");
  await assert.rejects(runPost(ok.id, hand.id), /posted to by hand/);
  assert.equal(mock.ig.published, 0);
});

test("token: refreshed only when under 7 days are left (and >= 24h old); an expired one says reconnect", async () => {
  resetIg();
  const { prisma } = await import("../src/lib/db");
  const { instagramToken } = await import("../src/lib/instagram");
  const a = await igAccount();
  const before = mock.ig.refreshCount;
  assert.equal(await instagramToken(await prisma.account.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() + 30 * 86400_000) } })), "IGlong");
  assert.equal(mock.ig.refreshCount, before, "30 days left: no refresh");
  const fresh = await instagramToken(await prisma.account.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() + 3 * 86400_000) } }));
  assert.equal(mock.ig.refreshCount, before + 1);
  assert.equal(fresh, `IGlong${mock.ig.refreshCount}`);
  const saved = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(saved.accessToken, fresh);
  assert.ok(saved.expiresAt!.getTime() - Date.now() > 59 * 86400_000, "another 60 days");
  await assert.rejects(instagramToken(await prisma.account.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } })), /ran out.*Reconnect/);
  assert.match((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).error!, /Reconnect/);
  await igAccount(); // reconnect clears it
});

test("stats sync: Reels views (insights) + likes/comments; without insights, likes/comments only; a stuck publish is settled", async () => {
  resetIg();
  const { prisma } = await import("../src/lib/db");
  const { runStatsSync } = await import("../src/workers/poster");
  const a = await igAccount();
  const clip = await approvedClip("kai");
  const p = await prisma.post.create({ data: { clipId: clip.id, platform: "instagram", accountId: a.id, externalId: "reel-9", status: "live" } });
  const stuck = await prisma.post.create({ data: { clipId: clip.id, platform: "instagram", accountId: a.id, publishId: "cont-1", status: "processing", postedAt: new Date(Date.now() - 3600_000) } });
  mock.ig.statuses = ["PUBLISHED"];
  const out = await runStatsSync();
  assert.match(out, /@vicecity\.clips: \d+ Reels checked/);
  const got = await prisma.post.findUniqueOrThrow({ where: { id: p.id } });
  assert.deepEqual([got.views, got.likes, got.comments], [4321, 80, 6]);
  assert.deepEqual(await prisma.post.findUniqueOrThrow({ where: { id: stuck.id } }).then((x) => [x.status, x.error]), ["live", "Posted, but Clip Factory didn't get the link"]);

  mock.ig.insightsError = true;
  await prisma.post.update({ where: { id: p.id }, data: { likes: 0 } });
  await runStatsSync();
  const g2 = await prisma.post.findUniqueOrThrow({ where: { id: p.id } });
  assert.deepEqual([g2.views, g2.likes, g2.comments], [4321, 77, 5], "views kept, likes/comments from the basic fields");
});

test("approve: an Instagram 'post when I approve' account in the clip's channel gets the upload; a turned-off one doesn't", async () => {
  const { prisma } = await import("../src/lib/db");
  const { setClipStatus } = await import("../app/actions");
  const { queue, redis } = await import("../src/lib/queues");
  await queue("post").obliterate({ force: true });
  const a = await igAccount();
  await prisma.account.update({ where: { id: a.id }, data: { autoPost: true, homeChannelId: "main", disabled: false } });
  const clip = await approvedClip("kai", { status: "pending", channelId: "main" });
  await setClipStatus(clip.id, "approved");
  const jobs = await queue("post").getJobs(["waiting", "delayed", "prioritized"]);
  assert.deepEqual(jobs.map((j) => j.data), [{ clipId: clip.id, accountId: a.id }]);

  await queue("post").obliterate({ force: true });
  await prisma.account.update({ where: { id: a.id }, data: { disabled: true } });
  const c2 = await approvedClip("kai", { status: "pending", channelId: "main" });
  await setClipStatus(c2.id, "approved");
  assert.equal((await queue("post").getJobs(["waiting", "delayed", "prioritized"])).length, 0, "disabled account skipped");
  await queue("post").obliterate({ force: true });
  await prisma.account.update({ where: { id: a.id }, data: { disabled: false, autoPost: false } });
  redis().disconnect();
});

test("tiktok: drafts stay the default; Direct Post is opt-in, needs video.publish, posts SELF_ONLY with the creator's switches", async () => {
  const { prisma } = await import("../src/lib/db");
  const tt = await import("../src/lib/tiktok");
  const { runPost, runStatsSync } = await import("../src/workers/poster");
  assert.doesNotMatch(new URL(tt.tiktokAuthUrl("s", "c")).searchParams.get("scope")!, /video\.publish/, "not asked for unless switched on");
  process.env.TIKTOK_DIRECT_POST = "on";
  assert.match(new URL(tt.tiktokAuthUrl("s", "c")).searchParams.get("scope")!, /video\.publish/);
  mock.ttScope = "user.info.basic,user.info.profile,video.upload,video.list,video.publish";
  const acct = await tt.connectTikTok("code", "verifier");
  assert.equal(tt.canDirectPost(acct), true);

  // Default: still a draft.
  mock.requests.length = 0;
  const c0 = await approvedClip("kai");
  assert.match(await runPost(c0.id, acct.id), /TikTok inbox/);

  await prisma.account.update({ where: { id: acct.id }, data: { directPost: true } });
  mock.requests.length = 0;
  const c1 = await approvedClip("kai");
  assert.match(await runPost(c1.id, acct.id), /private: only you can see it/);
  const init = mock.requests.find((r) => r.path.startsWith("/v2/post/publish/video/init/"))!;
  const body = JSON.parse(init.body.toString());
  assert.equal(body.post_info.privacy_level, "SELF_ONLY");
  assert.equal(body.post_info.disable_duet, true, "follows creator_info");
  assert.equal(body.post_info.disable_comment, false);
  assert.match(body.post_info.title, /@kai/);
  assert.equal(body.source_info.source, "FILE_UPLOAD");
  const post = await prisma.post.findFirstOrThrow({ where: { clipId: c1.id } });
  assert.deepEqual([post.status, post.publishId], ["live", "v_pub_file~v2.9"]);

  // The sync follows it: PUBLISH_COMPLETE without a public id (private) -> noted, no link.
  mock.tiktokStatus = { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] };
  await runStatsSync();
  assert.equal((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).error, "Posted as private (only you can see it)");

  // Unaudited app on a public account: TikTok's error in plain words.
  mock.ttDirectError = "unaudited_client_can_only_post_to_private_accounts";
  const c2 = await approvedClip("kai");
  await assert.rejects(runPost(c2.id, acct.id), /PRIVATE accounts.*switch off "Post directly"/);
  mock.ttDirectError = null;
  mock.ttCreator = { privacy_level_options: ["PUBLIC_TO_EVERYONE"] };
  const c3 = await approvedClip("kai");
  await assert.rejects(runPost(c3.id, acct.id), /only me/);

  // Without the scope, a ticked box can't post directly.
  mock.ttCreator = { privacy_level_options: ["SELF_ONLY"] };
  await prisma.account.update({ where: { id: acct.id }, data: { scopes: "video.upload" } });
  const c4 = await approvedClip("kai");
  await assert.rejects(runPost(c4.id, acct.id), /didn't allow direct posting/);
  delete process.env.TIKTOK_DIRECT_POST;
});

test("db push upgrade from the v2.0.0 schema (87ddbb4) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV200Schema(now);
  const git = spawnSync("git", ["show", "87ddbb4:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the v2.0.0 one");
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
  sql(`INSERT INTO Channel (id, name, createdAt) VALUES ('main', 'ViceCityClips', 0)`);
  sql(`INSERT INTO Account (id, platform, channelId, refreshToken, mode, handle, homeChannelId, createdAt) VALUES ('ig1', 'instagram', NULL, '', 'manual', '@vicecity.clips', 'main', 0)`);
  sql(`INSERT INTO Account (id, platform, channelId, refreshToken, autoPost, createdAt) VALUES ('tt1', 'tiktok', 'open-1', 'rft', 1, 0)`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, mode, handle, homeChannelId, scopes, directPost, autoPost FROM Account ORDER BY id")), [
    { id: "ig1", mode: "manual", handle: "@vicecity.clips", homeChannelId: "main", scopes: null, directPost: false, autoPost: false },
    { id: "tt1", mode: "api", handle: null, homeChannelId: null, scopes: null, directPost: false, autoPost: true },
  ]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
