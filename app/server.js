import http from "node:http";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { analyze, mockAnalyze, ScanError, MODEL } from "./analyze.js";
import { studioFromEnv } from "./studio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MOCK = process.env.PATRICK_MOCK === "1";
const PASSCODE = process.env.PATRICK_PASSCODE || "";
const MAX_SCANS_PER_DAY = Number(process.env.PATRICK_MAX_SCANS_PER_DAY) || 200;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;
const DATA_DIR = process.env.PATRICK_DATA_DIR || path.join(here, "data");
const studio = studioFromEnv(DATA_DIR);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let scanDay = new Date().toDateString();
let scansToday = 0;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function passcodeOk(req) {
  if (!PASSCODE) return true;
  // <video src> can't send headers, so the preview route takes ?key= instead.
  const query = new URL(req.url, "http://localhost").searchParams.get("key");
  const given = Buffer.from(String(req.headers["x-patrick-key"] || query || ""));
  const want = Buffer.from(PASSCODE);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req, max = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new ScanError(max === MAX_BODY ? "Photo is too large." : "Request is too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ScanError("Bad request.", 400);
  }
}

async function handleScan(req, res) {
  if (!passcodeOk(req)) return send(res, 401, { error: "Wrong passcode." });

  const today = new Date().toDateString();
  if (today !== scanDay) {
    scanDay = today;
    scansToday = 0;
  }
  if (scansToday >= MAX_SCANS_PER_DAY) {
    return send(res, 429, { error: `Daily scan limit (${MAX_SCANS_PER_DAY}) reached.` });
  }

  const body = await readJson(req);
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(body.image || "");
  if (!match) throw new ScanError("Send a JPEG, PNG or WebP photo.", 400);

  const tagPrice = body.tagPrice === "" || body.tagPrice == null ? NaN : Number(body.tagPrice);
  const note = typeof body.note === "string" ? body.note.slice(0, 300) : "";
  const input = { mediaType: match[1], imageB64: match[2], tagPrice, note };

  scansToday++;
  try {
    const result = MOCK ? mockAnalyze(input) : await analyze(input);
    send(res, 200, result);
  } catch (err) {
    scansToday--; // don't count failed scans against the cap
    throw err;
  }
}

// ---------- studio ----------
async function handleStudio(req, res, url) {
  if (!passcodeOk(req)) return send(res, 401, { error: "Wrong passcode." });
  const parts = url.pathname.split("/").filter(Boolean); // api, studio, ...
  const [, , a, b] = parts;

  if (req.method === "GET" && !a) {
    return send(res, 200, { services: studio.services(), ...(await studio.list()) });
  }
  if (req.method === "POST" && a === "clip") {
    const body = await readJson(req, 64 * 1024);
    return send(res, 202, await studio.clipFromUrl(String(body.url || "").trim()));
  }
  if (req.method === "POST" && a === "upload") {
    const length = Number(req.headers["content-length"]);
    if (length > MAX_UPLOAD) throw new ScanError("Video is over 4 GB.", 413);
    const name = path.basename(String(req.headers["x-filename"] || "video.mp4")).replace(/[^\w.\- ]/g, "_").slice(0, 120) || "video.mp4";
    await fs.mkdir(studio.uploadDir, { recursive: true });
    const tmp = path.join(studio.uploadDir, `${randomUUID()}-${name}`);
    let size = 0;
    try {
      await pipeline(
        req,
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > MAX_UPLOAD) throw new ScanError("Video is over 4 GB.", 413);
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    if (!size) {
      await fs.rm(tmp, { force: true });
      throw new ScanError("The upload was empty.", 400);
    }
    return send(res, 202, await studio.clipFromFile(tmp, name));
  }
  if (req.method === "POST" && a === "short") {
    const body = await readJson(req, 64 * 1024);
    return send(res, 202, await studio.makeShort(body.topic));
  }
  if (req.method === "GET" && a === "video" && b) {
    return proxyVideo(req, res, await studio.videoUrl(b));
  }
  if (req.method === "POST" && a && b === "approve") {
    const body = await readJson(req, 64 * 1024);
    return send(res, 200, await studio.approve(a, body));
  }
  if (req.method === "POST" && a && b === "reject") return send(res, 200, await studio.reject(a));
  if (req.method === "PUT" && a && !b) {
    const body = await readJson(req, 256 * 1024);
    return send(res, 200, await studio.update(a, body));
  }
  send(res, 404, { error: "Not found." });
}

// Streams a rendered video from the render service, passing Range through so
// phones can seek (iOS won't play video without range support).
async function proxyVideo(req, res, upstream) {
  let up;
  try {
    up = await fetch(upstream, { headers: req.headers.range ? { range: req.headers.range } : {} });
  } catch {
    return send(res, 502, { error: "Can't reach the render service." });
  }
  const headers = { "cache-control": "private, max-age=300" };
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = up.headers.get(h);
    if (v) headers[h] = v;
  }
  res.writeHead(up.status, headers);
  if (!up.body) return res.end();
  await pipeline(Readable.fromWeb(up.body), res).catch(() => res.destroy());
}

async function handleStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  try {
    const data = await fs.readFile(file);
    send(res, 200, data, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  } catch {
    send(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/studio" || url.pathname.startsWith("/api/studio/")) {
      return await handleStudio(req, res, url);
    }
    if (req.method === "GET" && req.url === "/api/config") {
      return send(res, 200, { needsPasscode: Boolean(PASSCODE), mock: MOCK });
    }
    if (req.method === "POST" && req.url === "/api/scan") return await handleScan(req, res);
    if (req.method === "GET") return await handleStatic(req, res);
    send(res, 405, "Method not allowed");
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof ScanError) return send(res, err.status, { error: err.message });
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Anthropic auth failed. Check ANTHROPIC_API_KEY.");
      return send(res, 500, { error: "Server API key is missing or wrong." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return send(res, 429, { error: "Too many scans at once. Wait a few seconds." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${err.status}:`, err.message);
      return send(res, 502, { error: "The AI service had a problem. Try again." });
    }
    console.error(err);
    send(res, 500, { error: "Something broke on the server." });
  }
});

// Check render jobs in the background so finished videos land in the queue.
setInterval(() => studio.poll().catch((err) => console.error("Studio poll:", err)), 15_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Patrick flip scanner on http://localhost:${PORT}`);
  console.log(MOCK ? "MOCK mode: no AI calls are made." : `Model: ${MODEL}`);
  if (!MOCK && !process.env.ANTHROPIC_API_KEY) console.warn("Warning: ANTHROPIC_API_KEY is not set.");
  if (!PASSCODE) console.warn("Warning: PATRICK_PASSCODE is not set. Set one before putting this on the internet.");
  const svc = studio.services();
  console.log(`Studio: openshorts=${svc.openshorts} shortmaker=${svc.shortmaker} postiz=${svc.postiz}`);
});
