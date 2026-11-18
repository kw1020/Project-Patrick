import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FACE_AT, SEAM, autoLayout, boxToRemember, camInfoFits, chooseLayout, cropXExpr, faceInOutput, fullcamCrop, needsDetect, overlayPlace,
  parseCamInfo, planLayout, splitGameShift, type CamInfo,
} from "../src/lib/layout";
import { layoutChip, parseLayoutSetting } from "../src/lib/edit-styles";
import { buildAss, buildFilter, probeDuration, renderVertical, run } from "../src/lib/media";
import { buildStyledFilter, probeSize, renderStyled } from "../src/lib/edit";
import { toV180Schema } from "./schema-v173";

// v1.9.0 layouts: cam on top + game below, full streamer cam, Auto; face/webcam detection with OpenCV Haar cascades.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v190-"));
const storage = path.join(dir, "storage");
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const PY = process.env.PYTHON || "python3";
const SRC = { w: 1920, h: 1080 };

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: storage, REDIS_URL: "redis://localhost:6379/12", WHISPER_ENGINE: "off",
  });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  (await import("../src/lib/paths")).ensureStorage();
});
after(async () => {
  const { prisma } = await import("../src/lib/db");
  await prisma.$disconnect();
  try { const { redis } = await import("../src/lib/queues"); redis().disconnect(); } catch { /* never connected */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const det = (o: Partial<CamInfo>): CamInfo => ({
  v: 1, winStart: 0, winLength: 20, found: true, faceBox: [0.77, 0.09, 0.07, 0.13], hitRate: 1, faceAreaFrac: 0.009, region: "corner",
  camBox: [0.67, 0.03, 0.31, 0.31], snapped: 4, frame: [1920, 1080], track: [], ...o,
});
const CORNER = det({});
const CHAT = det({ faceBox: [0.41, 0.13, 0.105, 0.187], faceAreaFrac: 0.0195, region: "center", camBox: [0.28, 0.05, 0.38, 0.38], snapped: 0 });
const BIG = det({ faceBox: [0.35, 0.2, 0.2, 0.35], faceAreaFrac: 0.07, region: "large", camBox: [0.1, 0, 0.8, 0.8], snapped: 0 });
const NONE = det({ found: false, faceBox: null, hitRate: 0, faceAreaFrac: 0, region: null, camBox: null, snapped: 0 });

// ---------- Auto rule ----------
test("autoLayout: no face -> blur, big/centred face -> full cam, corner cam -> split, funny -> full cam only when sharp", () => {
  assert.equal(autoLayout(null, "gaming").layout, "blur");
  assert.equal(autoLayout(NONE, "funny").layout, "blur");
  assert.equal(autoLayout(det({ hitRate: 0.3 }), "gaming").layout, "blur", "face in < 40% of frames does not count");
  assert.equal(autoLayout(BIG, "gaming").layout, "fullcam");
  assert.equal(autoLayout(det({ region: "corner", faceAreaFrac: 0.045 }), "gaming").layout, "fullcam", ">= 4% of the frame = face cam");
  assert.equal(autoLayout(CHAT, "gaming").layout, "fullcam", "Just Chatting face in the middle");
  assert.equal(autoLayout(CORNER, "gaming").layout, "split");
  assert.equal(autoLayout(CORNER, "funny").layout, "split", "a small corner cam would be a blurry full cam: split + cam punch-in");
  assert.equal(autoLayout(det({ camBox: [0.5, 0.0, 0.5, 0.55] }), "funny").layout, "fullcam", "funny + a big webcam = full cam");
  assert.equal(autoLayout(det({ camBox: [0.5, 0.0, 0.5, 0.55], hitRate: 0.5 }), "funny").layout, "split", "funny needs a well-found face");
  assert.equal(autoLayout(det({ camBox: null }), "gaming").layout, "blur");
  assert.match(autoLayout(det({ error: "boom", found: false }), null).why, /failed/);
});

test("layout setting parsing, chips, old 'facecam' = split", () => {
  assert.equal(parseLayoutSetting("facecam"), "split");
  assert.equal(parseLayoutSetting("fullcam"), "fullcam");
  assert.equal(parseLayoutSetting("nope"), "auto");
  assert.equal(parseLayoutSetting(undefined), "auto");
  assert.deepEqual(["split", "facecam", "fullcam", "blur", null].map(layoutChip), ["Cam + game", "Cam + game", "Full cam", "Blur", null]);
});

test("chooseLayout: a typed-in box always wins; remembered box reused; forced layouts fall back to blur without a face", () => {
  const manual = { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, remembered = { x: 0.6, y: 0.6, w: 0.35, h: 0.35 };
  let c = chooseLayout({ mode: "auto", det: CORNER, category: "gaming", manual, remembered });
  assert.deepEqual([c.layout, c.camFrom, c.cam], ["split", "manual", manual]);
  c = chooseLayout({ mode: "auto", det: CORNER, category: "gaming", manual: null, remembered });
  assert.deepEqual([c.layout, c.camFrom], ["split", "detected"], "this clip's own detection beats the remembered spot");
  c = chooseLayout({ mode: "auto", det: null, category: "gaming", manual: null, remembered });
  assert.deepEqual([c.layout, c.camFrom, c.cam], ["split", "remembered", remembered], "detection skipped -> remembered spot");
  assert.equal(chooseLayout({ mode: "auto", det: null, manual: null, remembered: null }).layout, "blur");
  assert.equal(chooseLayout({ mode: "auto", det: CHAT, category: "gaming", manual, remembered: null }).layout, "fullcam", "Just Chatting shot -> full cam even with a box");
  assert.equal(chooseLayout({ mode: "split", det: NONE, manual: null, remembered: null }).layout, "blur");
  assert.equal(chooseLayout({ mode: "split", det: NONE, manual, remembered: null }).camFrom, "manual");
  assert.equal(chooseLayout({ mode: "fullcam", det: NONE, manual: null, remembered: null }).layout, "blur");
  c = chooseLayout({ mode: "fullcam", det: CORNER, manual: null, remembered: null });
  assert.deepEqual([c.layout, c.cam?.x], ["fullcam", 0.67], "full cam of a corner cam stays inside the cam box");
  assert.equal(chooseLayout({ mode: "fullcam", det: CHAT, manual: null, remembered: null }).cam, null, "Just Chatting: crop of the whole frame");
  assert.equal(chooseLayout({ mode: "blur", det: CORNER, manual, remembered }).layout, "blur");
  assert.equal(chooseLayout({ mode: "auto", det: det({ error: "no cv2", found: false }), manual, remembered: null }).camFrom, "manual", "failed check + typed box -> split");
});

test("needsDetect + cached camInfo: re-cuts don't re-detect unless the window changed", () => {
  const base = { cached: null, winStart: 5, winLength: 20, manual: null, remembered: null, nonGame: false };
  assert.equal(needsDetect({ ...base, mode: "blur" }), false);
  assert.equal(needsDetect({ ...base, mode: "auto" }), true);
  const cached = det({ winStart: 5, winLength: 20 });
  assert.equal(needsDetect({ ...base, mode: "auto", cached }), false);
  assert.equal(needsDetect({ ...base, mode: "auto", cached, winStart: 7 }), true, "window moved");
  assert.equal(needsDetect({ ...base, mode: "auto", cached: det({ winStart: 5, winLength: 20, error: "x" }) }), true, "a failed check is retried");
  const box = { x: 0.7, y: 0, w: 0.3, h: 0.3 };
  assert.equal(needsDetect({ ...base, mode: "auto", manual: box }), false);
  assert.equal(needsDetect({ ...base, mode: "split", remembered: box }), false);
  assert.equal(needsDetect({ ...base, mode: "auto", remembered: box, nonGame: true }), true, "Just Chatting: look, it may be a full-screen cam");
  assert.equal(needsDetect({ ...base, mode: "fullcam", manual: box }), true);
  assert.equal(camInfoFits(cached, 5.02, 19.98), true);
  assert.equal(parseCamInfo(JSON.stringify(cached))?.hitRate, 1);
  assert.equal(parseCamInfo("{bad"), null);
  assert.equal(parseCamInfo(JSON.stringify({ found: true })), null);
});

test("boxToRemember: only a confident, snapped corner detection on a Twitch creator without a typed box", () => {
  const choice = chooseLayout({ mode: "auto", det: CORNER, category: "gaming", manual: null, remembered: null });
  const o = { choice, det: CORNER, platform: "twitch", manual: null, remembered: null };
  assert.equal(boxToRemember(o), "0.67,0.03,0.31,0.31");
  assert.equal(boxToRemember({ ...o, remembered: "0.67,0.03,0.31,0.31" }), null, "already remembered");
  assert.equal(boxToRemember({ ...o, manual: "0.7,0,0.3,0.3" }), null, "typed-in box wins");
  assert.equal(boxToRemember({ ...o, platform: "youtube" }), null);
  assert.equal(boxToRemember({ ...o, det: det({ hitRate: 0.5 }) }), null, "low confidence");
  assert.equal(boxToRemember({ ...o, det: det({ snapped: 1 }) }), null, "just an estimate, no visible edges");
});

// ---------- Cam box estimation (detect_cam.py's summary, fed injected detector output) ----------
function summarize(input: unknown) {
  const r = spawnSync(PY, [path.join(ROOT, "scripts", "detect_cam.py"), "--summarize"], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

test("detect_cam summary: steady corner face -> webcam box ~3.6x the face, 16:9, inside the frame; stray hits ignored", () => {
  const face = [1480, 100, 140, 140];
  const faces = Array.from({ length: 10 }, (_, i) => {
    const f = [[face[0] + (i % 3) * 4, face[1] + (i % 2) * 3, face[2], face[3]]];
    if (i % 4 === 0) f.push([200 + i * 90, 600, 60, 60]); // game textures that look like faces for a frame
    return i === 7 ? [] : f;
  });
  const s = summarize({ frame: [1920, 1080], faces, times: faces.map((_, i) => i * 2) });
  assert.equal(s.found, true);
  assert.equal(s.hitRate, 0.9);
  assert.equal(s.region, "corner");
  const [x, y, w, h] = s.camBox;
  assert.ok(Math.abs(w * 1920 - 140 * 3.6) < 4, `cam width ~3.6x face: ${w * 1920}`);
  assert.ok(Math.abs((w * 1920) / (h * 1080) - 16 / 9) < 0.05, "16:9");
  assert.ok(x >= 0 && y >= 0 && x + w <= 1.0001 && y + h <= 1.0001, "inside the frame");
  assert.ok(x * 1920 < 1480 && (x + w) * 1920 > 1620 && y * 1080 <= 100, "contains the face");
  assert.equal(s.track.length, 9);

  // Face hard against the top-right corner: the box is shifted to stay inside the frame, not cut.
  const edge = summarize({ frame: [1920, 1080], faces: Array(6).fill([[1800, 5, 110, 110]]) });
  assert.ok(edge.camBox[0] + edge.camBox[2] <= 1.0001 && edge.camBox[1] >= 0);
  assert.ok(edge.camBox[2] * 1920 >= 390, "kept its full width");
});

test("detect_cam summary: big face = large, centred face = center, flicker = not found", () => {
  assert.equal(summarize({ frame: [1920, 1080], faces: Array(10).fill([[700, 200, 400, 400]]) }).region, "large");
  assert.equal(summarize({ frame: [1920, 1080], faces: Array(10).fill([[860, 300, 200, 200]]) }).region, "center");
  const flicker = summarize({ frame: [1920, 1080], faces: [[[100, 100, 80, 80]], [], [], [[900, 500, 80, 80]], [], [], [], [], [], []] });
  assert.deepEqual([flicker.found, flicker.camBox], [false, null]);
  assert.equal(summarize({ frame: [1920, 1080], faces: Array(10).fill([]) }).found, false);
});

test("detect_cam.py on a real video with no face (testsrc) returns found=false within the time budget", { timeout: 120_000 }, async () => {
  const src = path.join(dir, "testsrc.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=12", "-c:v", "libx264", "-preset", "ultrafast", src]);
  const { detectCam } = await import("../src/lib/camdetect");
  const t0 = Date.now();
  const d = await detectCam(src, 1, 10);
  if (d.error && /No module named 'cv2'|numpy/.test(d.error)) return; // OpenCV not installed here: the cutter falls back to blur (tested above)
  assert.equal(d.error, undefined);
  assert.deepEqual([d.found, d.camBox, d.frame], [false, null, [1920, 1080]]);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
  const bad = await detectCam(path.join(dir, "missing.mp4"), 0, 5);
  assert.equal(bad.found, false);
  assert.ok(bad.error, "never throws");
});

// Only when a real face picture is available (e.g. scikit-image's public-domain astronaut.png): CF_FACE_IMAGE=/path/astronaut.png
test("detect_cam.py finds a real face in a corner webcam over moving gameplay (CF_FACE_IMAGE)", { timeout: 120_000, skip: !process.env.CF_FACE_IMAGE }, async () => {
  const src = path.join(dir, "cam.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=2400x1350:r=30:d=12", "-loop", "1", "-framerate", "30", "-t", "12", "-i", process.env.CF_FACE_IMAGE!,
    "-filter_complex", "[0:v]crop=1920:1080:x='240+200*sin(t/3)':y=135[g];[1:v]scale=640:640,crop=600:338:0:0,pad=612:350:6:6:color=0x202020[cam];[g][cam]overlay=W-w-24:24",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
  const { detectCam } = await import("../src/lib/camdetect");
  const d = await detectCam(src, 1, 10);
  assert.equal(d.found, true, JSON.stringify(d));
  assert.equal(d.region, "corner");
  assert.ok(d.hitRate >= 0.8);
  const [x, y, w, h] = d.camBox!;
  // The real cam: x 1284..1896, y 24..374 (border included). Within ~12px, and not reaching into the game.
  assert.ok(Math.abs(x * 1920 - 1290) < 14 && Math.abs((x + w) * 1920 - 1890) < 14, `x ${x * 1920}..${(x + w) * 1920}`);
  assert.ok(Math.abs(y * 1080 - 30) < 14 && Math.abs((y + h) * 1080 - 368) < 14, `y ${y * 1080}..${(y + h) * 1080}`);
  assert.ok(d.snapped >= 3);
});

// ---------- Geometry + placement ----------
test("fullcamCrop: 9:16 inside the frame, face near 40% from the top, static unless the face really moves", () => {
  const c = fullcamCrop(SRC, CHAT, null);
  assert.ok(Math.abs(c.w / c.h - 9 / 16) < 0.01, `9:16: ${c.w}x${c.h}`);
  assert.ok(c.h >= 1080 * 0.75 && c.h <= 1080 && c.w % 2 === 0 && c.h % 2 === 0);
  assert.equal(c.y, 0, "face high in the frame: the crop can't go above the top");
  assert.equal(c.keys.length, 1, "no track = static");
  const faceCx = (0.41 + 0.105 / 2) * 1920;
  assert.ok(Math.abs(c.keys[0].x + c.w / 2 - faceCx) < 2, "centred on the face");
  // A face in the middle of the frame lands at ~40% from the top.
  const mid = fullcamCrop(SRC, det({ faceBox: [0.45, 0.42, 0.1, 0.18], region: "center" }), null);
  const faceY = (0.42 + 0.09) * 1080;
  assert.ok(Math.abs((faceY - mid.y) / mid.h - FACE_AT) < 0.02, `face at ${(faceY - mid.y) / mid.h}`);
  // Small wobble -> static; a real move -> keys (median of 3 kills a single bad frame).
  const wobble = fullcamCrop(SRC, det({ ...CHAT, track: [[1, 0.46, 0.22], [3, 0.47, 0.22], [5, 0.465, 0.22]] }), null);
  assert.equal(wobble.keys.length, 1);
  const moving = fullcamCrop(SRC, det({ ...CHAT, track: [[1, 0.3, 0.2], [3, 0.35, 0.2], [5, 0.9, 0.2], [7, 0.45, 0.2], [9, 0.5, 0.2]] }), null);
  assert.equal(moving.keys.length, 5);
  assert.ok(moving.keys[2].x < 0.6 * 1920, "the one-frame jump to 0.9 is ignored");
  assert.ok(moving.keys.every((k) => k.x >= 0 && k.x + moving.w <= 1920));
  // Corner cam: the crop stays inside the webcam box.
  const cam = { x: 0.67, y: 0.03, w: 0.31, h: 0.31 };
  const inCam = fullcamCrop(SRC, CORNER, cam);
  assert.ok(inCam.keys[0].x >= cam.x * 1920 && inCam.keys[0].x + inCam.w <= (cam.x + cam.w) * 1920 + 1);
  assert.ok(inCam.y >= cam.y * 1080 && inCam.y + inCam.h <= (cam.y + cam.h) * 1080 + 1);
});

test("cropXExpr: hold, eased pan between keys, remapped through jump cuts", () => {
  assert.equal(cropXExpr([{ t: 0, x: 600 }]), "600");
  assert.equal(cropXExpr([{ t: 1, x: 600 }, { t: 3, x: 600 }]), "600");
  const e = cropXExpr([{ t: 1, x: 600 }, { t: 3, x: 700 }]);
  assert.equal(e, "if(lt(t,1),600,if(lt(t,3),600+100*(0.5-0.5*cos(PI*(t-1)/2)),700))");
  const ev = (expr: string, t: number) => Function("t", "PI", "cos", "lt", "ifF", `return ${expr.replace(/if\(/g, "ifF(")}`)(t, Math.PI, Math.cos, (a: number, b: number) => (a < b ? 1 : 0), (c: number, a: number, b: number) => (c ? a : b));
  assert.equal(ev(e, 0), 600);
  assert.equal(ev(e, 2), 650);
  assert.equal(ev(e, 5), 700);
  const remapped = cropXExpr([{ t: 1, x: 600 }, { t: 5, x: 700 }], (t) => (t > 2 ? t - 1 : t));
  assert.match(remapped, /lt\(t,4\)/, "key times follow the edited timeline");
});

test("splitGameShift: the game crop moves away from a corner cam, at most 12%", () => {
  assert.equal(splitGameShift(SRC, { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }), -0.0373);
  assert.equal(splitGameShift(SRC, { x: 0.02, y: 0.6, w: 0.28, h: 0.3 }), 0.0373);
  assert.equal(splitGameShift(SRC, { x: 0.8, y: 0, w: 0.2, h: 0.2 }), 0, "cam outside the crop");
  assert.equal(splitGameShift(SRC, { x: 0.52, y: 0, w: 0.46, h: 0.4 }), -0.12, "capped");
});

const overlaps = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => a.top < b.bottom && b.top < a.bottom;

test("overlayPlace: captions/hook/credit never on the face; fullcam captions at ~72%, split captions just under the seam", () => {
  const blur = overlayPlace("blur", null);
  assert.deepEqual([blur.capY, blur.hookY, blur.creditY], [1190, 250, 110]);
  // fullcam, face in the upper middle
  const face = { x: 380, y: 600, w: 320, h: 330 };
  const fc = overlayPlace("fullcam", face);
  assert.equal(fc.capY, Math.round(1920 * 0.72));
  const head = { top: face.y - face.h * 0.25, bottom: face.y + face.h * 1.25 };
  assert.ok(!overlaps({ top: fc.capY - 60, bottom: fc.capY + 60 }, head), "captions under the chin");
  assert.ok(!overlaps({ top: fc.hookY, bottom: fc.hookY + 190 }, head), "hook off the face");
  assert.deepEqual([fc.creditY, fc.creditAlign], [110, 8]);
  // fullcam, head near the top: hook and credit move off it
  const high = overlayPlace("fullcam", { x: 380, y: 150, w: 320, h: 330 });
  assert.ok(high.hookY > 150 + 330 * 1.25, "hook below the head");
  assert.equal(high.creditAlign, 2, "credit at the bottom");
  // split
  const sp = overlayPlace("split", { x: 400, y: 120, w: 260, h: 260 });
  assert.ok(sp.capY > SEAM && sp.capY - 60 >= SEAM, "captions at/below the seam");
  const camFace = { top: 120 - 65, bottom: 120 + 325 };
  const hook = sp.hookAlign === 2 ? { top: sp.hookY - 190, bottom: sp.hookY } : { top: sp.hookY, bottom: sp.hookY + 190 };
  assert.ok(!overlaps(hook, camFace), "hook off the face");
  assert.ok(!overlaps({ top: sp.capY - 60, bottom: sp.capY + 60 }, hook), "hook and captions apart");
  assert.equal(sp.creditAlign, 2, "face reaches the top of the cam: credit at the bottom");
  const smallFace = overlayPlace("split", { x: 450, y: 220, w: 150, h: 150 });
  assert.deepEqual([smallFace.hookAlign, smallFace.hookY, smallFace.creditY], [2, SEAM - 14, 110], "small face: hook just above the seam, credit on top");
});

test("faceInOutput + planLayout: zoom on the cam for funny split clips, on the game otherwise; fullcam = whole frame", () => {
  const choice = chooseLayout({ mode: "auto", det: CORNER, category: "funny", manual: null, remembered: null });
  const funny = planLayout({ choice, det: CORNER, src: SRC, category: "funny" });
  const game = planLayout({ choice, det: CORNER, src: SRC, category: "gaming" });
  assert.equal(funny.kind === "split" && funny.zoomOn, "cam");
  assert.equal(game.kind === "split" && game.zoomOn, "game");
  const f = faceInOutput({ layout: "split", src: SRC, det: CORNER, cam: choice.cam });
  assert.ok(f && f.y > 0 && f.y + f.h < SEAM, "face inside the cam part");
  const fc = planLayout({ choice: chooseLayout({ mode: "auto", det: CHAT, manual: null, remembered: null }), det: CHAT, src: SRC });
  assert.equal(fc.kind, "fullcam");
  const ff = buildStyledFilter({ style: "hype", facecam: null, plan: fc, src: SRC, segs: [{ start: 0, end: 4 }, { start: 6, end: 10 }], hasAudio: false, zoom: "(1+0.1)", duration: 8 });
  assert.match(ff, /\[cv\]crop=\d+:\d+:x='[^']+':y=\d+,scale=w='2\*trunc\(1080\*/, "fullcam: crop, then the zoom on the whole frame");
  const sf = buildStyledFilter({ style: "hype", facecam: null, plan: funny, src: SRC, segs: [{ start: 0, end: 10 }], hasAudio: false, zoom: "(1+0.1)", duration: 10 });
  assert.match(sf, /\[ca1\]crop=[^;]*scale=w='2\*trunc/, "funny split: zoom on the cam");
  assert.match(sf, /\[cb1\]scale=\d+:1280,crop=1080:1280:x=\d+:y=0\[bot\]/, "game still");
  const plain = buildFilter({ facecam: null, plan: fc });
  assert.match(plain, /^\[0:v\]crop=\d+:\d+:x='\d+':y=\d+,scale=1080:1920/);
  const ass = buildAss({ words: [{ word: "hi", start: 0, end: 1 }], credit: "twitch.tv/x", duration: 5, layout: "fullcam", place: fc.place, hook: "hook" });
  assert.match(ass, new RegExp(`\\\\an5\\\\pos\\(540,${fc.place.capY}\\)`));
});

// ---------- Real renders ----------
test("real renders: styled split + fullcam and plain split + fullcam are 1080x1920 (real ffmpeg)", { timeout: 300_000 }, async () => {
  const src = path.join(dir, "game.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
  const size = async (f: string) => (await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", f])).stdout.trim();
  const moving = det({ ...CHAT, track: [[1, 0.4, 0.2], [4, 0.5, 0.2], [7, 0.6, 0.2]] });
  const plans = {
    split: planLayout({ choice: chooseLayout({ mode: "split", det: CORNER, manual: null, remembered: null }), det: CORNER, src: SRC, category: "funny" }),
    fullcam: planLayout({ choice: chooseLayout({ mode: "fullcam", det: moving, manual: null, remembered: null }), det: moving, src: SRC }),
  };
  assert.ok(plans.fullcam.kind === "fullcam" && plans.fullcam.crop.keys.length === 3, "moving crop");
  const words = "no way he did that bro".split(" ").map((w, i) => ({ word: w, start: 0.5 + i * 0.6, end: 0.9 + i * 0.6 }));
  for (const [name, plan] of Object.entries(plans)) {
    const out = path.join(dir, `styled-${name}.mp4`);
    await renderStyled({ input: src, output: out, start: 1, length: 10, facecam: null, plan, style: "hype", words, credit: "twitch.tv/x", hook: "Look at this", minSec: 5,
      hasAudio: true, workDir: path.join(dir, "work"), id: name, peakAt: 5 });
    assert.equal(await size(out), "1080,1920", name);
    const plain = path.join(dir, `plain-${name}.mp4`), ass = path.join(dir, `${name}.ass`);
    fs.writeFileSync(ass, buildAss({ words, credit: "twitch.tv/x", duration: 10, layout: plan.kind, place: plan.place }));
    await renderVertical({ input: src, output: plain, start: 1, length: 10, facecam: null, plan, assPath: ass });
    assert.equal(await size(plain), "1080,1920", `plain ${name}`);
    assert.ok(Math.abs(await probeDuration(plain) - 10) < 0.5);
  }
  assert.deepEqual(await probeSize(src), SRC);
});

// ---------- Migration + the cutter ----------
test("migrateV190Settings: blur -> auto once; a later Blur choice sticks; facecam is left alone", async () => {
  const { prisma } = await import("../src/lib/db");
  const { migrateV190Settings } = await import("../src/workers/migrate");
  await prisma.settings.upsert({ where: { id: "main" }, update: { layout: "blur", migratedAutoLayout: false }, create: { id: "main", layout: "blur" } });
  assert.equal(await migrateV190Settings(), "layout moved to auto (v1.9.0)");
  let s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.deepEqual([s.layout, s.migratedAutoLayout], ["auto", true]);
  await prisma.settings.update({ where: { id: "main" }, data: { layout: "blur" } });
  assert.equal(await migrateV190Settings(), null, "runs once");
  s = await prisma.settings.findUniqueOrThrow({ where: { id: "main" } });
  assert.equal(s.layout, "blur");
  await prisma.settings.update({ where: { id: "main" }, data: { layout: "facecam", migratedAutoLayout: false } });
  assert.equal(await migrateV190Settings(), "layout kept (facecam)");
  await prisma.settings.delete({ where: { id: "main" } });
  const fresh = await prisma.settings.create({ data: { id: "main" } });
  assert.equal(fresh.layout, "auto", "new installs default to Auto");
});

test("runCut: detection cached on the clip, webcam spot remembered on the creator and reused, a typed box wins, re-cut layout", { timeout: 300_000 }, async () => {
  const { prisma } = await import("../src/lib/db");
  const { runCut } = await import("../src/workers/cutter");
  // Stand-in detector (PYTHON points at it): prints a confident corner detection and counts its calls.
  const calls = path.join(dir, "calls.txt");
  const fake = path.join(dir, "fakepy.sh");
  const out = { found: true, faceBox: CORNER.faceBox, hitRate: 1, faceAreaFrac: 0.009, region: "corner", camBox: CORNER.camBox, snapped: 4, frame: [1920, 1080], track: [], ms: 5 };
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\necho '${JSON.stringify(out)}'\n`, { mode: 0o755 });
  const oldPy = process.env.PYTHON;
  process.env.PYTHON = fake;
  try {
    fs.mkdirSync(path.join(storage, "raw"), { recursive: true });
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=10", "-f", "lavfi", "-i", "sine=frequency=300:duration=10",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path.join(storage, "raw", "cam.mp4")]);
    await prisma.settings.upsert({ where: { id: "main" }, update: { layout: "auto", judgeEnabled: false, editStyle: "clean", jumpCuts: "off" }, create: { id: "main", layout: "auto", judgeEnabled: false } });
    const st = await prisma.streamer.create({ data: { twitchId: "v190", login: "camguy", name: "CamGuy", approved: true } });
    const mk = async () => {
      const m = await prisma.moment.create({ data: { streamerId: st.id, timestamp: new Date(), source: "twitch_clip", gameName: "Grand Theft Auto VI" } });
      return prisma.clip.create({ data: { momentId: m.id, rawPath: "raw/cam.mp4", winStart: 1, winLength: 8, duration: 8, words: "[]", wordsFull: true, category: "gaming" } });
    };
    const ncalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").length : 0);

    const c1 = await mk();
    assert.match(await runCut(c1.id), /split \(webcam in the corner.*webcam spot remembered/);
    let clip = await prisma.clip.findUniqueOrThrow({ where: { id: c1.id } });
    assert.equal(clip.layout, "split");
    assert.equal(parseCamInfo(clip.camInfo)?.winStart, 1);
    assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: st.id } })).facecamAuto, "0.67,0.03,0.31,0.31");
    assert.equal(ncalls(), 1);

    // Re-cut in another style: same window -> cached detection, no new face check. Re-cut as full cam: still cached.
    await runCut(c1.id, "hype");
    assert.equal(ncalls(), 1, "re-cut reuses Clip.camInfo");
    assert.match(await runCut(c1.id, "hype", "off", "fullcam"), /fullcam/);
    assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: c1.id } })).layout, "fullcam");
    assert.equal(ncalls(), 1);

    // Next clip from this creator: the remembered spot is used, no face check.
    const c2 = await mk();
    assert.match(await runCut(c2.id), /split \(remembered webcam spot\)/);
    assert.equal(ncalls(), 1);
    clip = await prisma.clip.findUniqueOrThrow({ where: { id: c2.id } });
    assert.deepEqual([clip.layout, clip.camInfo], ["split", null]);

    // A typed-in box always wins (and nothing new is remembered).
    await prisma.streamer.update({ where: { id: st.id }, data: { facecam: "0.7,0.05,0.28,0.3", facecamAuto: null } });
    const c3 = await mk();
    assert.match(await runCut(c3.id), /split \(your webcam box\)/);
    assert.equal(ncalls(), 1);
    assert.equal((await prisma.streamer.findUniqueOrThrow({ where: { id: st.id } })).facecamAuto, null);

    // Blur in Settings: no face check at all.
    await prisma.settings.update({ where: { id: "main" }, data: { layout: "blur" } });
    const c4 = await mk();
    assert.match(await runCut(c4.id), /blur \(blur chosen\)/);
    assert.equal(ncalls(), 1);

    // Detector broken (no OpenCV): the clip is still cut, in blur, and nothing breaks.
    process.env.PYTHON = path.join(dir, "no-such-python");
    await prisma.settings.update({ where: { id: "main" }, data: { layout: "auto" } });
    await prisma.streamer.update({ where: { id: st.id }, data: { facecam: null } });
    const c5 = await mk();
    assert.match(await runCut(c5.id), /blur \(face check failed, used blur/);
    assert.equal((await prisma.clip.findUniqueOrThrow({ where: { id: c5.id } })).camInfo, null, "a failed check isn't cached");
  } finally {
    process.env.PYTHON = oldPy;
  }
});

// ---------- db push upgrade ----------
test("db push upgrade from the v1.8.0 schema (9bf0915) with rows: no prompt, rows kept, new columns defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV180Schema(now);
  const git = spawnSync("git", ["show", "9bf0915:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 9bf0915 one");
  const uniques = (s: string) => (s.match(/@unique|@@unique|@@id/g) ?? []).length;
  assert.equal(uniques(now), uniques(old), "no new unique constraints");
  const up = path.join(dir, "upgrade");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "old.prisma"), old);
  const env = { ...process.env, DATABASE_URL: `file:${path.join(up, "krew.db")}` };
  const push = (schema: string) => spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schema], { env, encoding: "utf8" });
  const first = push(path.join(up, "old.prisma"));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const sql = (q: string) => execFileSync(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(env.DATABASE_URL)} } } });
    p.$queryRawUnsafe(${JSON.stringify(q)}).then((r) => { console.log(JSON.stringify(r, (k, v) => typeof v === "bigint" ? Number(v) : v)); return p.$disconnect(); });
  `], { encoding: "utf8", cwd: ROOT });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, facecam, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, '0.7,0,0.3,0.3', 0, 0)`);
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'twitch_clip', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, duration, winStart, winLength, words, editStyle, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 30, 7.5, 32, '[]', 'hype', 0, 0)`);
  sql(`INSERT INTO Settings (id) VALUES ('main')`);
  assert.deepEqual(JSON.parse(sql("SELECT layout FROM Settings")), [{ layout: "blur" }]);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, status, editStyle, layout, camInfo FROM Clip")), [{ id: "c1", status: "pending", editStyle: "hype", layout: null, camInfo: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT facecam, facecamAuto FROM Streamer")), [{ facecam: "0.7,0,0.3,0.3", facecamAuto: null }]);
  // The existing value is kept (the worker's one-time migration moves blur -> auto), the flag defaults to false.
  assert.deepEqual(JSON.parse(sql("SELECT layout, migratedAutoLayout FROM Settings")), [{ layout: "blur", migratedAutoLayout: false }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
