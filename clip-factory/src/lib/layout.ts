// v1.9.0 layouts (Krew: "the streamer's camera up and game down. Or just a full streamer cam if it's like a funny moment").
// Everything here is pure (tested in test/v190.test.ts). The face/webcam detection itself is scripts/detect_cam.py,
// run by src/lib/camdetect.ts; its JSON summary is a CamInfo.
import type { Facecam } from "./media";
import { type LayoutKind, type LayoutSetting } from "./edit-styles";

export { type LayoutKind, type LayoutSetting, LAYOUTS, parseLayoutSetting, layoutChip, DEFAULT_LAYOUT } from "./edit-styles";

const W = 1080, H = 1920;
/** Split layout: the cam fills the top 640px (a third), the game the 1280px below. */
export const SEAM = 640;

/** A face has to sit in the same place in >= 40% of the sampled frames to count at all. */
export const MIN_HIT = 0.4;
/** "Good" detection: >= 60% of the frames (needed for the funny -> full cam rule and to remember a creator's webcam). */
export const GOOD_HIT = 0.6;
/** Face area >= 4% of the frame = a face-cam / Just Chatting shot (detect_cam.py's LARGE_FACE). */
export const LARGE_FACE = 0.04;
/** Full cam on a webcam BOX (not the whole frame) only when the box is at least half the frame tall, else it's too blurry. */
export const SHARP_CAM_H = 0.5;
/** Fullcam may zoom into the frame down to this share of its height to put the face ~40% from the top. */
export const FULLCAM_MIN_H = 0.75;
export const FACE_AT = 0.4;

type Box4 = [number, number, number, number];
export type CamInfo = {
  v: 1; winStart: number; winLength: number; // the window it was measured on (re-cuts reuse it while this is unchanged)
  found: boolean; faceBox: Box4 | null; hitRate: number; faceAreaFrac: number; region: "corner" | "center" | "large" | null;
  camBox: Box4 | null; snapped: number; frame: [number, number]; track: [number, number, number][]; ms?: number; error?: string;
};

export const boxToCam = (b: Box4 | null | undefined): Facecam | null => (b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null);
export const camToString = (c: Facecam) => [c.x, c.y, c.w, c.h].map((v) => String(Math.round(v * 1000) / 1000)).join(",");

/** Parse a stored Clip.camInfo; null when missing/garbled. */
export function parseCamInfo(s: string | null | undefined): CamInfo | null {
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" && j.v === 1 && typeof j.found === "boolean" ? (j as CamInfo) : null;
  } catch { return null; }
}

/** The cached detection is still good when it was measured on this window (0.05s tolerance). */
export const camInfoFits = (c: CamInfo | null, winStart: number, winLength: number) =>
  Boolean(c && !c.error && Math.abs(c.winStart - winStart) < 0.05 && Math.abs(c.winLength - winLength) < 0.05);

/**
 * The Auto rule. No steady face -> blur. A big or centred face (Just Chatting, IRL, face-cam-only) -> full cam. A funny clip
 * with a well-found face -> full cam too, but only when the camera is big enough to fill the screen sharply (a small corner
 * webcam would be a 5x blurry upscale; it stays Cam + game, with the punch-in on the cam). Small face near a corner/edge -> split.
 */
export function autoLayout(det: CamInfo | null, category: string | null | undefined): { layout: LayoutKind; why: string } {
  if (!det || !det.found || det.hitRate < MIN_HIT) return { layout: "blur", why: det?.error ? "face check failed" : "no face found" };
  const pct = `${Math.round(det.hitRate * 100)}%`;
  if (det.region === "large" || det.faceAreaFrac >= LARGE_FACE) return { layout: "fullcam", why: `big face on screen (${pct} of frames)` };
  if (det.region === "center") return { layout: "fullcam", why: `face in the middle of the frame (${pct} of frames)` };
  if (category === "funny" && det.hitRate >= GOOD_HIT && det.camBox && det.camBox[3] >= SHARP_CAM_H) return { layout: "fullcam", why: `funny moment, big webcam (${pct} of frames)` };
  if (det.region === "corner" && det.camBox) return { layout: "split", why: `webcam in the corner (${pct} of frames)` };
  return { layout: "blur", why: "face not in a usable spot" };
}

/**
 * Does the cutter need to run detect_cam.py? Not for blur, not when this window was already measured, and not when the creator
 * has a webcam box (typed in, or remembered from a confident detection) for auto/split, unless they're in a non-game category
 * (Just Chatting may be a full-screen cam, so we look).
 */
export function needsDetect(o: { mode: LayoutSetting; cached: CamInfo | null; winStart: number; winLength: number; manual: Facecam | null; remembered: Facecam | null; nonGame: boolean }) {
  if (o.mode === "blur") return false;
  if (camInfoFits(o.cached, o.winStart, o.winLength)) return false;
  if ((o.mode === "auto" || o.mode === "split") && (o.manual || o.remembered) && !o.nonGame) return false;
  return true;
}

export type LayoutChoice = { layout: LayoutKind; cam: Facecam | null; camFrom: "manual" | "remembered" | "detected" | null; why: string };

/** Which layout + webcam box a clip gets. A typed-in box (Streamer.facecam) always wins over a detected or remembered one. */
export function chooseLayout(o: { mode: LayoutSetting; det: CamInfo | null; category?: string | null; manual: Facecam | null; remembered: Facecam | null }): LayoutChoice {
  const det = o.det && !o.det.error ? o.det : null;
  const detCam = det && det.found && det.hitRate >= MIN_HIT ? boxToCam(det.camBox) : null;
  const known = o.manual ? { cam: o.manual, camFrom: "manual" as const } : o.remembered ? { cam: o.remembered, camFrom: "remembered" as const } : null;
  const splitWith = (why: string): LayoutChoice | null => {
    if (o.manual) return { layout: "split", cam: o.manual, camFrom: "manual", why: `${why}, your webcam box` };
    if (detCam && det!.region === "corner") return { layout: "split", cam: detCam, camFrom: "detected", why };
    if (o.remembered) return { layout: "split", cam: o.remembered, camFrom: "remembered", why: `${why}, remembered webcam spot` };
    if (detCam) return { layout: "split", cam: detCam, camFrom: "detected", why };
    return null;
  };
  if (o.mode === "blur") return { layout: "blur", cam: null, camFrom: null, why: "blur chosen" };
  if (o.mode === "split") return splitWith("cam + game chosen") ?? { layout: "blur", cam: null, camFrom: null, why: "no webcam found, used blur" };
  if (o.mode === "fullcam") {
    if (det?.found && det.hitRate >= MIN_HIT) return { layout: "fullcam", cam: det.region === "corner" ? (o.manual ?? detCam) : null, camFrom: det.region === "corner" ? (o.manual ? "manual" : "detected") : null, why: "full cam chosen" };
    if (known) return { layout: "fullcam", cam: known.cam, camFrom: known.camFrom, why: "full cam chosen (webcam box, no face check)" };
    return { layout: "blur", cam: null, camFrom: null, why: "no face found, used blur" };
  }
  // auto
  if (!det) {
    if (known) return { layout: "split", cam: known.cam, camFrom: known.camFrom, why: known.camFrom === "manual" ? "your webcam box" : "remembered webcam spot" };
    return { layout: "blur", cam: null, camFrom: null, why: o.det?.error ? "face check failed, used blur" : "no face found" };
  }
  const a = autoLayout(det, o.category);
  if (a.layout === "split") return splitWith(a.why) ?? { layout: "blur", cam: null, camFrom: null, why: a.why };
  if (a.layout === "fullcam") return { layout: "fullcam", cam: det.region === "corner" ? (o.manual ?? detCam) : null, camFrom: det.region === "corner" ? (o.manual ? "manual" : "detected") : null, why: a.why };
  return { layout: "blur", cam: null, camFrom: null, why: a.why };
}

/**
 * The webcam box to remember on a Twitch creator ("x,y,w,h"), or null. Only a confident split detection: face in >= 60% of the
 * frames, in a corner, and at least 2 sides of the box snapped to a visible edge (a plain estimate is only a guess).
 */
export function boxToRemember(o: { choice: LayoutChoice; det: CamInfo | null; platform: string; manual: string | null; remembered: string | null }): string | null {
  const d = o.det;
  if (o.platform !== "twitch" || o.manual || !d || d.error) return null;
  if (o.choice.layout !== "split" || o.choice.camFrom !== "detected" || !o.choice.cam) return null;
  if (!(d.hitRate >= GOOD_HIT && d.region === "corner" && d.snapped >= 2)) return null;
  const v = camToString(o.choice.cam);
  return v === o.remembered ? null : v;
}

// ---------- Geometry ----------
export type Rect = { x: number; y: number; w: number; h: number };
const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

export type FullcamCrop = { w: number; h: number; y: number; keys: { t: number; x: number }[] };

/**
 * Fullcam: a 9:16 crop (source pixels) around the face. Inside the whole frame, or inside the webcam box when the face is in a
 * corner cam. Height: the full frame (or cam) height, zoomed in down to 75% when that puts the face nearer 40% from the top.
 * x follows the face slowly: if it moves less than 8% of the crop width it stays still (median), otherwise keys every sampled
 * frame (median of 3 neighbours, so one bad frame can't jerk it) that cropXExpr eases between.
 */
export function fullcamCrop(src: { w: number; h: number }, det: CamInfo | null, cam: Facecam | null): FullcamCrop {
  const area: Rect = cam ? { x: cam.x * src.w, y: cam.y * src.h, w: cam.w * src.w, h: cam.h * src.h } : { x: 0, y: 0, w: src.w, h: src.h };
  const face = det?.faceBox ? { x: det.faceBox[0] * src.w, y: det.faceBox[1] * src.h, w: det.faceBox[2] * src.w, h: det.faceBox[3] * src.h } : null;
  const fcx = face ? face.x + face.w / 2 : area.x + area.w / 2;
  const fcy = face ? face.y + face.h / 2 : area.y + area.h * 0.45;
  let ch = area.h;
  if (!cam) {
    // Zoom in a little (never under 75% of the height) when the face sits far from 40%.
    const rel = (fcy - area.y) / area.h;
    const want = rel < FACE_AT ? (fcy - area.y) / FACE_AT : rel > FACE_AT ? (area.y + area.h - fcy) / (1 - FACE_AT) : area.h;
    ch = clamp(want, area.h * FULLCAM_MIN_H, area.h);
  }
  let cw = ch * 9 / 16;
  if (cw > area.w) { cw = area.w; ch = cw * 16 / 9; }
  const w = even(Math.min(cw, area.w)), h = even(Math.min(ch, area.h));
  const y = Math.round(clamp(fcy - FACE_AT * h, area.y, area.y + area.h - h));
  const xOf = (cx: number) => Math.round(clamp(cx - w / 2, area.x, area.x + area.w - w));
  const track = (det?.track ?? []).filter((p) => Number.isFinite(p[1]));
  if (track.length < 2) return { w, h, y, keys: [{ t: 0, x: xOf(fcx) }] };
  const xs = track.map((p) => xOf(p[1] * src.w));
  if (Math.max(...xs) - Math.min(...xs) <= 0.08 * w) return { w, h, y, keys: [{ t: 0, x: xOf(fcx) }] };
  const med3 = xs.map((_, i) => [xs[Math.max(0, i - 1)], xs[i], xs[Math.min(xs.length - 1, i + 1)]].sort((a, b) => a - b)[1]);
  return { w, h, y, keys: track.map((p, i) => ({ t: r1(p[0]), x: med3[i] })) };
}

/**
 * ffmpeg crop x expression for the keys: holds before the first and after the last, cosine-eases between them (no jitter, no
 * sudden pan). `remap` turns a window time into the edited time (jump cuts). One key = a plain number.
 */
export function cropXExpr(keys: { t: number; x: number }[], remap: (t: number) => number = (t) => t): string {
  if (!keys.length) return "0";
  const k = keys.map((p) => ({ t: Math.round(remap(p.t) * 1000) / 1000, x: p.x }))
    .filter((p, i, a) => i === 0 || p.t > a[i - 1].t + 0.05); // a jump cut can squash two keys together
  if (k.length === 1 || k.every((p) => p.x === k[0].x)) return String(k[0].x);
  let e = String(k[k.length - 1].x);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i], b = k[i + 1];
    const seg = a.x === b.x ? String(a.x) : `${a.x}+${b.x - a.x}*(0.5-0.5*cos(PI*(t-${a.t})/${Math.round((b.t - a.t) * 1000) / 1000}))`;
    e = `if(lt(t,${b.t}),${seg},${e})`;
  }
  return `if(lt(t,${k[0].t}),${k[0].x},${e})`;
}

/**
 * Split: the game part is a centre crop of the frame. When the webcam sits in that crop (a corner cam reaches into it), move the
 * crop sideways away from the cam (at most 12% of the frame width) so no slice of the cam shows in the game. Returns the shift as
 * a fraction of the source width (negative = left).
 */
export function splitGameShift(src: { w: number; h: number }, cam: Facecam): number {
  const scaledW = src.w * (H - SEAM) / src.h;
  if (scaledW <= W) return 0;
  const half = W / scaledW / 2, lo = 0.5 - half, hi = 0.5 + half;
  const camL = cam.x, camR = cam.x + cam.w;
  let s = 0;
  if (camL < hi && camL + cam.w / 2 > 0.5) s = -(hi - camL); // cam on the right reaching into the crop
  else if (camR > lo && camR - cam.w / 2 < 0.5) s = camR - lo; // cam on the left
  return Math.round(clamp(s, -0.12, 0.12) * 10000) / 10000;
}

/** Where the face ends up in the 1080x1920 output (for keeping text off it). Null when unknown. */
export function faceInOutput(o: { layout: LayoutKind; src: { w: number; h: number }; det: CamInfo | null; cam: Facecam | null; crop?: FullcamCrop | null }): Rect | null {
  const fb = o.det?.found && o.det.faceBox ? o.det.faceBox : null;
  if (o.layout === "split" && o.cam) {
    const cw = o.cam.w * o.src.w, ch = o.cam.h * o.src.h;
    const k = Math.max(W / cw, SEAM / ch), ox = (cw * k - W) / 2, oy = (ch * k - SEAM) / 2;
    // No face check (typed-in / remembered box): assume a face in the middle, 45% down, a third of the cam tall.
    const f = fb && fb[0] >= o.cam.x - 0.01 && fb[0] + fb[2] <= o.cam.x + o.cam.w + 0.01
      ? { x: fb[0] * o.src.w - o.cam.x * o.src.w, y: fb[1] * o.src.h - o.cam.y * o.src.h, w: fb[2] * o.src.w, h: fb[3] * o.src.h }
      : { x: cw * 0.35, y: ch * 0.28, w: cw * 0.3, h: ch * 0.34 };
    return { x: f.x * k - ox, y: f.y * k - oy, w: f.w * k, h: f.h * k };
  }
  if (o.layout === "fullcam" && o.crop && fb) {
    const k = H / o.crop.h, cx = o.crop.keys[0]?.x ?? 0;
    return { x: (fb[0] * o.src.w - cx) * k, y: (fb[1] * o.src.h - o.crop.y) * k, w: fb[2] * o.src.w * k, h: fb[3] * o.src.h * k };
  }
  return null;
}

// ---------- Text placement ----------
/** y positions in the 1080x1920 frame. capY = caption centre; hook anchored top (an8) or bottom (an2) at hookY; credit likewise. */
export type OverlayPlace = { capY: number; hookY: number; hookAlign: 8 | 2; creditY: number; creditAlign: 8 | 2 };
export const HOOK_H = 190; // two lines of hook text in its box
const CREDIT_TOP: Pick<OverlayPlace, "creditY" | "creditAlign"> = { creditY: 110, creditAlign: 8 };
const CREDIT_BOTTOM: Pick<OverlayPlace, "creditY" | "creditAlign"> = { creditY: H - 34, creditAlign: 2 }; // just above the progress bar

/**
 * Text that never covers the face. The face rect is the detected face (eyes to chin), grown 25% for hair/forehead.
 * blur: v1.7.3 places (credit 110, hook 250, captions 62%).
 * split: captions just under the seam (y=760); hook just above the seam (inside the cam, under the face) or, if the face is
 * low in the cam, under the captions; credit at the top unless the face reaches up there, then at the bottom.
 * fullcam: captions at 72% (pushed lower if the chin reaches there); hook at the top if the head is clear of it, else under
 * the captions; credit at the top unless the head is there, then at the bottom.
 */
export function overlayPlace(layout: LayoutKind | "facecam", face: Rect | null): OverlayPlace {
  if (layout === "blur") return { capY: Math.round(H * 0.62), hookY: 250, hookAlign: 8, ...CREDIT_TOP };
  const f = face ? { top: face.y - face.h * 0.25, bottom: face.y + face.h * 1.25 } : null;
  if (layout === "split" || layout === "facecam") {
    const capY = SEAM + 120;
    const hookAbove = !f || f.bottom + 10 < SEAM - 14 - HOOK_H;
    return {
      capY, hookY: hookAbove ? SEAM - 14 : capY + 90, hookAlign: hookAbove ? 2 : 8,
      ...(!f || f.top > 175 ? CREDIT_TOP : CREDIT_BOTTOM),
    };
  }
  let capY = Math.round(H * 0.72);
  if (f && f.bottom + 70 > capY) capY = Math.min(H - 260, Math.round(f.bottom + 80));
  const hookTop = !f || f.top > 250 + HOOK_H + 20;
  return {
    capY, hookY: hookTop ? 250 : Math.min(H - 60 - HOOK_H, capY + 90), hookAlign: 8,
    ...(!f || f.top > 175 ? CREDIT_TOP : CREDIT_BOTTOM),
  };
}

// ---------- The plan the renderers use ----------
export type LayoutPlan =
  | { kind: "blur"; place: OverlayPlace }
  | { kind: "split"; cam: Facecam; zoomOn: "cam" | "game"; gameShift: number; place: OverlayPlace }
  | { kind: "fullcam"; crop: FullcamCrop; place: OverlayPlace };

/**
 * Everything the render needs for the chosen layout. Punch-in / zoom rule: split -> on the CAM for funny clips (the reaction is
 * the point), on the GAME otherwise; fullcam -> the whole frame; blur -> the gameplay layer (the blurred fill never zooms).
 */
export function planLayout(o: { choice: LayoutChoice; det: CamInfo | null; src: { w: number; h: number }; category?: string | null }): LayoutPlan {
  const { choice, det, src } = o;
  if (choice.layout === "split" && choice.cam) {
    const face = faceInOutput({ layout: "split", src, det, cam: choice.cam });
    return { kind: "split", cam: choice.cam, zoomOn: o.category === "funny" ? "cam" : "game", gameShift: splitGameShift(src, choice.cam), place: overlayPlace("split", face) };
  }
  if (choice.layout === "fullcam") {
    const crop = fullcamCrop(src, det, choice.cam);
    return { kind: "fullcam", crop, place: overlayPlace("fullcam", faceInOutput({ layout: "fullcam", src, det, cam: choice.cam, crop })) };
  }
  return { kind: "blur", place: overlayPlace("blur", null) };
}

/** Pre-1.9 callers pass only `facecam`: a box = split (zoom on the game), none = blur. */
export function legacyPlan(facecam: Facecam | null, src?: { w: number; h: number }): LayoutPlan {
  if (!facecam) return { kind: "blur", place: overlayPlace("blur", null) };
  return { kind: "split", cam: facecam, zoomOn: "game", gameShift: src ? splitGameShift(src, facecam) : 0, place: overlayPlace("split", null) };
}
