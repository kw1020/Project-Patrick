import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHeat } from "../src/lib/chat";

// v1.7.1: Streamer.login is unique PER PLATFORM, so the same name can be a Twitch streamer and a YouTube channel.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v171-"));
const realFetch = globalThis.fetch;
const UC = (s: string) => `UC${s.padEnd(22, "x")}`;
const SCHEMA = path.join(__dirname, "..", "prisma", "schema.prisma");

before(async () => {
  // Fake yt-dlp: "Approve a YouTube channel" resolves @kaicenat / @otherkai.
  const fake = path.join(dir, "fake-ytdlp.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const url = process.argv[process.argv.length - 1];
const m = url.match(/@([^/]+)\\/videos$/);
const known = { kaicenat: "${UC("kai")}", otherkai: "${UC("other")}" };
if (!m || !known[m[1]]) { console.error("ERROR: [youtube:tab] This channel does not exist."); process.exit(1); }
const handle = m[1] === "otherkai" ? "kaicenat" : m[1]; // otherkai is a DIFFERENT channel that now uses @kaicenat
console.log(JSON.stringify({ id: known[m[1]], channel_id: known[m[1]], channel: "Kai Cenat", uploader_id: "@" + handle, entries: [] }));
`);
  fs.chmodSync(fake, 0o755);
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"),
    REDIS_URL: "redis://localhost:6379/13", // own Redis db: don't touch other tests' queues
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: "gta6-id",
    YOUTUBE_API_URL: "http://yt.test/youtube/v3", YTDLP: fake,
  });
  delete process.env.YOUTUBE_API_KEY;
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  (await import("../src/lib/twitch")).setSleep(async () => {});
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.YOUTUBE_API_KEY; });
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
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const USERS = [
  { id: "2", login: "kaicenat", display_name: "KaiCenat", profile_image_url: "http://kai.png" },
  { id: "3", login: "ishowspeed", display_name: "IShowSpeed", profile_image_url: "http://speed.png" },
  { id: "9", login: "xqc", display_name: "xQc", profile_image_url: "http://xqc.png" },
];
function stubTwitch(streams: unknown[] = []) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname.endsWith("/users")) {
      const ids = u.searchParams.getAll("id"), logins = u.searchParams.getAll("login");
      return json({ data: USERS.filter((x) => ids.includes(x.id) || logins.includes(x.login)) });
    }
    if (u.pathname.endsWith("/streams") && u.searchParams.get("game_id")) return json({ data: streams, pagination: {} });
    return json({ data: [], pagination: {} });
  }) as typeof fetch;
}

test("single add: the same name is approved on Twitch AND YouTube; a same-platform clash is still refused", async () => {
  stubTwitch();
  const { prisma } = await import("../src/lib/db");
  const actions = await import("../app/actions");
  assert.match((await actions.addStreamer(null, form({ login: "kaicenat", note: "" }))).ok!, /KaiCenat approved/);
  const yt = await actions.addYouTubeChannel(null, form({ channel: "@kaicenat", note: "" }));
  assert.equal(yt.error, undefined, yt.error);
  assert.match(yt.ok!, /youtube\.com\/@kaicenat\) approved/);
  const rows = await prisma.streamer.findMany({ where: { login: "kaicenat" }, orderBy: { platform: "asc" } });
  assert.deepEqual(rows.map((r) => [r.platform, r.twitchId, r.approved]), [["twitch", "2", true], ["youtube", `yt:${UC("kai")}`, true]]);
  // Adding again in either order changes nothing and never errors.
  assert.match((await actions.addStreamer(null, form({ login: "kaicenat", note: "" }))).ok!, /approved/);
  assert.ok((await actions.addYouTubeChannel(null, form({ channel: "@kaicenat", note: "" }))).ok);
  assert.equal(await prisma.streamer.count({ where: { login: "kaicenat" } }), 2);
  // A DIFFERENT YouTube channel now using @kaicenat: same-platform clash, plain message.
  const other = await actions.addYouTubeChannel(null, form({ channel: "@otherkai", note: "" }));
  assert.match(other.error!, /A YouTube channel called "kaicenat" is already in the list/);
  // A different Twitch account whose login an old Twitch row still holds (rename): plain message, no crash.
  await prisma.streamer.create({ data: { twitchId: "old-speed", login: "ishowspeed", name: "Old Speed" } });
  const stale = await actions.addStreamer(null, form({ login: "ishowspeed", note: "" }));
  assert.match(stale.error!, /another Twitch account in Clip Factory already uses the name "ishowspeed"/);
  // Credits stay per platform.
  const { creatorUrl } = await import("../src/lib/social");
  assert.deepEqual(rows.map((r) => creatorUrl(r)), ["https://twitch.tv/kaicenat", "https://youtube.com/@kaicenat"]);
  await prisma.streamer.deleteMany();
});

test("bulk add: both platforms approved; re-running adds the missing YouTube rows and leaves approved rows untouched", async () => {
  stubTwitch();
  const { prisma } = await import("../src/lib/db");
  const actions = await import("../app/actions");
  // What v1.7.0 left behind: Twitch-only rows already approved (YouTube was skipped as a "name clash").
  await prisma.streamer.create({ data: { twitchId: "2", login: "kaicenat", name: "KaiCenat", approved: true, approvalNote: "Paid campaign", profileImage: "http://old.png" } });
  const before = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "2" } });
  const picks = [
    { name: "Kai Cenat", twitch: { id: "2", login: "kaicenat", name: "KaiCenat", avatar: null }, youtube: { channelId: UC("kai"), handle: "@KaiCenat", title: "Kai Cenat", avatar: null } },
    { name: "xQc", twitch: { id: "9", login: "xqc", name: "xQc", avatar: null }, youtube: { channelId: UC("xqc"), handle: "xqc", title: "xQcOW", avatar: null } },
  ];
  const r1 = await actions.approveCreators(picks, "");
  assert.ok(r1.items.every((i) => i.ok), JSON.stringify(r1.items));
  assert.deepEqual([r1.twitchApproved, r1.youtubeApproved], [1, 2], "only xQc's Twitch row is new; both YouTube rows are new");
  const after1 = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "2" } });
  assert.deepEqual(after1, before, "existing approved Twitch row not touched");
  for (const login of ["kaicenat", "xqc"]) {
    const rows = await prisma.streamer.findMany({ where: { login, approved: true } });
    assert.deepEqual(rows.map((r) => r.platform).sort(), ["twitch", "youtube"], login);
  }
  // Run it again (Krew presses "Approve all ticked" twice): nothing new, nothing changed.
  const snapshot = await prisma.streamer.findMany({ orderBy: { twitchId: "asc" } });
  const r2 = await actions.approveCreators(picks, "A typed note");
  assert.deepEqual([r2.twitchApproved, r2.youtubeApproved], [0, 0]);
  assert.ok(r2.items.every((i) => i.ok && /already approved/.test(i.message)), JSON.stringify(r2.items));
  assert.deepEqual(await prisma.streamer.findMany({ orderBy: { twitchId: "asc" } }), snapshot);
  // The next lookup marks both as already approved (so the table un-ticks them).
  const { resolveCreators } = await import("../src/lib/creator-lookup");
  process.env.YOUTUBE_API_KEY = "k";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname.endsWith("/search/channels")) return json({ data: [{ id: "2", broadcaster_login: "kaicenat", display_name: "KaiCenat" }] });
    if (u.hostname === "yt.test" && u.searchParams.get("forHandle"))
      return json({ items: [{ id: UC("kai"), snippet: { title: "Kai Cenat", customUrl: "@kaicenat" }, statistics: { subscriberCount: "1" } }] });
    return json({ data: [] });
  }) as typeof fetch;
  const look = await resolveCreators(["Kai Cenat"]);
  assert.ok(look.rows[0].twitch.status === "found" && look.rows[0].twitch.match.approved);
  assert.ok(look.rows[0].youtube.status === "found" && look.rows[0].youtube.match.approved);
  await prisma.streamer.deleteMany();
});

test("Scout keeps a Twitch streamer whose login matches an approved YouTube @handle; Twitch-only paths ignore the YouTube row", async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.streamer.create({ data: { twitchId: `yt:${UC("speed")}`, platform: "youtube", login: "ishowspeed", name: "IShowSpeed YT", approved: true } });
  await prisma.streamer.create({ data: { twitchId: "3", login: "ishowspeed", name: "IShowSpeed", approved: true } });
  stubTwitch([{ id: "s3", user_id: "3", user_login: "ishowspeed", user_name: "IShowSpeed", game_id: "gta6-id", game_name: "Grand Theft Auto VI", title: "GTA", viewer_count: 50000, started_at: new Date().toISOString(), thumbnail_url: "" }]);
  const channels: string[][] = [];
  const { runScout } = await import("../src/workers/scout");
  await runScout({ setChannels: (l: string[]) => channels.push(l) } as unknown as ChatHeat);
  const tw = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "3" } });
  assert.deepEqual({ live: tw.isLive, viewers: tw.viewers, platform: tw.platform }, { live: true, viewers: 50000, platform: "twitch" });
  assert.deepEqual(channels.at(-1), ["ishowspeed"], "chat joined once, for the Twitch row");
  const yt = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${UC("speed")}` } });
  assert.deepEqual({ live: yt.isLive, platform: yt.platform, name: yt.name }, { live: false, platform: "youtube", name: "IShowSpeed YT" });
  await prisma.streamer.deleteMany();
});

test("db push upgrade from the v1.7.0 schema (login @unique) keeps every row and needs no --accept-data-loss", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  // The v1.7.0 schema (commit 04b05d1) differs only in these two lines.
  const old = now.replace(/  login         String\n/, "  login         String    @unique\n").replace(/\n\n  @@index\(\[platform, login\]\)\n}/, "\n}");
  assert.notEqual(old, now);
  assert.match(old, /login\s+String\s+@unique/);
  assert.doesNotMatch(old, /@@index\(\[platform, login\]\)/);
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
  `], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, approvalNote, createdAt, updatedAt) VALUES
    ('a', '2', 'kaicenat', 'KaiCenat', 'twitch', 1, 'Paid campaign', 0, 0),
    ('b', 'yt:${UC("b")}', 'mrbeast', 'MrBeast', 'youtube', 1, 'Approved by Krew', 0, 0)`);
  // Exactly what the web container runs on start: no flags.
  const second = push(SCHEMA);
  const out = second.stdout + second.stderr;
  assert.equal(second.status, 0, out);
  assert.doesNotMatch(out, /data loss|accept-data-loss/i);
  assert.match(out, /in sync/);
  const rows = JSON.parse(sql("SELECT id, twitchId, login, platform, approved, approvalNote FROM Streamer ORDER BY id"));
  assert.deepEqual(rows, [
    { id: "a", twitchId: "2", login: "kaicenat", platform: "twitch", approved: true, approvalNote: "Paid campaign" },
    { id: "b", twitchId: `yt:${UC("b")}`, login: "mrbeast", platform: "youtube", approved: true, approvalNote: "Approved by Krew" },
  ]);
  // After the upgrade the YouTube row for the same name fits next to the Twitch one.
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, createdAt, updatedAt) VALUES ('c', 'yt:${UC("kai")}', 'kaicenat', 'Kai Cenat', 'youtube', 0, 0)`);
  assert.equal(JSON.parse(sql("SELECT count(*) AS n FROM Streamer WHERE login = 'kaicenat'"))[0].n, 2);
  // Pushing again is a no-op.
  assert.equal(push(SCHEMA).status, 0);
});
