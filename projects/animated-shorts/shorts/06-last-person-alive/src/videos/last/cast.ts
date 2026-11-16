// Everyone on screen in "What if you were the last person alive?": YOU (one character), and in the flashback the
// city's crowd and workers. Plus the effect cards (smoke, stink, exhaust, candle, water rings).
import { Pen, fxPuff, fxRing, Expr, FrontOpts, SideOpts, Outfit } from "./toon";
import {
  FPS, V3, hh, smooth, clamp01, SHOTS, YOU1, SHOP2, SPORT, QUEUE_X, QUEUE_Z1, PLANT, ROOF, SUBWAY, PORCH, DECK_H, SHOWROOM_Z, BOOKS, PAPER, PILE_H,
  T_PLANTS, floodY, T_ROT, T_BEANS, T_START,
} from "./story";
import { Stage, CamInfo, person, blob, lidAt, viewOf, findSun, SUN, LN, q, LEAD, Who } from "./cast_base";

export type { Stage } from "./cast_base";
export { Pool, Actor, Fx, SU } from "./cast_base";

const L = LEAD;
export const YOU: Outfit = { jacket: "#e0603f", pants: "#34466e", boots: "#f2efe8", hat: "hair", hair: "#4a3020", skin: "#f5c9a0" };
const COATS = ["#3f6fb5", "#8c3b4a", "#5d7a3a", "#b5653f", "#2f5f6a", "#7b5ac9", "#d9a441", "#4a4f5a"];
const HAIRS = ["#2a201a", "#5a3b2a", "#c9a24a", "#8a4a2a", "#1d1b22"];
const SKINS = ["#ffe2c2", "#f5c9a0", "#ecd0b6", "#c99067", "#8a5a3a"];
const folk = (v: number): Outfit => ({ jacket: COATS[v % 8], pants: ["#3b3f52", "#34466e", "#5a4a3a"][v % 3], boots: "#3a2a1e", hat: "hair", hair: HAIRS[v % 5], skin: SKINS[v % 5] });
const WORKER: Outfit = { jacket: "#f08a2c", pants: "#3b4a6b", boots: "#4a3426", hat: "cap", cap: "#f2c230", skin: "#ecd0b6" };
const who = (i: number, o: Outfit, k: string): Who => ({ i, o, okey: k });

type GuyOpts = { expr: Expr; side?: boolean; dir?: [number, number]; mode?: FrontOpts["mode"]; phase?: number; look?: number; facing?: -1 | 0 | 1; noBlob?: boolean; tilt?: number; headTilt?: number };
const guy = (out: Stage, cam: CamInfo, t: number, w: Who, x: number, y: number, z: number, o: GuyOpts) => {
  const dir = o.dir ?? [0, -1];
  const v = viewOf(cam, x, z, dir[0], dir[1]);
  const view = o.side ? { side: true, mirror: v.mirror } : { side: false, mirror: false };
  const blink = lidAt(t, w.i);
  const fo: FrontOpts = { mode: o.mode ?? "stand", phase: o.phase ?? 0, expr: o.expr, blink, look: o.look ?? 0, facing: o.facing ?? 0, tilt: o.tilt ?? 0, headTilt: o.headTilt ?? 0 };
  const so: SideOpts = { mode: o.mode === "stroll" ? "march" : "stand", phase: o.phase ?? 0, expr: o.expr, blink, stomp: 0.5, stride: 0.8 * v.fs };
  out.places.push(person(cam, w, x, y, z, view, fo, so));
  if (!o.noBlob) blob(out, x, y, z);
};

// ---------------- effect drawings ----------------
const fxStink = (p: Pen, t: number) => {
  for (let k = 0; k < 3; k++) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 16; i++) { const y = 280 - i * 16, x = 80 + k * 70 + 18 * Math.sin(i * 0.8 + t * 6.28 + k); pts.push([x, y]); }
    p.stroke(pts, 10, "#6f9a3a");
  }
};
const fxSmoke = (p: Pen, t: number, col: string) => {
  for (let i = 0; i < 5; i++) {
    const a = (160 + i * 55) * Math.PI / 180, d = 40 + 70 * t, r = (40 + 20 * (i % 2)) * (1 - 0.4 * t);
    p.ell(150 + d * Math.cos(a), 170 + d * 0.5 * Math.sin(a), r, r * 0.85, col.replace("A", (0.9 * (1 - t)).toFixed(3)), 0);
  }
};
const fxFlame = (p: Pen, t: number) => {
  const w = 1 + 0.08 * Math.sin(t * 40);
  p.poly([[150, 60], [150 + 38 * w, 170], [150, 230], [150 - 38 * w, 170]], "#ffb43a", 6);
  p.poly([[150, 120], [150 + 18 * w, 185], [150, 222], [150 - 18 * w, 185]], "#fff3b0", 0);
};
const fxGlow = (p: Pen) => {
  const g = p.g, gr = g.createRadialGradient(150, 150, 0, 150, 150, 150);
  gr.addColorStop(0, "rgba(255,190,90,0.55)"); gr.addColorStop(1, "rgba(255,150,60,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 300, 300);
};

const smoke = (out: Stage, x: number, y: number, z: number, u: number, s: number, col = "rgba(240,236,228,A)") => {
  if (u < 0 || u >= 1) return;
  out.fx.push({ key: `smk${col}${q(u, 20)}`, cw: 300, ch: 300, draw: (p) => fxSmoke(p, q(u, 20), col), x, y, z, w: s, h: s, soft: true });
};

// ---------------- the stage per shot ----------------
export const stage = (id: number, t: number, cam: CamInfo): Stage => {
  const out: Stage = { places: [], fx: [] };
  LN.v = SHOTS[id - 1].light as "day" | "golden";
  findSun(cam, SUN);
  const me = (x: number, y: number, z: number, o: GuyOpts) => guy(out, cam, t, who(1, YOU, "you"), x, y, z, o);
  switch (id) {
    case 1: me(YOU1[0], 0, YOU1[2], { expr: t < 93 / FPS ? "neutral" : t < 122 / FPS - L ? "smile" : "grin" }); break;
    case 2: {
      const f = t * FPS;
      if (f < 210) me(SHOP2[0] + 1.6, 0, SHOP2[2] + 0.6, { expr: "grin", facing: -1 });
      else if (f < 244) me(SPORT[0] - 1.35, 0, SPORT[2] - 0.6, { expr: "grin", facing: 1 });
      else me(QUEUE_X, 0, QUEUE_Z1 + 0.7, { expr: "smile_closed" });
      break;
    }
    case 3: {
      for (let k = 0; k < 3; k++) {
        const sx = PLANT[0] - 35 + 35 * k + 8, sz = PLANT[2] - 4, top = 46;
        for (let n = 0; n < 6; n++) {
          const born = t - n * 0.35, u = ((born * 0.35) % 1 + 1) % 1, t0 = born - u / 0.35;
          if (t0 > T_PLANTS[k]) continue; // puffs born after the plant shut down never appear
          smoke(out, sx + 14 * u, top + 3 + 22 * u, sz, u, 8 + 16 * u);
        }
      }
      break;
    }
    case 4: if (t * FPS >= 466) me(ROOF[0], ROOF[1], ROOF[2], { expr: t < 532 / FPS - L ? "relief_open" : "smile", headTilt: -6, noBlob: true }); break;
    case 5: {
      const y = floodY(t);
      if (y > -4.1) for (let k = 0; k < 4; k++) {
        const u = q(((t * 0.6 + k * 0.25) % 1), 30);
        out.fx.push({ key: `ring${u}`, cw: 600, ch: 600, draw: (p) => fxRing(p, u), x: SUBWAY[0] + (hh(k, 1) - 0.5) * 1.6, y: y + 0.02, z: SUBWAY[2] + 2 + 3 * hh(k, 2), w: 1.6, h: 1.6, flat: true });
      }
      break;
    }
    case 6: {
      if (t > T_ROT - L) for (let k = 0; k < 2; k++) {
        const u = q(((t * 0.8 + k * 0.5) % 1), 24);
        out.fx.push({ key: `stink${u}`, cw: 300, ch: 300, draw: (p) => fxStink(p, u), x: PORCH[0] - 1.1 + k * 0.25, y: DECK_H + 0.75, z: PORCH[2] + 0.55, w: 0.6, h: 0.6, soft: true });
      }
      me(PORCH[0] + 1.6, DECK_H + 0.05, PORCH[2] - 1.0, { expr: t < T_BEANS - L ? "neutral" : "pained", mode: "sit" });
      break;
    }
    case 7: {
      const f = t * FPS;
      if (f < 985) {
        const z = SHOWROOM_Z + 1 + 7.5 * smooth((f - 823) / 160);
        me(2.6, 0, z, { expr: "grin", side: true, dir: [0, 1], mode: "stroll", phase: q((t * 1.4) % 1, 24) });
      } else {
        const after = t > T_START - L;
        me(2.0, 0, SHOWROOM_Z + 6.6, { expr: after ? (t > T_START + 0.8 ? "nervous" : "shock") : "grin", facing: 1 });
        if (after) for (let k = 0; k < 3; k++) smoke(out, 4.6, 0.35, SHOWROOM_Z + 8.6 - 2.3, (t - T_START) * 0.9 - k * 0.25, 1.4 + k * 0.4, "rgba(60,58,64,A)");
      }
      break;
    }
    case 8: me(BOOKS[0] - 1.9, 0, BOOKS[2] - 1.0, { expr: "grin", facing: -1 }); break;
    case 9: {
      me(BOOKS[0] - 2.2, 0.48, BOOKS[2] - 1.35, { expr: "smile_closed", mode: "sit", noBlob: true });
      const u = q((t * 3) % 1, 12);
      out.fx.push({ key: "glow", cw: 300, ch: 300, draw: fxGlow, x: BOOKS[0] - 1.45, y: 0.95, z: BOOKS[2] - 1.6, w: 1.6, h: 1.6, soft: true });
      out.fx.push({ key: `flame${u}`, cw: 300, ch: 300, draw: (p) => fxFlame(p, u), x: BOOKS[0] - 1.45, y: 0.93, z: BOOKS[2] - 1.6, w: 0.12, h: 0.12 });
      break;
    }
    case 10: {
      for (let i = 0; i < 140; i++) {
        const lane = hh(i, 1), dirz = hh(i, 2) < 0.5 ? 1 : -1;
        const x = lane < 0.4 ? 7.2 + 1.8 * hh(i, 3) + (Math.abs(((-30 + 90 * hh(i, 4)) % 90) - 9) < 5 ? 0 : 0) : lane < 0.8 ? -7.2 - 1.8 * hh(i, 3) : (hh(i, 3) - 0.5) * 9;
        const z = -30 + ((90 * hh(i, 4) + dirz * 1.3 * (t - 38)) % 90 + 90) % 90;
        guy(out, cam, t, who(100 + i, folk(i), `f${i % 40}`), x, 0, z, { expr: (["neutral", "smile", "smile_closed"] as Expr[])[i % 3], side: true, dir: [0, dirz], mode: "stroll", phase: q((t * 1.4 + hh(i, 5)) % 1, 12) });
      }
      guy(out, cam, t, who(90, WORKER, "w0"), 7.0, 1.6, 8.5, { expr: "stern", noBlob: true });
      guy(out, cam, t, who(91, WORKER, "w1"), 8.2, 0.12, 9.8, { expr: "smile", facing: -1 });
      guy(out, cam, t, who(92, { ...WORKER, jacket: "#2f6a43" }, "w2"), 6.0, 0.12, 10.2, { expr: "neutral", facing: 1 });
      break;
    }
    case 13: case 14:
      me(PAPER[0], PILE_H, PAPER[2], { expr: id === 13 ? (t < 1705 / FPS ? "neutral" : "dazed") : "dazed", mode: "sit", noBlob: true });
      break;
  }
  return out;
};
