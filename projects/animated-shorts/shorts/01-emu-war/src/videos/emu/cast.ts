// Everyone with a face in "The Great Emu War": soldiers, the major, the farmer, the kid (template cards) and the
// emus (emu.ts cards), placed per shot as a pure function of shot id + time.
import { fxPuff, fxStars, fxCreak, fxBurst, DIGGER, MAJOR, FARMER, KID, Expr, FrontOpts, SideOpts, Outfit, Prop } from "./toon";
import { emuSide, emuFront, EmuGait, EmuExpr, EmuOpts } from "./emu";
import {
  FPS, V3, hh, smooth, clamp01, GUN0, EMU_CU, MAJOR3, DAM, DAM_R, GUN5, TRACK_Z, CRATES9, MAJOR9, FLOCK, PORCH, DECK_H, MAJOR13, FARMER14,
  ROCK, ROCK_TOP, ABANDONED, SHOTS, emuRunX, truckX, truckBounce, T_SPLIT, T_SPILL,
} from "./story";
import { Stage, CamInfo, Place, person, blob, lidAt, light2D, viewOf, findSun, SUN, LN, q, fkey, tmp, LEAD, Who } from "./cast_base";

export type { Stage } from "./cast_base";
export { Pool, Actor, Fx, SU } from "./cast_base";

const L = LEAD;
const DIG = [0, 1, 2, 3].map((v) => ({ ...DIGGER, skin: ["#ffe2c2", "#f5c9a0", "#ecd0b6", "#e8b48a"][v], moustache: v === 1 ? "#4a3426" : undefined }) as Outfit);
const who = (i: number, o: Outfit, k: string): Who => ({ i, o, okey: k });

/** emu drawing size by distance (1000 x 1000 design canvas) */
const emuTier = (d: number): [number, number, number] => (d < 4.5 ? [1600, 1600, 1.6] : d < 10 ? [900, 900, 0.9] : d < 24 ? [420, 420, 0.42] : [200, 200, 0.2]);

type EmuSpec = { i: number; x: number; y?: number; z: number; dx: number; dz: number; gait: EmuGait; phase: number; expr?: EmuExpr; front?: boolean; noBlob?: boolean };
const emu = (out: Stage, cam: CamInfo, t: number, e: EmuSpec) => {
  const y = e.y ?? 0, d = cam.pos.distanceTo(tmp.set(e.x, y + 1, e.z));
  const view = viewOf(cam, e.x, e.z, e.dx, e.dz);
  const front = e.front ?? false;
  const mirror = !front && view.mirror;
  const far = d > 24;
  const o: EmuOpts = { gait: e.gait, phase: q(((e.phase % 1) + 1) % 1, far ? 8 : 24), expr: e.expr ?? "neutral", blink: far ? 0 : lidAt(t, e.i + 300),
    light: light2D(cam, mirror), seed: e.i % 5 };
  const [w, h, k] = emuTier(d);
  out.places.push({ key: `E|${front ? "F" : "S"}|${fkey(o)}`, x: e.x, y, z: e.z, mirror, geo: "emu", size: [w, h, k],
    draw: (p) => (front ? emuFront(p, o) : emuSide(p, o)) } as unknown as Place);
  if (!e.noBlob && !far) blob(out, e.x, y, e.z, 1.25);
};

/** a soldier / civilian card */
const guy = (out: Stage, cam: CamInfo, t: number, w: Who, x: number, y: number, z: number, o: { expr: Expr; side?: boolean; dir?: [number, number]; prop?: Prop; tilt?: number; look?: number; facing?: -1 | 0 | 1; noBlob?: boolean }) => {
  const dir = o.dir ?? [0, -1];
  const v = viewOf(cam, x, z, dir[0], dir[1]);
  const view = o.side ? { side: true, mirror: v.mirror } : { side: false, mirror: false };
  const blink = lidAt(t, w.i);
  const fo: FrontOpts = { mode: "stand", expr: o.expr, blink, prop: o.prop ?? null, tilt: o.tilt ?? 0, look: o.look ?? 0, facing: o.facing ?? 0 };
  const so: SideOpts = { mode: "stand", expr: o.expr, blink };
  out.places.push(person(cam, w, x, y, z, view, fo, so));
  if (!o.noBlob) blob(out, x, y, z);
};

const puff = (out: Stage, x: number, y: number, z: number, u: number, s = 1.6) => {
  if (u < 0 || u >= 1) return;
  out.fx.push({ key: `puff${q(u, 20)}`, cw: 300, ch: 300, draw: (p) => fxPuff(p, q(u, 20)), x, y: y + 0.35 * s, z, w: s, h: s, soft: true });
};

// hammer strike timing (template): 0 raised .. 1 struck, strikes on the given times
const hammerK = (t: number, hits: number[]) => {
  let k = 1;
  for (const th of hits) {
    const n = (t - th) * FPS;
    if (n >= -11 && n < -7) k = Math.min(k, 1 - smooth((n + 11) / 4));
    else if (n >= -7 && n < 0) k = 0;
  }
  return k;
};

// ---------------- crowds of emus ----------------
const field = (out: Stage, cam: CamInfo, t: number, n: number, x0: number, x1: number, z0: number, z1: number, seed: number, exprs: EmuExpr[] = ["neutral"]) => {
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * hh(i, seed), z = z0 + (z1 - z0) * hh(i, seed + 1), a = hh(i, seed + 2) * Math.PI * 2;
    const g: EmuGait = hh(i, seed + 3) < 0.55 ? "peck" : hh(i, seed + 3) < 0.8 ? "stand" : "walk";
    const sp = g === "walk" ? 0.6 : 0;
    emu(out, cam, t, { i: i + seed * 1000, x: x + Math.cos(a) * sp * t * 0.2, z: z + Math.sin(a) * sp * t * 0.2, dx: Math.cos(a), dz: Math.sin(a), gait: g,
      phase: t * (g === "peck" ? 0.9 : 1.1) + hh(i, seed + 4), expr: exprs[i % exprs.length] });
  }
};

// ---------------- the stage per shot ----------------
export const stage = (id: number, t: number, cam: CamInfo): Stage => {
  const out: Stage = { places: [], fx: [] };
  LN.v = SHOTS[id - 1].light;
  findSun(cam, SUN);
  switch (id) {
    case 1: {
      guy(out, cam, t, who(1, MAJOR, "maj"), GUN0[0] + 1.3, 0, GUN0[2] - 0.8, { expr: "stern", side: true, dir: [0, 1] });
      guy(out, cam, t, who(2, DIG[0], "d0"), GUN0[0] - 0.55, 0, GUN0[2] - 0.55, { expr: "grin", side: true, dir: [0, 1] });
      guy(out, cam, t, who(3, DIG[1], "d1"), GUN0[0] + 0.45, 0, GUN0[2] - 1.6, { expr: "stern", side: true, dir: [0, 1] });
      field(out, cam, t, 46, -22, 26, 16, 64, 11);
      emu(out, cam, t, { i: 7, x: EMU_CU[0], z: EMU_CU[2], dx: 0, dz: -1, gait: "stand", phase: 0, expr: t < 113 / FPS ? "neutral" : "smug", front: true });
      break;
    }
    case 2: {
      field(out, cam, t, 150, -45, 62, -8, 85, 21);
      for (let i = 0; i < 6; i++) emu(out, cam, t, { i: 900 + i, x: 15 + 2.2 * i + hh(i, 3), z: 14 + 2.8 * hh(i, 4) + (i % 2) * 1.5, dx: hh(i, 5) < 0.5 ? 1 : -1, dz: 0.2,
        gait: "peck", phase: t * 1.2 + hh(i, 6) });
      break;
    }
    case 3: {
      const late = t > 418 / FPS - L;
      guy(out, cam, t, who(1, MAJOR, "maj"), MAJOR3[0], 0, MAJOR3[2], { expr: late ? "grin" : "stern" });
      guy(out, cam, t, who(2, DIG[0], "d0"), MAJOR3[0] - 1.45, 0, MAJOR3[2] + 0.7, { expr: t > 370 / FPS - L ? "grin" : "neutral" });
      guy(out, cam, t, who(3, DIG[1], "d1"), MAJOR3[0] + 1.55, 0, MAJOR3[2] + 0.9, { expr: t > 370 / FPS - L ? "smile" : "neutral", facing: -1 });
      break;
    }
    case 4: {
      for (let i = 0; i < 34; i++) {
        const x = -16 + 21 * hh(i, 41), z0 = 74 + 40 * hh(i, 42), z = z0 + 1.1 * (t - 455 / FPS);
        emu(out, cam, t, { i: 400 + i, x, z, dx: 0.05 * (hh(i, 43) - 0.5), dz: 1, gait: "walk", phase: t * 1.1 + hh(i, 44), expr: "smug" });
      }
      break;
    }
    case 5: {
      for (let i = 0; i < 170; i++) {
        const a = hh(i, 51) * Math.PI * 2, r = DAM_R + 1 + (i < 60 ? 2.5 * hh(i, 52) : 4 + 20 * hh(i, 52));
        const x = DAM[0] + Math.cos(a) * r, z = DAM[2] + Math.sin(a) * r, drink = i < 60;
        emu(out, cam, t, { i: 500 + i, x, z, dx: -Math.cos(a), dz: -Math.sin(a), gait: drink ? "peck" : hh(i, 53) < 0.5 ? "stand" : "walk", phase: t + hh(i, 54) });
      }
      const jam = t > 681 / FPS - L;
      // gunner behind the gun (gun aims toward the dam, i.e. -x -z)
      guy(out, cam, t, who(2, DIG[0], "d0"), GUN5[0] + 0.6, 0, GUN5[2] + 0.6, { expr: jam ? "shock" : "stern", facing: -1 });
      if (jam) {
        const u = (t - 681 / FPS) / 1.2;
        puff(out, GUN5[0] - 0.1, 0.7, GUN5[2] - 0.1, u, 1.1);
        out.fx.push({ key: `creak${q((t * 1.3) % 1, 30)}`, cw: 300, ch: 300, draw: (p) => fxCreak(p, q((t * 1.3) % 1, 30)), x: GUN5[0] - 0.15, y: 1.25, z: GUN5[2] - 0.25, w: 0.45, h: 0.45 });
      }
      break;
    }
    case 6: {
      const x = truckX(6, t), go = t > 787 / FPS;
      guy(out, cam, t, who(2, DIG[0], "d0"), x - 1.3, 1.08, TRACK_Z + 0.35, { expr: go ? "grin" : "stern", noBlob: true });
      guy(out, cam, t, who(3, DIG[1], "d1"), x - 2.2, 1.08, TRACK_Z - 0.5, { expr: go ? "laugh" : "stern", prop: go ? null : ["hammer", q(hammerK(t, [724 / FPS, 745 / FPS]), 30)], noBlob: true });
      if (!go) guy(out, cam, t, who(1, MAJOR, "maj"), x + 1.4, 0, TRACK_Z - 2.3, { expr: "stern" });
      for (const th of [724 / FPS, 745 / FPS]) if (t >= th && t < th + 5 / FPS) {
        const u = (t - th) / (5 / FPS);
        out.fx.push({ key: `burst${q(u, 30)}`, cw: 500, ch: 500, draw: (p) => fxBurst(p, q(u, 30)), x: x - 1.65, y: 1.75, z: TRACK_Z - 0.6, w: 0.7, h: 0.7 });
      }
      if (go) for (let k = 0; k < 4; k++) puff(out, x - 3 - k * 1.6, 0, TRACK_Z + (k % 2 ? 0.6 : -0.6), ((t - T_GO_S) * 1.2 + k * 0.25) % 1, 1.8);
      break;
    }
    case 7: case 8: {
      const ex = emuRunX(t), xt = truckX(id, t), by = truckBounce(id, t);
      for (let i = 0; i < 16; i++) {
        const x = ex - 9 * hh(i, 71), z = TRACK_Z + (hh(i, 72) - 0.5) * 7;
        emu(out, cam, t, { i: 700 + i, x, z, dx: 1, dz: 0, gait: "run", phase: t * 2.4 + hh(i, 73), expr: i % 3 ? "happy" : "smug" });
        puff(out, x - 1.2, 0, z, ((t * 1.6 + hh(i, 74)) % 1), 1.3);
      }
      const dizzy = id === 8 && t > 993 / FPS - L;
      guy(out, cam, t, who(2, DIG[0], "d0"), xt - 1.25, 1.08 + by * 1.25, TRACK_Z + 0.3, { expr: id === 8 ? (dizzy ? "dazed" : "nervous") : "grin", noBlob: true,
        tilt: id === 8 ? 9 * Math.sin(t * 9) : 0 });
      if (dizzy) { const u = (t * 0.9) % 1; out.fx.push({ key: `stars${q(u, 30)}`, cw: 420, ch: 210, draw: (p) => fxStars(p, q(u, 30)), x: xt - 1.25, y: 1.08 + by * 1.25 + 2.35, z: TRACK_Z + 0.3, w: 0.75, h: 0.375 }); }
      for (let k = 0; k < 3; k++) puff(out, xt - 3.2 - k * 1.4, 0, TRACK_Z + (k - 1) * 0.8, ((t * 1.3 + k * 0.33) % 1), 2.0);
      break;
    }
    case 9: case 10: {
      const lucky = id === 9;
      guy(out, cam, t, who(1, MAJOR, "maj"), MAJOR9[0], 0, MAJOR9[2], { expr: lucky ? (t > 1064 / FPS - L ? "grin" : "smile") : t < 1134 / FPS - L ? "nervous" : "pained", facing: 1 });
      if (!lucky) {
        const u = (t - 1101 / FPS) / ((1172 - 1101) / FPS);
        emu(out, cam, t, { i: 990, x: MAJOR9[0] + 6 - 11 * u, z: MAJOR9[2] + 6.5, dx: -1, dz: 0, gait: "walk", phase: t * 1.2, expr: "smug" });
      }
      break;
    }
    case 11: {
      const split = Math.max(0, t - T_SPLIT);
      for (let i = 0; i < 150; i++) {
        const g = i % 8, ang = (g / 8) * Math.PI * 2 + 0.3, r0 = 7 * Math.sqrt(hh(i, 81)), a0 = hh(i, 82) * Math.PI * 2;
        const hx = FLOCK[0] + Math.cos(a0) * r0, hz = FLOCK[2] + Math.sin(a0) * r0;
        const d = split > 0 ? 9 * Math.max(0, split - 0.15) ** 1.1 : 0;
        const x = hx + Math.cos(ang) * d, z = hz + Math.sin(ang) * d;
        emu(out, cam, t, { i: 1100 + i, x, z, dx: split > 0 ? Math.cos(ang) : Math.cos(a0), dz: split > 0 ? Math.sin(ang) : Math.sin(a0),
          gait: split > 0.15 ? "run" : hh(i, 83) < 0.5 ? "peck" : "stand", phase: t * (split > 0 ? 2.4 : 1) + hh(i, 84), noBlob: true });
      }
      break;
    }
    case 12: {
      const spilled = t > T_SPILL - L;
      const ex: Expr = !spilled ? "smile" : t < 1460 / FPS - L ? "shock" : t < 1491 / FPS - L ? "grin" : "nervous";
      guy(out, cam, t, who(5, KID, "kid"), PORCH[0] - 0.55, DECK_H, PORCH[2] + 0.3, { expr: ex, look: t > 1491 / FPS ? 1 : 0 });
      break;
    }
    case 13: {
      const late = t > 1672 / FPS - L;
      guy(out, cam, t, who(1, MAJOR, "maj"), MAJOR13[0], 0, MAJOR13[2], { expr: late ? "grin" : t > 1604 / FPS ? "smile" : "stern" });
      for (let i = 0; i < 26; i++) emu(out, cam, t, { i: 1300 + i, x: MAJOR13[0] - 18 + 36 * hh(i, 91), z: MAJOR13[2] + 10 + 30 * hh(i, 92), dx: hh(i, 93) < 0.5 ? 1 : -1, dz: 0,
        gait: hh(i, 94) < 0.5 ? "stand" : "peck", phase: t + hh(i, 95) });
      break;
    }
    case 14: {
      const ex: Expr = t < 1769 / FPS - L ? "smile" : t < 1815 / FPS - L ? "nervous" : "pained";
      guy(out, cam, t, who(6, FARMER, "far"), FARMER14[0], 0, FARMER14[2], { expr: ex });
      field(out, cam, t, 22, FARMER14[0] - 16, FARMER14[0] + 16, FARMER14[2] + 6, FARMER14[2] + 34, 61);
      break;
    }
    case 15: {
      emu(out, cam, t, { i: 1500, x: ROCK[0], y: ROCK_TOP, z: ROCK[2], dx: 0, dz: -1, gait: "stand", phase: 0, expr: "smug", front: true, noBlob: true });
      emu(out, cam, t, { i: 1501, x: ABANDONED[0] + 2.3, z: ABANDONED[2] + 2.4, dx: -1, dz: -0.2, gait: "peck", phase: t * 0.9, expr: "neutral" });
      break;
    }
  }
  return out;
};
const T_GO_S = 787 / FPS;
