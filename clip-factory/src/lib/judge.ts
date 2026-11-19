import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EXTRA_TAGS, cleanExtras, type ExtraTag } from "./social";
import type { JudgeFrame } from "./frames";

export const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-sonnet-5-5";

// v1.9.4: `observations` comes BEFORE `score` so the model writes down what it saw and heard first, then scores it.
const Verdict = z.object({
  observations: z.string().describe("At most 2 plain sentences: what visibly and audibly happens in this clip (from the frames, the audio summary and the transcript), before any judgement"),
  // v1.9.8 (Krew: "we need the clips to be actually entertaining"): name the payoff or the score is capped at 4.
  payoff: z.string().describe("ONE line naming the specific funny or impressive thing that happens and its result, e.g. \"he jumps the car off the pier and lands on a moving train\". Empty string if you can't name one: random gameplay, chatter, nothing resolves"),
  // v1.9.8: two yes/no checks an editor makes, written before the score and used to fix the window.
  hook_lands: z.boolean().describe("true if the first ~1.5 seconds of the proposed window (or of your best_start) already pull a stranger in: action, a loud moment or a line that sets up the payoff. false for dead air, greetings, menus or a sentence picked up halfway"),
  payoff_in_window: z.boolean().describe("true if the payoff (the thing the clip is about, plus the reaction to it) happens inside the proposed window"),
  payoff_at: z.number().nullable().describe("Seconds into the SOURCE where the payoff happens, or null if there is none"),
  score: z.number().describe("1-10 on the rubric: how likely a stranger scrolling short-form video stops and watches to the end"),
  hook_text: z.string().describe("Short scroll-stopping hook, max 45 characters, no hashtags or emoji: on screen for the first seconds AND the first line of the post caption"),
  title: z.string().describe("Post title, max 80 characters"),
  hashtags: z.array(z.string()).describe("4-6 hashtags without the # sign"),
  extra_hashtags: z.array(z.enum(EXTRA_TAGS)).describe("1-2 extra hashtags for the caption, without #: GTA6Funny for funny moments, GTA6Clips for GTA gameplay, StreamerMoments for reactions/IRL, Gaming for other games"),
  reason: z.string().describe("One or two plain sentences on why this score"),
  category: z.enum(["funny", "gaming"]).describe("funny: comedy, banter, reactions, funny fails (any stream, not only games). gaming: plays, clutches, chases, game moments"),
  // v2.0.6 (Krew: "the judge just determines what channel it should go to"): a plain string (checked in code), so the schema
  // stays the same for every call whatever the channels are called.
  channel: z.string().describe("The name of the ONE channel from the message's channel list whose audience fits this clip best, copied exactly. Empty string if the message has no channel list"),
  best_start: z.number().nullable().describe("Seconds into the SOURCE where the best stretch starts, or null to keep the proposed window"),
  best_end: z.number().nullable().describe("Seconds into the SOURCE where the best stretch ends (after the payoff lands), or null"),
});
export type Verdict = Omit<z.infer<typeof Verdict>, "extra_hashtags"> & {
  extra_hashtags: ExtraTag[];
  /** v1.9.4: tokens this call used (input = all input incl. cache reads/writes and images); null if the API didn't say. */
  usage: { input: number; output: number } | null;
};
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
  // v1.8.0: the whole source, so the Judge can pick the best stretch itself (best_start/best_end).
  sourceLength?: number | null; // seconds
  timedTranscript?: string | null; // "[12.4s] text…" one line per sentence, times in the source
  window?: { start: number; end: number } | null; // the proposed window (seconds in the source)
  lengthRange?: { min: number; max: number } | null; // allowed clip length
  // v1.9.1 Campaign mode: the creator's campaign caption rules (free text) + banned words; the hook must follow them.
  campaignRules?: string | null;
  bannedWords?: string | null;
  // v1.9.4: stills from the source (seconds in the source + base64 JPEG), sent as image blocks before the text.
  // null/[] = text only; framesFailed = we tried and ffmpeg couldn't take them (the Judge is told).
  frames?: JudgeFrame[] | null;
  framesFailed?: boolean;
  // v1.9.4 calibration guard: one line added when the recent scores barely vary (src/lib/judge-stats.ts calibrationNudge).
  calibration?: string | null;
  // v1.9.8: <audio_summary> block (src/lib/audio-summary.ts): loudness per 0.5s, spikes, speech/silence, chat heat.
  audioSummary?: string | null;
  // v2.0.6: Krew's channels the clip can go to (name, focus, types, one line about it, clips it got in the last 24h).
  channels?: { name: string; focus: string; kinds: string; about: string; recent: number }[] | null;
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
  if (i.campaignRules?.trim()) lines.push(`Campaign caption rules: ${i.campaignRules.trim().replace(/\s*\n\s*/g, " / ").slice(0, 1500)}`);
  if (i.bannedWords?.trim()) lines.push(`Campaign banned words (never in the hook): ${i.bannedWords.trim().replace(/\s*\n\s*/g, ", ").slice(0, 500)}`);
  if (i.category === "funny" || i.category === "gaming") lines.push(`First guess at the type: ${i.category} (from chat, the Twitch category or the title)`);
  if (i.sourceLength && i.window) {
    const range = i.lengthRange ? ` Clips must be ${i.lengthRange.min}-${i.lengthRange.max}s long.` : "";
    lines.push(`Source video: ${Math.round(i.sourceLength * 10) / 10}s. Proposed window: ${i.window.start.toFixed(1)}s to ${i.window.end.toFixed(1)}s (picked automatically around the biggest loudness jump / reaction).${range}`);
  }
  // v1.8.0: with the whole source's timed transcript (window edges + sound cues marked in it), the window's plain transcript
  // would only repeat it. Older clips get the plain transcript.
  if (i.timedTranscript != null && i.sourceLength) lines.push("", "<source_transcript>", i.timedTranscript.trim() || "(no speech detected in the whole source)", "</source_transcript>");
  else lines.push("", "<transcript>", i.transcript?.trim() || "(no speech detected)", "</transcript>");
  if (i.audioSummary?.trim()) lines.push("", i.audioSummary.trim());
  if (i.stats?.chat?.length) lines.push("", "<chat_sample>", ...i.stats.chat.slice(0, 40), "</chat_sample>");
  if (i.frames?.length) lines.push("", `The ${i.frames.length} images above are stills from the source at the times shown (same seconds as the transcript and the audio summary). Watch the clip through them in time order with the audio summary as the soundtrack; describe what happens in observations, check the hook and the payoff, then score.`);
  else if (i.framesFailed) lines.push("", "No frames could be taken from this clip, so judge it from the text only and say so in observations.");
  if (i.calibration?.trim()) lines.push("", i.calibration.trim());
  if (i.channels?.length) {
    lines.push("", "Krew's channels (put the name of the best fit in \"channel\"):",
      ...i.channels.map((c) => `- ${c.name}: ${c.about}. Focus: ${c.focus === "gta" ? "GTA 6" : "any game"}; types: ${c.kinds || "none"}; ${c.recent} clip${c.recent === 1 ? "" : "s"} in the last 24h`),
      "Pick by who would watch it. When two channels fit about equally, pick the one with fewer clips in the last 24h so every channel gets a fair share.");
  }
  return lines.join("\n");
}

/** The user message: text only (a plain string, as before v1.9.4) or, with frames, "[frame at 31.2s]" + image per frame, then the text. */
export function judgeContent(input: JudgeInput): string | Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const text = render(input);
  if (!input.frames?.length) return text;
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  for (const f of input.frames) {
    blocks.push({ type: "text", text: `[frame at ${f.at.toFixed(1)}s]` });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
  }
  blocks.push({ type: "text", text });
  return blocks;
}

/** v1.9.8: score cap when the Judge can't name a specific payoff (Krew: "fewer, higher-quality clips"). */
export const NO_PAYOFF_CAP = 4;
const VAGUE = /^(none|nothing|n\/?a|no (clear |real )?(payoff|event)|unclear|not sure|unknown|nothing (really )?happens|just (talking|gameplay|chatting)|random|ordinary gameplay)\b/i;
/** A real payoff: a specific line (>= 3 words, not "nothing"/"unclear"/"just gameplay") with a time. */
export function namedPayoff(payoff: string | null | undefined, at: number | null | undefined): boolean {
  const p = (payoff ?? "").trim();
  return at != null && p.split(/\s+/).length >= 3 && !VAGUE.test(p);
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
    messages: [{ role: "user", content: judgeContent(input) }],
    // v1.9.4: "medium" (was "low") so it actually weighs the frames and the rubric.
    output_config: { effort: "medium", format: zodOutputFormat(Verdict) },
    // If a safety classifier declines the request, re-run it on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return null;
  const v = res.parsed_output;
  const u = (res as { usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
  const usage = u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
    ? { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens } : null;
  const payoffAt = typeof v.payoff_at === "number" && Number.isFinite(v.payoff_at) ? Math.round(v.payoff_at * 100) / 100 : null;
  const payoff = (v.payoff ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const named = namedPayoff(payoff, payoffAt);
  let score = Math.min(10, Math.max(1, Math.round(v.score * 10) / 10));
  if (!named && score > NO_PAYOFF_CAP) score = NO_PAYOFF_CAP;
  return {
    observations: (v.observations ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    payoff,
    score,
    hook_text: v.hook_text.replace(/[#\n]/g, " ").trim().slice(0, 60),
    title: v.title.replace(/[<>\n]/g, " ").trim().slice(0, 90),
    hashtags: v.hashtags,
    // Validated in code: known tags only, deduped, max 2; none → the worker's fallback (defaultExtras).
    extra_hashtags: cleanExtras(v.extra_hashtags, []),
    reason: (named ? "" : "No clear payoff, so capped at 4. ") + v.reason.trim().slice(0, 500),
    category: v.category === "funny" ? "funny" : "gaming",
    channel: (v.channel ?? "").replace(/\s+/g, " ").trim().slice(0, 60), // checked against the routing rules by the worker
    best_start: typeof v.best_start === "number" && Number.isFinite(v.best_start) ? Math.round(v.best_start * 100) / 100 : null,
    best_end: typeof v.best_end === "number" && Number.isFinite(v.best_end) ? Math.round(v.best_end * 100) / 100 : null,
    hook_lands: typeof v.hook_lands === "boolean" ? v.hook_lands : true,
    payoff_in_window: typeof v.payoff_in_window === "boolean" ? v.payoff_in_window : true,
    payoff_at: payoffAt,
    usage,
  };
}
