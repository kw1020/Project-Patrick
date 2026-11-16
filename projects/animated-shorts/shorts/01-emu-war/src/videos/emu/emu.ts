// Our own cartoon emu, drawn flat on a 1000 x 1000 canvas (feet at y = 975), same ink and shading language as toon.ts.
// Side view faces screen-right; front view for close-ups. Gaits: stand, walk, run, peck (head to the ground).
import { Pen, INK, mul } from "./toon";

type P2 = [number, number];
export type EmuGait = "stand" | "walk" | "run" | "peck";
export type EmuExpr = "neutral" | "smug" | "shock" | "happy";
export type EmuOpts = { gait: EmuGait; phase: number; expr: EmuExpr; blink: number; light: number; seed: number };

const BODY = "#5b4433", BODY_HI = "#7d6049", NECK = "#8fa3c2", HEAD = "#3e3530", LEG = "#857d72", BEAK = "#4d443c", IRIS = "#c8552c";
const SH: [number, number, number] = [0.62, 0.62, 0.72];
const rnd = (s: number, k: number) => { const v = Math.sin(s * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };

/** two-bone leg whose middle joint (the emu's ankle) bends backward (-x) */
const ikBack = (hip: P2, foot: P2, l1: number, l2: number): P2 => {
  const dx = foot[0] - hip[0], dy = foot[1] - hip[1], d = Math.max(1, Math.min(Math.hypot(dx, dy), l1 + l2 - 0.5));
  const A = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))), k = Math.atan2(dy, dx) + A;
  return [hip[0] + l1 * Math.cos(k), hip[1] + l1 * Math.sin(k)];
};

/** shaggy feather body: ellipse whose lower half breaks into a fringe of points */
const shag = (cx: number, cy: number, rx: number, ry: number, seed: number, tail: number): P2[] => {
  const pts: P2[] = [];
  const n = 64;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let r = 1;
    const below = Math.sin(a) > 0.05;
    if (below) r += (i % 2 ? 0.13 : -0.02) * (0.7 + 0.6 * rnd(seed, i));
    let x = cx + rx * r * Math.cos(a), y = cy + ry * r * Math.sin(a);
    if (Math.cos(a) < -0.55) { x -= tail * (-Math.cos(a) - 0.55); y += tail * 0.5 * (-Math.cos(a) - 0.55); } // drooping tail
    pts.push([x, y]);
  }
  return pts;
};

const eye = (p: Pen, x: number, y: number, r: number, expr: EmuExpr, blink: number, look = 1) => {
  if (blink >= 0.9) { p.stroke([[x - r, y], [x + r, y]], r * 0.35); return; }
  if (expr === "happy") { p.arc(x, y + r * 0.3, r * 0.9, r * 0.8, 200, 340, r * 0.35); return; }
  const R = expr === "shock" ? r * 1.35 : r;
  p.ell(x, y, R, R, "#ffffff", r * 0.28);
  p.dot(x + look * R * 0.25, y + R * 0.05, expr === "shock" ? R * 0.28 : R * 0.55, IRIS);
  p.dot(x + look * R * 0.25, y + R * 0.05, expr === "shock" ? R * 0.16 : R * 0.3, INK);
  const lid = Math.max(blink, expr === "smug" ? 0.5 : 0);
  if (lid > 0.05) {
    // lid: head colour over the top of the eye, flat lower edge
    const yl = y - R + 2 * R * lid;
    const pts: P2[] = [];
    for (let i = 0; i <= 16; i++) { const a = Math.PI + (i / 16) * Math.PI; pts.push([x + (R + 1) * Math.cos(a), y + (R + 1) * Math.sin(a)]); }
    pts.push([x + R + 1, yl], [x - R - 1, yl]);
    p.poly(pts, HEAD, 0);
    p.stroke([[x - R * 1.05, yl], [x + R * 1.05, yl]], r * 0.3);
  }
};

export const emuSide = (p: Pen, o: EmuOpts) => {
  const ph = ((o.phase % 1) + 1) % 1, run = o.gait === "run", walk = o.gait === "walk", peck = o.gait === "peck";
  const bob = run ? -26 * Math.abs(Math.sin(2 * Math.PI * ph)) : walk ? -8 * Math.abs(Math.sin(2 * Math.PI * ph)) : 0;
  const cx = 450, cy = 470 + bob + (peck ? 30 : 0), tilt = run ? -0.12 : peck ? 0.18 : 0;
  const hip: P2 = [cx + 40, cy + 95];
  const S = run ? 250 : walk ? 120 : 0, lift = run ? 120 : 55;
  // legs: stance foot slides back on the ground, swing foot lifts and reaches forward
  const leg = (k: number, far: boolean) => {
    const u = (ph + k * 0.5) % 1;
    let fx: number, fy: number;
    if (S === 0) { fx = hip[0] + (far ? -40 : 30); fy = 975; }
    else if (u < 0.5) { fx = hip[0] + S / 2 - S * (u / 0.5); fy = 975; }
    else { const v = (u - 0.5) / 0.5; fx = hip[0] - S / 2 + S * v; fy = 975 - lift * Math.sin(Math.PI * v); }
    const ank = ikBack(hip, [fx, fy], 222, 205);
    const col = far ? mul(LEG, [0.78, 0.78, 0.84]) : LEG;
    p.line([hip, ank, [fx, fy]], col, 30);
    // three toes forward
    for (const [dx, dy] of [[52, 4], [44, -10], [-22, 2]] as P2[]) p.line([[fx, fy - 4], [fx + dx, fy - 4 + dy]], col, 13);
  };
  leg(1, true);
  // neck + head target
  let head: P2 = [cx + 235, cy - 330];
  if (run) head = [cx + 320, cy - 230];
  if (walk) head = [cx + 245 + 12 * Math.sin(2 * Math.PI * ph), cy - 320];
  if (peck) head = [cx + 320, 880 + 20 * Math.sin(2 * Math.PI * ph * 2)];
  const base: P2 = [cx + 150, cy - 55], mid: P2 = [(base[0] + head[0]) / 2 + (peck ? 50 : -30), (base[1] + head[1]) / 2 + (peck ? -60 : 0)];
  const neckPts: P2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, s = 1 - t;
    neckPts.push([s * s * base[0] + 2 * s * t * mid[0] + t * t * head[0], s * s * base[1] + 2 * s * t * mid[1] + t * t * head[1]]);
  }
  p.line(neckPts, NECK, 40);
  p.line(neckPts.slice(0, 6), BODY, 66); // feathered lower neck
  // body
  p.rot = [tilt, cx, cy];
  const bp = shag(cx, cy, 215, 150, o.seed, 70);
  p.shadedFill(bp, BODY, mul(BODY, SH), o.light, 215, 0.4);
  for (let i = 0; i < 9; i++) { // feather strokes
    const x = cx - 150 + 38 * i + 10 * rnd(o.seed, i + 30), y = cy - 40 + 60 * rnd(o.seed, i + 50);
    p.stroke([[x, y], [x - 30, y + 45]], 7, BODY_HI);
  }
  p.inkRing(bp, 11, o.light + Math.PI, 0.45);
  p.rot = null;
  leg(0, false);
  // head: small dark oval along the neck's end, flat wide beak
  const dir = Math.atan2(head[1] - neckPts[10][1], head[0] - neckPts[10][0]);
  const hd = peck ? dir : Math.max(-0.5, Math.min(0.5, dir + Math.PI / 2)) * 0.4;
  const hx = head[0], hy = head[1];
  const c = Math.cos(hd), s2 = Math.sin(hd);
  const R = (x: number, y: number): P2 => [hx + x * c - y * s2, hy + x * s2 + y * c];
  p.poly([R(36, -15), R(118, 2), R(38, 19)], BEAK, 8);
  p.ell(hx, hy, 58, 45, HEAD, 10, 0, 360, (hd * 180) / Math.PI);
  const [ex, ey] = R(8, -10);
  eye(p, ex, ey, 19, o.expr, o.blink);
  const [nx, ny] = R(76, -2); p.dot(nx, ny, 3.5, INK);
};

export const emuFront = (p: Pen, o: EmuOpts) => {
  const cx = 500, cy = 560;
  // legs
  for (const s of [-1, 1]) {
    const col = s < 0 ? mul(LEG, [0.85, 0.85, 0.9]) : LEG;
    p.line([[cx + s * 60, cy + 90], [cx + s * 72, 760], [cx + s * 64, 972]], col, 32);
    for (const dx of [-36, 0, 36]) p.line([[cx + s * 64, 970], [cx + s * 64 + dx, 985]], col, 13);
  }
  const bp = shag(cx, cy, 230, 175, o.seed, 0);
  p.shadedFill(bp, BODY, mul(BODY, SH), o.light, 230, 0.4);
  for (let i = 0; i < 10; i++) {
    const x = cx - 170 + 38 * i, y = cy - 30 + 70 * rnd(o.seed, i + 40);
    p.stroke([[x, y], [x + (i < 5 ? -18 : 18), y + 50]], 8, BODY_HI);
  }
  p.inkRing(bp, 12, o.light + Math.PI, 0.45);
  p.line([[cx, cy - 120], [cx + 4, 330], [cx, 200]], NECK, 44);
  p.line([[cx, cy - 120], [cx + 2, cy - 200]], BODY, 74);
  // head
  p.ell(cx, 170, 56, 48, HEAD, 10);
  eye(p, cx - 26, 160, 15, o.expr, o.blink, 0);
  eye(p, cx + 26, 160, 15, o.expr, o.blink, 0);
  p.ell(cx, 198, 30, 14, BEAK, 7);
  p.dot(cx - 9, 196, 3, INK); p.dot(cx + 9, 196, 3, INK);
};
