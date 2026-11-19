// v2.0.5 Top 5: render with ffmpeg. One run per entry (its card in front: the title card for #5, a number card for the rest;
// the end card behind #1) to a lossless-ish intermediate (x264 crf 16 + PCM), then ONE final run that joins them
// (x264 veryfast crf 20 + AAC, faststart). The card is the entry's own first frame (its end card: its last frame), blurred and
// darkened, so the "#3" sits over the clip that's about to play. Zoom: only the entry's one punch-in on its payoff, on the
// layout's zoom layer (split = cam for funny / game otherwise, fullcam = whole frame, blur = the gameplay, never the fill).
import fs from "node:fs";
import path from "node:path";
import { probeDuration, run } from "./media";
import { ensureSfx, fitSize } from "./edit";
import { SEAM, cropXExpr, type LayoutPlan } from "./layout";
import {
  CARD_FRAMES, END_FRAMES, FPS, TITLE_FRAMES, cardAss, endAss, entryAss, punchExpr, titleAss, type EntryWindow,
} from "./top5";

const W = 1080, H = 1920;

export type Top5RenderEntry = {
  n: number; login: string; file: string; hasAudio: boolean; src: { w: number; h: number };
  layout: LayoutPlan; win: EntryWindow; captions: { start: number; end: number; text: string }[];
  /** fullcam crop keys are timed from this file second (the detection window's start); null = static. */
  cropKeysFrom?: number | null;
};

/** scale(+zoom)+crop of one layer. z = zoom factor expression (t = entry seconds) or null. */
function layer(w: number, h: number, cw: number, ch: number, z: string | null, shift = 0) {
  if (!z) return shift ? `scale=${w}:${h},crop=${cw}:${ch}:x=${Math.round(Math.max(0, Math.min(w - cw, (w - cw) / 2 + w * shift)))}:y=${Math.round((h - ch) / 2)}` : `scale=${w}:${h},crop=${cw}:${ch}`;
  const zw = `2*trunc(${w}*(${z})/2)`, zh = `2*trunc(${h}*(${z})/2)`;
  const x = shift ? `max(0,min(${zw}-${cw},(${zw}-${cw})/2+${zw}*${shift}))` : `(${zw}-${cw})/2`;
  return `scale=w='${zw}':h='${zh}':eval=frame,crop=${cw}:${ch}:x='${x}':y='(${zh}-${ch})/2'`;
}

/** [0:v] -> [L]: the v1.9 layout at 30 fps with the zoom on its zoom layer (same geometry as edit.ts buildStyledFilter). */
export function layoutChain(plan: LayoutPlan, src: { w: number; h: number }, zoom: string | null, cropOffset = 0): string {
  const g: string[] = [`[0:v]fps=${FPS},setpts=PTS-STARTPTS[cv]`];
  const color = "eq=saturation=1.05:contrast=1.03,unsharp=5:5:0.4:5:5:0";
  if (plan.kind === "split") {
    const f = plan.cam, topH = SEAM, botH = H - topH;
    const bot = fitSize(src.w, src.h, W, botH, "cover");
    const camPx = { w: Math.max(2, Math.round(f.w * src.w)), h: Math.max(2, Math.round(f.h * src.h)) };
    const top = fitSize(camPx.w, camPx.h, W, topH, "cover");
    g.push(`[cv]split=2[ca1][cb1]`);
    g.push(`[ca1]crop=${camPx.w}:${camPx.h}:${Math.round(f.x * src.w)}:${Math.round(f.y * src.h)},${layer(top.w, top.h, W, topH, plan.zoomOn === "cam" ? zoom : null)}[top]`);
    g.push(`[cb1]${layer(bot.w, bot.h, W, botH, plan.zoomOn === "game" ? zoom : null, plan.gameShift)}[bot]`);
    g.push(`[top][bot]vstack=inputs=2,setsar=1,${color},drawbox=x=0:y=${topH - 3}:w=${W}:h=6:color=black@0.55:t=fill[L]`);
  } else if (plan.kind === "fullcam") {
    const c = plan.crop;
    const x = cropXExpr(c.keys, (t) => t - cropOffset);
    g.push(`[cv]crop=${c.w}:${c.h}:x='${x}':y=${c.y},${layer(W, H, W, H, zoom)},setsar=1,${color}[L]`);
  } else {
    const fg = fitSize(src.w, src.h, W, H, "contain");
    g.push(`[cv]split=2[ca1][cb1]`);
    g.push(`[ca1]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=${W}:${H},eq=brightness=-0.07[bg]`);
    g.push(`[cb1]${layer(fg.w, fg.h, fg.w, fg.h, zoom)},${color}[fg]`);
    g.push(`[bg][fg]overlay=${(W - fg.w) / 2}:${(H - fg.h) / 2},setsar=1[L]`);
  }
  return g.join(";");
}

const FREEZE = "gblur=sigma=24,eq=brightness=-0.16:saturation=0.8";
const AFMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

/**
 * The filter for one entry run. Inputs: 0 = the source seeked to the entry start, 1 = whoosh (or silence), 2 = silence.
 * Card (title / number) + entry (+ end card for the last one), concatenated; output [v] [a].
 */
export function buildEntryFilter(e: Top5RenderEntry, o: { card: "title" | "number"; end: boolean; ass: { card: string; entry: string; end?: string } }): { filter: string; frames: number } {
  const len = e.win.end - e.win.start;
  const F = Math.round(len * FPS);
  const CF = o.card === "title" ? TITLE_FRAMES : CARD_FRAMES;
  const g: string[] = [];
  const zoom = punchExpr(e.win.payoff - e.win.start, len);
  g.push(layoutChain(e.layout, e.src, zoom, e.cropKeysFrom != null ? e.win.start - e.cropKeysFrom : 0));
  g.push(`[L]trim=end_frame=${F},setpts=PTS-STARTPTS,split=${o.end ? 3 : 2}[e][c]${o.end ? "[x]" : ""}`);
  g.push(`[c]trim=end_frame=1,setpts=PTS-STARTPTS,${FREEZE},tpad=stop_mode=clone:stop=${CF - 1},ass=${o.ass.card},format=yuv420p[cv]`);
  g.push(`[e]ass=${o.ass.entry},format=yuv420p[ev]`);
  if (o.end) g.push(`[x]trim=start_frame=${F - 1}:end_frame=${F},setpts=PTS-STARTPTS,${FREEZE},tpad=stop_mode=clone:stop=${END_FRAMES - 1},ass=${o.ass.end},format=yuv420p[xv]`);
  const sec = (f: number) => (f / FPS).toFixed(6);
  const ain = e.hasAudio ? "[0:a]" : "[2:a]";
  // the moment's own sound, normalised to -14 LUFS like the clips, 30 ms in / 80 ms out so joins never click
  g.push(`${ain}atrim=0:${len.toFixed(6)},asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11,${AFMT},apad,atrim=0:${sec(F)},afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, F / FPS - 0.08).toFixed(3)}:d=0.08[ea]`);
  const whooshAt = o.card === "title" ? 600 : 0;
  g.push(`[1:a]${AFMT},adelay=delays=${whooshAt}:all=1,volume=0.55,apad,atrim=0:${sec(CF)}[ca]`);
  if (o.end) g.push(`[2:a]${AFMT},atrim=0:${sec(END_FRAMES)}[xa]`);
  g.push(`[cv][ca][ev][ea]${o.end ? "[xv][xa]" : ""}concat=n=${o.end ? 3 : 2}:v=1:a=1[v][a]`);
  return { filter: g.join(";"), frames: CF + F + (o.end ? END_FRAMES : 0) };
}

export type Top5RenderResult = { ms: number; entryMs: number[]; duration: number; frames: number };

/**
 * Render the whole Top 5 (entries in countdown order, #5 first) into `final`. `title` = the on-screen title, `channel` = the
 * end card's "Follow @<channel>" and the watermark.
 */
export async function renderTop5(o: { entries: Top5RenderEntry[]; title: string; channel: string; watermark: string | null; workDir: string; final: string }): Promise<Top5RenderResult> {
  const t0 = Date.now();
  fs.mkdirSync(o.workDir, { recursive: true });
  const sfx = await ensureSfx();
  const parts: string[] = [];
  const entryMs: number[] = [];
  let frames = 0;
  try {
    for (let i = 0; i < o.entries.length; i++) {
      const t1 = Date.now();
      const e = o.entries[i], last = i === o.entries.length - 1;
      const names = { card: `card-${i}.ass`, entry: `entry-${i}.ass`, end: `end.ass` };
      fs.writeFileSync(path.join(o.workDir, names.card), i === 0 ? titleAss({ card: o.title, first: e.n, watermark: o.watermark }) : cardAss({ n: e.n, login: e.login, watermark: o.watermark }));
      fs.writeFileSync(path.join(o.workDir, names.entry), entryAss({ n: e.n, login: e.login, captions: e.captions, len: e.win.end - e.win.start, place: e.layout.place, watermark: o.watermark }));
      if (last) fs.writeFileSync(path.join(o.workDir, names.end), endAss({ channel: o.channel }));
      const { filter, frames: f } = buildEntryFilter(e, { card: i === 0 ? "title" : "number", end: last, ass: names });
      const len = e.win.end - e.win.start;
      const out = path.join(o.workDir, `part-${i}.mkv`);
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", e.win.start.toFixed(3), "-t", (len + 0.6).toFixed(3), "-i", path.resolve(e.file)];
      if (sfx) args.push("-i", sfx.whoosh); else args.push("-f", "lavfi", "-t", "2", "-i", "anullsrc=r=48000:cl=stereo");
      args.push("-f", "lavfi", "-t", String(Math.ceil(len + 4)), "-i", "anullsrc=r=48000:cl=stereo");
      args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-frames:v", String(f),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-g", "30", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", out);
      await run("ffmpeg", args, { cwd: o.workDir, timeoutMs: 5 * 60_000 });
      parts.push(out);
      frames += f;
      entryMs.push(Date.now() - t1);
    }
    const part = o.final + ".part.mp4";
    fs.mkdirSync(path.dirname(o.final), { recursive: true });
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const p of parts) args.push("-i", p);
    const K = parts.length;
    args.push("-filter_complex", `${parts.map((_, k) => `[${k}:v][${k}:a]`).join("")}concat=n=${K}:v=1:a=1[cv][ca];[cv]format=yuv420p[v];[ca]alimiter=limit=0.95,${AFMT}[a]`,
      "-map", "[v]", "-map", "[a]", "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-f", "mp4", path.resolve(part));
    try {
      await run("ffmpeg", args, { timeoutMs: 15 * 60_000 });
      fs.renameSync(part, o.final);
    } finally { fs.rmSync(part, { force: true }); }
  } finally {
    for (const p of parts) fs.rmSync(p, { force: true });
  }
  return { ms: Date.now() - t0, entryMs, duration: await probeDuration(o.final), frames };
}
