import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { checkAndCount, newDeviceId } from "./licenses.js";
import { gatherAssignment, listAssignments, UserError } from "./canvas.js";

const PORT = process.env.PORT || 3000;
// Each paying customer gets a code. Comma-separated, e.g. "alex-2026,sam-2026".
const ACCESS_CODES = (process.env.PATRICK_ACCESS_CODES || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

const client = new Anthropic();
// Demo mode: no API key yet, so Patrick sends a sample answer to show how the app works.
const DEMO = !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
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
app.post("/api/canvas/assignments", async (req, res) => {
  if (!allowed(req, res, { count: false })) return;
  const { canvasUrl, token } = req.body || {};
  try {
    res.json({ assignments: await listAssignments(canvasUrl, token) });
  } catch (err) {
    canvasError(res, err);
  }
});

app.post("/api/canvas/gather", async (req, res) => {
  if (!allowed(req, res, { count: false })) return;
  const { canvasUrl, token, courseId, assignmentId } = req.body || {};
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

  if (DEMO) {
    for (const word of DEMO_ANSWER.split(/(?<= )/)) {
      res.write(word);
      await new Promise((r) => setTimeout(r, 15));
    }
    return res.end();
  }

  try {
    const stream = client.beta.messages.stream({
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

app.listen(PORT, () => {
  console.log(`Patrick Homework Helper running at http://localhost:${PORT}`);
  if (DEMO) console.warn("Demo mode: no ANTHROPIC_API_KEY set, sending sample answers.");
  if (!ACCESS_CODES.length) console.warn("Warning: PATRICK_ACCESS_CODES not set — anyone can use it.");
});
