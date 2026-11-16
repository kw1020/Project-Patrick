// "What if you jumped into a hole through the Earth?": shots timed to voice/words.json (Kokoro af_heart x1.2, 64.2 s).
// Sets: a backyard with the hole, an Arctic drill rig, a big cutaway Earth in space, the exit hole in the open ocean,
// a marble in a bowl, and the inside of the core.
export const FPS = 30;
export const TOTAL = 1960;
export const D0 = 0;
export type V3 = [number, number, number];

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
export const hh = (i: number, s = 0) => { const v = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return v - Math.floor(v); };

export const YARD: V3 = [150, 0, -40];             // the hole is at YARD; the house behind it
export const RIG: V3 = [-300, 0, 300];
export const EARTH: V3 = [0, 260, 3000], ER = 40;  // cutaway globe in space, tunnel along its y axis
export const OCEAN: V3 = [-2600, 0, -2600];          // the exit hole, in the middle of the sea
export const BOWL: V3 = [300, 0, 300];
export const CORE: V3 = [0, 1000, -3000];

/** where the faller is along the tunnel: +1 = top (home), -1 = bottom (other side), 0 = centre */
export const T_JUMP = 744 / FPS;
export const T_STOP = 1009 / FPS;
/** the first trip: top -> bottom between the jump and the stop (cosine: speed peaks at the centre) */
export const fallU = (t: number) => (t < T_JUMP ? 1 : t > T_STOP ? -1 : Math.cos(Math.PI * (t - T_JUMP) / (T_STOP - T_JUMP)));
/** back and forth forever (shots 10, 12): one swing per 1.6 s */
export const swingU = (t: number, t0: number, period = 3.2) => Math.cos((2 * Math.PI * (t - t0)) / period);
/** with air: every trip a little shorter, settling at the centre */
export const T_AIR = 1737 / FPS;
export const airU = (t: number) => Math.exp(-(t - T_AIR) * 0.75) * Math.cos((2 * Math.PI * (t - T_AIR)) / 2.4);
/** the marble in the bowl (shot 11) */
export const marbleA = (t: number) => 0.9 * Math.cos((2 * Math.PI * (t - 1513 / FPS)) / 1.7);

export type Light = "day" | "golden" | "night" | "candle" | "space" | "core";
export type ShotDef = { id: number; a: number; b: number; light: Light; sunAz?: number; sunEl?: number };
export const SHOTS: ShotDef[] = [
  { id: 1, a: 0, b: 80, light: "day", sunAz: 140 },
  { id: 2, a: 80, b: 167, light: "space", sunAz: 110, sunEl: 25 },
  { id: 3, a: 167, b: 348, light: "day", sunAz: 130, sunEl: 25 },
  { id: 4, a: 348, b: 660, light: "space", sunAz: 110, sunEl: 25 },
  { id: 5, a: 660, b: 761, light: "day", sunAz: 140 },
  { id: 6, a: 761, b: 1009, light: "space", sunAz: 110, sunEl: 25 },
  { id: 7, a: 1009, b: 1149, light: "day", sunAz: 140 },
  { id: 8, a: 1149, b: 1278, light: "day", sunAz: 140 },
  { id: 9, a: 1278, b: 1513, light: "space", sunAz: 110, sunEl: 25 },
  { id: 10, a: 1513, b: 1618, light: "day", sunAz: 140, sunEl: 50 },
  { id: 11, a: 1618, b: 1737, light: "day", sunAz: 140 },
  { id: 12, a: 1737, b: 1866, light: "space", sunAz: 110, sunEl: 25 },
  { id: 13, a: 1866, b: TOTAL, light: "core", sunAz: 60, sunEl: 30 },
];
export const XFADE: Record<number, number> = { 13: 10 };
export const FLASH_AT = 80;

export const shotAt = (f: number) => SHOTS.find((s) => f >= s.a && f < s.b) ?? SHOTS[SHOTS.length - 1];
export const layersAt = (f: number): { id: number; alpha: number }[] => {
  for (const s of SHOTS) {
    const x = XFADE[s.id];
    if (x && f >= s.a - x / 2 && f < s.a + x / 2) return [{ id: s.id - 1, alpha: 1 }, { id: s.id, alpha: (f - (s.a - x / 2) + 1) / (x + 1) }];
  }
  return [{ id: shotAt(f).id, alpha: 1 }];
};

export type Cam = { pos: V3; look: V3; fov: number; roll: number };
type Shot = Partial<Cam> & { pos: V3; look: V3 };
type Key = { f: number; dur?: number; cut?: boolean; s: (f: number) => Shot };
export const glide = (u: number) => { const x = clamp01(u); return x * x * x * (x * (6 * x - 15) + 10); };
const mix = (a: Cam, b: Cam, k: number): Cam => ({
  pos: a.pos.map((v, i) => v + (b.pos[i] - v) * k) as V3, look: a.look.map((v, i) => v + (b.look[i] - v) * k) as V3,
  fov: a.fov + (b.fov - a.fov) * k, roll: a.roll + (b.roll - a.roll) * k,
});
const full = (c: Shot): Cam => ({ fov: 40, roll: 0, ...c });
const run = (keys: Key[], f: number) => {
  let cur = full(keys[0].s(f));
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    if (f < k.f) break;
    cur = k.cut ? full(k.s(f)) : mix(cur, full(k.s(f)), glide((f - k.f) / (k.dur ?? 24)));
  }
  return cur;
};
const pushK = (f: number, f0: number, rate: number, punch = 0, n = 35) => {
  const x = Math.max(0, f - f0);
  let s = rate * x;
  if (punch > rate) for (let i = 0; i < Math.min(x, n); i++) s += (punch - rate) * Math.max(0, Math.min(1, (i + 0.5) / 8, (n - i - 0.5) / 8));
  return Math.exp(-s);
};
const dolly = (pos: V3, look: V3, k: number, rest: Partial<Cam> = {}): Shot =>
  ({ pos: [look[0] + (pos[0] - look[0]) * k, look[1] + (pos[1] - look[1]) * k, look[2] + (pos[2] - look[2]) * k], look, ...rest });
const add = (a: V3, x: number, y: number, z: number): V3 => [a[0] + x, a[1] + y, a[2] + z];
const T = (f: number) => f / FPS;
// the cutaway is opened toward -z (the camera side); the wedge faces the lens
const EW = (d: number, y = 0, x = 0): V3 => add(EARTH, x, y, -d);

const CAMS: Record<number, Key[]> = {
  1: [{ f: 0, s: (f) => dolly(add(YARD, -0.6, 1.8, -4.6), add(YARD, -0.2, 0.8, 0.6), pushK(f, 0, 0.0025), { fov: 42 }) }],
  2: [{ f: 76, s: (f) => dolly(EW(150, 10, 25), add(EARTH, 0, 0, 0), pushK(f, 76, 0.0018), { fov: 40 }) }],
  3: [
    { f: 163, s: (f) => dolly(add(RIG, 10, 4, -26), add(RIG, 0, 10, 0), pushK(f, 163, 0.0018), { fov: 44 }) },
    { f: 296, dur: 34, s: (f) => dolly(add(RIG, 5, 1.8, -12), add(RIG, 0, 0.5, 0), pushK(f, 296, 0.002), { fov: 40, roll: 0.03 }) },
  ],
  4: [
    { f: 344, s: (f) => dolly(add(EARTH, 0.5, ER + 3, -14), add(EARTH, 0, ER - 1.5, 0), pushK(f, 344, 0.002), { fov: 38 }) },
    { f: 380, dur: 36, s: (f) => dolly(EW(150, 10, 25), add(EARTH, 0, 0, 0), pushK(f, 380, 0.0012), { fov: 40 }) },
    { f: 470, dur: 40, s: (f) => dolly(EW(70, 4, 12), add(EARTH, 0, 0, 0), pushK(f, 470, 0.0018), { fov: 40, roll: -0.03 }) },
    { f: 590, cut: true, s: (f) => dolly(EW(14, 1, 3), add(EARTH, 0, 0, -2), pushK(f, 590, 0.0025, 0.006, 25), { fov: 38 }) },
  ],
  5: [
    { f: 656, s: (f) => dolly(add(YARD, 1.6, 1.5, -4.6), add(YARD, 0.2, 0.9, 0.3), pushK(f, 656, 0.0025), { fov: 40 }) },
    { f: 742, cut: true, s: (f) => dolly(add(YARD, 0.4, 3.4, -2.6), add(YARD, 0, -0.5, 0.2), pushK(f, 742, 0.002), { fov: 44, roll: 0.04 }) },
  ],
  6: [
    { f: 757, s: (f) => dolly(EW(110, 8, 18), add(EARTH, 0, 0, 0), pushK(f, 757, 0.0015), { fov: 40 }) },
    { f: 868, dur: 20, s: (f) => dolly(EW(34, 2, 6), add(EARTH, 0, 0, 0), pushK(f, 868, 0.002), { fov: 38, roll: 0.04 }) },
    { f: 940, dur: 30, s: (f) => dolly(EW(110, -8, 18), add(EARTH, 0, -6, 0), pushK(f, 940, 0.0015), { fov: 40 }) },
  ],
  7: [
    { f: 1005, s: (f) => dolly(add(OCEAN, 0.8, 1.2, -3.2), add(OCEAN, 0, 0.9, 0), pushK(f, 1005, 0.0025), { fov: 38 }) },
    { f: 1086, dur: 24, s: (f) => dolly(add(OCEAN, 0.5, 1.2, -2.6), add(OCEAN, 0, 1.1, 0), pushK(f, 1086, 0.002), { fov: 36, roll: 0.03 }) },
  ],
  8: [{ f: 1145, s: (f) => { const u = glide((f - 1150) / 110); return { pos: add(OCEAN, 0.8 + 6 * u, 1.2 + 34 * u, -3.2 - 30 * u), look: add(OCEAN, 0, 0.9 - 0.9 * u, 0), fov: 38 + 6 * u, roll: 0 }; } }],
  9: [
    { f: 1274, s: (f) => dolly(EW(100, 4, 16), add(EARTH, 0, 0, 0), pushK(f, 1274, 0.0012), { fov: 40 }) },
  ],
  10: [{ f: 1509, s: (f) => dolly(add(BOWL, 0.1, 1.7, -1.3), add(BOWL, 0, 0.18, 0.05), pushK(f, 1509, 0.002), { fov: 44 }) }],
  11: [
    { f: 1614, s: (f) => dolly(add(YARD, 1.4, 1.5, -4.8), add(YARD, 0.2, 1.1, 0.3), pushK(f, 1614, 0.0022), { fov: 40 }) },
  ],
  12: [
    { f: 1733, s: (f) => dolly(EW(100, 4, 16), add(EARTH, 0, 0, 0), pushK(f, 1733, 0.0012), { fov: 40 }) },
    { f: 1830, dur: 36, s: (f) => dolly(EW(30, 1, 5), add(EARTH, 0, 0, 0), pushK(f, 1830, 0.002), { fov: 38 }) },
  ],
  13: [{ f: 1862, s: (f) => dolly(add(CORE, 0.3, 1.6, -4.2), add(CORE, 0, 1.4, 0), pushK(f, 1862, 0.0022), { fov: 38, roll: 0.03 }) }],
};

const KICKS: [number, number][] = [[T_STOP, 0.8], [1009 / FPS, 0.0]];
export const kickAt = (t: number) => {
  let a = 0;
  for (const [t0, g] of KICKS) {
    const n = Math.floor((t - t0) * FPS + 1e-6);
    if (n >= 0 && n < 7) a += g * (n % 2 ? -1 : 1) * (1 - n / 7) ** 1.5;
  }
  return a;
};
export const camAt = (id: number, f: number): Cam => {
  const c = run(CAMS[id], f), a = kickAt(T(f));
  if (!a) return c;
  const d: V3 = [c.look[0] - c.pos[0], c.look[1] - c.pos[1], c.look[2] - c.pos[2]];
  const L = Math.hypot(...d), h = Math.hypot(d[0], d[2]) || 1;
  const m = (3 / 640) * Math.tan((c.fov * Math.PI) / 360) * L * a;
  return { ...c, look: [c.look[0] - (d[2] / h) * m, c.look[1] + 0.6 * m, c.look[2] + (d[0] / h) * m], roll: c.roll + a * 0.004 };
};

export type Dof = { f: number; dur?: number; cInf: number; focus?: (f: number) => V3 };
export const DOF: Dof[] = [
  { f: 0, cInf: 10 }, { f: 76, cInf: 0 }, { f: 163, cInf: 0 }, { f: 296, dur: 34, cInf: 6 }, { f: 344, cInf: 0 }, { f: 656, cInf: 10 },
  { f: 742, cInf: 6 }, { f: 757, cInf: 0 }, { f: 1005, cInf: 10 }, { f: 1145, cInf: 6 }, { f: 1274, cInf: 0 }, { f: 1509, cInf: 10 },
  { f: 1614, cInf: 10 }, { f: 1733, cInf: 0 }, { f: 1862, cInf: 12 },
];
export const dofAt = (f: number) => {
  let i = 0; while (i + 1 < DOF.length && f >= DOF[i + 1].f) i++;
  const d = DOF[i], p = DOF[Math.max(0, i - 1)];
  const k = d.dur ? Math.min(1, (f - d.f) / d.dur) : 1;
  return { cInf: p.cInf + (d.cInf - p.cInf) * k, focus: d.focus };
};
