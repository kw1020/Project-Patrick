import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-sonnet-5-5";

const Verdict = z.object({
  score: z.number().describe("1-10: how likely a stranger scrolling short-form video stops and watches to the end"),
  hook_text: z.string().describe("On-screen text for the first seconds, max 45 characters, no hashtags or emoji"),
  title: z.string().describe("Post title, max 80 characters"),
  hashtags: z.array(z.string()).describe("4-6 hashtags without the # sign"),
  reason: z.string().describe("One or two plain sentences on why this score"),
  category: z.enum(["funny", "gaming"]).describe("funny: comedy, banter, reactions, funny fails (any stream, not only games). gaming: plays, clutches, chases, game moments"),
});
export type Verdict = z.infer<typeof Verdict>;
/** The structured-output schema (exported for tests). */
export const VerdictSchema = Verdict;

export type JudgeInput = {
  streamer: string;
  game?: string | null;
  durationSec: number;
  source: "chat" | "twitch_clip" | "youtube";
  replayScore?: number; // YouTube: heatmap value at the peak (0-1, 1 = the most replayed part)
  sourceTitle?: string | null;
  sourceViews?: number;
  transcript: string | null;
  stats?: { kind?: string; ratio?: number; rate?: number; baseline?: number; hypeShare?: number; laughShare?: number; viewers?: number; chat?: string[] } | null;
  minScore: number;
  category?: string | null; // the pipeline's first guess (chat laughs / Twitch category / title), evidence only
};

export function judgeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const PROMPT_FILE = "prompts/judge.md";

/** Extract the system prompt: the text between the `## SYSTEM` and `## END SYSTEM` lines of prompts/judge.md, trimmed. */
export function loadJudgePrompt(text?: string): string {
  const src = text ?? readPromptFile();
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## SYSTEM");
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === "## END SYSTEM");
  if (start < 0 || end < 0) throw new Error(`${PROMPT_FILE}: missing "## SYSTEM" / "## END SYSTEM" markers around the Judge system prompt`);
  const block = lines.slice(start + 1, end).join("\n").trim();
  if (!block) throw new Error(`${PROMPT_FILE}: the SYSTEM block is empty`);
  return block;
}

function readPromptFile(): string {
  const candidates = [path.join(process.cwd(), PROMPT_FILE)];
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", PROMPT_FILE));
  } catch {
    /* import.meta.url unavailable */
  }
  if (typeof __dirname === "string") candidates.push(path.resolve(__dirname, "../..", PROMPT_FILE));
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      /* try the next location */
    }
  }
  throw new Error(`Judge prompt file ${PROMPT_FILE} not found (looked in: ${candidates.join(", ")})`);
}

/** The Judge system prompt, read once from prompts/judge.md at module load. */
export const JUDGE_SYSTEM = loadJudgePrompt();

function render(i: JudgeInput) {
  const lines = [
    `Streamer: ${i.streamer}`,
    ...(i.game ? [`Game: ${i.game}`] : []),
    `Clip length: ${Math.round(i.durationSec)}s`,
    `Auto-reject cut-off: below ${i.minScore}`,
  ];
  if (i.source === "youtube") {
    lines.push(`Found as: the most-replayed part of a YouTube video (${i.sourceViews ?? 0} views, replay score ${i.replayScore ?? "?"})`);
    if (i.sourceTitle) lines.push(`Video title: ${i.sourceTitle}`);
  } else if (i.source === "twitch_clip") {
    lines.push(`Found as: a clip a viewer made on Twitch, ${i.sourceViews ?? 0} views so far`);
    if (i.sourceTitle) lines.push(`Viewer's clip title: ${i.sourceTitle}`);
  } else {
    const s = i.stats ?? {};
    lines.push(`Found as: a chat spike (${s.kind ?? "volume"}). Chat hit ${s.rate?.toFixed(1) ?? "?"} messages/sec against a normal ${s.baseline?.toFixed(2) ?? "?"} (${s.ratio ?? "?"}x), ${Math.round((s.hypeShare ?? 0) * 100)}% of messages were hype words or emotes, ${s.viewers ?? "?"} viewers.`);
    if (s.laughShare != null) lines.push(`Laughs (LMAO, KEKW, 😂, "I can't"…) were ${Math.round(s.laughShare * 100)}% of chat's reactions; the rest were gameplay hype (W, Pog, "no way").`);
  }
  if (i.category === "funny" || i.category === "gaming") lines.push(`First guess at the type: ${i.category} (from chat, the Twitch category or the title)`);
  lines.push("", "<transcript>", i.transcript?.trim() || "(no speech detected)", "</transcript>");
  if (i.stats?.chat?.length) lines.push("", "<chat_sample>", ...i.stats.chat.slice(0, 40), "</chat_sample>");
  return lines.join("\n");
}

/** Ask Claude to score a clip. Returns null when the model declines or returns nothing usable. */
export async function judgeClip(input: JudgeInput, lessons: string | null = null, client = new Anthropic()): Promise<Verdict | null> {
  // The fixed instructions come first and are cached; the lessons block only changes when stats sync.
  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [{ type: "text", text: JUDGE_SYSTEM, ...(lessons ? {} : { cache_control: { type: "ephemeral" as const } }) }];
  if (lessons) system.push({ type: "text", text: `<results_from_krews_accounts>\n${lessons}\n</results_from_krews_accounts>`, cache_control: { type: "ephemeral" } });
  const res = await client.beta.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: render(input) }],
    output_config: { effort: "low", format: zodOutputFormat(Verdict) },
    // If a safety classifier declines the request, re-run it on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return null;
  const v = res.parsed_output;
  return {
    score: Math.min(10, Math.max(1, Math.round(v.score * 10) / 10)),
    hook_text: v.hook_text.replace(/[#\n]/g, " ").trim().slice(0, 60),
    title: v.title.replace(/[<>\n]/g, " ").trim().slice(0, 90),
    hashtags: v.hashtags,
    reason: v.reason.trim().slice(0, 500),
    category: v.category === "funny" ? "funny" : "gaming",
  };
}
