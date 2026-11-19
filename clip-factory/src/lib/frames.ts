import fs from "node:fs";
import path from "node:path";
import { run } from "./media";

// v1.9.4: the Judge looks at the moment. A few stills from the RAW source across the proposed window go into its message
// as image blocks (Krew: "The Judge is only giving every video a 6 out of 10"). Pure time picking + one ffmpeg call.

export const JUDGE_FRAME_COUNT = 8;
/** v1.9.8: never more than this many stills (cost: each 640x360 JPEG is ~300 input tokens). */
export const JUDGE_FRAME_MAX = 12;
/** ffmpeg scene score that counts as a cut / big change of shot. */
export const SCENE_THRESHOLD = 0.3;

/** Scene-change times (source seconds) in [start, start+length] from `showinfo` output lines (pts_time:12.34). */
export function parseSceneTimes(stderr: string, start: number): number[] {
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round((start + parseFloat(m[1])) * 10) / 10).filter((t) => Number.isFinite(t));
}

/**
 * v1.9.8: where the picture changes a lot (ffmpeg select='gt(scene,0.3)') inside the window, biggest changes not ranked,
 * at most `max`, >= 1.5s apart. Decodes the window at 10 fps and 256px wide to stay cheap. Throws on ffmpeg errors.
 */
export async function detectScenes(input: string, start: number, length: number, max = 3, timeoutMs = 45_000): Promise<number[]> {
  const { stderr } = await run(process.env.FFMPEG || "ffmpeg", ["-hide_banner", "-loglevel", "info", "-ss", start.toFixed(2), "-t", length.toFixed(2), "-i", input,
    "-an", "-vf", `fps=10,scale=256:-2,select=gt(scene\\,${SCENE_THRESHOLD}),showinfo`, "-f", "null", "-"], { timeoutMs });
  const out: number[] = [];
  for (const t of parseSceneTimes(stderr, start)) if (!out.some((x) => Math.abs(x - t) < 1.5) && out.length < max) out.push(t);
  return out;
}
export const JUDGE_FRAME_WIDTH = 640;
/** ffmpeg mjpeg quality scale (2 = best, 31 = worst); 6 is roughly "JPEG quality 70". */
export const JUDGE_FRAME_Q = 6;

export type JudgeFrame = { at: number; data: string }; // at = seconds in the source, data = base64 JPEG

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Which moments of the source to show the Judge (seconds in the source, sorted, 0.1s steps).
 * 2 in the first 3s of the window (the hook), 3 around the payoff (−2s, at it, +2s), the rest spread over the window
 * (each placed as far as possible from the frames already chosen). No payoff, or one outside the window → 60% of the way in.
 * Frames closer than 0.4s to one already picked are skipped and filled by the spread, so short windows still get distinct times.
 */
export function pickFrameTimes(o: { start: number; end: number; payoffAt?: number | null; count?: number; sourceLength?: number | null; peaks?: number[]; scenes?: number[] }): number[] {
  // v1.9.8: up to 2 frames per loudness/chat peak (at it, +1s for the reaction) and up to 3 scene changes (+0.2s, the new
  // shot), on top of the 8, capped at JUDGE_FRAME_MAX. Without peaks/scenes it's the v1.9.4 pick.
  const peaks = (o.peaks ?? []).filter((t) => Number.isFinite(t) && t >= o.start && t <= o.end).slice(0, 2);
  const scenes = (o.scenes ?? []).filter((t) => Number.isFinite(t) && t > o.start + 0.5 && t < o.end - 0.5).slice(0, 3);
  const extra = peaks.length * 2 + scenes.length;
  const count = Math.max(1, Math.min(JUDGE_FRAME_MAX, Math.round(o.count ?? JUDGE_FRAME_COUNT + extra)));
  const start = Math.max(0, o.start);
  const hardEnd = o.sourceLength != null && o.sourceLength > 0 ? Math.min(o.end, o.sourceLength) : o.end;
  const end = Math.max(start, hardEnd - 0.1); // the last decodable instant
  const len = end - start;
  if (len <= 0.05) return [r1(start)];
  const clamp = (t: number) => Math.min(end, Math.max(start, t));
  const p = o.payoffAt != null && o.payoffAt >= start && o.payoffAt <= end ? o.payoffAt : start + Math.min(len, (hardEnd - start) * 0.6);

  const picked: number[] = [];
  const tooClose = (t: number) => picked.some((x) => Math.abs(x - t) < 0.4);
  const add = (t: number) => { const c = r1(clamp(t)); if (picked.length < count && !tooClose(c)) picked.push(c); };
  // The hook: what a scroller sees first.
  add(start + Math.min(0.3, len * 0.05));
  add(start + Math.min(2.5, len * 0.4));
  // The payoff and the reaction to it.
  add(p);
  add(p - 2);
  add(p + 2);
  // v1.9.8: the loud/chat peaks and the reaction right after, then the scene changes.
  for (const t of peaks) { add(t); add(t + 1); }
  for (const t of scenes) add(t + 0.2);
  // The rest: spread out, each as far as possible from what's already there (0.1s grid).
  const steps = Math.max(1, Math.round(len * 10));
  while (picked.length < count) {
    let best = -1, bestGap = -1;
    for (let i = 0; i <= steps; i++) {
      const t = r1(start + (len * i) / steps);
      const gap = Math.min(...picked.map((x) => Math.abs(x - t)));
      if (gap > bestGap + 1e-9) { bestGap = gap; best = t; }
    }
    if (best < 0 || bestGap < 0.1) break; // window too short for more distinct frames
    picked.push(best);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * (v1.9.6: `width` lets the Supreme Judge's video check ask for 540 wide = 540x960 from a 1080x1920 clip.)
 * Grab the frames with ONE ffmpeg run (an input seek per frame, so it's fast on long files), scaled to 640px wide JPEGs.
 * Throws if ffmpeg fails or any frame is missing; the caller then judges from text only.
 */
export async function extractFrames(input: string, times: number[], workDir: string, id: string, timeoutMs = 60_000, width = JUDGE_FRAME_WIDTH): Promise<JudgeFrame[]> {
  if (!times.length) return [];
  fs.mkdirSync(workDir, { recursive: true });
  const outs = times.map((_, i) => path.join(workDir, `${id}-judge-${i}.jpg`));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const t of times) args.push("-ss", t.toFixed(2), "-i", input);
  times.forEach((_, i) => {
    args.push("-map", `${i}:v:0`, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", String(JUDGE_FRAME_Q), "-f", "image2", outs[i]);
  });
  try {
    await run(process.env.FFMPEG || "ffmpeg", args, { timeoutMs });
    return outs.map((f, i) => {
      const buf = fs.readFileSync(f);
      if (!buf.length) throw new Error(`frame at ${times[i]}s is empty`);
      return { at: times[i], data: buf.toString("base64") };
    });
  } finally {
    for (const f of outs) fs.rmSync(f, { force: true });
  }
}
