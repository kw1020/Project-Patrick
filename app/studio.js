import fs from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL, ScanError } from "./analyze.js";

// Studio: Patrick's content agent. OpenShorts cuts long videos into vertical
// clips, short-video-maker renders faceless shorts from a script, Claude writes
// the captions, Krew approves, and Postiz schedules the posts.

export const PLATFORMS = ["tiktok", "instagram", "youtube"];

// Postiz provider identifiers that count as each platform.
const POSTIZ_IDS = {
  tiktok: ["tiktok", "tiktok-business"],
  instagram: ["instagram", "instagram-standalone"],
  youtube: ["youtube"],
};

const MUSIC = ["sad", "melancholic", "happy", "euphoric/high", "excited", "chill", "uneasy", "angry", "dark", "hopeful", "contemplative", "funny/quirky"];
const MAX_TAGS = 15;

const str = { type: "string" };
const strList = { type: "array", items: str };

const CAPTIONS = {
  type: "object",
  additionalProperties: false,
  required: ["tiktok", "instagram", "youtube"],
  properties: {
    tiktok: { type: "object", additionalProperties: false, required: ["caption"], properties: { caption: str } },
    instagram: { type: "object", additionalProperties: false, required: ["caption"], properties: { caption: str } },
    youtube: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "tags"],
      properties: { title: str, description: str, tags: strList },
    },
  },
};

export const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "music", "scenes", "captions"],
  properties: {
    title: str,
    music: { type: "string", enum: MUSIC },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "searchTerms"],
        properties: { text: str, searchTerms: strList },
      },
    },
    captions: CAPTIONS,
  },
};

export const CAPTIONS_SCHEMA = CAPTIONS;

const CAPTION_RULES = `Caption rules:
- tiktok.caption: one punchy line plus 3-5 hashtags, under 300 characters.
- instagram.caption: a hook line, one or two short lines of value, a call to follow, then 5-10 hashtags. Under 1500 characters.
- youtube.title: under 90 characters, curiosity-driven, no clickbait lies, ends with #Shorts. youtube.description: two sentences plus 3 hashtags. youtube.tags: 5-12 plain keywords without the # sign.
- Write like a real person talking, not an ad. No emoji walls. Never promise income or results you cannot back up.`;

function system(niche) {
  return `You are Patrick, the content agent for Krew Sutherland. Krew's channel is about: ${niche}.
You write short-form video content for TikTok, Instagram Reels and YouTube Shorts that earns watch time honestly. Strong first line, one clear idea per video, no filler.
${CAPTION_RULES}`;
}

export class StudioError extends ScanError {}

const round2 = (n) => Math.round(n * 100) / 100;

export function cleanCaptions(c) {
  const tags = (c.youtube.tags || [])
    .map((t) => String(t).replace(/^#/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  return {
    tiktok: { caption: String(c.tiktok.caption || "").slice(0, 2200) },
    instagram: { caption: String(c.instagram.caption || "").slice(0, 2200) },
    youtube: {
      title: String(c.youtube.title || "").slice(0, 100),
      description: String(c.youtube.description || "").slice(0, 5000),
      tags,
    },
  };
}

/** Starting captions from OpenShorts' own per-platform text, used if Claude is unavailable. */
export function captionsFromClip(clip) {
  const title = clip.video_title_for_youtube_short || clip.title || "New short";
  return cleanCaptions({
    tiktok: { caption: clip.video_description_for_tiktok || title },
    instagram: { caption: clip.video_description_for_instagram || title },
    youtube: { title, description: clip.video_description_for_tiktok || "", tags: [] },
  });
}

/** Postiz post settings per platform. aiGenerated flags AI shorts where the platform asks. */
export function postSettings(platform, captions, { aiGenerated, tiktokPrivacy }) {
  if (platform === "youtube") {
    return {
      title: captions.youtube.title,
      type: "public",
      selfDeclaredMadeForKids: "no",
      tags: captions.youtube.tags.map((t) => ({ value: t, label: t })),
    };
  }
  if (platform === "tiktok") {
    return {
      privacy_level: tiktokPrivacy,
      duet: false,
      stitch: false,
      comment: true,
      autoAddMusic: "no",
      brand_content_toggle: false,
      brand_organic_toggle: false,
      video_made_with_ai: Boolean(aiGenerated),
      content_posting_method: "DIRECT_POST",
    };
  }
  return { post_type: "post", collaborators: [] };
}

function postText(platform, captions) {
  if (platform === "youtube") return captions.youtube.description;
  return captions[platform].caption;
}

export function createStudio(opts = {}) {
  const cfg = {
    dataFile: opts.dataFile,
    openshortsUrl: (opts.openshortsUrl || "").replace(/\/$/, ""),
    shortmakerUrl: (opts.shortmakerUrl || "").replace(/\/$/, ""),
    postizUrl: (opts.postizUrl || "").replace(/\/$/, ""),
    postizKey: opts.postizKey || "",
    geminiKey: opts.geminiKey || "",
    niche: opts.niche || "flipping thrift-store finds for profit and using AI to make money",
    voice: opts.voice || "am_michael",
    tiktokPrivacy: opts.tiktokPrivacy || "SELF_ONLY",
    mock: Boolean(opts.mock),
    uploadDir: opts.uploadDir,
    timeoutMs: opts.timeoutMs || 30_000,
  };
  const claude = opts.claude || null;
  let state = null;
  let saving = Promise.resolve();
  let polling = false;

  // ---------- storage ----------
  async function load() {
    if (state) return state;
    try {
      state = JSON.parse(await fs.readFile(cfg.dataFile, "utf8"));
    } catch {
      state = { jobs: [], items: [] };
    }
    return state;
  }
  function save() {
    const snapshot = JSON.stringify(state, null, 2);
    saving = saving.then(async () => {
      await fs.mkdir(path.dirname(cfg.dataFile), { recursive: true });
      const tmp = `${cfg.dataFile}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, cfg.dataFile);
    });
    return saving;
  }
  const now = () => new Date().toISOString();

  // ---------- http ----------
  async function call(base, pathname, init = {}, what = "service") {
    if (!base) throw new StudioError(`${what} is not set up. See studio/README.md.`, 503);
    let res;
    try {
      res = await fetch(base + pathname, { ...init, signal: init.signal || AbortSignal.timeout(cfg.timeoutMs) });
    } catch (err) {
      throw new StudioError(`Can't reach ${what} (${err.cause?.code || err.name}). Is it running?`, 502);
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = body?.detail || body?.msg || body?.error || body?.message || res.statusText;
      const err = new StudioError(`${what} said: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, res.status >= 500 ? 502 : 400);
      err.upstreamStatus = res.status;
      throw err;
    }
    return body;
  }

  // ---------- Claude ----------
  async function askClaude(userText, schema) {
    if (!claude) throw new StudioError("ANTHROPIC_API_KEY is not set, so Patrick can't write scripts.", 503);
    const response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema } },
      system: system(cfg.niche),
      messages: [{ role: "user", content: userText }],
    });
    if (response.stop_reason === "refusal") throw new StudioError("Patrick declined to write that one. Try a different topic.", 422);
    if (response.stop_reason === "max_tokens") throw new StudioError("The writer ran long and was cut off. Try again.", 502);
    const text = response.content.find((b) => b.type === "text")?.text;
    try {
      return JSON.parse(text);
    } catch {
      throw new StudioError("Got a garbled answer from the writer. Try again.", 502);
    }
  }

  async function writeScript(topic) {
    if (cfg.mock) return mockScript(topic);
    return askClaude(
      `Write a 30-45 second faceless short about: ${topic}

Split it into 4-7 scenes. Each scene's text is what the voiceover says (one or two sentences). Scene 1 is the hook and must stop the scroll in under 3 seconds. The last scene is a short call to follow.
searchTerms: 2-3 single, concrete, visual words per scene for finding stock footage on Pexels (e.g. "thrift", "cash", "laptop"), never abstract ideas.
Pick the music mood that fits. Then write the captions.`,
      SCRIPT_SCHEMA,
    );
  }

  async function writeClipCaptions(clip, source) {
    if (cfg.mock || !claude) return captionsFromClip(clip);
    try {
      const raw = await askClaude(
        `OpenShorts cut this clip from a longer video (${source}). Here is what it knows about the clip:
${JSON.stringify(
  {
    hook: clip.viral_hook_text,
    youtube_title: clip.video_title_for_youtube_short,
    tiktok: clip.video_description_for_tiktok,
    instagram: clip.video_description_for_instagram,
    seconds: clip.end != null && clip.start != null ? round2(clip.end - clip.start) : undefined,
  },
  null,
  2,
)}
Rewrite the captions for Krew's channel.`,
        CAPTIONS,
      );
      return cleanCaptions(raw);
    } catch (err) {
      console.error("Caption writer failed, using OpenShorts text:", err.message);
      return captionsFromClip(clip);
    }
  }

  // ---------- job submission ----------
  function addJob(job) {
    const full = { id: randomUUID(), status: "rendering", createdAt: now(), updatedAt: now(), error: null, ...job };
    state.jobs.unshift(full);
    return full;
  }

  async function clipFromUrl(url) {
    await load();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new StudioError("That isn't a valid link.", 400);
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new StudioError("Use an http(s) link.", 400);
    let upstreamId = `mock-${randomUUID()}`;
    if (!cfg.mock) {
      const body = await call(
        cfg.openshortsUrl,
        "/api/process",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...(cfg.geminiKey ? { "x-gemini-key": cfg.geminiKey } : {}) },
          body: JSON.stringify({ url: parsed.href, acknowledged: true, output_format: "vertical" }),
        },
        "OpenShorts",
      );
      upstreamId = body.job_id;
    }
    const job = addJob({ kind: "clip", service: "openshorts", upstreamId, source: parsed.href });
    await save();
    return job;
  }

  async function clipFromFile(filePath, fileName) {
    await load();
    let upstreamId = `mock-${randomUUID()}`;
    try {
      if (!cfg.mock) {
        const form = new FormData();
        form.set("file", await openAsBlob(filePath), fileName);
        form.set("acknowledged", "true");
        form.set("output_format", "vertical");
        const body = await call(
          cfg.openshortsUrl,
          "/api/process",
          {
            method: "POST",
            headers: cfg.geminiKey ? { "x-gemini-key": cfg.geminiKey } : {},
            body: form,
            signal: AbortSignal.timeout(30 * 60_000),
          },
          "OpenShorts",
        );
        upstreamId = body.job_id;
      }
    } finally {
      await fs.rm(filePath, { force: true });
    }
    const job = addJob({ kind: "clip", service: "openshorts", upstreamId, source: fileName });
    await save();
    return job;
  }

  async function makeShort(topic) {
    await load();
    topic = String(topic || "").trim().slice(0, 500);
    if (!topic) throw new StudioError("Give Patrick a topic.", 400);
    const script = await writeScript(topic);
    let upstreamId = `mock-${randomUUID()}`;
    if (!cfg.mock) {
      const body = await call(
        cfg.shortmakerUrl,
        "/api/short-video",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scenes: script.scenes,
            config: { paddingBack: 1500, music: script.music, captionPosition: "bottom", voice: cfg.voice, orientation: "portrait", musicVolume: "low" },
          }),
        },
        "short-video-maker",
      );
      upstreamId = body.videoId;
    }
    const job = addJob({
      kind: "short",
      service: "shortmaker",
      upstreamId,
      source: topic,
      title: script.title,
      script: script.scenes,
      captions: cleanCaptions(script.captions),
    });
    await save();
    return job;
  }

  // ---------- polling ----------
  function addItem(item) {
    state.items.unshift({
      id: randomUUID(),
      status: "ready",
      createdAt: now(),
      updatedAt: now(),
      error: null,
      platforms: [...PLATFORMS],
      postiz: null,
      ...item,
    });
  }

  async function pollJob(job) {
    if (job.service === "openshorts") {
      const clips = cfg.mock ? mockClips() : null;
      let status = "completed";
      let result = { clips };
      if (!cfg.mock) {
        try {
          const body = await call(cfg.openshortsUrl, `/api/status/${encodeURIComponent(job.upstreamId)}`, {}, "OpenShorts");
          status = body.status;
          result = body.result || {};
        } catch (err) {
          if (err.upstreamStatus === 404) status = "failed";
          else throw err;
        }
      }
      if (status === "failed") return finishJob(job, "failed", "OpenShorts couldn't process this video.");
      if (status !== "completed") return;
      const list = result.clips || [];
      for (const [i, clip] of list.entries()) {
        if (!clip.video_url) continue;
        const captions = await writeClipCaptions(clip, job.source);
        addItem({
          kind: "clip",
          jobId: job.id,
          title: clip.video_title_for_youtube_short || `Clip ${i + 1}`,
          video: cfg.mock ? null : cfg.openshortsUrl + clip.video_url,
          seconds: clip.end != null && clip.start != null ? round2(clip.end - clip.start) : null,
          aiGenerated: false,
          captions,
        });
      }
      return finishJob(job, list.length ? "done" : "failed", list.length ? null : "No clips came out of this video.");
    }

    let status = "ready";
    if (!cfg.mock) {
      const body = await call(cfg.shortmakerUrl, `/api/short-video/${encodeURIComponent(job.upstreamId)}/status`, {}, "short-video-maker");
      status = body.status;
    }
    if (status === "failed") return finishJob(job, "failed", "short-video-maker failed to render this one.");
    if (status !== "ready") return;
    addItem({
      kind: "short",
      jobId: job.id,
      title: job.title,
      video: cfg.mock ? null : `${cfg.shortmakerUrl}/api/short-video/${encodeURIComponent(job.upstreamId)}`,
      seconds: null,
      aiGenerated: true,
      captions: job.captions,
    });
    return finishJob(job, "done", null);
  }

  function finishJob(job, status, error) {
    job.status = status;
    job.error = error;
    job.updatedAt = now();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await load();
      const pending = state.jobs.filter((j) => j.status === "rendering");
      for (const job of pending) {
        try {
          await pollJob(job);
        } catch (err) {
          // Upstream hiccup: keep the job rendering and try again next tick.
          console.error(`Studio poll ${job.service} ${job.upstreamId}:`, err.message);
        }
      }
      if (pending.length) await save();
    } finally {
      polling = false;
    }
  }

  // ---------- review & posting ----------
  function findItem(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) throw new StudioError("That video isn't in the queue.", 404);
    return item;
  }

  async function update(id, patch) {
    await load();
    const item = findItem(id);
    if (item.status === "scheduled") throw new StudioError("Already scheduled. Change it in Postiz.", 409);
    if (patch.captions) item.captions = cleanCaptions(patch.captions);
    if (Array.isArray(patch.platforms)) item.platforms = PLATFORMS.filter((p) => patch.platforms.includes(p));
    item.updatedAt = now();
    await save();
    return item;
  }

  async function reject(id) {
    await load();
    const item = findItem(id);
    if (item.status === "scheduled") throw new StudioError("Already scheduled. Delete it in Postiz.", 409);
    item.status = "rejected";
    item.updatedAt = now();
    await save();
    return item;
  }

  async function postizChannels() {
    const list = await call(cfg.postizUrl, "/public/v1/integrations", { headers: { authorization: cfg.postizKey } }, "Postiz");
    const pick = {};
    for (const p of PLATFORMS) {
      pick[p] = list.find((ch) => !ch.disabled && POSTIZ_IDS[p].includes(ch.identifier)) || null;
    }
    return pick;
  }

  async function approve(id, { platforms, when } = {}) {
    await load();
    const item = findItem(id);
    if (item.status !== "ready") throw new StudioError(`This one is ${item.status}, not ready to post.`, 409);
    const chosen = PLATFORMS.filter((p) => (platforms || item.platforms).includes(p));
    if (!chosen.length) throw new StudioError("Pick at least one platform.", 400);
    const date = when ? new Date(when) : new Date();
    if (Number.isNaN(date.getTime())) throw new StudioError("Bad schedule time.", 400);
    const type = date.getTime() <= Date.now() + 60_000 ? "now" : "schedule";

    if (cfg.mock) {
      item.status = "scheduled";
      item.postiz = { mock: true, platforms: chosen, date: date.toISOString(), type };
      item.updatedAt = now();
      await save();
      return item;
    }
    if (!cfg.postizKey) throw new StudioError("POSTIZ_API_KEY is not set. See studio/README.md.", 503);

    const channels = await postizChannels();
    const missing = chosen.filter((p) => !channels[p]);
    if (missing.length) throw new StudioError(`Connect ${missing.join(", ")} in Postiz first.`, 400);

    // Patrick fetches the video and hands Postiz the bytes, so Postiz never
    // needs to reach the render services itself.
    let video;
    try {
      const res = await fetch(item.video, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      video = await res.blob();
    } catch (err) {
      throw new StudioError(`Couldn't fetch the rendered video (${err.message}).`, 502);
    }
    const form = new FormData();
    form.set("file", new Blob([video], { type: "video/mp4" }), `${item.id}.mp4`);
    const media = await call(
      cfg.postizUrl,
      "/public/v1/upload",
      { method: "POST", headers: { authorization: cfg.postizKey }, body: form, signal: AbortSignal.timeout(10 * 60_000) },
      "Postiz",
    );

    const opts2 = { aiGenerated: item.aiGenerated, tiktokPrivacy: cfg.tiktokPrivacy };
    const result = await call(
      cfg.postizUrl,
      "/public/v1/posts",
      {
        method: "POST",
        headers: { authorization: cfg.postizKey, "content-type": "application/json" },
        body: JSON.stringify({
          type,
          date: date.toISOString(),
          shortLink: false,
          tags: [],
          posts: chosen.map((p) => ({
            integration: { id: channels[p].id },
            value: [{ content: postText(p, item.captions), image: [{ id: media.id, path: media.path }] }],
            settings: postSettings(p, item.captions, opts2),
          })),
        }),
      },
      "Postiz",
    );
    item.status = "scheduled";
    item.postiz = { platforms: chosen, date: date.toISOString(), type, result };
    item.updatedAt = now();
    await save();
    return item;
  }

  async function list() {
    await load();
    return {
      jobs: state.jobs.slice(0, 50),
      items: state.items.filter((i) => i.status !== "rejected").slice(0, 100),
    };
  }

  function services() {
    return {
      mock: cfg.mock,
      openshorts: cfg.mock || Boolean(cfg.openshortsUrl),
      shortmaker: cfg.mock || Boolean(cfg.shortmakerUrl),
      postiz: cfg.mock || Boolean(cfg.postizUrl && cfg.postizKey),
      claude: cfg.mock || Boolean(claude),
    };
  }

  async function videoUrl(id) {
    await load();
    const item = findItem(id);
    if (!item.video) throw new StudioError("No video file for this one (mock mode).", 404);
    return item.video;
  }

  return { list, services, clipFromUrl, clipFromFile, makeShort, poll, update, reject, approve, videoUrl, uploadDir: cfg.uploadDir };
}

export function studioFromEnv(dataDir) {
  const mock = process.env.PATRICK_MOCK === "1";
  return createStudio({
    dataFile: path.join(dataDir, "studio.json"),
    uploadDir: path.join(dataDir, "uploads"),
    openshortsUrl: process.env.OPENSHORTS_URL,
    shortmakerUrl: process.env.SHORTMAKER_URL,
    postizUrl: process.env.POSTIZ_URL,
    postizKey: process.env.POSTIZ_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    niche: process.env.STUDIO_NICHE,
    voice: process.env.STUDIO_VOICE,
    tiktokPrivacy: process.env.STUDIO_TIKTOK_PRIVACY,
    mock,
    claude: mock || !process.env.ANTHROPIC_API_KEY ? null : new Anthropic(),
  });
}

// ---------- mock data ----------
function mockScript(topic) {
  return {
    title: `The truth about ${topic}`,
    music: "excited",
    scenes: [
      { text: `Everyone gets ${topic} wrong. Here's what actually works.`, searchTerms: ["crowd", "phone", "money"] },
      { text: "Step one: start with what people already search for.", searchTerms: ["search", "laptop", "typing"] },
      { text: "Step two: test small before you spend big.", searchTerms: ["coins", "jar", "savings"] },
      { text: "Follow for part two.", searchTerms: ["smile", "city", "sunset"] },
    ],
    captions: {
      tiktok: { caption: `Nobody tells you this about ${topic} #sidehustle #money #ai` },
      instagram: { caption: `Everyone gets ${topic} wrong.\n\nStart with demand, test small, then scale.\n\nFollow for part two.\n\n#sidehustle #money #ai #entrepreneur #reselling` },
      youtube: { title: `The truth about ${topic} #Shorts`, description: `What actually works with ${topic}. Part two coming soon. #sidehustle #money #ai`, tags: ["side hustle", "make money", "ai"] },
    },
  };
}

function mockClips() {
  return [
    {
      start: 12.3,
      end: 41.8,
      video_url: "/videos/mock/clip1.mp4",
      viral_hook_text: "I paid $4 for this 🤯",
      video_title_for_youtube_short: "I paid $4 for this at Goodwill #Shorts",
      video_description_for_tiktok: "Goodwill find that paid for my week #thrift #flip",
      video_description_for_instagram: "Goodwill find that paid for my week. Follow for more flips. #thrift #reseller",
    },
  ];
}
