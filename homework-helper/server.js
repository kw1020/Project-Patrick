import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { spawn } from "node:child_process";
import { checkAndCount, newDeviceId } from "./licenses.js";
import { gatherAssignment, listAssignments, UserError } from "./canvas.js";
import { anthropicKey, hint, loadSettings, saveSettings } from "./settings.js";

// The PC launcher saves the API key in a .env file next to this one.
try {
  process.loadEnvFile();
} catch {}

const PORT = process.env.PORT || 3000;
const URL_HERE = `http://localhost:${PORT}`;
// Each paying customer gets a code. Comma-separated, e.g. "alex-2026,sam-2026".
const ACCESS_CODES = (process.env.PATRICK_ACCESS_CODES || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

// Uses the key from the Settings page (or .env). Returns null when there's no key yet,
// which puts Patrick in demo mode: he sends a sample answer to show how the app works.
let client = null;
let clientKey = null;
function getClient() {
  const key = anthropicKey();
  if (!key && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  if (!client || key !== clientKey) {
    client = new Anthropic(key ? { apiKey: key } : {});
    clientKey = key;
  }
  return client;
}
const DEMO_ANSWER = `(Demo mode: add an API key to get real answers.)

1. 2x + 5 = 17
   2x = 12
   **x = 6**

2. 3x - 4 = 11
   3x = 15
   **x = 5**

3. x/2 + 3 = 10
   x/2 = 7
   **x = 14**`;

const SYSTEM_PROMPT = `You are Patrick, a homework doer for a middle/high school student. Your job is to do the homework they send and hand back finished answers they can copy down.

How you work:
- Answer EVERY question in the photo or message, numbered to match the assignment. Don't skip any.
- Lead with the answers. No lessons, no "your turn" problems, no asking them to try it themselves.
- Math/science problems: show the work in short lines, the way a student would write it on paper (teachers usually want work shown), and put each final answer in **bold**.
- Multiple choice / fill in the blank / short answer: give just the answer, plus a one-line reason only if the question asks "explain" or "why".
- Writing (essays, paragraphs, responses): write the full piece at the student's grade level, in a natural student voice, not overly fancy. Match any length or format the assignment asks for.
- If part of a photo is blurry or cut off, answer everything you can read, then say which numbers you couldn't read so they can retake just that part.
- Double-check math before answering. Accuracy matters most.
- Use plain text math (like x^2, sqrt(5), 3/4) instead of LaTeX.`;

const app = express();
app.set("trust proxy", 1); // so secure cookies work behind Render/Railway HTTPS
app.use(express.json({ limit: "60mb" })); // Canvas assignments can include PDFs
app.use(express.static("public"));

// Each browser gets a secret device ID cookie; codes get locked to the first one that uses them.
function deviceIdFor(req, res) {
  const match = /(?:^|;\s*)patrick_device=([a-f0-9]{48})/.exec(req.headers.cookie || "");
  if (match) return match[1];
  const id = newDeviceId();
  res.cookie("patrick_device", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: 5 * 365 * 24 * 60 * 60 * 1000,
  });
  return id;
}

// Returns true if the request may continue; otherwise sends the error response.
function allowed(req, res, { count }) {
  if (!ACCESS_CODES.length) return true;
  const { code } = req.body || {};
  if (!ACCESS_CODES.includes(code)) {
    res.status(401).json({ error: "Wrong access code." });
    return false;
  }
  const check = checkAndCount(code, deviceIdFor(req, res), { count });
  if (!check.ok) res.status(check.status).json({ error: check.error });
  return check.ok;
}

function canvasError(res, err) {
  if (!(err instanceof UserError)) console.error(err);
  res.status(400).json({ error: err instanceof UserError ? err.message : "Couldn't reach Canvas. Check the address and try again." });
}

// The student's Canvas token is only used for this request; it's never saved on the server.
// Canvas details typed into the panel win; otherwise use the ones saved in Settings.
function canvasLogin(body) {
  const saved = loadSettings();
  return {
    canvasUrl: body?.canvasUrl || saved.canvasUrl,
    token: body?.token || saved.canvasToken,
  };
}

app.post("/api/canvas/assignments", async (req, res) => {
  if (!allowed(req, res, { count: false })) return;
  const { canvasUrl, token } = canvasLogin(req.body);
  try {
    res.json({ assignments: await listAssignments(canvasUrl, token) });
  } catch (err) {
    canvasError(res, err);
  }
});

app.post("/api/canvas/gather", async (req, res) => {
  if (!allowed(req, res, { count: false })) return;
  const { courseId, assignmentId } = req.body || {};
  const { canvasUrl, token } = canvasLogin(req.body);
  try {
    res.json(await gatherAssignment(canvasUrl, token, courseId, assignmentId));
  } catch (err) {
    canvasError(res, err);
  }
});

app.post("/api/ask", async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "No question sent." });
  }
  if (!allowed(req, res, { count: true })) return;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const ai = getClient();
  if (!ai) {
    for (const word of DEMO_ANSWER.split(/(?<= )/)) {
      res.write(word);
      await new Promise((r) => setTimeout(r, 15));
    }
    return res.end();
  }

  try {
    const stream = ai.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      res.write("\n\nPatrick can't help with that one. Try asking a different way.");
    }
    res.end();
  } catch (err) {
    console.error(err);
    const msg =
      err instanceof Anthropic.RateLimitError
        ? "Patrick is busy right now. Try again in a minute."
        : err instanceof Anthropic.APIConnectionError
          ? "Patrick couldn't connect. Check the internet and try again."
          : "Something went wrong. Try again.";
    if (!res.headersSent) res.status(500);
    res.end(`\n\n${msg}`);
  }
});

// ---- Settings page ----
// Only the computer Patrick runs on can see or change keys, never someone on the internet.
function fromThisComputer(req) {
  const peer = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  const origin = req.headers.origin;
  const sameSite = !origin || origin === `http://${req.headers.host}`;
  return loopback && !req.headers["x-forwarded-for"] && sameSite;
}

function settingsView() {
  const s = loadSettings();
  const key = anthropicKey();
  return {
    anthropicKeySet: !!key,
    anthropicKeyHint: hint(key),
    canvasUrl: s.canvasUrl || "",
    canvasTokenSet: !!s.canvasToken,
    canvasTokenHint: hint(s.canvasToken),
  };
}

app.get("/api/settings", (req, res) => {
  const codesRequired = ACCESS_CODES.length > 0;
  if (!fromThisComputer(req)) return res.json({ editable: false, codesRequired, anthropicKeySet: !!getClient() });
  res.json({ editable: true, codesRequired, ...settingsView() });
});

app.post("/api/settings", async (req, res) => {
  if (!fromThisComputer(req)) return res.status(403).json({ error: "Settings can only be changed on the computer running Patrick." });
  const { anthropicKey: newKey, canvasUrl, canvasToken } = req.body || {};
  const changes = {};
  if (typeof newKey === "string") {
    const key = newKey.trim();
    if (key) {
      // Check the key with a free call before saving it.
      try {
        await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
      } catch (err) {
        const why = err instanceof Anthropic.AuthenticationError ? "Anthropic says that key isn't valid. Copy it again and paste the whole thing."
          : err instanceof Anthropic.PermissionDeniedError ? "That key isn't allowed to use the API. Check Billing and the key's workspace."
          : "Couldn't check the key. Check your internet and try again.";
        return res.status(400).json({ error: why });
      }
    }
    changes.anthropicKey = key || null;
  }
  if (typeof canvasUrl === "string") changes.canvasUrl = canvasUrl.trim() || null;
  if (typeof canvasToken === "string") changes.canvasToken = canvasToken.trim() || null;
  saveSettings(changes);
  res.json({ editable: true, ...settingsView() });
});

// Opens Patrick in the default browser (used by the PC launcher).
function openBrowser() {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", URL_HERE]]
    : process.platform === "darwin" ? ["open", [URL_HERE]]
    : ["xdg-open", [URL_HERE]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

// On a PC, only listen on this computer so others on the Wi-Fi can't use it.
const HOST = process.env.PATRICK_OPEN ? "127.0.0.1" : undefined;
const server = app.listen(PORT, HOST, (err) => {
  if (err) return; // handled by the "error" listener below
  console.log(`Patrick is running at ${URL_HERE}`);
  if (!getClient()) console.warn("Demo mode: no API key yet. Add one on Patrick's Settings page.");
  if (!ACCESS_CODES.length && !process.env.PATRICK_OPEN) console.warn("Warning: PATRICK_ACCESS_CODES not set — anyone can use it.");
  if (process.env.PATRICK_OPEN) {
    console.log("Keep this window open while you use Patrick. Close it to stop him.");
    openBrowser();
  }
});

server.on("error", (err) => {
  // Already running (e.g. launcher double-clicked twice): just open it.
  if (err.code === "EADDRINUSE" && process.env.PATRICK_OPEN) {
    console.log("Patrick is already running. Opening him now.");
    openBrowser();
    setTimeout(() => process.exit(0), 1000);
  } else {
    throw err;
  }
});
