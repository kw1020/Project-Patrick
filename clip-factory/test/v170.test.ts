import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// v1.7.0: one-click approve (no reason), "Add a list of creators" (bulk resolver + approve), Workroom data.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v170-"));
const realFetch = globalThis.fetch;
const MIN = 60_000;

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"),
    REDIS_URL: "redis://localhost:6379/12", // own Redis db: don't touch other tests' queues
    TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_GAME_ID: "gta6-id",
    YOUTUBE_API_URL: "http://yt.test/youtube/v3", MAX_BACKLOG: "3",
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
const UC = (s: string) => `UC${s.padEnd(22, "x")}`;
const chan = (id: string, login: string, display: string, live = false, game = "") => ({ id, broadcaster_login: login, display_name: display, thumbnail_url: `http://${login}.png`, is_live: live, game_name: game });

const TWITCH_SEARCH: Record<string, unknown[] | "fail" | "hang"> = {
  "Kai Cenat": [chan("1", "kaicenatfan", "KaiCenatFan", true, "Just Chatting"), chan("2", "kaicenat", "KaiCenat", false, "GTA")],
  "Marlon": [chan("3", "marlonxyz", "marlonxyz"), chan("4", "marlon_live", "Marlon_Live", true, "Fortnite")],
  "Case Oh": [chan("5", "caseoh_", "caseoh_", true, "GTA")],
  "Nobody Here": [],
  "Big Yt": [],
  "Broken": "fail",
  "Slow": "hang",
};
const YT_CHANNELS: Record<string, { id: string; snippet: Record<string, unknown>; statistics: Record<string, unknown> }> = {
  kai: { id: UC("kai"), snippet: { title: "Kai Cenat", customUrl: "@KaiCenat", thumbnails: { default: { url: "http://yt-kai" } } }, statistics: { subscriberCount: "10500000" } },
  a: { id: UC("a"), snippet: { title: "Big Yt Clips", customUrl: "@bigytclips" }, statistics: { subscriberCount: "5000" } },
  b: { id: UC("b"), snippet: { title: "Big YT", customUrl: "@bigyt" }, statistics: { subscriberCount: "2000000" } },
  c: { id: UC("c"), snippet: { title: "Unrelated Giant", customUrl: "@giant" }, statistics: { subscriberCount: "99000000" } },
};

function stub(opts: { ytQuota?: boolean } = {}) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(u);
    if (u.hostname === "id.twitch.tv") return json({ access_token: "tok", expires_in: 3600 });
    if (u.hostname === "yt.test") {
      if (opts.ytQuota) return json({ error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } }, 403);
      if (u.pathname.endsWith("/channels") && u.searchParams.get("forHandle")) {
        return json(u.searchParams.get("forHandle") === "@KaiCenat" ? { items: [YT_CHANNELS.kai] } : {});
      }
      if (u.pathname.endsWith("/search")) {
        return json(u.searchParams.get("q") === "Big Yt" ? { items: ["a", "b", "c"].map((k) => ({ id: { kind: "youtube#channel", channelId: YT_CHANNELS[k].id } })) } : { items: [] });
      }
      if (u.pathname.endsWith("/channels")) {
        const ids = (u.searchParams.get("id") ?? "").split(",");
        return json({ items: Object.values(YT_CHANNELS).filter((c) => ids.includes(c.id)) });
      }
    }
    if (u.pathname.endsWith("/search/channels")) {
      const r = TWITCH_SEARCH[u.searchParams.get("query") ?? ""] ?? [];
      if (r === "fail") return json({ message: "bad request" }, 400);
      if (r === "hang") return new Promise<Response>(() => {});
      return json({ data: r });
    }
    if (u.pathname.endsWith("/users")) {
      const users = [
        { id: "2", login: "kaicenat", display_name: "KaiCenat", profile_image_url: "http://kai-fresh.png" },
        { id: "5", login: "caseoh_", display_name: "caseoh_", profile_image_url: "http://caseoh.png" },
        { id: "50", login: "someone", display_name: "Someone", profile_image_url: "http://someone.png" },
      ];
      const ids = u.searchParams.getAll("id"), logins = u.searchParams.getAll("login");
      return json({ data: users.filter((x) => ids.includes(x.id) || logins.includes(x.login)) });
    }
    return json({ data: [] });
  }) as typeof fetch;
  return calls;
}

// ---------- One-click approve ----------
test("every approve path works with no reason; the note defaults sensibly", async () => {
  stub();
  const { prisma } = await import("../src/lib/db");
  const { queue } = await import("../src/lib/queues");
  const actions = await import("../app/actions");

  // Streamers page "Approve a streamer" with an empty note.
  const r = await actions.addStreamer(null, form({ login: "https://twitch.tv/Someone", note: "" }));
  assert.match(r.ok!, /Someone approved/);
  let s = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "50" } });
  assert.deepEqual({ approved: s.approved, note: s.approvalNote }, { approved: true, note: "Approved by Krew" });
  // A typed note is kept.
  await actions.addStreamer(null, form({ login: "someone", note: "Paid campaign" }));
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "50" } })).approvalNote, "Paid campaign");

  // Live page / Scout list one-click Approve: evidence quote when their suggestion had one, else the default.
  const withEv = await prisma.streamer.create({ data: { twitchId: "70", login: "evguy", name: "EvGuy" } });
  await prisma.suggestion.create({ data: { streamerId: withEv.id, score: 10, reasons: "[]", evidence: "Clips welcome!", evidenceSource: "bio" } });
  const plain = await prisma.streamer.create({ data: { twitchId: "71", login: "plainguy", name: "PlainGuy" } });
  await queue("scout").drain();
  await actions.approveStreamer(withEv.id);
  await actions.approveStreamer(plain.id);
  s = await prisma.streamer.findUniqueOrThrow({ where: { id: withEv.id } });
  assert.deepEqual({ approved: s.approved, note: s.approvalNote }, { approved: true, note: 'Bio says: "Clips welcome!"' });
  s = await prisma.streamer.findUniqueOrThrow({ where: { id: plain.id } });
  assert.deepEqual({ approved: s.approved, note: s.approvalNote }, { approved: true, note: "Approved by Krew" });
  assert.ok((await queue("scout").getWaitingCount()) >= 1, "Scout poked");

  // setApproved directly: typed note wins; unapproving leaves the note alone; empty note → default.
  await actions.setApproved(plain.id, true, "  Discord says OK  ");
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: plain.id } })).approvalNote, "Discord says OK");
  await actions.setApproved(plain.id, false);
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: plain.id } })).approved, false);
  await actions.setApproved(plain.id, true, "");
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: plain.id } })).approvalNote, "Approved by Krew");

  // Suggestion card: Approve with no form at all.
  const sugGuy = await prisma.streamer.create({ data: { twitchId: "72", login: "sugguy", name: "SugGuy" } });
  const sug = await prisma.suggestion.create({ data: { streamerId: sugGuy.id, score: 9, reasons: "[]" } });
  assert.match((await actions.approveSuggestion(sug.id, null)).ok!, /SugGuy approved/);
  s = await prisma.streamer.findUniqueOrThrow({ where: { id: sugGuy.id } });
  assert.deepEqual({ approved: s.approved, note: s.approvalNote }, { approved: true, note: "Approved by Krew" });
  assert.equal((await prisma.suggestion.findUniqueOrThrow({ where: { id: sug.id } })).status, "approved");
});

// ---------- Bulk resolver ----------
test("starter list: exactly Krew's 21 names, in order", async () => {
  const { KREW_TOP_21 } = await import("../src/lib/starter-creators");
  assert.deepEqual([...KREW_TOP_21], ["Kai Cenat", "IShowSpeed", "xQc", "Jynxzi", "Adin Ross", "CaseOh", "Marlon", "Lacy", "Joe Bart", "Ninja", "Pokimane",
    "Shroud", "Clix", "Asmongold", "HasanAbi", "Ludwig", "Sodapoppin", "TimTheTatman", "Tarik", "Sketch", "Fanum"]);
});

test("pickTwitch: exact name (ignoring case/spaces/underscores) first, then live + prefix, prefix, live, first", async () => {
  const { pickTwitch } = await import("../src/lib/creator-lookup");
  assert.equal(pickTwitch("Kai Cenat", TWITCH_SEARCH["Kai Cenat"] as never)!.ch.id, "2");
  assert.equal(pickTwitch("Kai Cenat", TWITCH_SEARCH["Kai Cenat"] as never)!.exact, true);
  assert.equal(pickTwitch("CaseOh", [chan("9", "caseohfan", "CaseohFan", true), chan("5", "caseoh_", "caseoh_")])!.ch.id, "5");
  const m = pickTwitch("Marlon", TWITCH_SEARCH["Marlon"] as never)!;
  assert.deepEqual([m.ch.id, m.exact], ["4", false]);
  assert.equal(pickTwitch("zzz", [chan("7", "abc", "abc"), chan("8", "def", "def", true)])!.ch.id, "8");
  assert.equal(pickTwitch("zzz", [chan("7", "abc", "abc")])!.ch.id, "7");
  assert.equal(pickTwitch("zzz", []), null);
});

test("resolveCreators with a YouTube key: Twitch search + YouTube forHandle/search; not found + per-name errors stay in their cell", async () => {
  process.env.YOUTUBE_API_KEY = "yt-key";
  const calls = stub();
  const { resolveCreators } = await import("../src/lib/creator-lookup");
  const r = await resolveCreators(["Kai Cenat", "Marlon", "Nobody Here", "Big Yt", "Broken", "@kai cenat", ""]);
  assert.deepEqual(r.rows.map((x) => x.name), ["Kai Cenat", "Marlon", "Nobody Here", "Big Yt", "Broken"]);
  const [kai, marlon, nobody, big, broken] = r.rows;

  assert.equal(kai.twitch.status, "found");
  if (kai.twitch.status === "found") assert.deepEqual({ login: kai.twitch.match.login, exact: kai.twitch.match.exact, game: kai.twitch.match.game }, { login: "kaicenat", exact: true, game: "GTA" });
  assert.equal(kai.youtube.status, "found");
  if (kai.youtube.status === "found") assert.deepEqual({ ...kai.youtube.match }, { channelId: UC("kai"), handle: "kaicenat", title: "Kai Cenat", subscribers: 10_500_000, avatar: "http://yt-kai", exact: true, approved: false });
  assert.ok(marlon.twitch.status === "found" && marlon.twitch.match.login === "marlon_live" && !marlon.twitch.match.exact);
  assert.equal(marlon.youtube.status, "none");
  assert.deepEqual([nobody.twitch.status, nobody.youtube.status], ["none", "none"]);
  // Search → biggest channel among loosely matching titles (not the unrelated 99M one).
  assert.ok(big.youtube.status === "found" && big.youtube.match.handle === "bigyt" && big.youtube.match.subscribers === 2_000_000);
  assert.equal(broken.twitch.status, "error");
  assert.deepEqual(r.notes, []);

  const forHandle = calls.filter((u) => u.hostname === "yt.test" && u.searchParams.get("forHandle")).map((u) => u.searchParams.get("forHandle"));
  assert.ok(forHandle.includes("@KaiCenat") && forHandle.includes("@BigYt"), forHandle.join());
  assert.equal(calls.filter((u) => u.pathname.endsWith("/search") && u.searchParams.get("q") === "Kai Cenat").length, 0, "no 100-unit search when forHandle found it");
  assert.ok(calls.every((u) => u.hostname !== "yt.test" || u.searchParams.get("key") === "yt-key"));
});

test("YouTube quota used up: a plain note, YouTube cells say why, Twitch still works", async () => {
  process.env.YOUTUBE_API_KEY = "yt-key";
  stub({ ytQuota: true });
  const { resolveCreators } = await import("../src/lib/creator-lookup");
  const r = await resolveCreators(["Kai Cenat", "Marlon", "Big Yt"], { concurrency: 1 });
  assert.ok(r.rows.every((x) => x.youtube.status === "error" && /quota/.test(x.youtube.reason)));
  assert.equal(r.rows[0].twitch.status, "found");
  assert.match(r.notes.join(" "), /YouTube: daily API quota used up/);
});

test("a name that hangs runs out of time without breaking the table", async () => {
  stub();
  const { resolveCreators } = await import("../src/lib/creator-lookup");
  const t0 = Date.now();
  const r = await resolveCreators(["Slow", "Kai Cenat"], { timeoutMs: 300, concurrency: 1 });
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(r.rows[0].twitch, { status: "error", reason: "ran out of time" });
  assert.match(r.notes.join(" "), /too long/);
});

test("approving ticked matches creates the right rows; the same name on Twitch and YouTube gets both (v1.7.1)", async () => {
  process.env.YOUTUBE_API_KEY = "yt-key";
  stub();
  const { prisma } = await import("../src/lib/db");
  const { queue } = await import("../src/lib/queues");
  const { resolveCreators } = await import("../src/lib/creator-lookup");
  const actions = await import("../app/actions");
  const r = await resolveCreators(["Kai Cenat", "Big Yt", "Case Oh"]);
  const pick = (i: number, t: boolean, y: boolean) => {
    const row = r.rows[i];
    return {
      name: row.name,
      ...(t && row.twitch.status === "found" ? { twitch: { id: row.twitch.match.id, login: row.twitch.match.login, name: row.twitch.match.name, avatar: row.twitch.match.avatar } } : {}),
      ...(y && row.youtube.status === "found" ? { youtube: { channelId: row.youtube.match.channelId, handle: row.youtube.match.handle, title: row.youtube.match.title, avatar: row.youtube.match.avatar } } : {}),
    };
  };
  await queue("scout").drain(); await queue("youtube").drain();
  const res = await actions.approveCreators([pick(0, true, true), pick(1, false, true), pick(2, true, false)], "");
  assert.equal(res.twitchApproved, 2);
  assert.equal(res.youtubeApproved, 2);
  assert.ok(res.items.every((i) => i.ok), JSON.stringify(res.items));

  const kai = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "2" } });
  assert.deepEqual({ login: kai.login, name: kai.name, img: kai.profileImage, platform: kai.platform, approved: kai.approved, note: kai.approvalNote },
    { login: "kaicenat", name: "KaiCenat", img: "http://kai-fresh.png", platform: "twitch", approved: true, note: "Approved by Krew" });
  const ytKai = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${UC("kai")}` } });
  assert.deepEqual({ login: ytKai.login, platform: ytKai.platform, approved: ytKai.approved }, { login: "kaicenat", platform: "youtube", approved: true }, "YouTube Kai added next to Twitch Kai");
  assert.equal(await prisma.streamer.count({ where: { login: "kaicenat" } }), 2);

  const big = await prisma.streamer.findUniqueOrThrow({ where: { twitchId: `yt:${UC("b")}` } });
  assert.deepEqual({ login: big.login, name: big.name, platform: big.platform, approved: big.approved }, { login: "bigyt", name: "Big YT", platform: "youtube", approved: true });
  assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { twitchId: "5" } })).login, "caseoh_");
  assert.ok((await queue("scout").getWaitingCount()) >= 1, "Scout poked");
  assert.ok((await queue("youtube").getWaitingCount()) >= 1, "YouTube scanner poked");

  // Typed note is used; a junk pick is refused with a message, not a crash.
  const again = await actions.approveCreators([{ name: "Junk", youtube: { channelId: "nope", handle: "x", title: "x", avatar: null } }], "Paid campaign");
  assert.deepEqual([again.items[0].ok, again.youtubeApproved], [false, 0]);
  // An old row of a different Twitch account holds the name: plain message, no crash.
  await prisma.streamer.create({ data: { twitchId: "old4", login: "marlon_live", name: "Old Marlon" } });
  const stale = await actions.approveCreators([{ name: "Marlon", twitch: { id: "4", login: "marlon_live", name: "Marlon_Live", avatar: null } }]);
  assert.equal(stale.items[0].ok, false);
  assert.match(stale.items[0].message, /already uses the name "marlon_live"/);
  // Already-approved matches are flagged on the next lookup.
  const r2 = await resolveCreators(["Kai Cenat"]);
  assert.ok(r2.rows[0].twitch.status === "found" && r2.rows[0].twitch.match.approved);
});

// ---------- Workroom ----------
test("workroom: right column per status/stage, time in stage, clips per hour, line full", async () => {
  const { prisma } = await import("../src/lib/db");
  const { getWorkroom, stageAge, columnForStage } = await import("../src/lib/workroom");
  await prisma.post.deleteMany(); await prisma.clip.deleteMany(); await prisma.moment.deleteMany();
  const now = new Date();
  const ago = (m: number) => new Date(now.getTime() - m * MIN);
  const st = await prisma.streamer.create({ data: { twitchId: "w1", login: "worky", name: "Worky", approved: true, profileImage: "http://w.png" } });
  const moment = (source: string, createdAt: Date) => prisma.moment.create({ data: { streamerId: st.id, timestamp: createdAt, source, sourceTitle: `${source} moment`, createdAt } });
  const clip = async (source: string, data: Record<string, unknown>, momentAt = ago(1)) =>
    prisma.clip.create({ data: { momentId: (await moment(source, momentAt)).id, title: `${data.status}/${data.stage ?? "-"}`, ...data } as never });

  const grab = await clip("chat", { status: "processing", stage: "grab", stageAt: ago(2) });
  await clip("twitch_clip", { status: "processing", stage: "transcribe", stageAt: ago(1) });
  await clip("youtube", { status: "processing", stage: "judge", stageAt: ago(0.5) });
  await clip("twitch_clip", { status: "processing", stage: "cut", score: 8 }, ago(20)); // no stageAt: falls back to updatedAt
  const ready = await clip("twitch_clip", { status: "pending", score: 7.5, duration: 30, finalPath: "final/a.mp4" }, ago(30));
  const uploading = await clip("twitch_clip", { status: "approved", stage: "post", stageAt: ago(1), duration: 30 }, ago(40));
  const draft = await clip("twitch_clip", { status: "posted", duration: 30 }, ago(50));
  await prisma.post.create({ data: { clipId: draft.id, platform: "tiktok", status: "draft", postedAt: ago(5) } });
  const live = await clip("youtube", { status: "posted", duration: 30 }, ago(60));
  await prisma.post.create({ data: { clipId: live.id, platform: "youtube", status: "live", url: "https://youtube.com/shorts/x", postedAt: ago(60) } });
  await prisma.post.create({ data: { clipId: live.id, platform: "youtube", status: "live", postedAt: ago(25 * 60) } }); // older than 24h
  await clip("chat", { status: "failed", stage: "grab", error: "grab: VOD not ready" });
  await clip("twitch_clip", { status: "rejected", duration: 20 }, ago(100));
  await clip("twitch_clip", { status: "pending", duration: 20, createdAt: ago(5 * 60) }, ago(5 * 60)); // outside the 3h window

  const w = await getWorkroom(now);
  const titles = (k: keyof typeof w.columns) => w.columns[k].map((i) => i.title);
  assert.deepEqual(titles("downloading"), ["processing/grab"]);
  assert.deepEqual(titles("captions"), ["processing/transcribe"]);
  assert.deepEqual(titles("judge"), ["processing/judge"]);
  assert.deepEqual(titles("cutting"), ["processing/cut"]);
  assert.ok(titles("ready").includes("pending/-"));
  assert.equal(w.columns.ready[0].clipId === ready.id || w.columns.ready[1].clipId === ready.id, true);
  assert.deepEqual(w.columns.posting.map((i) => i.clipId).sort(), [uploading.id, draft.id].sort());
  assert.deepEqual(w.columns.posted.map((i) => i.url), ["https://youtube.com/shorts/x"]);
  assert.equal(w.summary.postedToday, 1);
  assert.deepEqual(w.problems.map((p) => p.error), ["grab: VOD not ready"]);
  // Finding = moments from the last 10 min (every clip above made one at ago(1) or older).
  assert.ok(w.columns.finding.length >= 1 && w.columns.finding.every((f) => now.getTime() - new Date(f.since).getTime() <= 10 * MIN));
  assert.equal(w.columns.finding[0].sourceLabel !== undefined, true);

  // Time in stage: stageAt, else updatedAt.
  const g = w.columns.downloading[0];
  assert.equal(g.clipId, grab.id);
  assert.equal(stageAge(g.since, now), "2m");
  assert.equal(w.columns.cutting[0].score, 8);
  assert.ok(now.getTime() - new Date(w.columns.cutting[0].since).getTime() < MIN);
  assert.deepEqual(["Chat spike", "Twitch clip", "YouTube peak"], [w.columns.downloading[0].sourceLabel, w.columns.captions[0].sourceLabel, w.columns.judge[0].sourceLabel]);

  // Clips out of the line in the last 3h: ready, uploading, draft, live, rejected = 5 → 1.7/h.
  assert.equal(w.summary.perHour, 1.7);
  assert.deepEqual({ inLine: w.summary.inLine, max: w.summary.backlogMax, full: w.summary.lineFull }, { inLine: 4, max: 3, full: true });
  assert.equal(w.summary.ready, 2);

  assert.equal(stageAge(new Date(now.getTime() - 45_000), now), "45s");
  assert.equal(stageAge(new Date(now.getTime() - 65 * MIN), now), "1h 5m");
  assert.equal(columnForStage(null), "downloading");
  assert.equal(columnForStage("post"), "posting");
});
