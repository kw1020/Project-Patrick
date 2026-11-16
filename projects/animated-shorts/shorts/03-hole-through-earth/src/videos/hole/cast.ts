// "What if you jumped into a hole through the Earth?": YOU, the faller, plus effect cards.
import { Pen, fxPuff, fxBurst, Expr, FrontOpts, SideOpts, Outfit } from "./toon";
import { FPS, V3, hh, smooth, clamp01, SHOTS, YARD, EARTH, ER, OCEAN, CORE, T_JUMP, T_STOP, fallU, swingU, airU } from "./story";
import { Stage, CamInfo, person, blob, lidAt, viewOf, findSun, SUN, LN, q, LEAD, Who } from "./cast_base";

export type { Stage } from "./cast_base";
export { Pool, Actor, Fx, SU } from "./cast_base";

const L = LEAD;
export const YOU: Outfit = { jacket: "#e0603f", pants: "#34466e", boots: "#f2efe8", hat: "hair", hair: "#4a3020", skin: "#f5c9a0" };
const ME: Who = { i: 1, o: YOU, okey: "you" };
type O = { expr: Expr; mode?: FrontOpts["mode"]; tilt?: number; look?: number; facing?: -1 | 0 | 1; noBlob?: boolean; scale?: number; wave?: number };
const me = (out: Stage, cam: CamInfo, t: number, x: number, y: number, z: number, o: O) => {
  const blink = lidAt(t, 1);
  const fo: FrontOpts = { mode: o.mode ?? "stand", expr: o.expr, blink, look: o.look ?? 0, facing: o.facing ?? 0, tilt: o.tilt ?? 0, wave: o.wave ?? 0 };
  const so: SideOpts = { mode: "stand", expr: o.expr, blink };
  out.places.push(person(cam, ME, x, y, z, { side: false, mirror: false }, fo, so, o.scale ?? 1));
  if (!o.noBlob) blob(out, x, y, z);
};

const fxArrow = (p: Pen) => { p.poly([[150, 20], [230, 130], [175, 130], [175, 280], [125, 280], [125, 130], [70, 130]], "#ffd84a", 10); };
const fxSpeed = (p: Pen, t: number) => { for (let i = 0; i < 7; i++) { const x = 30 + i * 38, y0 = 20 + 60 * hh(i, Math.floor(t * 8)), l = 120 + 100 * hh(i, 3); p.stroke([[x, y0], [x, y0 + l]], 7, "rgba(255,255,255,0.85)"); } };
/** a cartoon submarine on a 400 x 200 canvas, squashed by s 0..1 */
const fxSub = (p: Pen, s: number) => {
  const h = 60 * (1 - 0.8 * s), w = 150 * (1 + 0.25 * s);
  p.ell(200, 120, w, h, "#f2c230", 8);
  p.poly([[180, 120 - h], [230, 120 - h], [222, 120 - h - 34 * (1 - 0.7 * s)], [188, 120 - h - 34 * (1 - 0.7 * s)]], "#e0a820", 7);
  for (const x of [150, 200, 250]) p.ell(x, 120, 14, 14 * (1 - 0.6 * s), "#9fd4ff", 5);
};
const fxEmber = (p: Pen) => { p.ell(150, 150, 60, 60, "#ffb43a", 0); p.ell(150, 150, 30, 30, "#fff1a0", 0); };

export const stage = (id: number, t: number, cam: CamInfo): Stage => {
  const out: Stage = { places: [], fx: [] };
  LN.v = SHOTS[id - 1].light as "day" | "golden";
  findSun(cam, SUN);
  const f = t * FPS;
  const card = (key: string, draw: (p: Pen) => void, x: number, y: number, z: number, w: number, h: number, soft = false, rot = 0, cw = 300, ch = 300) =>
    out.fx.push({ key, cw, ch, draw, x, y, z, w, h, soft, rot });
  const puff = (x: number, y: number, z: number, u: number, s = 1.4) => { if (u >= 0 && u < 1) out.fx.push({ key: `puff${q(u, 20)}`, cw: 300, ch: 300, draw: (p) => fxPuff(p, q(u, 20)), x, y: y + 0.35 * s, z, w: s, h: s, soft: true }); };
  /** the faller on the cutaway: u = +1 top .. -1 bottom; the figure is 3.5x size so it reads on a 40 m globe */
  const faller = (u: number, expr: Expr) => me(out, cam, t, EARTH[0], EARTH[1] + u * ER - 3.5 * 1.1, EARTH[2] - 1.2, { expr, noBlob: true, scale: 3.5 });
  switch (id) {
    case 1: me(out, cam, t, YARD[0] - 0.4, 0, YARD[2] + 1.1, { expr: f < 40 ? "smile" : "grin", facing: 1 }); break;
    case 2: me(out, cam, t, EARTH[0], EARTH[1] + ER, EARTH[2] - 1.0, { expr: "grin", noBlob: true, scale: 3.5 }); break;
    case 4: {
      if (f >= 590) { const s = smooth((f - 600) / 30); card(`sub${q(s, 20)}`, (p) => fxSub(p, q(s, 20)), EARTH[0], EARTH[1], EARTH[2] - 4, 4.4, 2.2, false, 0, 400, 200); }
      break;
    }
    case 5: {
      const dt = t - T_JUMP, y = dt < 0 ? 0 : 3.2 * dt - 6 * dt * dt;
      me(out, cam, t, YARD[0], Math.max(-4, y), YARD[2] + (dt < 0 ? 1.0 : 1.0 - Math.min(1, dt * 2.2)), { expr: dt < 0 ? (f > 700 ? "grin" : "smile") : "laugh", noBlob: dt > 0 });
      if (f > 690 && f < 744) for (let k = 0; k < 5; k++) { const u = q(((t * 1.3 + k * 0.2) % 1), 15); card(`spk${u}`, (p) => fxBurst(p, u, "#9fe8ff", 6, 10, 90), YARD[0] + Math.cos(k * 1.26) * 0.9, 0.3 + 0.4 * u, YARD[2] + Math.sin(k * 1.26) * 0.9, 0.3, 0.3, false, 0, 500, 500); }
      if (dt >= 0 && dt < 0.5) puff(YARD[0], 0, YARD[2] + 1.1, dt * 2, 1.2);
      break;
    }
    case 6: {
      const u = fallU(t), fast = Math.abs(u) < 0.35;
      faller(u, f < 868 ? "grin" : fast ? "shock" : f < 940 ? "laugh" : "relief_open");
      if (t > T_JUMP && t < T_STOP && Math.abs(u) < 0.6) { const s = q(t % 1, 8); card(`spd${s}`, (p) => fxSpeed(p, s), EARTH[0], EARTH[1] + u * ER + 1 * Math.sign(u + 0.001) * 3, EARTH[2] - 1.0, 5, 5, true); }
      break;
    }
    case 7: case 8: {
      const rise = id === 7 ? smooth((f - 1009) / 22) : 1;
      me(out, cam, t, OCEAN[0], -2.3 + 1.3 * rise, OCEAN[2] + 0.15, { expr: id === 7 ? (f < 1089 - 2 ? "relief_open" : "grin") : f < 1181 ? "grin" : "nervous", noBlob: true, look: id === 8 ? Math.round(Math.sin(t * 2.5)) : 0 });
      break;
    }
    case 9: {
      faller(swingU(t, 1278 / FPS, 3.2), "grin");
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.2, r = ER * 0.5, x = EARTH[0] + Math.cos(a) * r * 0.75, y = EARTH[1] + Math.sin(a) * r;
        card("arrow", fxArrow, x, y, EARTH[2] - 8, 7, 7, false, a + Math.PI / 2);
      }
      break;
    }
    case 11: {
      const c = Math.cos((2 * Math.PI * (t - 1667 / FPS)) / 2.4), y = -2.6 + 2.6 * clamp01(c * 1.25);
      me(out, cam, t, YARD[0], y, YARD[2] + 0.3, { expr: c > 0.6 ? "grin" : "shock", noBlob: true });
      break;
    }
    case 12: faller(airU(t), f < 1840 ? "grin" : "neutral"); break;
    case 13: {
      me(out, cam, t, CORE[0], CORE[1] + 0.15 * Math.sin(t * 1.6), CORE[2], { expr: f < 1900 ? "neutral" : "smile_closed", noBlob: true, tilt: 6 * Math.sin(t * 0.9), look: 1 });
      for (let k = 0; k < 14; k++) { const u = ((t * 0.15 + hh(k, 1)) % 1); card("ember", fxEmber, CORE[0] + (hh(k, 2) - 0.5) * 8, CORE[1] - 2 + 7 * u, CORE[2] + 1 + 6 * hh(k, 3), 0.12, 0.12, true); }
      break;
    }
  }
  return out;
};
