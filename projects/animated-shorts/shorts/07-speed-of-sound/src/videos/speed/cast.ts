// "What if you could run at the speed of sound?": YOU (the runner) plus all the effect cards.
import { Pen, fxPuff, fxBurst, fxStars, Expr, FrontOpts, SideOpts, Outfit, INK } from "./toon";
import { FPS, V3, hh, smooth, clamp01, SHOTS, RUN_X, START_Z, T_GO, runZ, carZ, T_FAST, T_STOP, T_SLAM, T_BILL, PORCH, DECK_H, SHOP2 } from "./story";
import { Stage, CamInfo, person, blob, lidAt, viewOf, findSun, SUN, LN, q, LEAD, Who } from "./cast_base";

export type { Stage } from "./cast_base";
export { Pool, Actor, Fx, SU } from "./cast_base";

const L = LEAD;
export const YOU: Outfit = { jacket: "#e0603f", pants: "#34466e", boots: "#f2efe8", hat: "hair", hair: "#4a3020", skin: "#f5c9a0" };
const ME: Who = { i: 1, o: YOU, okey: "you" };

type GuyOpts = { expr: Expr; side?: boolean; dir?: [number, number]; mode?: FrontOpts["mode"]; phase?: number; look?: number; facing?: -1 | 0 | 1; noBlob?: boolean; tilt?: number; stride?: number };
const me = (out: Stage, cam: CamInfo, t: number, x: number, y: number, z: number, o: GuyOpts) => {
  const dir = o.dir ?? [0, -1];
  const v = viewOf(cam, x, z, dir[0], dir[1]);
  const view = o.side ? { side: true, mirror: v.mirror } : { side: false, mirror: false };
  const blink = lidAt(t, 1);
  const fo: FrontOpts = { mode: o.mode ?? "stand", phase: o.phase ?? 0, expr: o.expr, blink, look: o.look ?? 0, facing: o.facing ?? 0, tilt: o.tilt ?? 0, lift: o.mode === "march" ? 90 : 0 };
  const so: SideOpts = { mode: o.mode === "march" ? "march" : "stand", phase: o.phase ?? 0, expr: o.expr, blink, stomp: 1.4, stride: (o.stride ?? 1.6) * Math.max(0.3, v.fs) };
  out.places.push(person(cam, ME, x, y, z, view, fo, so));
  if (!o.noBlob) blob(out, x, y, z);
};
const runPh = (t: number) => q((t * 4.2) % 1, 16);

// ---------------- effect drawings (300 x 300 unless noted) ----------------
const fxSpeed = (p: Pen, t: number) => { for (let i = 0; i < 7; i++) { const y = 30 + i * 38, x0 = 20 + 60 * hh(i, Math.floor(t * 8)), l = 120 + 100 * hh(i, 3); p.stroke([[x0, y], [x0 + l, y]], 7, "rgba(255,255,255,0.85)"); } };
const fxHeat = (p: Pen, t: number) => {
  for (let k = 0; k < 4; k++) { const pts: [number, number][] = []; for (let i = 0; i <= 16; i++) { const y = 280 - i * 16, x = 50 + k * 65 + 16 * Math.sin(i * 0.9 + t * 6.28 + k); pts.push([x, y]); } p.stroke(pts, 9, k % 2 ? "#ff8c3a" : "#ffb43a"); }
};
const fxCone = (p: Pen, t: number) => { for (let k = 0; k < 3; k++) { const r = 60 + 90 * t + k * 22; p.arc(150, 150, r, r * 0.9, 120, 240, 10 * (1 - t) + 2, "rgba(255,255,255,0.9)"); } };
const fxShards = (p: Pen, t: number) => {
  for (let i = 0; i < 14; i++) {
    const a = hh(i, 1) * 6.28, d = 30 + 130 * t * (0.5 + hh(i, 2)), x = 150 + Math.cos(a) * d, y = 120 + Math.sin(a) * d * 0.6 + 160 * t * t, s = 12 + 14 * hh(i, 3);
    p.poly([[x, y - s], [x + s * 0.8, y + s * 0.6], [x - s * 0.7, y + s * 0.4]], i % 2 ? "#cfeaff" : "#9fd0f0", 3);
  }
};
const fxWind = (p: Pen, t: number) => {
  for (let i = 0; i < 6; i++) { const y = 40 + i * 42, x = 300 - ((t * 300 + i * 70) % 330); p.arc(x, y, 50, 14, 180, 300, 6, "rgba(255,255,255,0.85)"); }
};
/** an arm out of a car window, from the shoulder at (40, 150), swept back by `back` 0..1 */
const fxArm = (p: Pen, back: number, flap: number) => {
  const a = (back * 55 + flap) * Math.PI / 180, ex = 40 + 170 * Math.cos(a), ey = 150 + 170 * Math.sin(a) * 0.4;
  p.line([[40, 150], [ex, ey]], "#e0603f", 34);
  p.ell(ex + 18 * Math.cos(a), ey + 8 * Math.sin(a), 22, 18, "#f5c9a0", 7, 0, 360, a * 57.3);
};
const fxReceipt = (p: Pen, flat: boolean) => {
  p.poly([[10, 6], [110, 6], [110, 994], [10, 994]], "#fbfaf5", 5);
  for (let y = 40; y < 990; y += 26) p.stroke([[25, y], [25 + 40 + 40 * hh(y, flat ? 1 : 2), y]], 5, "#9a958a");
};

// ---------------- the stage per shot ----------------
export const stage = (id: number, t: number, cam: CamInfo): Stage => {
  const out: Stage = { places: [], fx: [] };
  LN.v = SHOTS[id - 1].light as "day" | "golden";
  findSun(cam, SUN);
  const puff = (x: number, y: number, z: number, u: number, s = 1.4) => {
    if (u < 0 || u >= 1) return;
    out.fx.push({ key: `puff${q(u, 20)}`, cw: 300, ch: 300, draw: (p) => fxPuff(p, q(u, 20)), x, y: y + 0.35 * s, z, w: s, h: s, soft: true });
  };
  const card = (key: string, draw: (p: Pen) => void, x: number, y: number, z: number, w: number, h: number, soft = true, rot = 0, cw = 300, ch = 300) =>
    out.fx.push({ key, cw, ch, draw, x, y, z, w, h, soft, rot });
  const f = t * FPS;
  switch (id) {
    case 1: me(out, cam, t, RUN_X, 0, START_Z, { expr: f < 104 ? "grin" : "nervous" }); break;
    case 2: {
      const z = runZ(2, t), go = t > T_GO;
      me(out, cam, t, RUN_X, 0, z, { expr: go ? "grin" : "stern", side: true, dir: [0, 1], mode: go ? "march" : "stand", phase: runPh(t) });
      if (go) { for (let k = 0; k < 4; k++) puff(RUN_X, 0, z - 1.5 - k * 2.2, ((t - T_GO) * 1.5 + k * 0.2) % 1, 1.6 + k * 0.3); card(`spd${q(t % 1, 8)}`, (p) => fxSpeed(p, q(t % 1, 8)), RUN_X, 1.2, z - 1.4, 2.2, 2.0); }
      if (t >= T_GO && t < T_GO + 0.3) puff(RUN_X, 0, START_Z, (t - T_GO) / 0.3, 3);
      break;
    }
    case 3: case 4: {
      const z = runZ(id, t), hurt = id === 3 ? f > 441 - 2 : f > 527 - 2;
      me(out, cam, t, RUN_X, 0, z, { expr: id === 3 ? (hurt ? "pained" : "grin") : hurt ? "shock" : "pained", mode: "march", phase: runPh(t), dir: [0, 1] });
      if (id === 3) card(`heat${q(t % 1, 12)}`, (p) => fxHeat(p, q(t % 1, 12)), RUN_X, 1.75, z + 0.45, 0.9, 0.9);
      if (id === 4 && f >= 527 && f < 545) { const u = (f - 527) / 18; card(`splat${q(u, 18)}`, (p) => fxBurst(p, q(u, 18), "#b8d43a", 9, 30, 160), RUN_X + 0.08, 1.78, z + 0.32, 0.45, 0.45, false, 0, 500, 500); }
      break;
    }
    case 5: {
      const z = runZ(5, t);
      if (z < 30) me(out, cam, t, RUN_X, 0, z, { expr: "grin", mode: "march", phase: runPh(t), dir: [0, 1] });
      for (let k = 0; k < 5; k++) puff(RUN_X, 0, z - 2 - k * 3, ((t * 1.4 + k * 0.2) % 1), 2 + k * 0.4);
      if (f >= 606 && f < 640) { const u = (f - 606) / 34; card(`cone${q(u, 17)}`, (p) => fxCone(p, q(u, 17)), RUN_X, 1.3, z - 1.2, 5 + 6 * u, 5 + 6 * u); }
      if (f >= 662) for (const [x, zz] of [[-9.2, -8], [9.2, -14], [-9.2, -20], [9.2, -26], [-9.2, -32]] as const) { const u = clamp01((f - 662 - (zz % 5) * 2) / 30); if (u > 0 && u < 1) card(`shard${q(u, 15)}`, (p) => fxShards(p, q(u, 15)), x * 0.92, 4.5, zz, 3.2, 3.2, false); }
      break;
    }
    case 6: {
      const z = runZ(6, t);
      me(out, cam, t, RUN_X + 1.2, 0, z, { expr: "grin", side: f < 778, mode: "march", phase: runPh(t), dir: [0, 1] });
      for (let k = 0; k < 4; k++) puff(RUN_X + 1.2, 0, z - 2.5 - k * 3, ((t * 1.4 + k * 0.25) % 1), 2);
      break;
    }
    case 7: {
      const u = clamp01((f - 850) / 50), head = -110 + 230 * u;
      for (let zz = -110; zz < head; zz += 5) puff(RUN_X, 0, zz, 0.05 + 0.4 * clamp01((head - zz) / 160), 13);
      break;
    }
    case 8: me(out, cam, t, PORCH[0] + 1.6, DECK_H + 0.05, PORCH[2] - 1.0, { expr: f < 982 ? "dazed" : "pained", mode: "sit", noBlob: true }); break;
    case 9: {
      const z = runZ(9, t), hard = f > 1122;
      me(out, cam, t, RUN_X, 0, z, { expr: hard ? "pained" : "stern", side: true, dir: [0, 1], mode: "march", phase: runPh(t) });
      for (let k = 0; k < (hard ? 4 : 2); k++) card(`wind${q((t * 1.5 + k * 0.3) % 1, 16)}`, (p) => fxWind(p, q((t * 1.5 + k * 0.3) % 1, 16)), RUN_X - 0.3, 1.0 + k * 0.35, z + 1.2 - 0.15 * k, 1.8, 1.8);
      break;
    }
    case 10: {
      const z = carZ(t), fast = t > T_FAST, back = fast ? smooth((t - T_FAST) / 0.4) : 0, flap = fast ? 9 * Math.sin(t * 40) : 0;
      me(out, cam, t, 1.75, 0.55, z - 0.2, { expr: fast ? "shock" : "smile", mode: "sit", noBlob: true });
      card(`arm${q(back, 20)}${q(flap, 2)}`, (p) => fxArm(p, q(back, 20), q(flap, 2)), 0.62, 1.2, z - 0.05, 0.9, 0.9, false);
      if (fast) for (let k = 0; k < 3; k++) card(`wind${q((t * 2 + k * 0.3) % 1, 16)}`, (p) => fxWind(p, q((t * 2 + k * 0.3) % 1, 16)), 0.4, 1.0 + k * 0.3, z + 0.6, 1.4, 1.4);
      break;
    }
    case 11: {
      const z = runZ(11, t), u = t - T_STOP, stopped = u > 0.55, dazed = t > T_SLAM - L / 2;
      me(out, cam, t, RUN_X, 0, z, { expr: dazed ? "dazed" : u > 0 ? "shock" : "grin", side: !stopped, dir: [0, 1], mode: stopped ? "stand" : "march", phase: u > 0 ? 0.25 : runPh(t), tilt: stopped ? -6 : 0 });
      if (u > 0 && u < 0.6) for (let k = 0; k < 3; k++) { const s = q((u * 6 + k * 0.33) % 1, 15); card(`spark${s}`, (p) => fxBurst(p, s, "#ffd84a", 8, 20, 150), RUN_X, 0.15, z + 0.3 - k * 0.5, 0.6, 0.6, false, 0, 500, 500); puff(RUN_X, 0, z - 1 - k, (u * 2 + k * 0.2) % 1, 1.5); }
      if (dazed) { const s = q((t * 0.9) % 1, 30); card(`stars${s}`, (p) => fxStars(p, s), RUN_X, 2.3, z, 0.75, 0.375, false, 0, 420, 210); }
      break;
    }
    case 12: {
      const x = SHOP2[0] + 1.7, z = SHOP2[2] + 0.4, bill = t > T_BILL - L / 2;
      me(out, cam, t, x, 0, z, { expr: bill ? "shock" : "nervous" });
      const len = 0.5 + 7 * smooth((t - T_BILL) / 0.9);
      card("rcptV", (p) => fxReceipt(p, false), x + 0.42, 0.55, z - 0.12, 0.13, 0.95, false, 0, 120, 1000);
      if (len > 0.6) out.fx.push({ key: "rcptF", cw: 120, ch: 1000, draw: (p) => fxReceipt(p, true), x: x + 0.45 + len * 0.18, y: 0.03, z: z - 0.25 - len * 0.48, w: 0.13, h: len, flat: true, rot: 0.36 });
      break;
    }
  }
  return out;
};
