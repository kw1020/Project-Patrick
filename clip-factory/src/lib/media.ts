import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/** 9:16 (1080x1920) filtergraph. "blur" = blurred fill behind the full frame; facecam = cam on top, gameplay below. */
export function buildFilter(opts: { facecam: Facecam | null; assFile?: string | null }) {
  const W = 1080, H = 1920;
  let g: string;
  if (opts.facecam) {
    const f = opts.facecam, topH = 640, botH = H - topH;
    g = [
      `[0:v]split=2[a][b]`,
      `[a]crop=w=iw*${f.w}:h=ih*${f.h}:x=iw*${f.x}:y=ih*${f.y},scale=${W}:${topH}:force_original_aspect_ratio=increase,crop=${W}:${topH}[top]`,
      `[b]scale=-2:${botH},crop=${W}:${botH}[bot]`,
      `[top][bot]vstack=inputs=2,setsar=1,fps=30[v0]`,
    ].join(";");
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
export function buildAss(opts: { words: Word[]; credit: string; duration: number; font?: string; layout: "blur" | "facecam"; hook?: string | null }) {
  const font = opts.font || process.env.CAPTION_FONT || "DejaVu Sans";
  const capMarginV = opts.layout === "facecam" ? 360 : 470;
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
    `Style: Cap,${font},86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,7,3,2,60,60,${capMarginV},1`,
    `Style: Credit,${font},40,&H30FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,8,40,40,110,1`,
    // Hook: white text on a pink box near the top, first few seconds only.
    `Style: Hook,${font},62,&H00FFFFFF,&H00FFFFFF,&H00813DFF,&H00813DFF,-1,0,0,0,100,100,0,0,3,14,0,8,90,90,${opts.layout === "facecam" ? 175 : 250},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 1,${assTime(0)},${assTime(opts.duration)},Credit,,0,0,0,,${assEscape(opts.credit)}`,
  ];
  const hook = assEscape(opts.hook || "").slice(0, 70);
  if (hook) lines.push(`Dialogue: 2,${assTime(0)},${assTime(Math.min(4.5, opts.duration))},Hook,,0,0,0,,{\\fad(0,250)}${hook}`);
  for (const c of chunkWords(opts.words)) {
    if (c.start >= opts.duration) continue;
    const text = assEscape(c.text).toUpperCase();
    if (!text) continue;
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(Math.min(c.end, opts.duration))},Cap,,0,0,0,,{\\fad(60,0)}${text}`);
  }
  return lines.join("\n") + "\n";
}

/** Render the final vertical clip. */
export async function renderVertical(opts: {
  input: string; output: string; start: number; length: number; facecam: Facecam | null; assPath?: string | null;
}) {
  const cwd = opts.assPath ? path.dirname(opts.assPath) : undefined;
  const filter = buildFilter({ facecam: opts.facecam, assFile: opts.assPath ? path.basename(opts.assPath) : null });
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
