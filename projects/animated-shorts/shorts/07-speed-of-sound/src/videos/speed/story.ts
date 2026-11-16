// "What if you could run at the speed of sound?": shots timed to voice/words.json (Kokoro af_heart x1.2, 57.2 s).
// The runner runs up the city street (z); on screen we show the speed with tracking shots, streaks and effects.
export const FPS = 30;
export const TOTAL = 1745;
export const D0 = 0;
export type V3 = [number, number, number];

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
export const hh = (i: number, s = 0) => { const v = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return v - Math.floor(v); };

// places shared with the city set (world.ts)
export const SHOP2: V3 = [-9.5, 0, 22];
export const SPORT: V3 = [4.6, 0, 30];
export const QUEUE_X = -7.8, QUEUE_Z0 = 38, QUEUE_Z1 = 58;
export const PLANT: V3 = [400, 0, 0];
export const ROOF: V3 = [-14, 22, 6];
export const SUBWAY: V3 = [7.9, 0, -30];
export const PORCH: V3 = [150, 0, -40], DECK_H = 0.45;
export const SHOWROOM_Z = 72;
export const BOOKS: V3 = [9.5, 0, -60];
export const BEACH: V3 = [-400, 0, 0];
export const HIGHWAY: V3 = [0, 0, -400];
export const PAPER: V3 = [0, 0, -92], PILE_H = 4.0;
export const floodY = (_t: number) => -4.2;
export const erosion = (_t: number) => 0;
export const waveX = (_t: number) => 0;
export const T_PLANTS = [0, 0, 0];

// ---------------- the run ----------------
export const RUN_X = 1.2;
export const START_Z = -100;
export const T_GO = 202 / FPS;
export const V_SHOW = 45; // on-screen speed in m/s (the real 343 m/s would cross the set in under a second)
/** runner z per shot */
export const runZ = (id: number, t: number) => {
  switch (id) {
    case 1: return START_Z;
    case 2: { const u = Math.max(0, t - T_GO); return START_Z + (u < 0.75 ? 30 * u * u : 16.9 + V_SHOW * (u - 0.75)); }
    case 3: return -110 + 30 * (t - 303 / FPS); // riding shots: camera and runner move together, the street streaks past
    case 4: return -100 + 30 * (t - 506 / FPS);
    case 5: return 20 + V_SHOW * (t - 606 / FPS);
    case 6: return 8 + V_SHOW * (t - 744 / FPS);
    case 9: return -110 + 30 * (t - 1029 / FPS);
    case 11: { const u = t - 1400 / FPS, z0 = 40 - 12.4; return z0 + (u < 0 ? V_SHOW * u : V_SHOW * Math.min(u, 0.55) - 40.9 * Math.min(u, 0.55) ** 2); }
    default: return 0;
  }
};
/** how far the street has slid past a "riding along" camera (shots 3, 4, 9) */
export const ride = (t: number, t0: number) => ((V_SHOW * (t - t0)) % 64 + 64) % 64;
export const T_STOP = 1400 / FPS, T_SLAM = 1465 / FPS;
/** the convertible in the window analogy (shot 10): slow in the parking lot, fast on the highway */
export const T_FAST = 1315 / FPS;
export const carZ = (t: number) => { const a = 1207 / FPS; return -110 + 3 * (t - a) + (t > T_FAST ? 14 * (t - T_FAST) ** 2 : 0); };
export const T_BILL = 1688 / FPS;

// ---------------- shots ----------------
export type Light = "day" | "golden" | "night" | "candle";
export type ShotDef = { id: number; a: number; b: number; light: Light; sunAz?: number; sunEl?: number };
export const SHOTS: ShotDef[] = [
  { id: 1, a: 0, b: 178, light: "day", sunAz: 130 },
  { id: 2, a: 178, b: 303, light: "day", sunAz: 130 },
  { id: 3, a: 303, b: 506, light: "day", sunAz: 150 },
  { id: 4, a: 506, b: 572, light: "day", sunAz: 150 },
  { id: 5, a: 572, b: 706, light: "day", sunAz: 140 },
  { id: 6, a: 706, b: 845, light: "day", sunAz: 140 },
  { id: 7, a: 845, b: 918, light: "golden", sunAz: 40, sunEl: 15 },
  { id: 8, a: 918, b: 1029, light: "day", sunAz: 140 },
  { id: 9, a: 1029, b: 1207, light: "day", sunAz: 130 },
  { id: 10, a: 1207, b: 1388, light: "day", sunAz: 140 },
  { id: 11, a: 1388, b: 1585, light: "day", sunAz: 140 },
  { id: 12, a: 1585, b: TOTAL, light: "day", sunAz: 150 },
];
export const XFADE: Record<number, number> = { 7: 8, 8: 8 };
export const FLASH_AT = 178;

export const shotAt = (f: number) => SHOTS.find((s) => f >= s.a && f < s.b) ?? SHOTS[SHOTS.length - 1];
export const layersAt = (f: number): { id: number; alpha: number }[] => {
  for (const s of SHOTS) {
    const x = XFADE[s.id];
    if (x && f >= s.a - x / 2 && f < s.a + x / 2) return [{ id: s.id - 1, alpha: 1 }, { id: s.id, alpha: (f - (s.a - x / 2) + 1) / (x + 1) }];
  }
  return [{ id: shotAt(f).id, alpha: 1 }];
};

// ---------------- camera ----------------
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
const T = (f: number) => f / FPS;
// riding along: the runner stays at zR in the middle of the street; the camera rides with him while the street
// (a 64 m repeat of buildings, lamps, cars) slides past
export const RIDE_Z = -60;

const CAMS: Record<number, Key[]> = {
  1: [
    { f: 0, s: (f) => dolly([RUN_X + 0.2, 1.6, START_Z - 3.8], [RUN_X, 1.4, START_Z], pushK(f, 0, 0.0022), { fov: 38 }) },
    { f: 100, dur: 30, s: (f) => dolly([RUN_X + 0.1, 1.6, START_Z - 2.7], [RUN_X, 1.5, START_Z], pushK(f, 100, 0.002), { fov: 36, roll: 0.03 }) },
  ],
  2: [
    { f: 178, s: (f) => dolly([RUN_X - 4.5, 1.2, START_Z + 0.3], [RUN_X, 1.1, START_Z + 0.2], pushK(f, 178, 0.002), { fov: 42 }) },
    { f: 235, cut: true, s: (f) => { const z = runZ(2, T(f)); return { pos: [RUN_X - 3.6, 1.2, z], look: [RUN_X, 1.1, z], fov: 44, roll: -0.03 }; } },
  ],
  3: [
    { f: 303, s: (f) => { const z = runZ(3, T(f)); return dolly([RUN_X + 0.15, 1.75, z + 2.6], [RUN_X, 1.65, z], pushK(f, 303, 0.002), { fov: 38 }); } },
    { f: 438, dur: 20, s: (f) => { const z = runZ(3, T(f)); return dolly([RUN_X + 0.1, 1.72, z + 1.9], [RUN_X, 1.7, z], pushK(f, 438, 0.002, 0.006, 25), { fov: 34, roll: 0.04 }); } },
  ],
  4: [
    { f: 506, s: (f) => { const z = runZ(4, T(f)); return dolly([RUN_X + 0.1, 1.72, z + 1.8], [RUN_X, 1.72, z], pushK(f, 506, 0.003), { fov: 34 }); } },
  ],
  5: [
    { f: 572, s: (f) => dolly([-2.8, 2.2, 26], [1.0, 1.6, -20], pushK(f, 572, 0.0015), { fov: 44 }) },
  ],
  6: [
    { f: 706, s: (f) => dolly([-3.6, 1.6, 3.5], [5.6, 2.2, 9.5], pushK(f, 706, 0.002), { fov: 42 }) },
    { f: 778, cut: true, s: (f) => { const z = runZ(6, T(f)); return { pos: [RUN_X + 1.0, 2.0, z + 5.5], look: [RUN_X + 1.5, 1.6, z - 30], fov: 44, roll: 0 }; } },
  ],
  7: [
    { f: 841, s: (f) => dolly([0, 150, -170], [0, 0, 15], pushK(f, 841, 0.001), { fov: 44 }) },
  ],
  8: [
    { f: 914, s: (f) => dolly([PORCH[0] + 1.6, 2.0, PORCH[2] + 2.6], [PORCH[0] + 1.6, 1.0, PORCH[2] - 1.0], pushK(f, 914, 0.0025, 0.006, 25), { fov: 40 }) },
  ],
  9: [
    { f: 1025, s: (f) => { const z = runZ(9, T(f)); return dolly([RUN_X - 3.2, 1.3, z - 0.6], [RUN_X, 1.2, z + 0.4], pushK(f, 1025, 0.0018), { fov: 42 }); } },
    { f: 1120, dur: 22, s: (f) => { const z = runZ(9, T(f)); return dolly([RUN_X - 2.4, 1.25, z - 0.2], [RUN_X, 1.25, z + 0.5], pushK(f, 1120, 0.002), { fov: 40, roll: -0.04 }); } },
  ],
  10: [
    { f: 1203, s: (f) => { const z = carZ(T(f)); return { pos: [-3.2, 1.7, z + 0.6], look: [1.6, 1.15, z + 0.2], fov: 40, roll: 0 }; } },
  ],
  11: [
    { f: 1384, s: (f) => dolly([RUN_X - 4.2, 1.4, 41.5], [RUN_X, 1.1, 39.5], pushK(f, 1384, 0.002), { fov: 42 }) },
    { f: 1463, cut: true, s: (f) => dolly([RUN_X - 0.3, 1.65, 40 + 3.2], [RUN_X + 0.2, 1.55, 40], pushK(f, 1463, 0.0025), { fov: 36, roll: 0.04 }) },
  ],
  12: [
    { f: 1581, s: (f) => dolly([SHOP2[0] + 4.6, 1.7, SHOP2[2] - 3.2], [SHOP2[0] + 1.7, 1.45, SHOP2[2] + 0.4], pushK(f, 1581, 0.0022), { fov: 40 }) },
    { f: 1684, dur: 30, s: (f) => dolly([SHOP2[0] + 5.6, 2.6, SHOP2[2] - 6.5], [SHOP2[0] + 2.6, 0.6, SHOP2[2] - 1.5], pushK(f, 1684, 0.0015), { fov: 46, roll: -0.03 }) },
  ],
};

const KICKS: [number, number][] = [[202 / FPS, 1.0], [527 / FPS, 1.2], [606 / FPS, 1.6], [669 / FPS, 0.8], [T_SLAM, 1.6]];
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
  { f: 0, cInf: 12 }, { f: 178, cInf: 8 }, { f: 235, cInf: 4 }, { f: 303, cInf: 14 }, { f: 506, cInf: 14 }, { f: 572, cInf: 0 },
  { f: 706, cInf: 6 }, { f: 778, cInf: 4 }, { f: 841, cInf: 0 }, { f: 914, cInf: 12 }, { f: 1025, cInf: 6 }, { f: 1203, cInf: 6 },
  { f: 1384, cInf: 6 }, { f: 1463, cInf: 13 }, { f: 1581, cInf: 10 }, { f: 1684, dur: 30, cInf: 4 },
];
export const dofAt = (f: number) => {
  let i = 0; while (i + 1 < DOF.length && f >= DOF[i + 1].f) i++;
  const d = DOF[i], p = DOF[Math.max(0, i - 1)];
  const k = d.dur ? Math.min(1, (f - d.f) / d.dur) : 1;
  return { cInf: p.cInf + (d.cInf - p.cInf) * k, focus: d.focus };
};
