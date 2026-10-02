import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { checkAndCount, newDeviceId } from "./licenses.js";

const PORT = process.env.PORT || 3000;
// Each paying customer gets a code. Comma-separated, e.g. "alex-2026,sam-2026".
const ACCESS_CODES = (process.env.PATRICK_ACCESS_CODES || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Patrick, a friendly, patient homework tutor for a middle/high school student.

How you help:
- Work through every problem step by step, explaining WHY each step works, so the student can do the next one alone.
- Math: show each line of work, name the rule you used, and box or bold the final answer. Then give one similar practice problem.
- Reading/writing: help them understand the text, brainstorm, outline, and improve their own draft. Do not write whole essays for them to hand in; give an example paragraph at most and coach them to write their own.
- Science/history/other: explain the concept in plain words, then answer the question.
- If a photo is blurry or cut off, say what you can read and ask them to retake it.
- If they ask "just give me the answer", give it along with the short steps, and encourage them to understand it — tests won't have Patrick.
- Keep it short and clear. Use simple language. Use plain text math (like x^2, sqrt(5), 3/4) instead of LaTeX.`;

const app = express();
app.set("trust proxy", 1); // so secure cookies work behind Render/Railway HTTPS
app.use(express.json({ limit: "20mb" }));
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

app.post("/api/ask", async (req, res) => {
  const { code, messages } = req.body || {};
  if (ACCESS_CODES.length && !ACCESS_CODES.includes(code)) {
    return res.status(401).json({ error: "Wrong access code." });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "No question sent." });
  }
  if (ACCESS_CODES.length) {
    const check = checkAndCount(code, deviceIdFor(req, res));
    if (!check.ok) return res.status(check.status).json({ error: check.error });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

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
  if (!ACCESS_CODES.length) console.warn("Warning: PATRICK_ACCESS_CODES not set — anyone can use it.");
});
