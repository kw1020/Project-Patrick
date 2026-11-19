// Styled editing (v1.7.3): word-by-word captions, jump cuts, zooms, animated hook, sound effects, progress bar.
// Everything that decides WHAT the edit looks like is a pure function (tested in test/edit.test.ts);
// renderStyled() runs ONE ffmpeg render (one filter_complex) plus one cheap loudness pass.
import fs from "node:fs";
import path from "node:path";
import { run, type Facecam, type Word } from "./media";
import { storagePath } from "./paths";
import { type EditStyle, type JumpCutMode } from "./edit-styles";
import { FRAME, findPayoff, meanDb } from "./window";
import { TEXT_MAX_W, TEXT_SAFE, TEXT_X, fitScale } from "./platform-rules";
import { SEAM, cropXExpr, legacyPlan, overlayPlace, watermarkPlace, watermarkStyle, watermarkText, type LayoutPlan, type OverlayPlace } from "./layout";

export { type EditStyle, type JumpCutMode, EDIT_STYLES, JUMP_CUT_MODES, parseEditStyle, parseJumpCuts, DEFAULT_EDIT_STYLE } from "./edit-styles";

const W = 1080, H = 1920, FPS = 30;

/** ASS colours are &HAABBGGRR. */
type StyleSpec = {
  jumpCuts: boolean;
  altZoom: number; // extra zoom on every other jump-cut segment (0.08 = 108%)
  punch: number; // punch-in amount on the peak (0.15 = 115%), 0 = none
  sfx: boolean;
  eq: { saturation: number; contrast: number };
  bar: string; // ffmpeg colour of the progress bar
  cap: { size: number; upper: boolean; outline: number; shadow: number; active: string | null; activeScale: number; pop: boolean; tilt: boolean; maxChars: number };
  hook: { anim: "pop" | "fade"; size: number; text: string; box: string };
};

export const STYLES: Record<EditStyle, StyleSpec> = {
  hype: {
    jumpCuts: true, altZoom: 0.08, punch: 0.15, sfx: true, eq: { saturation: 1.15, contrast: 1.06 }, bar: "0xff3d81",
    cap: { size: 88, upper: true, outline: 8, shadow: 4, active: "&H0035E1FF", activeScale: 100, pop: true, tilt: false, maxChars: 18 },
    hook: { anim: "pop", size: 62, text: "&H00FFFFFF", box: "&H00813DFF" },
  },
  clean: {
    jumpCuts: true, altZoom: 0, punch: 0, sfx: false, eq: { saturation: 1.05, contrast: 1.03 }, bar: "white@0.6",
    cap: { size: 78, upper: false, outline: 6, shadow: 2, active: null, activeScale: 112, pop: false, tilt: false, maxChars: 18 },
    hook: { anim: "fade", size: 56, text: "&H00FFFFFF", box: "&H38000000" },
  },
  meme: {
    jumpCuts: true, altZoom: 0.08, punch: 0.25, sfx: true, eq: { saturation: 1.3, contrast: 1.1 }, bar: "0xffe135",
    cap: { size: 100, upper: true, outline: 9, shadow: 4, active: "&H0014FF39", activeScale: 100, pop: true, tilt: true, maxChars: 14 },
    hook: { anim: "pop", size: 72, text: "&H00000000", box: "&H0035E1FF" },
  },
};

export type Seg = { start: number; end: number };
const snap = (t: number) => Math.round(t * FPS) / FPS; // cut on frame boundaries so audio and video stay in sync
const r3 = (t: number) => Math.round(t * 1000) / 1000;

// ---------- Jump cuts ----------
/**
 * v1.8.0 (Krew: "it's randomly cutting when he's talking"): Whisper misses words under game audio, music and crosstalk,
 * so a "gap" between words is often real sound. Jump cuts now only remove gaps whose AUDIO is quiet, and far fewer.
 * light (default): gaps >= 1.2s, 0.35s kept each side, <= 15% of the window, <= 4 cuts, none within 1s of the payoff.
 * normal: gaps >= 0.8s, 0.25s each side, <= 25%, <= 6 cuts. off: none.
 */
export const JUMP_PRESETS: Record<Exclude<JumpCutMode, "off">, { maxGap: number; pad: number; maxShare: number; maxCuts: number }> = {
  light: { maxGap: 1.2, pad: 0.35, maxShare: 0.15, maxCuts: 4 },
  normal: { maxGap: 0.8, pad: 0.25, maxShare: 0.25, maxCuts: 6 },
};

/** Real silence is at least this far under the speech level, and never louder than SILENCE_MAX_DB. */
export const SILENCE_BELOW_SPEECH_DB = 20;
export const SILENCE_MAX_DB = -45;

/**
 * The level (dB) below which a 100ms frame counts as silence: 20 dB under the speech level (frames inside words), and never
 * above -45 dBFS. Game audio / music beds on Twitch sit around -40..-20 dBFS, so they never count as silence (v1.8.0 review:
 * the earlier -35 cap let quiet game beds be cut). Null when there's nothing to measure.
 */
export function silenceThreshold(levels: number[], words: Word[], frame = FRAME): number | null {
  if (!levels.length) return null;
  const speech = words.flatMap((w) => levels.slice(Math.max(0, Math.floor(w.start / frame)), Math.ceil(w.end / frame))).filter((v) => Number.isFinite(v));
  const pool = (speech.length >= 3 ? speech : levels.filter((v) => Number.isFinite(v))).sort((a, b) => a - b);
  if (!pool.length) return SILENCE_MAX_DB; // nothing but pure silence
  const level = pool[Math.floor(pool.length * (speech.length >= 3 ? 0.5 : 0.75))];
  return Math.min(SILENCE_MAX_DB, level - SILENCE_BELOW_SPEECH_DB);
}

/** Runs of quiet frames (every frame under `threshold`) inside [start, end], in seconds. Frames we don't have = not quiet. */
export function quietRuns(levels: number[], start: number, end: number, threshold: number, frame = FRAME): Seg[] {
  const a = Math.max(0, Math.floor(start / frame + 1e-6)), b = Math.min(levels.length, Math.ceil(end / frame - 1e-6));
  const out: Seg[] = [];
  let rs = -1;
  for (let i = a; i <= b; i++) {
    const q = i < b && levels[i] < threshold;
    if (q && rs < 0) rs = i;
    if (!q && rs >= 0) { out.push({ start: Math.max(start, rs * frame), end: Math.min(end, i * frame) }); rs = -1; }
  }
  return out;
}

/** True when every 100ms frame of [start, end] is under the threshold (frames we don't have = not quiet). */
export function isQuiet(levels: number[], start: number, end: number, threshold: number, frame = FRAME) {
  const a = Math.max(0, Math.floor(start / frame + 1e-6)), b = Math.ceil(end / frame - 1e-6);
  if (b <= a || b > levels.length) return false;
  for (let i = a; i < b; i++) if (!(levels[i] < threshold)) return false;
  return true;
}

/**
 * Which parts of the window to keep. Removes gaps between words longer than `maxGap` (keeping `pad` either side),
 * biggest first, never below `minSec`, never across `protect` (the payoff / punch-in), at most `maxCuts` and `maxShare`
 * of the window. With `levels` (100ms loudness of the window) a gap is only cut when its audio is really quiet.
 * Fewer than `minWords` words = no cuts. Times are seconds inside the window [0, length].
 */
export function planJumpCuts(opts: { words: Word[]; length: number; minSec: number; protect?: Seg | null; maxGap?: number; pad?: number; minWords?: number; maxCuts?: number; maxShare?: number; levels?: number[]; quietDb?: number | null }): Seg[] {
  const { length, minSec } = opts;
  const maxGap = opts.maxGap ?? 0.6, pad = opts.pad ?? 0.15, minWords = opts.minWords ?? 6, maxCuts = opts.maxCuts ?? 16;
  const maxRemove = (opts.maxShare ?? 1) * length;
  const threshold = opts.levels ? (opts.quietDb ?? silenceThreshold(opts.levels, opts.words)) : null;
  const whole = [{ start: 0, end: snap(length) }];
  const words = opts.words.filter((w) => w.word.trim() && w.start < length && w.end > 0).sort((a, b) => a.start - b.start);
  if (words.length < minWords || length <= minSec) return whole;
  const gaps: Seg[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i].end, b = words[i + 1].start;
    if (b - a <= maxGap) continue;
    const cands: Seg[] = [];
    if (opts.levels) {
      // Loudness known: only the truly silent part of the gap (>= maxGap of it) is cut; game sound, music or
      // untranscribed talk in the rest of the gap stays. 0.35s/0.25s (pad) is kept next to the words either way.
      if (threshold == null) continue;
      for (const q of quietRuns(opts.levels, a, Math.min(b, length), threshold)) {
        if (q.end - q.start < maxGap - 1e-6) continue;
        cands.push({ start: snap(Math.max(q.start + 0.05, a + pad)), end: snap(Math.min(q.end - 0.05, Math.min(b, length) - pad)) });
      }
    } else cands.push({ start: snap(a + pad), end: snap(Math.min(b, length) - pad) });
    for (const g of cands) {
      if (g.end - g.start < 0.1) continue;
      if (opts.protect && g.start < opts.protect.end && g.end > opts.protect.start) continue;
      gaps.push(g);
    }
  }
  gaps.sort((x, y) => (y.end - y.start) - (x.end - x.start));
  let total = snap(length), removed = 0;
  const cut: Seg[] = [];
  for (const g of gaps) {
    if (cut.length >= maxCuts) break;
    const len = g.end - g.start;
    if (total - len < minSec) continue; // would go under the minimum: keep this one
    if (removed + len > maxRemove + 1e-6) continue; // over the share cap: keep this one
    cut.push(g);
    total -= len;
    removed += len;
  }
  if (!cut.length) return whole;
  cut.sort((x, y) => x.start - y.start);
  const segs: Seg[] = [];
  let at = 0;
  for (const g of cut) { segs.push({ start: r3(at), end: r3(g.start) }); at = g.end; }
  segs.push({ start: r3(at), end: r3(snap(length)) });
  return segs.filter((s) => s.end - s.start > 0.05);
}

export const segsDuration = (segs: Seg[]) => r3(segs.reduce((n, s) => n + (s.end - s.start), 0));

/** Window time → edited time. A time inside a removed gap lands on the start of the next kept part. */
export function remapTime(t: number, segs: Seg[]) {
  let off = 0;
  for (const s of segs) {
    if (t < s.start) return r3(off);
    if (t <= s.end) return r3(off + (t - s.start));
    off += s.end - s.start;
  }
  return r3(off);
}

export function remapWords(words: Word[], segs: Seg[]): Word[] {
  const end = segs.length ? segs[segs.length - 1].end : 0;
  return words.filter((w) => w.word.trim() && w.start < end).map((w) => ({ word: w.word, start: remapTime(w.start, segs), end: remapTime(Math.min(w.end, end), segs) }));
}

/** Where each new part starts on the edited timeline (for the alternating zoom). */
export function cutPoints(segs: Seg[]) {
  const pts: number[] = [];
  let off = 0;
  for (let i = 0; i < segs.length - 1; i++) { off += segs[i].end - segs[i].start; pts.push(r3(off)); }
  return pts;
}

// ---------- Peak (punch-in) ----------
/** Parse `astats … ametadata=print` output: one RMS level (dB) per 1-second frame. */
export function parseLoudness(out: string): number[] {
  const levels: number[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/RMS_level=(-?inf|-?[\d.]+)/);
    if (m) levels.push(m[1].endsWith("inf") ? -Infinity : parseFloat(m[1]));
  }
  return levels;
}

/** Index of the loudest second, or null when it's all near-silent. */
export function loudestSecond(levels: number[]): number | null {
  let best = -1, val = -Infinity;
  levels.forEach((v, i) => { if (v > val) { val = v; best = i; } });
  return best >= 0 && val > -50 ? best : null;
}

/**
 * The peak moment inside the window (window seconds). Chat spikes: the moment itself (already placed back by the reaction
 * lag; the VOD section starts 30s before it). Everything else: the loudest second.
 */
export function pickPeak(opts: { source: string; vodOffset: number | null; vodId?: string | null; winStart: number; length: number; levels: number[] }): number | null {
  if (opts.source === "chat" && opts.vodId && opts.vodOffset != null) {
    const t = Math.min(30, opts.vodOffset) - opts.winStart;
    if (t > 0.5 && t < opts.length - 1) return r3(t);
  }
  const i = loudestSecond(opts.levels);
  if (i == null) return null;
  return r3(Math.min(opts.length - 1, i + 0.2));
}

/**
 * The punch-in moment when Clip.payoffAt doesn't fall inside the window (older clips, or the Judge moved the window off it):
 * a chat spike's known moment, else the same loudness-jump + reaction-word search the window uses (findPayoff), else the
 * loudest second.
 */
export function windowPeak(o: { peakHint?: { source: string; vodOffset: number | null; vodId?: string | null } | null; start: number; length: number; fine: number[]; levels: number[]; words: Word[] }): number | null {
  const source = o.peakHint?.source ?? "";
  if (source === "chat") {
    const p = pickPeak({ source, vodOffset: o.peakHint?.vodOffset ?? null, vodId: o.peakHint?.vodId, winStart: o.start, length: o.length, levels: o.levels });
    if (p != null) return p;
  }
  if (o.fine.length || o.words.length) {
    const p = findPayoff({ source: "window", duration: o.length, levels: o.fine, words: o.words, range: { from: 0.5, to: o.length } });
    if (!p.why.startsWith("no clear")) return r3(p.at);
  }
  return pickPeak({ source: "", vodOffset: null, winStart: o.start, length: o.length, levels: o.levels });
}

/** Punch-in timing on the edited timeline: 0.25s in (fully in at the peak), 1.2s hold, 0.25s out. */
export function punchAt(peak: number | null, duration: number): number | null {
  if (peak == null || duration < 4) return null;
  const start = peak - 0.25;
  return r3(Math.max(0.3, Math.min(start, duration - 2)));
}
export const PUNCH_LEN = 1.7;

/** ffmpeg expression for the zoom factor at time t (null = no zoom at all). */
export function zoomExpr(opts: { cuts: number[]; alt: number; punchStart: number | null; punch: number }): string | null {
  const parts: string[] = [];
  if (opts.alt > 0 && opts.cuts.length) parts.push(`(1+${opts.alt}*mod(${opts.cuts.slice(0, 24).map((c) => `gte(t,${c})`).join("+")},2))`);
  if (opts.punch > 0 && opts.punchStart != null) {
    const a = opts.punchStart, b = r3(a + PUNCH_LEN);
    const u = `clip(min((t-${a})/0.25,(${b}-t)/0.25),0,1)`;
    parts.push(`(1+${opts.punch}*${u}*${u}*(3-2*${u}))`); // smoothstep: eases in and out, no jerk
  }
  return parts.length ? parts.join("*") : null;
}

// ---------- ASS (captions, hook, credit) ----------
function assTime(t: number) {
  t = Math.max(0, t);
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = (cs % 6000) / 100;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
const esc = (s: string) => s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();

/** Chunks of ≤3 words that keep their words (for the active-word highlight). */
export function chunkWordsDetailed(words: Word[], maxWords = 3, maxChars = 18) {
  const chunks: { start: number; end: number; words: Word[] }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) chunks.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur }); cur = []; };
  for (const w of words) {
    const t = esc(w.word);
    if (!t) continue;
    const len = cur.map((x) => esc(x.word)).join(" ").length + t.length + 1;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length >= maxWords || len > maxChars || gap > 0.6) flush();
    cur.push(w);
    if (/[.!?]$/.test(t)) flush();
  }
  flush();
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    chunks[i].end = next ? Math.min(next.start, chunks[i].end + 0.4) : chunks[i].end + 0.4;
  }
  return chunks;
}

/** Break a long hook into two even lines up front, so it doesn't re-wrap while it pops in. */
export function splitHook(text: string, maxLine = 24) {
  if (text.length <= maxLine) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? text : `${text.slice(0, best)}\\N${text.slice(best + 1)}`;
}

/** Caption block centre: 62% of the frame height, clear of the hook (top) and the progress bar (bottom). */
export const CAPTION_Y = Math.round(H * 0.62);

export function buildStyledAss(opts: { words: Word[]; credit: string; duration: number; layout: "blur" | "facecam" | "split" | "fullcam"; hook?: string | null; style: EditStyle; font?: string; place?: OverlayPlace | null; watermark?: string | null; captionStyle?: EditStyle | null }) {
  const S = STYLES[opts.style], font = opts.font || process.env.CAPTION_FONT || "DejaVu Sans";
  // v2.0.6: a channel can have its own caption look (another style's captions); everything else follows the editing style.
  const C = STYLES[opts.captionStyle ?? opts.style].cap;
  const D = opts.duration;
  // v1.9.0: where text goes depends on the layout and where the face is (src/lib/layout.ts overlayPlace).
  const P = opts.place ?? overlayPlace(opts.layout, null);
  const hookY = P.hookY, capY = P.capY;
  // v1.9.8: every text line is centred on TEXT_X and shrunk to fit TEXT_MAX_W, so nothing sits under an app's buttons.
  const credit = esc(opts.credit), creditK = fitScale(credit, 42, TEXT_MAX_W, { outline: 4 });
  const creditTag = `{\\an${P.creditAlign}\\pos(${TEXT_X},${P.creditY})${creditK < 1 ? `\\fscx${Math.round(creditK * 100)}\\fscy${Math.round(creditK * 100)}` : ""}}`;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${font},${C.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,1,0,1,${C.outline},${C.shadow},5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    // Credit: always on, top centre, drawn last (above zooms, never scaled).
    `Style: Credit,${font},42,&H10FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,4,2,8,40,40,110,1`,
    `Style: Hook,${font},${S.hook.size},${S.hook.text},&H00FFFFFF,${S.hook.box},${S.hook.box},-1,0,0,0,100,100,0,0,3,16,0,8,${TEXT_SAFE.left + 16},${TEXT_SAFE.right + 16},${hookY},1`,
    watermarkStyle(font),
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 3,${assTime(0)},${assTime(D)},Credit,,0,0,0,,${creditTag}${credit}`,
  ];
  // v1.9.1: "@ViceCityClips" bottom right (Settings watermark), clear of the credit and captions; drawn after the zoom.
  const mark = watermarkText(opts.watermark), wm = watermarkPlace(P);
  if (mark && wm.start < D) lines.push(`Dialogue: 3,${assTime(wm.start)},${assTime(D)},Mark,,0,0,0,,${wm.tag}${mark}`);
  let hook = esc(opts.hook || "").slice(0, 70);
  if (hook) {
    if (opts.style === "meme") hook = hook.toUpperCase();
    hook = splitHook(hook);
    const end = Math.min(3.3, D);
    const an = P.hookAlign, orgY = an === 2 ? hookY - 40 : hookY + 40;
    const longest = hook.split("\\N").reduce((a, b) => (b.length > a.length ? b : a), "");
    const hk = fitScale(longest, S.hook.size, TEXT_MAX_W - 32), hs = (n: number) => Math.round(n * hk);
    const tags = S.hook.anim === "pop"
      // 0 → 110% → 100% in 200ms, one small wiggle, fade out.
      ? `\\an${an}\\pos(${TEXT_X},${hookY})\\org(${TEXT_X},${orgY})\\fscx0\\fscy0\\t(0,130,\\fscx${hs(110)}\\fscy${hs(110)})\\t(130,200,\\fscx${hs(100)}\\fscy${hs(100)})\\t(200,300,\\frz2)\\t(300,420,\\frz-2)\\t(420,500,\\frz0)\\fad(0,300)`
      : `\\an${an}\\pos(${TEXT_X},${hookY})${hk < 1 ? `\\fscx${hs(100)}\\fscy${hs(100)}` : ""}\\fad(300,300)`;
    lines.push(`Dialogue: 2,${assTime(0)},${assTime(end)},Hook,,0,0,0,,{${tags}}${hook}`);
  }
  const chunks = chunkWordsDetailed(opts.words, 3, C.maxChars);
  chunks.forEach((c, ci) => {
    if (c.start >= D) return;
    const tokens = c.words.map((w) => (C.upper ? esc(w.word).toUpperCase() : esc(w.word)));
    const tilt = C.tilt ? ((ci * 7 + 3) % 7) - 3 || 2 : 0; // -3..3°, never flat, same every render
    const grow = C.active ? 1 : C.activeScale / 100;
    const k = fitScale(tokens.join(" "), C.size * grow, TEXT_MAX_W, { spacing: 1, outline: C.outline }), sc = (n: number) => Math.round(n * k);
    const base = `\\an5\\pos(${TEXT_X},${capY})${tilt ? `\\frz${tilt}` : ""}${k < 1 ? `\\fscx${sc(100)}\\fscy${sc(100)}` : ""}`;
    c.words.forEach((w, wi) => {
      const s = wi === 0 ? c.start : w.start;
      const e = wi + 1 < c.words.length ? c.words[wi + 1].start : c.end;
      if (e - s < 0.02 || s >= D) return;
      const text = tokens.map((t, ti) => {
        if (ti !== wi) return t;
        if (C.active) return `{\\1c${C.active}&}${t}{\\1c&H00FFFFFF&}`;
        return `{\\fscx${sc(C.activeScale)}\\fscy${sc(C.activeScale)}}${t}{\\fscx${sc(100)}\\fscy${sc(100)}}`;
      }).join(" ");
      let anim = "";
      if (wi === 0) anim = C.pop ? `\\fscx${sc(80)}\\fscy${sc(80)}\\t(0,60,\\fscx${sc(105)}\\fscy${sc(105)})\\t(60,120,\\fscx${sc(100)}\\fscy${sc(100)})` : "\\fad(80,0)";
      lines.push(`Dialogue: 1,${assTime(s)},${assTime(Math.min(e, D))},Cap,,0,0,0,,{${base}${anim}}${text}`);
    });
  });
  return lines.join("\n") + "\n";
}

// ---------- Filtergraph ----------
const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
/** Size of the source scaled to fit inside (contain) or fill (cover) a box. */
export function fitSize(sw: number, sh: number, bw: number, bh: number, mode: "contain" | "cover") {
  const k = mode === "contain" ? Math.min(bw / sw, bh / sh) : Math.max(bw / sw, bh / sh);
  return { w: even(sw * k), h: even(sh * k) };
}

/** Scale to (w,h)×zoom and crop the centre back to (cw,ch). With no zoom: plain scale + crop. */
function zoomChain(w: number, h: number, cw: number, ch: number, z: string | null, shift = 0) {
  // shift = move the crop centre sideways by this share of the scaled width (split: keep the webcam out of the game part).
  if (!z) return shift ? `scale=${w}:${h},crop=${cw}:${ch}:x=${Math.round(Math.max(0, Math.min(w - cw, (w - cw) / 2 + w * shift)))}:y=${Math.round((h - ch) / 2)}` : `scale=${w}:${h},crop=${cw}:${ch}`;
  const zw = `2*trunc(${w}*(${z})/2)`, zh = `2*trunc(${h}*(${z})/2)`;
  // scale eval=frame changes the frame size per frame; crop's x/y must use the same numbers (its in_w is the first frame's).
  const x = shift ? `max(0,min(${zw}-${cw},(${zw}-${cw})/2+${zw}*${shift}))` : `(${zw}-${cw})/2`;
  return `scale=w='${zw}':h='${zh}':eval=frame,crop=${cw}:${ch}:x='${x}':y='(${zh}-${ch})/2'`;
}

export type StyledFilterOpts = {
  style: EditStyle; facecam: Facecam | null; src: { w: number; h: number }; segs: Seg[]; hasAudio: boolean;
  /** v1.9.0 layout (wins over `facecam`, which is the pre-1.9 way to ask for the split layout). */
  plan?: LayoutPlan | null;
  assFile?: string | null; zoom: string | null; duration: number; sfx?: { whooshAt?: number | null; boomAt?: number | null } | null;
};

/** The one filter_complex for a styled render. Inputs: 0 = source; then whoosh, boom (only those used). Outputs [v] and [a]. */
export function buildStyledFilter(o: StyledFilterOpts) {
  const S = STYLES[o.style];
  const g: string[] = [];
  const multi = o.segs.length > 1;
  // 1) Jump cuts: trim + concat (video and audio together, so they stay in sync).
  if (multi) {
    const n = o.segs.length;
    g.push(`[0:v]fps=${FPS},split=${n}${o.segs.map((_, i) => `[sv${i}]`).join("")}`);
    if (o.hasAudio) g.push(`[0:a]asplit=${n}${o.segs.map((_, i) => `[sa${i}]`).join("")}`);
    o.segs.forEach((s, i) => {
      g.push(`[sv${i}]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
      if (o.hasAudio) g.push(`[sa${i}]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
    });
    g.push(`${o.segs.map((_, i) => `[v${i}]${o.hasAudio ? `[a${i}]` : ""}`).join("")}concat=n=${n}:v=1:a=${o.hasAudio ? 1 : 0}[cv]${o.hasAudio ? "[ca]" : ""}`);
  } else {
    g.push(`[0:v]fps=${FPS}[cv]`);
    if (o.hasAudio) g.push(`[0:a]anull[ca]`);
  }
  // 2) 9:16 layout. The zoom goes on one layer (layout.ts planLayout): blur = the gameplay (the blurred fill stays still),
  // split = the cam for funny clips / the game otherwise, fullcam = the whole frame.
  const color = `eq=saturation=${S.eq.saturation}:contrast=${S.eq.contrast},unsharp=5:5:0.5:5:5:0`;
  const plan = o.plan ?? legacyPlan(o.facecam, o.src);
  if (plan.kind === "split") {
    const f = plan.cam, topH = SEAM, botH = H - topH;
    const bot = fitSize(o.src.w, o.src.h, W, botH, "cover");
    const camPx = { w: Math.max(2, Math.round(f.w * o.src.w)), h: Math.max(2, Math.round(f.h * o.src.h)) };
    const top = fitSize(camPx.w, camPx.h, W, topH, "cover");
    g.push(`[cv]split=2[ca1][cb1]`);
    g.push(`[ca1]crop=${camPx.w}:${camPx.h}:${Math.round(f.x * o.src.w)}:${Math.round(f.y * o.src.h)},${zoomChain(top.w, top.h, W, topH, plan.zoomOn === "cam" ? o.zoom : null)}[top]`);
    g.push(`[cb1]${zoomChain(bot.w, bot.h, W, botH, plan.zoomOn === "game" ? o.zoom : null, plan.gameShift)}[bot]`);
    // A thin dark seam line between cam and game.
    g.push(`[top][bot]vstack=inputs=2,setsar=1,${color},drawbox=x=0:y=${topH - 3}:w=${W}:h=6:color=black@0.55:t=fill[v0]`);
  } else if (plan.kind === "fullcam") {
    const c = plan.crop;
    const x = cropXExpr(c.keys, (t) => remapTime(t, o.segs));
    g.push(`[cv]crop=${c.w}:${c.h}:x='${x}':y=${c.y},${zoomChain(W, H, W, H, o.zoom)},setsar=1,${color}[v0]`);
  } else {
    const fg = fitSize(o.src.w, o.src.h, W, H, "contain");
    g.push(`[cv]split=2[ca1][cb1]`);
    g.push(`[ca1]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=${W}:${H},eq=brightness=-0.07[bg]`);
    g.push(`[cb1]${zoomChain(fg.w, fg.h, fg.w, fg.h, o.zoom)},${color}[fg]`);
    g.push(`[bg][fg]overlay=${(W - fg.w) / 2}:${(H - fg.h) / 2},setsar=1[v0]`);
  }
  // 3) Captions/hook/credit (drawn after the zoom so they never move), then the progress bar.
  const D = Math.max(0.1, o.duration);
  // drawbox can't animate its width in ffmpeg 6, so an 8px bar slides in from the left (overlay x is evaluated per frame).
  g.push(`color=c=${S.bar}:s=${W}x8:r=${FPS},format=yuva420p[bar]`);
  g.push(`[v0]${o.assFile ? `ass=${o.assFile},` : ""}drawbox=x=0:y=${H - 8}:w=${W}:h=8:color=black@0.35:t=fill[v1]`);
  g.push(`[v1][bar]overlay=x='-${W}+${W}*t/${D}':y=${H - 8}:shortest=1[v]`);
  // 4) Audio: loudness to -14 LUFS, then the sound effects underneath.
  if (o.hasAudio) {
    g.push(`[ca]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[an]`);
    const fx: string[] = [];
    let input = 1;
    if (o.sfx?.whooshAt != null) { g.push(`[${input++}:a]adelay=delays=${Math.round(o.sfx.whooshAt * 1000)}:all=1,volume=0.35[fx0]`); fx.push("[fx0]"); }
    if (o.sfx?.boomAt != null) { g.push(`[${input++}:a]adelay=delays=${Math.round(o.sfx.boomAt * 1000)}:all=1,volume=0.6[fx1]`); fx.push("[fx1]"); }
    if (fx.length) g.push(`[an]${fx.join("")}amix=inputs=${fx.length + 1}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.97[a]`);
    else g.push(`[an]anull[a]`);
  }
  return g.join(";");
}

// ---------- Sound effects (made with ffmpeg, no downloaded or copyrighted sounds) ----------
export const SFX_ARGS: Record<"whoosh" | "boom", string[]> = {
  // Filtered noise swell whose low-pass opens up over 0.35s = a "whoosh".
  whoosh: ["-f", "lavfi", "-i", "aevalsrc=exprs='(random(0)*2-1)*sin(PI*t/0.35)*sin(PI*t/0.35)':s=48000:d=0.35",
    "-af", "highpass=f=250,asendcmd=c='0.05 lowpass f 900;0.10 lowpass f 1600;0.15 lowpass f 2800;0.20 lowpass f 4500;0.25 lowpass f 7000',lowpass=f=500,volume=1.6,aformat=sample_rates=48000:channel_layouts=stereo"],
  // 130→55 Hz sine drop with a fast decay plus a little noise = a deep "boom".
  boom: ["-f", "lavfi", "-i", "aevalsrc=exprs='0.9*sin(2*PI*(55*t+3*(1-exp(-25*t))))*exp(-6*t)+0.25*(random(0)*2-1)*exp(-30*t)':s=48000:d=0.6",
    "-af", "lowpass=f=1200,afade=t=out:st=0.45:d=0.15,aformat=sample_rates=48000:channel_layouts=stereo"],
};

/** Make the SFX once and cache them in STORAGE_DIR/sfx. Returns null if they can't be made (the edit goes on without). */
export async function ensureSfx(): Promise<{ whoosh: string; boom: string } | null> {
  try {
    const dir = storagePath("sfx");
    fs.mkdirSync(dir, { recursive: true });
    const out = { whoosh: path.join(dir, "whoosh-v1.wav"), boom: path.join(dir, "boom-v1.wav") };
    for (const k of ["whoosh", "boom"] as const) {
      if (fs.existsSync(out[k]) && fs.statSync(out[k]).size > 1000) continue;
      const tmp = `${out[k]}.${process.pid}.tmp.wav`;
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...SFX_ARGS[k], tmp], { timeoutMs: 30_000 });
      fs.renameSync(tmp, out[k]);
    }
    return out;
  } catch (e) {
    console.warn("[edit] sound effects unavailable:", (e as Error).message);
    return null;
  }
}

// ---------- Probes ----------
export async function probeSize(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation", "-of", "csv=p=0", file]);
  const [w, h, rot] = stdout.trim().split("\n")[0].split(",").map((x) => parseFloat(x));
  if (!(w > 0 && h > 0)) throw new Error(`could not read the video size of ${file}`);
  return Math.abs(rot || 0) === 90 ? { w: h, h: w } : { w, h };
}

/** RMS level (dB) of each `step` seconds of [start, start+length] (default 0.1s; length 0 = to the end). Audio only, one cheap pass. */
export async function measureLevels(file: string, start: number, length: number, step = FRAME): Promise<number[]> {
  const n = Math.max(1, Math.round(8000 * step));
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...(start > 0 ? ["-ss", String(start)] : []), ...(length > 0 ? ["-t", String(length)] : []), "-i", file, "-vn",
    "-af", `aresample=8000,asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
    "-f", "null", "-"], { timeoutMs: 120_000 });
  return parseLoudness(stdout);
}

/** RMS level (dB) of each second of the window. */
export async function measureLoudness(file: string, start: number, length: number): Promise<number[]> {
  return measureLevels(file, start, length, 1);
}

/** 100ms levels -> 1-second levels (mean power). */
export function perSecond(levels: number[], frame = FRAME): number[] {
  const k = Math.max(1, Math.round(1 / frame)), out: number[] = [];
  for (let i = 0; i < levels.length; i += k) out.push(meanDb(levels.slice(i, i + k)));
  return out;
}

// ---------- Plan + render ----------
export type EditPlan = { segs: Seg[]; duration: number; words: Word[]; peak: number | null; punchStart: number | null; zoom: string | null };

/**
 * Everything the render needs, from the window's words + loudness. Pure. `levels` = 100ms loudness of the window:
 * jump cuts only happen where it's quiet, so with no levels (no audio / measuring failed) nothing is cut.
 */
export function planEdit(opts: { style: EditStyle; words: Word[]; length: number; minSec: number; peak: number | null; levels?: number[]; jumpCuts?: JumpCutMode }): EditPlan {
  const S = STYLES[opts.style];
  const mode = opts.jumpCuts ?? "light";
  // Never cut within 1s before the payoff or during the punch-in that follows it.
  const protect = opts.peak != null ? { start: opts.peak - 1, end: opts.peak + Math.max(1, PUNCH_LEN) } : null;
  const segs = S.jumpCuts && mode !== "off"
    ? planJumpCuts({ words: opts.words, length: opts.length, minSec: opts.minSec, protect, ...JUMP_PRESETS[mode], levels: opts.levels ?? [] })
    : [{ start: 0, end: snap(opts.length) }];
  const duration = segsDuration(segs);
  const words = remapWords(opts.words, segs);
  const peak = opts.peak != null ? remapTime(opts.peak, segs) : null;
  const punchStart = S.punch > 0 ? punchAt(peak, duration) : null;
  const zoom = zoomExpr({ cuts: cutPoints(segs), alt: S.altZoom, punchStart, punch: S.punch });
  return { segs, duration, words, peak, punchStart, zoom };
}

export async function renderStyled(opts: {
  input: string; output: string; start: number; length: number; facecam: Facecam | null; style: EditStyle;
  /** v1.9.0: the layout (src/lib/layout.ts planLayout); wins over `facecam`. */
  plan?: LayoutPlan | null;
  words: Word[]; credit: string; hook: string | null; minSec: number; hasAudio: boolean;
  /** v1.9.1: channel watermark text ("ViceCityClips"), null/empty = none. */
  watermark?: string | null;
  /** v2.0.6: the channel's caption look (null = the style's own captions). */
  captionStyle?: EditStyle | null;
  peakHint?: { source: string; vodOffset: number | null; vodId?: string | null } | null; workDir: string; id: string;
  /** v1.8.0: the payoff in WINDOW seconds (from Clip.payoffAt); used as the peak instead of recomputing. */
  peakAt?: number | null;
  jumpCuts?: JumpCutMode;
}) {
  const S = STYLES[opts.style];
  const src = await probeSize(opts.input);
  const fine = opts.hasAudio ? await measureLevels(opts.input, opts.start, opts.length).catch(() => [] as number[]) : [];
  const levels = perSecond(fine);
  const known = opts.peakAt != null && opts.peakAt > 0 && opts.peakAt < opts.length ? r3(opts.peakAt) : null;
  const peak = known ?? windowPeak({ ...opts, fine, levels });
  const plan = planEdit({ style: opts.style, words: opts.words, length: opts.length, minSec: opts.minSec, peak, levels: fine, jumpCuts: opts.jumpCuts ?? "light" });
  const lp = opts.plan ?? legacyPlan(opts.facecam, src);
  fs.mkdirSync(opts.workDir, { recursive: true });
  const assName = `${opts.id}.styled.ass`, assPath = path.join(opts.workDir, assName);
  fs.writeFileSync(assPath, buildStyledAss({ words: plan.words, credit: opts.credit, duration: plan.duration, layout: lp.kind, hook: opts.hook, style: opts.style, place: lp.place, watermark: opts.watermark, captionStyle: opts.captionStyle }));
  const sfx = S.sfx && opts.hasAudio ? await ensureSfx() : null;
  const whooshAt = sfx && opts.hook ? 0 : null;
  const boomAt = sfx && plan.punchStart != null ? plan.punchStart : null;
  const extra: string[] = [];
  if (whooshAt != null) extra.push("-i", sfx!.whoosh);
  if (boomAt != null) extra.push("-i", sfx!.boom);
  const filter = buildStyledFilter({ style: opts.style, facecam: opts.facecam, plan: lp, src, segs: plan.segs, hasAudio: opts.hasAudio, assFile: assName, zoom: plan.zoom, duration: plan.duration, sfx: { whooshAt, boomAt } });
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const tmp = opts.output + ".part.mp4";
  try {
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(opts.start), "-t", String(opts.length), "-i", path.resolve(opts.input), ...extra,
      "-filter_complex", filter, "-map", "[v]", ...(opts.hasAudio ? ["-map", "[a]"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-movflags", "+faststart", path.resolve(tmp),
    ], { cwd: opts.workDir, timeoutMs: 10 * 60_000 });
    fs.renameSync(tmp, opts.output);
  } finally {
    fs.rmSync(assPath, { force: true });
    fs.rmSync(tmp, { force: true });
  }
  return { ...plan, levels };
}

/** Run the styled render; if it throws, run the plain one and return a warning for the clip (never lose a clip to an effect). */
export async function renderOrFallback<T>(style: string, styled: () => Promise<T>, plain: () => Promise<void>): Promise<{ result: T | null; note: string | null }> {
  try {
    return { result: await styled(), note: null };
  } catch (e) {
    await plain();
    return { result: null, note: `The ${style} edit failed, so the plain edit was used: ${(e as Error).message}`.slice(0, 1000) };
  }
}
