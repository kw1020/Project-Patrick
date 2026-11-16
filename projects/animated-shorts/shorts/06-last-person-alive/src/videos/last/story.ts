// "What if you were the last person alive?": shots timed to voice/words.json (Kokoro af_heart x1.2, 59.9 s),
// story kinematics (plants shutting down, flooding, waves, the paper pile) and the template camera grammar.
export const FPS = 30;
export const TOTAL = 1830;
export const D0 = 0;
export type V3 = [number, number, number];

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
export const hh = (i: number, s = 0) => { const v = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return v - Math.floor(v); };

// ---------------- places (street runs along z; road x in [-6, 6], sidewalks to +-9.5) ----------------
export const YOU1: V3 = [1.5, 0, 10];
export const SHOP2: V3 = [-9.5, 0, 22];
export const SPORT: V3 = [4.6, 0, 30];
export const QUEUE_Z0 = 38, QUEUE_Z1 = 58, QUEUE_X = -7.8;
export const PLANT: V3 = [400, 0, 0];
export const ROOF: V3 = [-14, 22, 6];
export const SUBWAY: V3 = [7.9, 0, -30];          // stair opening x 6.6..9.2, z -34..-26, bottom y -4.2
export const PORCH: V3 = [150, 0, -40], DECK_H = 0.45;
export const SHOWROOM_Z = 72;
export const BOOKS: V3 = [9.5, 0, -60];
export const BEACH: V3 = [-400, 0, 0];
export const HIGHWAY: V3 = [0, 0, -400];
export const PAPER: V3 = [0, 0, -92], PILE_H = 4.0;

// ---------------- timing ----------------
export const T_PLANTS = [353, 365, 381].map((f) => f / FPS);   // "one by one, they shut down"
export const T_FLOOD0 = 575 / FPS, T_FLOOD1 = 705 / FPS;
export const floodY = (t: number) => -4.2 + 3.6 * smooth((t - T_FLOOD0) / (T_FLOOD1 - T_FLOOD0));
export const T_ROT = 734 / FPS, T_BEANS = 779 / FPS;
export const T_START = 987 / FPS;
export const T_WAVES = 1440 / FPS;
/** sandcastle erosion 0 .. 1 (each wave takes a bite) */
export const erosion = (t: number) => clamp01(0.08 * Math.floor(Math.max(0, t - T_WAVES) / 0.9) + 0.25 * smooth((t - T_WAVES) / 2.6));
export const waveX = (t: number) => { const u = ((t - 0.3) % 0.9 + 0.9) % 0.9 / 0.9; return Math.sin(Math.PI * u); };

// ---------------- shots ----------------
export type Light = "day" | "golden" | "night" | "candle";
export type ShotDef = { id: number; a: number; b: number; light: Light; sunAz?: number; sunEl?: number };
export const SHOTS: ShotDef[] = [
  { id: 1, a: 0, b: 173, light: "day", sunAz: 130 },
  { id: 2, a: 173, b: 294, light: "day", sunAz: 140 },
  { id: 3, a: 294, b: 401, light: "day", sunAz: 120 },
  { id: 4, a: 401, b: 571, light: "night", sunAz: 120, sunEl: 40 },
  { id: 5, a: 571, b: 712, light: "day", sunAz: 140 },
  { id: 6, a: 712, b: 823, light: "day", sunAz: 140 },
  { id: 7, a: 823, b: 1003, light: "day", sunAz: 140 },
  { id: 8, a: 1003, b: 1068, light: "day", sunAz: 150 },
  { id: 9, a: 1068, b: 1148, light: "candle", sunAz: 95, sunEl: 12 },
  { id: 10, a: 1148, b: 1352, light: "golden", sunAz: 40, sunEl: 12 },
  { id: 11, a: 1352, b: 1534, light: "day", sunAz: 140 },
  { id: 12, a: 1534, b: 1634, light: "day", sunAz: 150, sunEl: 40 },
  { id: 13, a: 1634, b: 1757, light: "day", sunAz: 140 },
  { id: 14, a: 1757, b: TOTAL, light: "day", sunAz: 140, sunEl: 55 },
];
export const XFADE: Record<number, number> = { 4: 8, 9: 10, 10: 8, 11: 8, 12: 8 };
export const FLASH_AT = 173;

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
const zoom = (pos: V3, look: V3, fov: number, k: number, rest: Partial<Cam> = {}): Shot =>
  ({ pos, look, fov: (360 / Math.PI) * Math.atan(Math.tan((fov * Math.PI) / 360) * k), ...rest });
const add = (a: V3, x: number, y: number, z: number): V3 => [a[0] + x, a[1] + y, a[2] + z];

const CAMS: Record<number, Key[]> = {
  1: [
    { f: 0, s: (f) => zoom([0.3, 1.7, -16], [1.2, 3.2, 30], 44, pushK(f, 0, 0.002)) },
    { f: 93, cut: true, s: (f) => dolly(add(YOU1, 0.15, 1.62, -3.4), add(YOU1, 0, 1.5, 0), pushK(f, 93, 0.0025, 0.006, 25), { fov: 36, roll: 0.03 }) },
  ],
  2: [
    { f: 169, s: (f) => dolly(add(SHOP2, 5.2, 1.8, -4.6), add(SHOP2, 1.3, 1.9, 0.6), pushK(f, 169, 0.0025), { fov: 42 }) },
    { f: 210, cut: true, s: (f) => dolly(add(SPORT, -3.2, 1.4, -4.6), add(SPORT, -0.7, 1.0, 0), pushK(f, 210, 0.003), { fov: 40, roll: -0.03 }) },
    { f: 244, cut: true, s: (f) => dolly([QUEUE_X + 0.45, 1.75, QUEUE_Z1 + 4.4], [QUEUE_X - 0.25, 1.2, QUEUE_Z1 - 5], pushK(f, 244, 0.0025, 0.005, 30), { fov: 40 }) },
  ],
  3: [
    { f: 290, s: (f) => zoom(add(PLANT, -40, 6, -175), add(PLANT, 0, 30, 0), 44, pushK(f, 290, 0.0016)) },
    { f: 376, dur: 20, s: (f) => zoom(add(PLANT, -40, 6, -175), add(PLANT, 15, 26, 0), 36, pushK(f, 376, 0.0015), { roll: -0.03 }) },
  ],
  4: [
    { f: 397, s: (f) => zoom([1.2, 1.4, -22], [0, 9, 40], 46, pushK(f, 397, 0.0018)) },
    { f: 466, cut: true, s: (f) => dolly(add(ROOF, -0.5, 0.75, -3.6), add(ROOF, 0.2, 2.6, 0.5), pushK(f, 466, 0.0015), { fov: 46, roll: 0.03 }) },
    { f: 520, dur: 40, s: (f) => dolly(add(ROOF, -0.9, 0.55, -4.4), add(ROOF, 0.6, 4.2, 1.5), pushK(f, 520, 0.0012), { fov: 50, roll: -0.02 }) },
  ],
  5: [
    { f: 567, s: (f) => dolly(add(SUBWAY, -5.2, 4.6, -8.5), add(SUBWAY, 0, -1.2, 0.5), pushK(f, 567, 0.002), { fov: 42 }) },
    { f: 618, cut: true, s: (f) => dolly(add(SUBWAY, -0.6, 3.0, -5.2), add(SUBWAY, 0, -2.6, 2.2), pushK(f, 618, 0.0025), { fov: 42, roll: 0.03 }) },
  ],
  6: [
    { f: 708, s: (f) => dolly(add(PORCH, -1.4, 1.2, 2.9), add(PORCH, -1.1, 0.9, 0.5), pushK(f, 708, 0.003), { fov: 38 }) },
    { f: 774, cut: true, s: (f) => dolly(add(PORCH, 1.4, 1.35, 2.2), add(PORCH, 1.6, 1.05, -1.2), pushK(f, 774, 0.0025, 0.006, 25), { fov: 38, roll: -0.03 }) },
  ],
  7: [
    { f: 819, s: (f) => dolly([-1.5, 2.3, SHOWROOM_Z - 6], [4.5, 0.9, SHOWROOM_Z + 9], pushK(f, 819, 0.002), { fov: 42 }) },
    { f: 952, dur: 26, s: (f) => dolly([0.5, 1.6, SHOWROOM_Z + 2.5], [4.6, 0.9, SHOWROOM_Z + 8], pushK(f, 952, 0.002), { fov: 40 }) },
    { f: 985, cut: true, s: (f) => dolly([-0.2, 1.6, SHOWROOM_Z + 3.0], [3.0, 1.0, SHOWROOM_Z + 8.0], pushK(f, 985, 0.003, 0.007, 20), { fov: 40, roll: 0.04 }) },
  ],
  8: [
    { f: 999, s: (f) => dolly(add(BOOKS, -5.6, 1.7, -4.8), add(BOOKS, -1.5, 1.7, -0.6), pushK(f, 999, 0.0025), { fov: 42 }) },
  ],
  9: [
    { f: 1063, s: (f) => dolly(add(BOOKS, -4.5, 1.45, -3.6), add(BOOKS, -1.8, 1.15, -1.2), pushK(f, 1063, 0.0025), { fov: 40, roll: 0.03 }) },
  ],
  10: [
    { f: 1144, s: (f) => dolly([-4, 15, -22], [2, 0, 16], pushK(f, 1144, 0.0018), { fov: 42 }) },
    { f: 1234, dur: 40, s: (f) => dolly([2.4, 2.3, 1.8], [7.0, 2.2, 8.6], pushK(f, 1234, 0.0018), { fov: 40, roll: 0.03 }) },
  ],
  11: [
    { f: 1348, s: (f) => dolly(add(BEACH, 3.4, 1.6, -4.6), add(BEACH, -1.5, 0.6, 0.7), pushK(f, 1348, 0.0022), { fov: 42 }) },
    { f: 1455, dur: 24, s: (f) => dolly(add(BEACH, 2.6, 1.2, -3.2), add(BEACH, -1.0, 0.45, 0.4), pushK(f, 1455, 0.002), { fov: 42, roll: -0.03 }) },
  ],
  12: [
    { f: 1530, s: (f) => { const u = (f - 1530) / 104; return { pos: add(HIGHWAY, -14 + 6 * u, 1.3, -2.4), look: add(HIGHWAY, 8 + 6 * u, 2.4, 0.5), fov: 42, roll: 0 }; } },
  ],
  13: [
    { f: 1630, s: (f) => dolly(add(PAPER, 1.0, PILE_H + 2.4, -6.4), add(PAPER, 0, PILE_H + 0.5, 0), pushK(f, 1630, 0.0025), { fov: 40 }) },
  ],
  14: [
    { f: 1755, s: (f) => { const u = glide((f - 1755) / 70); return { pos: add(PAPER, 2 + 6 * u, PILE_H + 6 + 40 * u, -14 - 40 * u), look: add(PAPER, 0, PILE_H, 0 + 10 * u), fov: 44, roll: 0 }; } },
  ],
};

const KICKS: [number, number][] = [[381 / FPS, 0.7], [987 / FPS, 1.0], [1757 / FPS, 0.6]];
export const kickAt = (t: number) => {
  let a = 0;
  for (const [t0, g] of KICKS) {
    const n = Math.floor((t - t0) * FPS + 1e-6);
    if (n >= 0 && n < 7) a += g * (n % 2 ? -1 : 1) * (1 - n / 7) ** 1.5;
  }
  return a;
};
const T = (f: number) => f / FPS;
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
  { f: 0, cInf: 0 }, { f: 93, cInf: 14 }, { f: 169, cInf: 10 }, { f: 210, cInf: 12 }, { f: 244, cInf: 6 }, { f: 290, cInf: 0 },
  { f: 397, cInf: 0 }, { f: 466, cInf: 8 }, { f: 567, cInf: 0 }, { f: 618, cInf: 8 }, { f: 708, cInf: 12 }, { f: 774, cInf: 13 },
  { f: 819, cInf: 0 }, { f: 952, dur: 26, cInf: 8 }, { f: 985, cInf: 12 }, { f: 999, cInf: 10 }, { f: 1063, cInf: 13 },
  { f: 1144, cInf: 0 }, { f: 1234, dur: 40, cInf: 10 }, { f: 1348, cInf: 12 }, { f: 1530, cInf: 5 }, { f: 1630, cInf: 13 }, { f: 1755, cInf: 0 },
];
export const dofAt = (f: number) => {
  let i = 0; while (i + 1 < DOF.length && f >= DOF[i + 1].f) i++;
  const d = DOF[i], p = DOF[Math.max(0, i - 1)];
  const k = d.dur ? Math.min(1, (f - d.f) / d.dur) : 1;
  return { cInf: p.cInf + (d.cInf - p.cInf) * k, focus: d.focus };
};
