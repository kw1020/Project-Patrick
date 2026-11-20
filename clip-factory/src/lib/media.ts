import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TEXT_MAX_W, TEXT_SAFE, TEXT_X, fitScale } from "./platform-rules";
import { cropXExpr, legacyPlan, overlayPlace, watermarkPlace, watermarkStyle, watermarkText, type LayoutPlan, type OverlayPlace } from "./layout";

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    const t = opts.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs) : null;
    p.on("error", (e) => { if (t) clearTimeout(t); reject(new Error(`${cmd} not found or failed to start: ${e.message}`)); });
    p.on("close", (code) => {
      if (t) clearTimeout(t);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`could not read duration of ${file}`);
  return d;
}

/**
 * v2.0.10: is this a complete, playable video? A download killed mid-way (e.g. Clip Factory restarted) leaves an mp4 with no
 * index ("moov atom not found") or no video stream ("Stream specifier ':v' matches no streams"). Returns null when fine,
 * else a plain reason.
 */
export async function brokenVideo(file: string): Promise<string | null> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
    const j = JSON.parse(stdout || "{}");
    const v = j.streams?.[0];
    if (!v?.width || !v?.height) return "the download has no video in it";
    const d = parseFloat(j.format?.duration);
    if (!Number.isFinite(d) || d < 1) return "the download is empty or cut short";
    return null;
  } catch (e) {
    return /moov atom not found|Invalid data/i.test((e as Error).message) ? "the download was cut off before it finished" : `the download can't be read (${(e as Error).message.split("\n")[0].slice(0, 120)})`;
  }
}

/** Which slice of the source to keep. Twitch clips are ≤60s; keep the middle so we get build-up + payoff. */
export function pickWindow(duration: number, minSec: number, maxSec: number) {
  const len = Math.min(duration, Math.max(minSec, maxSec));
  const start = Math.max(0, (duration - len) / 2);
  return { start: Math.round(start * 100) / 100, length: Math.round(len * 100) / 100 };
}

export type Facecam = { x: number; y: number; w: number; h: number }; // fractions of the source frame

export function parseFacecam(s: string | null | undefined): Facecam | null {
  if (!s) return null;
  const n = s.split(",").map((v) => parseFloat(v.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  const [x, y, w, h] = n;
  if (w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}

/**
 * 9:16 (1080x1920) filtergraph for the plain edit. blur = blurred fill behind the full frame; split = cam on top, game below
 * (moved away from the cam, see splitGameShift); fullcam = a 9:16 crop around the face (v1.9.0). `plan` wins over `facecam`.
 */
export function buildFilter(opts: { facecam: Facecam | null; assFile?: string | null; plan?: LayoutPlan | null }) {
  const W = 1080, H = 1920;
  const plan = opts.plan ?? legacyPlan(opts.facecam);
  let g: string;
  if (plan.kind === "split") {
    const f = plan.cam, topH = 640, botH = H - topH;
    const botCrop = plan.gameShift ? `crop=${W}:${botH}:x='max(0,min(iw-${W},(iw-${W})/2+iw*${plan.gameShift}))':y=0` : `crop=${W}:${botH}`;
    g = [
      `[0:v]split=2[a][b]`,
      `[a]crop=w=iw*${f.w}:h=ih*${f.h}:x=iw*${f.x}:y=ih*${f.y},scale=${W}:${topH}:force_original_aspect_ratio=increase,crop=${W}:${topH}[top]`,
      `[b]scale=-2:${botH},${botCrop}[bot]`,
      `[top][bot]vstack=inputs=2,setsar=1,fps=30[v0]`,
    ].join(";");
  } else if (plan.kind === "fullcam") {
    const c = plan.crop;
    g = `[0:v]crop=${c.w}:${c.h}:x='${cropXExpr(c.keys)}':y=${c.y},scale=${W}:${H},setsar=1,fps=30[v0]`;
  } else {
    g = [
      `[0:v]split=2[a][b]`,
      `[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=${W}:${H},eq=brightness=-0.07[bg]`,
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30[v0]`,
    ].join(";");
  }
  g += opts.assFile ? `;[v0]ass=${opts.assFile}[v]` : `;[v0]null[v]`;
  return g;
}

export type Word = { start: number; end: number; word: string };

function assTime(t: number) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
function assEscape(s: string) {
  return s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
}

/** Group words into short punchy caption chunks (≤3 words / ≤18 chars). */
export function chunkWords(words: Word[], maxWords = 3, maxChars = 18) {
  const chunks: { start: number; end: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    chunks.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word.trim()).join(" ") });
    cur = [];
  };
  for (const w of words) {
    if (!w.word.trim()) continue;
    const len = cur.map((x) => x.word.trim()).join(" ").length + w.word.trim().length + 1;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length >= maxWords || len > maxChars || gap > 0.6) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word.trim())) flush();
  }
  flush();
  // Keep each chunk on screen until the next one starts (max +0.4s) so captions don't flicker.
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    chunks[i].end = next ? Math.min(next.start, chunks[i].end + 0.4) : chunks[i].end + 0.4;
  }
  return chunks;
}

/** ASS subtitle file: big bold word-chunk captions + a permanent streamer credit. */
export function buildAss(opts: { words: Word[]; credit: string; duration: number; font?: string; layout: "blur" | "facecam" | "split" | "fullcam"; hook?: string | null; place?: OverlayPlace | null; watermark?: string | null }) {
  const font = opts.font || process.env.CAPTION_FONT || "DejaVu Sans";
  const capMarginV = 470;
  // v1.9.0: split / fullcam place the text off the face (src/lib/layout.ts overlayPlace); blur keeps the v1.7.1 styles.
  // v1.9.8: every layout (blur too) uses explicit places inside the apps' safe zone (TEXT_SAFE), centred on TEXT_X.
  const place = opts.place ?? overlayPlace(opts.layout, null);
  const at = (an: number, y: number, k = 1) => `{\\an${an}\\pos(${TEXT_X},${y})${k < 1 ? `\\fscx${Math.round(k * 100)}\\fscy${Math.round(k * 100)}` : ""}}`;
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${font},86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,7,3,2,${TEXT_SAFE.left},${TEXT_SAFE.right},${capMarginV},1`,
    `Style: Credit,${font},40,&H30FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,8,40,40,110,1`,
    // Hook: white text on a pink box near the top, first few seconds only.
    `Style: Hook,${font},62,&H00FFFFFF,&H00FFFFFF,&H00813DFF,&H00813DFF,-1,0,0,0,100,100,0,0,3,14,0,8,${TEXT_SAFE.left + 14},${TEXT_SAFE.right + 14},250,1`,
    watermarkStyle(font),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 1,${assTime(0)},${assTime(opts.duration)},Credit,,0,0,0,,${at(place.creditAlign, place.creditY, fitScale(assEscape(opts.credit), 40, TEXT_MAX_W, { outline: 3 }))}${assEscape(opts.credit)}`,
  ];
  // v1.9.1: "@ViceCityClips" bottom right (Settings watermark), clear of the credit and captions.
  const mark = watermarkText(opts.watermark), wm = watermarkPlace(place);
  if (mark && wm.start < opts.duration) lines.push(`Dialogue: 1,${assTime(wm.start)},${assTime(opts.duration)},Mark,,0,0,0,,${wm.tag}${mark}`);
  const hook = assEscape(opts.hook || "").slice(0, 70);
  if (hook) lines.push(`Dialogue: 2,${assTime(0)},${assTime(Math.min(4.5, opts.duration))},Hook,,0,0,0,,${at(place.hookAlign, place.hookY)}{\\fad(0,250)}${hook}`);
  for (const c of chunkWords(opts.words)) {
    if (c.start >= opts.duration) continue;
    const text = assEscape(c.text).toUpperCase();
    if (!text) continue;
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(Math.min(c.end, opts.duration))},Cap,,0,0,0,,${at(5, place.capY, fitScale(text, 86, TEXT_MAX_W, { spacing: 1, outline: 7 }))}{\\fad(60,0)}${text}`);
  }
  return lines.join("\n") + "\n";
}

/** Render the final vertical clip. */
export async function renderVertical(opts: {
  input: string; output: string; start: number; length: number; facecam: Facecam | null; assPath?: string | null; plan?: LayoutPlan | null;
}) {
  const cwd = opts.assPath ? path.dirname(opts.assPath) : undefined;
  const filter = buildFilter({ facecam: opts.facecam, plan: opts.plan, assFile: opts.assPath ? path.basename(opts.assPath) : null });
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const tmp = opts.output + ".part.mp4";
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(opts.start), "-t", String(opts.length), "-i", path.resolve(opts.input),
    "-filter_complex", filter, "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart", path.resolve(tmp),
  ], { cwd, timeoutMs: 10 * 60_000 });
  fs.renameSync(tmp, opts.output);
}

/** 16 kHz mono WAV of the kept window, for Whisper. */
export async function extractAudio(input: string, output: string, start: number, length: number) {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(start), "-t", String(length), "-i", input, "-vn", "-ac", "1", "-ar", "16000", output]);
}

export async function hasAudio(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
  return stdout.trim().length > 0;
}
