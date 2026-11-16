// "The Great Emu War" (1932): shots timed to the voice (voice/words.json, Kokoro af_heart x1.25), story kinematics
// (emu flocks, the truck chase, the scatter, the marbles) and the camera grammar of the bridge template:
// smootherstep glides, every hold creeps in, big reframes are cuts, impacts are 7-frame flip kicks.
export const FPS = 30;
export const TOTAL = 1990;
export const D0 = 0; // ground level (build.ts reads it)
export type V3 = [number, number, number];

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
export const hh = (i: number, s = 0) => { const v = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return v - Math.floor(v); };

// ---------------- places ----------------
export const GUN0: V3 = [0, 0, 0];               // first gun post, facing +z (shots 1, 4)
export const EMU_CU: V3 = [2.5, 0, 26];          // the smug emu of the hook
export const HOUSE: V3 = [36, 0, -22];
export const MAJOR3: V3 = [5, 0, -6];            // the army arrives (shot 3)
export const TRUCK3: V3 = [6.2, 0, -2.2];
export const CRATES3: V3 = [10.8, 0, -6.4];
export const DAM: V3 = [-80, 0, -80], DAM_R = 12;
export const GUN5: V3 = [-63, 0, -63];           // gun at the waterhole, aiming at the dam (toward -x -z)
export const TRACK_Z = -150;                     // the chase runs along +x
export const CRATES9: V3 = [30, 0, 41], MAJOR9: V3 = [27.4, 0, 37.2];
export const FLOCK: V3 = [-200, 0, 200];
export const PORCH: V3 = [150, 0, -40], DECK_H = 0.45;
export const MAJOR13: V3 = [-300, 0, -300];
export const FARMER14: V3 = [-40, 0, -30];
export const ROCK: V3 = [80, 0, 300], ROCK_TOP = 2.35;
export const ABANDONED: V3 = [90, 0, 288];

// ---------------- story kinematics ----------------
export const T_SHOT7 = 817 / FPS;
/** lead emu x in the chase (shots 7-8): 50 km/h = 14 m/s */
export const emuRunX = (t: number) => 120 + 14 * (t - T_SHOT7);
/** truck x: parked for "bolted", pulls away on "gave chase", then 22 m behind the emus */
export const T_GO = 787 / FPS;
export const truckX = (id: number, t: number) => {
  if (id === 6) return 40 + (t < T_GO ? 0 : 2.5 * (t - T_GO) ** 2);
  return emuRunX(t) - 22 - 1.5 * Math.sin(t * 0.7);
};
export const truckBounce = (id: number, t: number) => (id === 7 || id === 8 ? 0.26 * Math.abs(Math.sin(Math.PI * 1.7 * t)) : 0);
export const truckPitch = (id: number, t: number) => (id === 7 || id === 8 ? 0.07 * Math.sin(Math.PI * 1.7 * t + 0.6) : 0);
/** the flock (shot 11): one clump, then on "splits" eight groups run off in every direction */
export const T_SPLIT = 1293 / FPS;
/** marbles (shot 12) */
export const T_SPILL = 1440 / FPS;

// ---------------- shots ----------------
export type Light = "day" | "golden";
export type ShotDef = { id: number; a: number; b: number; light: Light; sunAz?: number; sunEl?: number };
export const SHOTS: ShotDef[] = [
  { id: 1, a: 0, b: 140, light: "day" },
  { id: 2, a: 140, b: 312, light: "day", sunAz: 110 },
  { id: 3, a: 312, b: 455, light: "day", sunAz: 150, sunEl: 45 },
  { id: 4, a: 455, b: 569, light: "day" },
  { id: 5, a: 569, b: 700, light: "day", sunAz: 120 },
  { id: 6, a: 700, b: 817, light: "day", sunAz: 150, sunEl: 45 },
  { id: 7, a: 817, b: 955, light: "day", sunAz: 150, sunEl: 45 },
  { id: 8, a: 955, b: 1028, light: "day", sunAz: 150, sunEl: 45 },
  { id: 9, a: 1028, b: 1101, light: "day" },
  { id: 10, a: 1101, b: 1172, light: "day" },
  { id: 11, a: 1172, b: 1383, light: "golden", sunAz: 30, sunEl: 10 },
  { id: 12, a: 1383, b: 1562, light: "day" },
  { id: 13, a: 1562, b: 1726, light: "golden" },
  { id: 14, a: 1726, b: 1841, light: "day" },
  { id: 15, a: 1841, b: TOTAL, light: "day", sunAz: 140, sunEl: 40 },
];
export const XFADE: Record<number, number> = { 11: 8, 12: 8, 13: 8, 14: 8, 15: 8 };
export const FLASH_AT = 140;

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
const T = (f: number) => f / FPS;
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
    { f: 0, s: (f) => dolly([-1.1, 1.55, -6.6], [0.6, 1.05, 4], pushK(f, 0, 0.0028), { fov: 44 }) },
    { f: 48, dur: 34, s: (f) => dolly([-0.8, 1.3, -4.6], [0.9, 1.1, 7], pushK(f, 48, 0.003), { fov: 40, roll: -0.04 }) },
    { f: 113, cut: true, s: (f) => dolly(add(EMU_CU, 0.15, 1.62, -2.7), add(EMU_CU, 0, 1.5, 0), pushK(f, 113, 0.003, 0.007, 20), { fov: 34, roll: 0.03 }) },
  ],
  2: [
    { f: 136, s: (f) => zoom([72, 40, -72], [6, 0, 22], 46, pushK(f, 136, 0.0022)) },
    { f: 268, cut: true, s: (f) => dolly([10.6, 1.05, 8.4], [16, 0.75, 14.5], pushK(f, 268, 0.003), { fov: 40, roll: 0.03 }) },
  ],
  3: [
    { f: 312, s: (f) => dolly(add(MAJOR3, 0.15, 1.62, -3.7), add(MAJOR3, 0, 1.5, 0), pushK(f, 312, 0.0025), { fov: 34 }) },
    { f: 364, dur: 22, s: (f) => dolly(add(MAJOR3, 0.6, 2.0, -7.6), add(MAJOR3, 0.6, 1.15, 0.6), pushK(f, 364, 0.002), { fov: 42, roll: -0.03 }) },
    { f: 396, cut: true, s: (f) => dolly(add(CRATES3, -1.7, 2.25, -3.1), add(CRATES3, 0, 1.4, 0), pushK(f, 396, 0.003), { fov: 36 }) },
    { f: 416, dur: 28, s: (f) => dolly(add(CRATES3, -3.6, 3.9, -7.4), add(CRATES3, 0, 0.9, 0), pushK(f, 416, 0.002), { fov: 44, roll: 0.03 }) },
  ],
  4: [
    { f: 455, s: (f) => zoom(add(GUN0, 0.14, 1.3, -1.45), add(GUN0, 0.02, 0.82, 30), 32, pushK(f, 455, 0.003)) },
    { f: 519, cut: true, s: (f) => { const z = 96 + 1.1 * (T(f) - 17.3); return dolly([9.5, 1.3, z - 3], [0, 1.0, z + 1], pushK(f, 519, 0.002), { fov: 38 }); } },
  ],
  5: [
    { f: 569, s: (f) => zoom(add(DAM, 34, 25, 32), add(DAM, 0, 0, 0), 46, pushK(f, 569, 0.0025)) },
    { f: 669, cut: true, s: (f) => dolly(add(GUN5, -0.3, 1.45, -2.1), add(GUN5, 0.3, 1.25, 0.3), pushK(f, 669, 0.003, 0.008, 18), { fov: 38, roll: 0.04 }) },
  ],
  6: [
    { f: 700, s: (f) => dolly([38.4, 2.3, TRACK_Z - 9.6], [39.0, 1.5, TRACK_Z], pushK(f, 700, 0.0025), { fov: 42 }) },
    { f: 785, cut: true, s: (f) => { const x = truckX(6, T(f)); return { pos: [x + 9.5, 1.25, TRACK_Z - 5.5] as V3, look: [x + 1, 1.15, TRACK_Z] as V3, fov: 40, roll: -0.03 }; } },
  ],
  7: [
    { f: 817, s: (f) => { const x = emuRunX(T(f)); return { pos: [x - 3.5, 1.4, TRACK_Z - 9.5] as V3, look: [x - 2.5, 1.05, TRACK_Z] as V3, fov: 40 }; } },
    { f: 912, cut: true, s: (f) => { const x = truckX(7, T(f)); return { pos: [x - 7.5, 1.05, TRACK_Z - 1.6] as V3, look: [x + 12, 1.3, TRACK_Z] as V3, fov: 42, roll: 0.03 }; } },
  ],
  8: [
    { f: 955, s: (f) => { const x = truckX(8, T(f)); return { pos: [x + 0.4, 2.6, TRACK_Z - 3.1] as V3, look: [x - 0.9, 2.15, TRACK_Z] as V3, fov: 38 }; } },
  ],
  9: [
    { f: 1028, s: (f) => dolly(add(MAJOR9, -0.5, 1.7, -4.6), add(MAJOR9, 0.9, 1.5, 0.6), pushK(f, 1028, 0.0022), { fov: 42 }) },
    { f: 1099, dur: 20, s: (f) => dolly(add(MAJOR9, -0.2, 1.62, -3.4), add(MAJOR9, 0.3, 1.5, 0.3), pushK(f, 1099, 0.002), { fov: 38, roll: 0.04 }) },
  ],
  11: [
    { f: 1168, s: (f) => dolly(add(FLOCK, 12, 42, -40), add(FLOCK, 0, 0, 0), pushK(f, 1168, 0.002), { fov: 40 }) },
    { f: 1290, dur: 40, s: (f) => dolly(add(FLOCK, 16, 66, -58), add(FLOCK, 0, 0, 4), pushK(f, 1290, 0.0012), { fov: 44, roll: -0.03 }) },
  ],
  12: [
    { f: 1379, s: (f) => dolly(add(PORCH, -0.1, 1.3, 3.6), add(PORCH, -0.25, 0.75, -0.1), pushK(f, 1379, 0.0025), { fov: 42 }) },
    { f: 1488, dur: 30, s: (f) => dolly(add(PORCH, 1.05, 0.82, 1.7), add(PORCH, 1.5, 0.55, -1.25), pushK(f, 1488, 0.0025), { fov: 40, roll: 0.04 }) },
  ],
  13: [
    { f: 1558, s: (f) => dolly(add(MAJOR13, 0.35, 1.62, -4.4), add(MAJOR13, 0, 1.55, 0), pushK(f, 1558, 0.0022), { fov: 36 }) },
    { f: 1670, dur: 20, s: (f) => dolly(add(MAJOR13, 0.2, 1.62, -3.1), add(MAJOR13, 0, 1.6, 0), pushK(f, 1670, 0.002, 0.006, 30), { fov: 34, roll: -0.04 }) },
  ],
  14: [
    { f: 1722, s: (f) => dolly(add(FARMER14, 0.7, 1.6, -4.6), add(FARMER14, 0, 1.4, 1.2), pushK(f, 1722, 0.0025), { fov: 40 }) },
    { f: 1822, dur: 18, s: (f) => dolly(add(FARMER14, 0.3, 1.6, -3.2), add(FARMER14, 0, 1.5, 0.4), pushK(f, 1822, 0.002), { fov: 36, roll: 0.04 }) },
  ],
  15: [
    { f: 1837, s: (f) => dolly(add(ROCK, 0.6, 1.0, -6.6), add(ROCK, 0, 3.5, 0), pushK(f, 1837, 0.0018, 0.005, 30), { fov: 42 }) },
    { f: 1920, cut: true, s: (f) => dolly(add(ABANDONED, -2.4, 1.05, -2.3), add(ABANDONED, 0.3, 0.2, 0.3), pushK(f, 1920, 0.0025), { fov: 40, roll: -0.03 }) },
  ],
};
CAMS[10] = CAMS[9];

// impact kicks: image offset flips sign every frame and decays over 7 f
const KICKS: [number, number][] = [[681 / FPS, 1.4], [724 / FPS, 0.8], [965 / FPS, 0.8], [979 / FPS, 0.9], [993 / FPS, 1.0], [1008 / FPS, 0.7]];
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

// ---------------- lens ----------------
export type Dof = { f: number; dur?: number; cInf: number; focus?: (f: number) => V3 };
export const DOF: Dof[] = [
  { f: 0, cInf: 8 },            // soldiers + gun from behind, emus mid
  { f: 113, cInf: 15 },         // smug emu CU
  { f: 140, cInf: 0 },          // farm aerial
  { f: 268, cInf: 12 },         // pecking emus
  { f: 312, cInf: 13 },         // major MS
  { f: 364, dur: 22, cInf: 9 },
  { f: 396, cInf: 14 },         // gun on crates
  { f: 416, dur: 28, cInf: 0 },
  { f: 455, cInf: 6, focus: () => [0, 1, 85] }, // over the gun: emus far, gun soft
  { f: 519, cInf: 10 },
  { f: 569, cInf: 0 },          // waterhole aerial
  { f: 669, cInf: 14 },         // jammed gun CU
  { f: 700, cInf: 8 },
  { f: 785, cInf: 0 },          // driving
  { f: 817, cInf: 6 },          // running emus
  { f: 912, cInf: 0 },
  { f: 955, cInf: 12 },         // bouncing gunner
  { f: 1028, cInf: 10 },        // major + crates
  { f: 1172, cInf: 0 },         // flock aerial
  { f: 1383, cInf: 9 },         // porch
  { f: 1562, cInf: 14 },        // golden major
  { f: 1726, cInf: 11 },        // farmer
  { f: 1841, cInf: 6 },         // hero emu
  { f: 1920, cInf: 14 },        // the abandoned gun
];
export const dofAt = (f: number) => {
  let i = 0; while (i + 1 < DOF.length && f >= DOF[i + 1].f) i++;
  const d = DOF[i], p = DOF[Math.max(0, i - 1)];
  const k = d.dur ? Math.min(1, (f - d.f) / d.dur) : 1;
  return { cInf: p.cInf + (d.cInf - p.cInf) * k, focus: d.focus };
};
