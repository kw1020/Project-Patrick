import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStudio, postSettings, cleanCaptions, captionsFromClip } from "../studio.js";

const CAPS = {
  tiktok: { caption: "tt #thrift" },
  instagram: { caption: "ig #thrift" },
  youtube: { title: "yt title #Shorts", description: "yt desc", tags: ["#thrift", "flip", ""] },
};

// One fake server standing in for OpenShorts, short-video-maker and Postiz.
async function fakeUpstream({ channels = ["tiktok", "instagram", "youtube"], osStatus = "completed" } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = (req.headers["content-type"] || "").includes("json") ? JSON.parse(raw.toString()) : raw;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (req.url === "/api/process") return json(200, { job_id: "os-1", status: "queued" });
    if (req.url === "/api/status/os-1") {
      return json(200, {
        status: osStatus,
        result: { clips: [{ start: 1, end: 31.5, video_url: "/videos/os-1/c1.mp4", video_title_for_youtube_short: "Clip one", video_description_for_tiktok: "t", video_description_for_instagram: "i" }] },
      });
    }
    if (req.url === "/api/status/missing") return json(404, { detail: "Job not found" });
    if (req.url === "/videos/os-1/c1.mp4" || req.url === "/api/short-video/svm-1") {
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(Buffer.from("FAKEMP4"));
    }
    if (req.url === "/api/short-video") return json(201, { videoId: "svm-1" });
    if (req.url === "/api/short-video/svm-1/status") return json(200, { status: "ready" });
    if (req.url === "/public/v1/integrations") {
      return json(200, channels.map((id, i) => ({ id: `ch-${i}`, identifier: id, disabled: false })));
    }
    if (req.url === "/public/v1/upload") return json(201, { id: "m-1", path: "http://postiz/uploads/m-1.mp4" });
    if (req.url === "/public/v1/posts") return json(201, [{ postId: "p-1" }]);
    json(404, { error: "nope" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise((r) => server.close(r)) };
}

function fakeClaude(payload) {
  const seen = [];
  return {
    seen,
    beta: {
      messages: {
        create: async (req) => {
          seen.push(req);
          const out = typeof payload === "function" ? payload(req) : payload;
          return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }] };
        },
      },
    },
  };
}

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-"));
  return path.join(dir, "studio.json");
}

async function studioWith(up, claude, extra = {}) {
  return createStudio({
    dataFile: await tmpFile(),
    openshortsUrl: up.url,
    shortmakerUrl: up.url,
    postizUrl: up.url,
    postizKey: "pk",
    geminiKey: "gk",
    claude,
    ...extra,
  });
}

test("cleanCaptions strips # from tags, drops blanks, caps lengths", () => {
  const c = cleanCaptions({ ...CAPS, youtube: { ...CAPS.youtube, title: "x".repeat(200) } });
  assert.deepEqual(c.youtube.tags, ["thrift", "flip"]);
  assert.equal(c.youtube.title.length, 100);
});

test("captionsFromClip falls back to OpenShorts text", () => {
  const c = captionsFromClip({ video_title_for_youtube_short: "T", video_description_for_tiktok: "tt" });
  assert.equal(c.youtube.title, "T");
  assert.equal(c.tiktok.caption, "tt");
  assert.equal(c.instagram.caption, "T");
});

test("postSettings builds valid Postiz settings per platform", () => {
  const c = cleanCaptions(CAPS);
  const yt = postSettings("youtube", c, { aiGenerated: false, tiktokPrivacy: "SELF_ONLY" });
  assert.equal(yt.type, "public");
  assert.deepEqual(yt.tags[0], { value: "thrift", label: "thrift" });
  const tt = postSettings("tiktok", c, { aiGenerated: true, tiktokPrivacy: "SELF_ONLY" });
  assert.equal(tt.privacy_level, "SELF_ONLY");
  assert.equal(tt.video_made_with_ai, true);
  assert.equal(tt.content_posting_method, "DIRECT_POST");
  assert.equal(postSettings("instagram", c, {}).post_type, "post");
});

test("clip a URL: OpenShorts job -> Claude captions -> queue item", async () => {
  const up = await fakeUpstream();
  const claude = fakeClaude(CAPS);
  try {
    const studio = await studioWith(up, claude);
    const job = await studio.clipFromUrl("https://www.youtube.com/watch?v=abc");
    assert.equal(job.status, "rendering");
    const submit = up.calls.find((c) => c.url === "/api/process");
    assert.equal(submit.body.url, "https://www.youtube.com/watch?v=abc");
    assert.equal(submit.body.acknowledged, true);
    assert.equal(submit.headers["x-gemini-key"], "gk");

    await studio.poll();
    const { jobs, items } = await studio.list();
    assert.equal(jobs[0].status, "done");
    assert.equal(items.length, 1);
    assert.equal(items[0].video, `${up.url}/videos/os-1/c1.mp4`);
    assert.equal(items[0].seconds, 30.5);
    assert.equal(items[0].captions.tiktok.caption, "tt #thrift");
    assert.equal(claude.seen[0].output_config.format.type, "json_schema");
  } finally {
    await up.close();
  }
});

test("still-processing jobs stay rendering", async () => {
  const up = await fakeUpstream({ osStatus: "processing" });
  try {
    const studio = await studioWith(up, fakeClaude(CAPS));
    await studio.clipFromUrl("https://example.com/v.mp4");
    await studio.poll();
    const { jobs, items } = await studio.list();
    assert.equal(jobs[0].status, "rendering");
    assert.equal(items.length, 0);
  } finally {
    await up.close();
  }
});

test("a job OpenShorts lost (404) is marked failed", async () => {
  const up = await fakeUpstream();
  try {
    const dataFile = await tmpFile();
    await fs.writeFile(dataFile, JSON.stringify({ jobs: [{ id: "j", kind: "clip", service: "openshorts", upstreamId: "missing", status: "rendering" }], items: [] }));
    const studio = createStudio({ dataFile, openshortsUrl: up.url });
    await studio.poll();
    assert.equal((await studio.list()).jobs[0].status, "failed");
  } finally {
    await up.close();
  }
});

test("caption writer failure falls back to OpenShorts text", async () => {
  const up = await fakeUpstream();
  const broken = { beta: { messages: { create: async () => { throw new Error("boom"); } } } };
  try {
    const studio = await studioWith(up, broken);
    await studio.clipFromUrl("https://example.com/v.mp4");
    await studio.poll();
    const { items } = await studio.list();
    assert.equal(items[0].captions.youtube.title, "Clip one");
  } finally {
    await up.close();
  }
});

test("make a short: Claude script -> short-video-maker -> AI-flagged item", async () => {
  const up = await fakeUpstream();
  const script = {
    title: "3 flips",
    music: "excited",
    scenes: [{ text: "Hook.", searchTerms: ["thrift", "cash"] }],
    captions: CAPS,
  };
  try {
    const studio = await studioWith(up, fakeClaude(script));
    const job = await studio.makeShort("3 thrift flips");
    assert.equal(job.title, "3 flips");
    const render = up.calls.find((c) => c.url === "/api/short-video");
    assert.deepEqual(render.body.scenes, script.scenes);
    assert.equal(render.body.config.orientation, "portrait");
    assert.equal(render.body.config.music, "excited");

    await studio.poll();
    const { items } = await studio.list();
    assert.equal(items[0].kind, "short");
    assert.equal(items[0].aiGenerated, true);
    assert.equal(items[0].video, `${up.url}/api/short-video/svm-1`);
  } finally {
    await up.close();
  }
});

test("empty topic is rejected", async () => {
  const studio = createStudio({ dataFile: await tmpFile(), mock: true });
  await assert.rejects(studio.makeShort("  "), /topic/);
});

test("approve uploads the video and schedules one post per platform", async () => {
  const up = await fakeUpstream();
  try {
    const studio = await studioWith(up, fakeClaude(CAPS));
    await studio.clipFromUrl("https://example.com/v.mp4");
    await studio.poll();
    const [item] = (await studio.list()).items;
    const when = new Date(Date.now() + 3 * 3600_000).toISOString();
    const done = await studio.approve(item.id, { platforms: ["tiktok", "youtube"], when });

    assert.equal(done.status, "scheduled");
    const upload = up.calls.find((c) => c.url === "/public/v1/upload");
    assert.equal(upload.headers.authorization, "pk");
    assert.ok(upload.body.includes(Buffer.from("FAKEMP4")));

    const post = up.calls.find((c) => c.url === "/public/v1/posts").body;
    assert.equal(post.type, "schedule");
    assert.equal(post.date, when);
    assert.equal(post.posts.length, 2);
    const [tt, yt] = post.posts;
    assert.equal(tt.integration.id, "ch-0");
    assert.equal(tt.value[0].content, "tt #thrift");
    assert.deepEqual(tt.value[0].image, [{ id: "m-1", path: "http://postiz/uploads/m-1.mp4" }]);
    assert.equal(tt.settings.video_made_with_ai, false);
    assert.equal(yt.integration.id, "ch-2");
    assert.equal(yt.settings.title, "yt title #Shorts");
    assert.equal(yt.value[0].content, "yt desc");

    await assert.rejects(studio.approve(item.id, {}), /scheduled/);
  } finally {
    await up.close();
  }
});

test("approve with no time posts now", async () => {
  const up = await fakeUpstream();
  try {
    const studio = await studioWith(up, fakeClaude(CAPS));
    await studio.clipFromUrl("https://example.com/v.mp4");
    await studio.poll();
    const [item] = (await studio.list()).items;
    await studio.approve(item.id, { platforms: ["instagram"] });
    assert.equal(up.calls.find((c) => c.url === "/public/v1/posts").body.type, "now");
  } finally {
    await up.close();
  }
});

test("approve refuses platforms not connected in Postiz", async () => {
  const up = await fakeUpstream({ channels: ["youtube"] });
  try {
    const studio = await studioWith(up, fakeClaude(CAPS));
    await studio.clipFromUrl("https://example.com/v.mp4");
    await studio.poll();
    const [item] = (await studio.list()).items;
    await assert.rejects(studio.approve(item.id, { platforms: ["tiktok", "youtube"] }), /Connect tiktok in Postiz/);
    assert.equal(up.calls.some((c) => c.url === "/public/v1/upload"), false);
  } finally {
    await up.close();
  }
});

test("edits, reject, and persistence across restarts", async () => {
  const dataFile = await tmpFile();
  const studio = createStudio({ dataFile, mock: true });
  await studio.clipFromUrl("https://example.com/v.mp4");
  await studio.poll();
  const [item] = (await studio.list()).items;
  await studio.update(item.id, { captions: { ...CAPS, tiktok: { caption: "edited" } }, platforms: ["youtube", "bogus"] });

  const again = createStudio({ dataFile, mock: true });
  const [saved] = (await again.list()).items;
  assert.equal(saved.captions.tiktok.caption, "edited");
  assert.deepEqual(saved.platforms, ["youtube"]);

  await again.reject(item.id);
  assert.equal((await again.list()).items.length, 0);
});

test("unreachable service gives a plain error", async () => {
  const studio = createStudio({ dataFile: await tmpFile(), openshortsUrl: "http://127.0.0.1:9", timeoutMs: 2000 });
  await assert.rejects(studio.clipFromUrl("https://example.com/v.mp4"), /Can't reach OpenShorts/);
  const unset = createStudio({ dataFile: await tmpFile() });
  await assert.rejects(unset.clipFromUrl("https://example.com/v.mp4"), /not set up/);
  await assert.rejects(unset.clipFromUrl("ftp://x"), /http/);
});
