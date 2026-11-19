// v2.0.0 Edits: render a plan (src/lib/edit-plan.ts) with ffmpeg.
// Step 1, per slice: the v1.9 layout (blur / cam + game / full cam) at 30 fps, then the slice's parts (1x, 0.5x slow-mo,
// freeze) cut to an exact frame count, audio kept in sync (atempo 0.5 in slow-mo) with 10 ms fades at the cut points so
// joins never click. Written as a lossless-ish intermediate (x264 crf 16 + PCM).
// Step 2, one ffmpeg run for the whole edit: concat (or crossfades for Smooth), zoom pulses / punches / drifts + shake as
// one scale+crop driven by the output frame number n, RGB split (chromashift) on drops, the vibe's grade + flashes (eq),
// vignette, title/credit/end text (ASS). Two outputs at once: the edit WITHOUT music (the one to post) and the preview
// with the timing track (or a click) mixed in and a "don't post this one" label.
import fs from "node:fs";
import path from "node:path";
import { buildFilter, chunkWords, probeDuration, run } from "./media";
import { FPS, H, W, buildEditAss, flashExprN, rgbEnable, zoomChainN, type EditPlan, type PlanSlice } from "./edit-plan";
import type { LayoutPlan } from "./layout";

export { chunkWords };

export type RenderSource = { file: string; hasAudio: boolean; layout: LayoutPlan };

const sec = (f: number) => (f / FPS).toFixed(6);

/** The filter_complex for one slice. Input 0 = the source (already seeked to slice.srcIn); input 1 = silence when it has no audio. */
export function buildSliceFilter(slice: PlanSlice, src: { hasAudio: boolean; layout: LayoutPlan }): string {
  const g: string[] = [];
  const lay = buildFilter({ facecam: null, plan: src.layout }).replace(/\[v\]$/, "[lay]");
  g.push(lay);
  const parts = slice.parts;
  const T = parts.reduce((n, p) => n + p.frames, 0);
  const P = parts.length;
  g.push(`[lay]tpad=stop_mode=clone:stop_duration=${(T / FPS + 2).toFixed(3)}${P > 1 ? `,split=${P}${parts.map((_, k) => `[s${k}]`).join("")}` : "[s0]"}`);
  const ain = src.hasAudio ? "[0:a]" : "[1:a]";
  g.push(`${ain}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad${P > 1 ? `,asplit=${P}${parts.map((_, k) => `[t${k}]`).join("")}` : "[t0]"}`);
  let vpos = 0, apos = 0; // source position in frames (30 fps)
  parts.forEach((p, k) => {
    const v0 = Math.round(vpos);
    if (p.speed === 1) {
      g.push(`[s${k}]trim=start_frame=${v0}:end_frame=${v0 + p.frames},setpts=PTS-STARTPTS[p${k}]`);
      g.push(`[t${k}]atrim=start=${sec(apos)}:end=${sec(apos + p.frames)},asetpts=PTS-STARTPTS[q${k}]`);
      vpos += p.frames; apos += p.frames;
    } else if (p.speed === 0.5) {
      const m = Math.ceil(p.frames / 2) + 2;
      g.push(`[s${k}]trim=start_frame=${v0}:end_frame=${v0 + m},setpts=2*(PTS-STARTPTS),framerate=fps=${FPS},tpad=stop_mode=clone:stop=${p.frames},trim=end_frame=${p.frames},setpts=PTS-STARTPTS[p${k}]`);
      g.push(`[t${k}]atrim=start=${sec(apos)}:end=${sec(apos + p.frames / 2)},asetpts=PTS-STARTPTS,atempo=0.5[q${k}]`);
      vpos += p.frames / 2; apos += p.frames / 2;
    } else {
      // freeze on the current frame; the audio keeps playing (the reaction carries on under the freeze)
      g.push(`[s${k}]trim=start_frame=${v0}:end_frame=${v0 + 1},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${p.frames - 1}[p${k}]`);
      g.push(`[t${k}]atrim=start=${sec(apos)}:end=${sec(apos + p.frames)},asetpts=PTS-STARTPTS[q${k}]`);
      apos += p.frames;
    }
  });
  const D = T / FPS;
  if (P > 1) {
    g.push(`${parts.map((_, k) => `[p${k}]`).join("")}concat=n=${P}:v=1:a=0[vv]`);
    g.push(`${parts.map((_, k) => `[q${k}]`).join("")}concat=n=${P}:v=0:a=1[aa]`);
  } else {
    g.push(`[p0]null[vv]`, `[q0]anull[aa]`);
  }
  g.push(`[vv]trim=end_frame=${T},setpts=PTS-STARTPTS,format=yuv420p[v]`);
  g.push(`[aa]apad,atrim=0:${D.toFixed(6)},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=${Math.max(0, D - 0.01).toFixed(6)}:d=0.01[a]`);
  return g.join(";");
}

/** Source seconds the slice needs (with a little slack), for -t. */
const sourceNeed = (s: PlanSlice) => s.parts.reduce((n, p) => n + (p.frames * (p.speed === 0.5 ? 0.5 : 1)) / FPS, 0) + 1;

export async function renderSlice(slice: PlanSlice, src: RenderSource, out: string) {
  const T = slice.parts.reduce((n, p) => n + p.frames, 0);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", slice.srcIn.toFixed(3), "-t", sourceNeed(slice).toFixed(3), "-i", path.resolve(src.file)];
  if (!src.hasAudio) args.push("-f", "lavfi", "-t", String(T / FPS + 3), "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-filter_complex", buildSliceFilter(slice, src), "-map", "[v]", "-map", "[a]", "-frames:v", String(T),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-g", "30", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", path.resolve(out));
  await run("ffmpeg", args, { timeoutMs: 5 * 60_000 });
}

export type BeatAudio = { file: string; offset: number } | null;

/**
 * The whole-edit filter. Inputs 0..K-1 = rendered slices; input K = the timing track / click (beat preview audio).
 * Outputs [vfin] (+ [afin] when there is creator audio in the final) and [vbeat] + [abeat].
 */
export function buildEditFilter(plan: EditPlan, o: { assFile: string; labelAssFile: string; finalAudio: boolean; creatorInPreview: boolean }) {
  const K = plan.slices.length;
  const g: string[] = [];
  const d = plan.transition.frames;
  if (plan.transition.kind === "xfade" && K > 1) {
    let v = "[0:v]", a = "[0:a]";
    for (let k = 1; k < K; k++) {
      const off = (plan.slices[k].f0 - d / 2) / FPS;
      const kind = k % 2 ? "fade" : "smoothleft";
      g.push(`${v}[${k}:v]xfade=transition=${kind}:duration=${(d / FPS).toFixed(4)}:offset=${off.toFixed(4)}[xv${k}]`);
      g.push(`${a}[${k}:a]acrossfade=d=${(d / FPS).toFixed(4)}:c1=tri:c2=tri[xa${k}]`);
      v = `[xv${k}]`; a = `[xa${k}]`;
    }
    g.push(`${v}trim=end_frame=${plan.frames},setpts=PTS-STARTPTS[vc]`);
    g.push(`${a}anull[ac]`);
  } else {
    g.push(`${plan.slices.map((_, k) => `[${k}:v][${k}:a]`).join("")}concat=n=${K}:v=1:a=1[vc0][ac]`);
    g.push(`[vc0]trim=end_frame=${plan.frames},setpts=PTS-STARTPTS[vc]`);
  }
  const gr = plan.grade;
  const chain = [
    zoomChainN(plan),
    ...(plan.fx.rgb.length ? [`chromashift=cbh=-10:crh=10:edge=smear:enable='${rgbEnable(plan.fx)}'`] : []),
    `eq=contrast=${gr.contrast}:saturation=${gr.saturation}:gamma=${gr.gamma}:brightness='${flashExprN(plan.fx, gr.brightness)}':eval=frame`,
    ...(gr.vignette ? [`vignette=angle=${gr.vignette}`] : []),
    `ass=${o.assFile}`, "format=yuv420p", "split=2[vfin][vb0]",
  ].filter((x) => x !== "null");
  g.push(`[vc]${chain.join(",")}`);
  g.push(`[vb0]ass=${o.labelAssFile}[vbeat]`);
  // creator audio: loudness down to -18 LUFS (sits under the sound added in TikTok); clipedit ducks it after the drop
  const D = plan.duration.toFixed(6);
  let creator = `[ac]loudnorm=I=-18:TP=-2:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D}`;
  if (plan.audio.duckFrom != null) {
    const A = (plan.audio.duckFrom + plan.audio.stabFrames) / FPS, k = plan.audio.duckTo;
    creator += `,volume='if(lt(t,${A.toFixed(3)}),1,if(lt(t,${(A + 0.08).toFixed(3)}),1-${(1 - k).toFixed(3)}*(t-${A.toFixed(3)})/0.08,${k}))':eval=frame`;
  }
  g.push(`${creator},asplit=2[cr1][cr2]`);
  if (o.finalAudio) g.push(`[cr1]anull[afin]`); else g.push(`[cr1]anullsink`);
  g.push(`[${K}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},volume=0.9[song]`);
  if (o.creatorInPreview) g.push(`[cr2]volume=0.6[cr3]`, `[song][cr3]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[abeat]`);
  else g.push(`[cr2]anullsink`, `[song]alimiter=limit=0.95[abeat]`);
  return g.join(";");
}

export type RenderResult = { ms: number; sliceMs: number; duration: number; frames: number };

/**
 * Render the plan: every slice, then the final + beat preview in one ffmpeg run. `beat` = the timing track (song + where the
 * edit starts in it) or a click WAV (offset 0). Files are written to `.part` names and moved into place at the end.
 */
export async function renderEdit(o: {
  plan: EditPlan; sources: RenderSource[]; credit: string; workDir: string; final: string; beatPreview: string; watermark?: string | null;
  beat: { file: string; offset: number }; creatorAudio: boolean;
}): Promise<RenderResult> {
  const t0 = Date.now();
  fs.mkdirSync(o.workDir, { recursive: true });
  const files: string[] = [];
  for (const s of o.plan.slices) {
    const f = path.join(o.workDir, `slice-${s.i}.mkv`);
    await renderSlice(s, o.sources[s.src], f);
    files.push(f);
  }
  const sliceMs = Date.now() - t0;
  fs.writeFileSync(path.join(o.workDir, "edit.ass"), buildEditAss(o.plan, { credit: o.credit, watermark: o.watermark }));
  fs.writeFileSync(path.join(o.workDir, "label.ass"), buildEditAss({ ...o.plan, title: { ...o.plan.title, text: "" }, end: null, captions: [] }, { credit: "", previewLabel: true }));
  const finalAudio = o.creatorAudio || o.plan.format === "clipedit"; // a clip -> edit always keeps the clip part's sound
  const filter = buildEditFilter(o.plan, { assFile: "edit.ass", labelAssFile: "label.ass", finalAudio, creatorInPreview: finalAudio });
  const partFinal = o.final + ".part.mp4", partBeat = o.beatPreview + ".part.mp4";
  fs.mkdirSync(path.dirname(o.final), { recursive: true });
  fs.mkdirSync(path.dirname(o.beatPreview), { recursive: true });
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const f of files) args.push("-i", path.basename(f));
  args.push(...(o.beat.offset > 0 ? ["-ss", o.beat.offset.toFixed(3)] : []), "-t", (o.plan.duration + 1).toFixed(3), "-i", path.resolve(o.beat.file));
  args.push("-filter_complex", filter);
  args.push("-map", "[vfin]", ...(finalAudio ? ["-map", "[afin]"] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(finalAudio ? ["-c:a", "aac", "-b:a", "160k", "-ar", "48000"] : []), "-movflags", "+faststart", "-f", "mp4", path.resolve(partFinal));
  args.push("-map", "[vbeat]", "-map", "[abeat]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", "-f", "mp4", path.resolve(partBeat));
  try {
    await run("ffmpeg", args, { cwd: o.workDir, timeoutMs: 15 * 60_000 });
    fs.renameSync(partFinal, o.final);
    fs.renameSync(partBeat, o.beatPreview);
  } finally {
    fs.rmSync(partFinal, { force: true });
    fs.rmSync(partBeat, { force: true });
    for (const f of files) fs.rmSync(f, { force: true });
  }
  return { ms: Date.now() - t0, sliceMs, duration: await probeDuration(o.final), frames: o.plan.frames };
}

export { W, H };
