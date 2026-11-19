// v1.9.6 Supreme Judge video check ("watch the video"): free ffmpeg checks on the final file + cut sanity from the edit
// plan, then a vision check (claude-sonnet-5-5, effort low) on ~10 frames. Pure parts are exported for tests.
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { run, type Word } from "./media";
import { loadPromptFile } from "./prompt-file";
import { QA_MODEL } from "./ai-spend";

export const ISSUE_TYPES = ["bad_cut", "caption_over_face", "cam_crop", "frozen", "black", "audio", "credit_missing", "ending", "other"] as const;
export const FIXES = ["recut_no_jumpcuts", "recut_layout_blur", "recut_layout_split", "recut_layout_fullcam", "recut_style_clean", "extend_end", "none"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export type Fix = (typeof FIXES)[number];

export const QaVerdict = z.object({
  ok: z.boolean().describe("true only when there are no issues"),
  issues: z.array(z.object({
    type: z.enum(ISSUE_TYPES),
    at_sec: z.number().nullable().describe("Seconds into the clip, or null"),
    detail: z.string().describe("One short plain sentence"),
    fix: z.enum(FIXES),
  })),
});
export type QaIssue = z.infer<typeof QaVerdict>["issues"][number] & { source?: "ffmpeg" | "plan" | "vision" };

/** What is stored on Clip.qa (JSON). */
export type QaResult = { ok: boolean; at: string; issues: QaIssue[]; checks: string[]; vision: "done" | "skipped" | "failed" | "refused"; visionNote?: string | null; frames?: number };

export const parseQa = (s: string | null | undefined): QaResult | null => { try { const v = s ? JSON.parse(s) : null; return v && Array.isArray(v.issues) ? v : null; } catch { return null; } };

export type CutPlan = { segs: { start: number; end: number }[]; punchStart: number | null; duration: number };
export const parseCutPlan = (s: string | null | undefined): CutPlan | null => { try { const v = s ? JSON.parse(s) : null; return v && Array.isArray(v.segs) ? v : null; } catch { return null; } };

// ---------- free ffmpeg checks ----------
export type FfStats = { black: { start: number; end: number }[]; freeze: { start: number; end: number }[]; silence: { start: number; end: number }[]; lufs: number | null; lra: number | null };

/** Parse one ffmpeg run of blackdetect + freezedetect + silencedetect + ebur128 (stderr). Open-ended ranges end at `duration`. */
export function parseFfmpegChecks(out: string, duration: number): FfStats {
  const num = (s: string) => Number(s);
  const black = [...out.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: num(m[1]), end: num(m[2]) }));
  const pairs = (startRe: RegExp, endRe: RegExp) => {
    const ev = [...out.matchAll(new RegExp(`${startRe.source}|${endRe.source}`, "g"))];
    const res: { start: number; end: number }[] = [];
    let open: number | null = null;
    for (const m of ev) {
      if (m[1] != null) open = num(m[1]);
      else if (m[2] != null && open != null) { res.push({ start: open, end: num(m[2]) }); open = null; }
    }
    if (open != null) res.push({ start: open, end: duration });
    return res;
  };
  const freeze = pairs(/freeze_start: ([\d.]+)/, /freeze_end: ([\d.]+)/);
  const silence = pairs(/silence_start: (-?[\d.]+)/, /silence_end: ([\d.]+)/).map((r) => ({ start: Math.max(0, r.start), end: r.end }));
  const lufs = /\bI:\s+(-?[\d.]+) LUFS/.exec(out), lra = /\bLRA:\s+([\d.]+) LU\b/.exec(out);
  return { black, freeze, silence, lufs: lufs ? num(lufs[1]) : null, lra: lra ? num(lra[1]) : null };
}

const r1 = (t: number) => Math.round(t * 10) / 10;

/** Issues from the ffmpeg numbers: black >= 0.4s, frozen >= 2s (not already black), silence >= 3s, very quiet, length off. */
export function ffmpegIssues(s: FfStats, o: { duration: number; planned: number | null; hasAudio: boolean }): QaIssue[] {
  const out: QaIssue[] = [];
  for (const b of s.black) out.push({ type: "black", at_sec: r1(b.start), detail: `Black picture for ${r1(b.end - b.start)}s`, fix: "none", source: "ffmpeg" });
  for (const f of s.freeze) {
    if (f.end - f.start < 2) continue;
    const inBlack = s.black.some((b) => b.start <= f.start + 0.2 && b.end >= f.end - 0.2);
    if (!inBlack) out.push({ type: "frozen", at_sec: r1(f.start), detail: `Picture frozen for ${r1(f.end - f.start)}s`, fix: "none", source: "ffmpeg" });
  }
  if (!o.hasAudio) out.push({ type: "audio", at_sec: null, detail: "The clip has no sound", fix: "none", source: "ffmpeg" });
  for (const x of s.silence) if (x.end - x.start >= 3) out.push({ type: "audio", at_sec: r1(x.start), detail: `Silent for ${r1(x.end - x.start)}s`, fix: "none", source: "ffmpeg" });
  if (o.hasAudio && s.lufs != null && s.lufs < -30) out.push({ type: "audio", at_sec: null, detail: `Very quiet overall (${s.lufs} LUFS)`, fix: "none", source: "ffmpeg" });
  if (o.planned != null && Math.abs(o.duration - o.planned) > 1) out.push({ type: "other", at_sec: null, detail: `Video is ${r1(o.duration)}s but the edit planned ${r1(o.planned)}s`, fix: "none", source: "ffmpeg" });
  return out;
}

export async function runFfmpegChecks(file: string, hasAudio: boolean, duration: number): Promise<FfStats> {
  const args = ["-hide_banner", "-nostats", "-i", path.resolve(file), "-vf", "blackdetect=d=0.4:pix_th=0.10,freezedetect=n=0.003:d=1.5"];
  if (hasAudio) args.push("-af", "silencedetect=n=-50dB:d=2,ebur128=framelog=quiet");
  args.push("-f", "null", "-");
  const { stderr } = await run("ffmpeg", args, { timeoutMs: 120_000 });
  return parseFfmpegChecks(stderr, duration);
}

// ---------- cut sanity from the edit plan ----------
/** Output time of each jump cut (the start of every segment after the first). */
export function cutTimes(plan: CutPlan): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < plan.segs.length; i++) { if (i > 0) out.push(r1(t)); t += plan.segs[i].end - plan.segs[i].start; }
  return out;
}

/**
 * words = the window's words in WINDOW seconds. A boundary of a removed gap inside a word (more than 0.05s of the word on
 * the far side) = bad_cut; a segment under 0.5s = bad_cut; the clip ending inside a word = ending (extend_end).
 */
export function planIssues(plan: CutPlan | null, words: Word[], windowLength: number | null): QaIssue[] {
  const out: QaIssue[] = [];
  if (plan && plan.segs.length) {
    const ct = cutTimes(plan);
    for (let i = 0; i < plan.segs.length - 1; i++) {
      for (const b of [plan.segs[i].end, plan.segs[i + 1].start]) {
        const w = words.find((x) => x.start < b - 0.05 && x.end > b + 0.05);
        if (w) { out.push({ type: "bad_cut", at_sec: ct[i], detail: `Jump cut ${i + 1} chops the word "${w.word.trim()}"`, fix: "recut_no_jumpcuts", source: "plan" }); break; }
      }
    }
    plan.segs.forEach((s, i) => {
      if (plan.segs.length > 1 && s.end - s.start < 0.5) out.push({ type: "bad_cut", at_sec: i ? ct[i - 1] : 0, detail: `A ${r1(s.end - s.start)}s piece between jump cuts (too short)`, fix: "recut_no_jumpcuts", source: "plan" });
    });
  }
  const end = windowLength ?? (plan ? plan.segs[plan.segs.length - 1]?.end : null);
  if (end != null) {
    const w = words.find((x) => x.start < end - 0.1 && x.end > end + 0.05);
    if (w) out.push({ type: "ending", at_sec: plan ? r1(plan.duration) : r1(end), detail: `Ends in the middle of "${w.word.trim()}"`, fix: "extend_end", source: "plan" });
  }
  return out;
}

// ---------- frames for the vision check ----------
/** ~10 output times: the hook, right after each cut, the punch-in, the last second, then evenly to fill. Labels say why. */
export function frameTimes(plan: CutPlan | null, duration: number, n = 10): { t: number; why: string }[] {
  const end = Math.max(0.1, duration - 0.1);
  const want: { t: number; why: string }[] = [{ t: 0.6, why: "hook" }];
  if (plan) {
    cutTimes(plan).forEach((c, i) => want.push({ t: c + 0.25, why: `right after jump cut ${i + 1}` }));
    if (plan.punchStart != null) want.push({ t: plan.punchStart + 0.4, why: "punch-in" });
  }
  want.push({ t: duration - 0.4, why: "last second" });
  const picked: { t: number; why: string }[] = [];
  const add = (x: { t: number; why: string }) => {
    const t = Math.round(Math.min(end, Math.max(0, x.t)) * 100) / 100;
    if (picked.length < n + 2 && !picked.some((p) => Math.abs(p.t - t) < 0.4)) picked.push({ t, why: x.why });
  };
  want.forEach(add);
  for (let k = 1; picked.length < n && k <= 2 * n; k++) add({ t: (duration * k) / (n + 1), why: "spot check" });
  return picked.sort((a, b) => a.t - b.t);
}

/** "[12.4s] text" lines of the words within 3s of each cut (output seconds) + the end. */
export function transcriptAroundCuts(words: Word[], plan: CutPlan | null): string {
  if (!words.length) return "(no speech detected)";
  const segs = plan?.segs ?? [];
  // window time → output time
  const toOut = (t: number) => {
    let acc = 0;
    for (const s of segs) { if (t < s.start) return null; if (t <= s.end) return acc + (t - s.start); acc += s.end - s.start; }
    return segs.length ? null : t;
  };
  const cuts = plan ? cutTimes(plan) : [];
  const lines: string[] = [];
  for (const w of words) {
    const o = toOut(w.start);
    if (o == null) continue;
    if (!cuts.length || cuts.some((c) => Math.abs(o - c) <= 3)) lines.push(`[${o.toFixed(1)}s] ${w.word.trim()}`);
  }
  return lines.join("\n").slice(0, 3000) || "(no words near the cuts)";
}

let QA_SYSTEM: string | null = null;
export const qaSystem = () => (QA_SYSTEM ??= loadPromptFile("prompts/supreme-qa.md"));

/** The vision request: text (cut list, transcript, the free checks) + one labelled base64 JPEG per frame. */
export function buildQaContent(o: { frames: { t: number; why: string; data: string }[]; plan: CutPlan | null; duration: number; layout: string | null; words: string; free: QaIssue[] }): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const cuts = o.plan ? cutTimes(o.plan) : [];
  const head = [
    `Clip length: ${o.duration.toFixed(1)}s. Layout: ${o.layout ?? "unknown"}.`,
    `Jump cuts at: ${cuts.length ? cuts.map((c) => `${c}s`).join(", ") : "none"}.${o.plan?.punchStart != null ? ` Punch-in at ${o.plan.punchStart.toFixed(1)}s.` : ""}`,
    `Free checks found: ${o.free.length ? o.free.map((i) => `${i.type}${i.at_sec != null ? ` at ${i.at_sec}s` : ""} (${i.detail})`).join("; ") : "nothing"}.`,
    "", "<transcript_around_cuts>", o.words, "</transcript_around_cuts>", "", `${o.frames.length} frames follow, in time order.`,
  ].join("\n");
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [{ type: "text", text: head }];
  for (const [i, f] of o.frames.entries()) {
    blocks.push({ type: "text", text: `Frame ${i + 1} at ${f.t.toFixed(2)}s (${f.why}):` });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
  }
  return blocks;
}

export async function visionQa(content: Anthropic.Beta.Messages.BetaContentBlockParam[], client = new Anthropic()) {
  const res = await client.beta.messages.parse({
    model: QA_MODEL,
    max_tokens: 4000,
    system: [{ type: "text", text: qaSystem(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { effort: "low", format: zodOutputFormat(QaVerdict) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  return { refused: res.stop_reason === "refusal", verdict: res.stop_reason === "refusal" ? null : res.parsed_output ?? null, usage: res.usage, model: (res as { model?: string }).model ?? QA_MODEL };
}

// ---------- Fix it ----------
export type FixPlan = { style?: string; layout?: string; jumpCuts?: "off"; extendSec?: number; fixes: Fix[] };

/** What "Fix it" changes for the re-cut: every suggested fix of the open issues together (none → nothing to do). */
export function fixPlan(issues: QaIssue[]): FixPlan | null {
  const fixes = [...new Set(issues.map((i) => i.fix).filter((f) => f && f !== "none"))] as Fix[];
  if (!fixes.length) return null;
  const p: FixPlan = { fixes };
  if (fixes.includes("recut_no_jumpcuts")) p.jumpCuts = "off";
  if (fixes.includes("recut_style_clean")) p.style = "clean";
  const lay = fixes.find((f) => f.startsWith("recut_layout_"));
  if (lay) p.layout = lay.replace("recut_layout_", "");
  if (fixes.includes("extend_end")) p.extendSec = 2;
  return p;
}
