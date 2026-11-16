// "What if you were the last person alive?": the template's sky + light rig (plus a night / candle look and a Milky
// Way dome), then our own sets: an empty city street (shops, parked cars, a sports-car row, a bookshop, a flooding
// subway entrance, towers), three power plants, a porch, a beach with a sandcastle, an overgrown highway and the
// paper mountain. update(id, f, camera) poses everything for shot `id` at frame f.
import * as THREE from "three";
import { Batch, boxGeo, V, lam, house, Kit } from "./build";
import { ctex, rep, cloudHD, beam, planksHD, facadeHD } from "./paint";
import { Pen } from "./toon";
import { LIGHTS, LOOK, LightPreset } from "./lights";
import { TONE, CHAR, twoTone, untone } from "./shade";
import { NOINK } from "./ink";
import { Pool, Actor, Fx, stage, SU } from "./cast";
import { quadUp, disc, T4, cyl, beamBetween, discTex, haloTex } from "./kit";
import {
  FPS, SHOTS, camAt, V3, hh, smooth, clamp01, ShotDef, SHOP2, SPORT, QUEUE_X, QUEUE_Z0, QUEUE_Z1, PLANT, ROOF, SUBWAY, PORCH, DECK_H, SHOWROOM_Z,
  BOOKS, BEACH, HIGHWAY, PAPER, PILE_H, floodY, erosion, waveX, T_PLANTS, carZ,
} from "./story";

export const loadKit = () => Promise.resolve({} as Kit);
const SUN_SHOT: Record<number, { az?: number; el?: number }> = {};

const asphaltTex = () => ctex("asphalt", 1024, 1024, (g, r) => {
  g.fillStyle = "#5d5f66"; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 3000; i++) { g.fillStyle = r() < 0.5 ? "rgba(40,42,48,0.4)" : "rgba(120,122,130,0.35)"; g.fillRect(r() * 1024, r() * 1024, 3 + r() * 5, 3 + r() * 5); }
  g.fillStyle = "#f0e6c0"; for (let y = 0; y < 1024; y += 256) g.fillRect(500, y + 40, 24, 150); // centre dashes
  g.fillStyle = "#e9e4d8"; g.fillRect(20, 0, 14, 1024); g.fillRect(990, 0, 14, 1024);
});
const crackTex = () => ctex("cracked", 1024, 1024, (g, r) => {
  g.fillStyle = "#6a6a66"; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(90,140,60,${0.5 * r()})`; g.beginPath(); g.ellipse(r() * 1024, r() * 1024, 10 + 40 * r(), 6 + 20 * r(), r() * 3, 0, 6.3); g.fill(); }
  g.strokeStyle = "rgba(30,30,30,0.8)"; g.lineWidth = 4;
  for (let i = 0; i < 26; i++) { let x = r() * 1024, y = r() * 1024; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 90; y += (r() - 0.5) * 90; g.lineTo(x, y); } g.stroke(); }
});
const concreteTex = () => ctex("concrete", 512, 512, (g, r) => {
  g.fillStyle = "#c9c3b6"; g.fillRect(0, 0, 512, 512);
  g.strokeStyle = "rgba(110,104,96,0.6)"; g.lineWidth = 3; for (let x = 0; x <= 512; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke(); g.beginPath(); g.moveTo(0, x); g.lineTo(512, x); g.stroke(); }
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(120,112,100,${0.25 * r()})`; g.fillRect(r() * 512, r() * 512, 4, 4); }
});
const paperTex = () => ctex("paper", 256, 256, (g) => {
  g.fillStyle = "#f6f3ea"; g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#d8d2c4"; for (let y = 6; y < 256; y += 9) g.fillRect(0, y, 256, 2);
});
const starTex = () => ctex("stars", 4096, 2048, (g, r) => {
  g.fillStyle = "#000000"; g.fillRect(0, 0, 4096, 2048);
  // Milky Way: a soft band across the sky with dust lanes
  for (let i = 0; i < 2600; i++) {
    const x = r() * 4096, y = 700 + 260 * Math.sin(x / 4096 * 6.283) + (r() - 0.5) * 360 * r();
    const gr = g.createRadialGradient(x, y, 0, x, y, 40 + 80 * r());
    gr.addColorStop(0, `rgba(170,180,230,${0.05 + 0.05 * r()})`); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(x - 120, y - 120, 240, 240);
  }
  for (let i = 0; i < 9000; i++) {
    const band = r() < 0.5, x = r() * 4096, y = band ? 700 + 260 * Math.sin(x / 4096 * 6.283) + (r() - 0.5) * 300 : r() * 1100;
    const s = r() < 0.03 ? 3 : r() < 0.2 ? 2 : 1;
    g.fillStyle = `rgba(255,${235 + 20 * r()},${215 + 40 * r()},${0.5 + 0.5 * r()})`; g.fillRect(x, y, s, s);
  }
});
const glassM = () => lam("glassL", () => ({ color: "#2e3f52" }));


const EMU_GEO = (() => { const g = new THREE.PlaneGeometry(1000 * SU, 1000 * SU); g.translate(0, (975 - 500) * SU, 0); return g; })();

export class World {
  root = new THREE.Group();
  private pool = new Pool();
  private actors: Actor[] = [];
  private emus: Actor[] = [];
  private fxs: Fx[] = [];
  private hemi: THREE.HemisphereLight; private sun: THREE.DirectionalLight; private fill: THREE.DirectionalLight;
  private sky: THREE.Mesh; private skyMat: THREE.ShaderMaterial;
  private fog = new THREE.Fog("#bccbec", 25, 420);
  private sunDisc: THREE.Sprite; private sunHalo: THREE.Sprite;
  private sunCache = new Map<number, THREE.Vector3>();
  private cloudMaps: Record<"day" | "golden", THREE.Texture[]>;
  private clouds: THREE.Mesh[] = [];
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4(); private v = new THREE.Vector3(); private sph = new THREE.Sphere();
  private water!: THREE.Mesh; private windows: THREE.MeshBasicMaterial[] = []; private foam: THREE.Mesh[] = []; private castle!: THREE.Group;
  private paperPile = new THREE.Group(); private paperFlood = new THREE.Group(); private stars!: THREE.Mesh; private food8 = new THREE.Group(); private conv = new THREE.Group();
  constructor(_kit: Kit) {
    const R = this.root;
    // ---- sky + light ----
    // sky: 5 colour stops by elevation (textures.md 5.2 #5 + depth.md 2/6.5), written as tone-map-inverted linear values
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { c0: { value: new THREE.Color() }, c1: { value: new THREE.Color() }, c2: { value: new THREE.Color() },
        c3: { value: new THREE.Color() }, c4: { value: new THREE.Color() }, e: { value: new THREE.Vector4() } },
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform vec3 c0, c1, c2, c3, c4; uniform vec4 e; varying vec3 vP;
        void main(){ float el = asin(clamp(normalize(vP).y, -1.0, 1.0));
          vec3 c = mix(c0, c1, smoothstep(0.0, e.x, el));
          c = mix(c, c2, smoothstep(e.x, e.y, el));
          c = mix(c, c3, smoothstep(e.y, e.z, el));
          c = mix(c, c4, smoothstep(e.z, e.w, el));
          gl_FragColor = vec4(c, 1.0); }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1100, 48, 24), this.skyMat);
    this.sky.renderOrder = -1; this.sky.frustumCulled = false; this.sky.layers.set(NOINK);
    R.add(this.sky);
    this.sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTex(), color: new THREE.Color(6.0, 4.4, 2.4), fog: false, depthWrite: false }));
    this.sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex(), color: new THREE.Color(1, 1, 1), fog: false, depthWrite: false, depthTest: true,
      transparent: true, blending: THREE.AdditiveBlending }));
    this.sunDisc.renderOrder = -0.5; this.sunHalo.renderOrder = 5;
    for (const m of [this.sunDisc, this.sunHalo]) { m.frustumCulled = false; m.layers.set(NOINK); R.add(m); }
    this.hemi = new THREE.HemisphereLight("#cfe6ff", "#6c5c8c", 1.1);
    this.sun = new THREE.DirectionalLight("#fff0d6", 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.fill = new THREE.DirectionalLight("#9fb8ff", 0.35);
    R.add(this.hemi, this.sun, this.sun.target, this.fill, this.fill.target);
    this.cloudMaps = { day: [0, 1, 2, 3].map((k) => cloudHD(k, LOOK.day.cloud)), golden: [0, 1, 2, 3].map((k) => cloudHD(k, LOOK.golden.cloud)) };
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3, d = 620 + (i % 3) * 60;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.cloudMaps.day[i % 4], color: new THREE.Color(1.1, 1.1, 1.1), transparent: true, depthWrite: false, fog: false }));
      const w = 130 + (i % 4) * 30;
      m.position.set(Math.cos(a) * d, 120 + (i % 4) * 38, Math.sin(a) * d); m.scale.set(w, w / 2, 1);
      m.layers.set(NOINK);
      this.clouds.push(m); R.add(m);
    }

    const b = new Batch(), M: Record<string, THREE.Material> = {};
    M.asphalt = lam("asphaltM", () => ({ map: rep(asphaltTex(), 1, 1) }));
    M.crack = lam("crackM", () => ({ map: rep(crackTex(), 1, 1) }));
    M.walk = lam("walkM", () => ({ map: rep(concreteTex(), 1, 1) }));
    M.grass = lam("grassL", () => ({ color: "#8fae5a" }));
    M.glass = glassM();
    M.tire = lam("tireL", () => ({ color: "#26262b" }));
    M.chrome = lam("chromeL", () => ({ color: "#c6c2b8" }));
    M.wood = lam("woodL", () => ({ map: beam() }));
    M.deck = lam("deckL", () => ({ map: rep(planksHD(), 1, 1) }));
    M.iron = twoTone(new THREE.MeshPhongMaterial({ color: "#3d4a3f", specular: "#888888", shininess: 40 }), 0.15);
    M.lampGreen = lam("lampGreen", () => ({ color: "#4fbf6a" }));
    M.tile = lam("tileL", () => ({ color: "#d9d4c4" }));
    M.dark = lam("darkL", () => ({ color: "#2a2a30" }));
    M.water = lam("waterL", () => ({ color: "#4f8fa8" }));
    M.sand = lam("sandL", () => ({ color: "#ecd39a" }));
    M.wet = lam("wetL", () => ({ color: "#c9ae78" }));
    M.foam = lam("foamL", () => ({ color: "#f6fbff" }));
    M.ocean = lam("oceanL", () => ({ color: "#3d9fbf" }));
    M.paper = lam("paperL", () => ({ map: paperTex() }));
    M.brick = lam("brickL", () => ({ color: "#b5603f" }));
    M.stackR = lam("stackR", () => ({ color: "#e8e3da" }));
    M.stackB = lam("stackB", () => ({ color: "#c0453a" }));
    M.leaf = lam("leafL", () => ({ color: "#5f9a4a" }));
    M.leafDk = lam("leafDkL", () => ({ color: "#4a7d3a" }));
    M.bark = lam("barkL", () => ({ color: "#7a5a40" }));
    M.rust = lam("rustL", () => ({ color: "#8a5236" }));
    M.can = lam("canL", () => ({ color: "#d9573a" }));
    M.rot = lam("rotL", () => ({ color: "#6f6a2a" }));
    for (const k of ["asphalt", "walk", "deck", "crack"]) { const m = M[k] as THREE.MeshLambertMaterial; if (m.map) { m.map.anisotropy = 16; m.map.needsUpdate = true; } }

    // ---- ground: road, sidewalks (with the subway opening), plaza beyond ----
    for (const [x0, x1, z0, z1] of [[-1000, -9.5, -1000, 1000], [9.5, 1000, -1000, 1000], [-9.5, 9.5, -1000, -135], [-9.5, 9.5, 135, 1000]]) b.add(quadUp(x0, x1, z0, z1, (x1 - x0) / 5, (z1 - z0) / 5, -0.01), M.walk);
    b.add(quadUp(-6, 6, -135, 135, 1, 270 / 12, 0.005), M.asphalt);
    const SX0 = SUBWAY[0] - 1.3, SX1 = SUBWAY[0] + 1.3, SZ0 = SUBWAY[2] - 4, SZ1 = SUBWAY[2] + 6;
    b.add(quadUp(-9.5, -6, -135, 135, 1, 60, 0.12), M.walk);
    b.add(quadUp(6, 9.5, -135, SZ0, 1, 30, 0.12), M.walk); b.add(quadUp(6, 9.5, SZ1, 135, 1, 30, 0.12), M.walk);
    b.add(quadUp(6, SX0, SZ0, SZ1, 0.2, 2.5, 0.12), M.walk); b.add(quadUp(SX1, 9.5, SZ0, SZ1, 0.1, 2.5, 0.12), M.walk);
    for (const s of [-1, 1]) b.add(boxGeo(V(s < 0 ? -6.12 : 6, 0, -135), V(s < 0 ? -6 : 6.12, 0.12, 135)), M.tile); // kerbs

    // ---- the subway pit: walls, stairs, tunnel mouth, railings and green globe lamps ----
    const PY = -4.2;
    b.add(boxGeo(V(SX0 - 0.2, PY - 0.2, SZ0), V(SX0, 0.12, SZ1)), M.tile); b.add(boxGeo(V(SX1, PY - 0.2, SZ0), V(SX1 + 0.2, 0.12, SZ1)), M.tile);
    b.add(boxGeo(V(SX0, PY - 0.2, SZ1), V(SX1, 0.12, SZ1 + 0.2)), M.dark);
    b.add(boxGeo(V(SX0, PY - 0.3, SZ0), V(SX1, PY, SZ1)), M.tile);
    for (let k = 0; k < 14; k++) { const z0 = SZ0 + k * 0.5, y = -(k + 1) * 0.3; b.add(boxGeo(V(SX0, y, z0), V(SX1, y + 0.3, z0 + 0.5)), M.tile); }
    b.add(boxGeo(V(SX0 + 0.3, PY, SZ1 - 0.4), V(SX1 - 0.3, PY + 2.4, SZ1 - 0.2)), M.dark); // tunnel mouth
    for (const x of [SX0 - 0.1, SX1 + 0.1]) { b.add(boxGeo(V(x - 0.04, 1.02, SZ0), V(x + 0.04, 1.1, SZ1)), M.iron); for (let z = SZ0; z <= SZ1; z += 0.5) b.add(boxGeo(V(x - 0.02, 0.12, z - 0.02), V(x + 0.02, 1.05, z + 0.02)), M.iron); }
    b.add(boxGeo(V(SX0 - 0.1, 1.02, SZ1 - 0.04), V(SX1 + 0.1, 1.1, SZ1 + 0.04)), M.iron);
    for (const [x, z] of [[SX0 - 0.1, SZ0], [SX1 + 0.1, SZ0]]) {
      b.add(cyl(0.05, 0.06, 2.6), M.iron, T4(x, 1.3, z));
      b.add(new THREE.SphereGeometry(0.22, 14, 10), M.lampGreen, T4(x, 2.75, z));
    }

    // ---- buildings both sides; the roof building and the shops are placed by hand ----
    const STY = [
      { wall: "#d9c4a3", shutter: "#3f6fb5" }, { wall: "#c47a5c", shutter: "#2f5f6a" }, { wall: "#e3d2b8", shutter: "#2f6a43", brick: true },
      { wall: "#b9c2c9", shutter: "#5a6070" }, { wall: "#d8a95f", shutter: "#5a3b2a" }, { wall: "#9aa7b3", shutter: "#3a3f4a" },
    ];
    const bldg = (side: number, z0: number, z1: number, h: number, si: number) => {
      const st = STY[si % STY.length], w = z1 - z0, d = 14, x0 = side < 0 ? -9.5 - d : 9.5, x1 = side < 0 ? -9.5 : 9.5 + d;
      b.add(boxGeo(V(x0, 0, z0), V(x1, h, z1)), lam("bw" + st.wall, () => ({ color: st.wall })));
      const fx = side < 0 ? -9.5 + 0.02 : 9.5 - 0.02;
      const key = `c${si}_${Math.round(w)}_${Math.round(h)}`;
      const fm = lam("cf" + key, () => ({ map: facadeHD(key, w, h, { wall: st.wall, shutter: st.shutter, door: true, brick: (st as { brick?: boolean }).brick }) }));
      const g = new THREE.PlaneGeometry(w, h); g.rotateY(side < 0 ? Math.PI / 2 : -Math.PI / 2); g.translate(fx, h / 2, (z0 + z1) / 2);
      b.add(g, fm);
      b.add(boxGeo(V(x0, h, z0), V(x1, h + 0.5, z0 + 0.3)), M.tile); b.add(boxGeo(V(x0, h, z1 - 0.3), V(x1, h + 0.5, z1)), M.tile); // parapet
      const ax = side < 0 ? -9.5 : 9.5, aw = side < 0 ? 1.4 : -1.4;
      if (h < 30 && hh(si, z0) < 0.6) b.add(boxGeo(V(Math.min(ax, ax + aw), 3.0, z0 + 0.6), V(Math.max(ax, ax + aw), 3.15, z1 - 0.6)), lam("aw" + (si % 4), () => ({ color: ["#c0453a", "#2f6a43", "#3f6fb5", "#d9a441"][si % 4] })));
    };
    for (const side of [-1, 1]) {
      let z = -132, i = side > 0 ? 3 : 0;
      while (z < 132) {
        const w = 9 + 6 * hh(i, side + 5);
        const near = Math.abs(z) < 50;
        const h = near ? 9 + 9 * hh(i, side + 7) : 18 + 30 * hh(i, side + 7);
        const skip = (side < 0 && z + w > 0 && z < 14) || (side < 0 && z + w > SHOP2[2] - 6 && z < SHOP2[2] + 6) || (side > 0 && z + w > BOOKS[2] - 6 && z < BOOKS[2] + 6);
        if (!skip) bldg(side, z, Math.min(132, z + w), h, i);
        z += w + 0.3; i++;
      }
    }
    bldg(-1, 0, 14, ROOF[1], 3);                                   // the roof of the night shot
    bldg(-1, SHOP2[2] - 6, SHOP2[2] + 6, 10, 0);                   // the open shop
    bldg(1, BOOKS[2] - 6, BOOKS[2] + 6, 9, 4);                     // the bookshop
    for (let k = 0; k < 9; k++) b.add(boxGeo(V(-60 + k * 14, 0, 140), V(-48 + k * 14, 40 + 35 * hh(k, 9), 156)), lam("tw" + (k % 3), () => ({ color: ["#9aa7b3", "#b9c2c9", "#7f8c99"][k % 3] })));
    // roof props
    b.add(boxGeo(V(-20, ROOF[1], 8), V(-18, ROOF[1] + 1.2, 10)), M.chrome); b.add(cyl(1.2, 1.2, 2.4, 16), M.wood, T4(-21, ROOF[1] + 2.4, 2));
    // shop windows + bookshop books + book stacks + candle crate
    b.add(boxGeo(V(-9.55, 0.5, SHOP2[2] - 4), V(-9.45, 2.8, SHOP2[2] + 4)), M.glass);
    b.add(boxGeo(V(9.45, 0.5, BOOKS[2] - 4.5), V(9.55, 2.8, BOOKS[2] + 4.5)), M.glass);
    const bookCols = ["#c0453a", "#2f6a43", "#3f6fb5", "#d9a441", "#7b5ac9", "#e8e3da"];
    for (let i = 0; i < 70; i++) {
      const x = BOOKS[0] - 0.3 - 2.6 * hh(i, 1), z = BOOKS[2] - 4 + 7 * hh(i, 2), n = 1 + Math.floor(5 * hh(i, 3));
      if (Math.abs(x - (BOOKS[0] - 2.2)) < 0.8 && Math.abs(z - (BOOKS[2] - 1.35)) < 0.8) continue;
      for (let k = 0; k < n; k++) b.add(boxGeo(V(x - 0.16, 0.12 + k * 0.06, z - 0.12), V(x + 0.16, 0.12 + (k + 1) * 0.06, z + 0.12)), lam("bk" + ((i + k) % 6), () => ({ color: bookCols[(i + k) % 6] })), T4(0, 0, 0, 0));
    }
    for (let k = 0; k < 6; k++) b.add(boxGeo(V(BOOKS[0] - 2.5, 0.12 + k * 0.06, BOOKS[2] - 1.6), V(BOOKS[0] - 1.9, 0.12 + (k + 1) * 0.06, BOOKS[2] - 1.1)), lam("bk" + (k % 6), () => ({ color: bookCols[k % 6] })));
    b.add(boxGeo(V(BOOKS[0] - 1.7, 0.12, BOOKS[2] - 1.85), V(BOOKS[0] - 1.2, 0.72, BOOKS[2] - 1.35)), M.wood);
    b.add(cyl(0.035, 0.035, 0.18, 10), M.foam, T4(BOOKS[0] - 1.45, 0.81, BOOKS[2] - 1.6));
    // queue posts + ropes to the cinema door
    for (let z = QUEUE_Z0; z <= QUEUE_Z1; z += 1.25) for (const dx of [-0.6, 0.6]) b.add(cyl(0.04, 0.06, 1.0, 8), M.chrome, T4(QUEUE_X + dx, 0.62, z));
    for (const dx of [-0.6, 0.6]) b.add(boxGeo(V(QUEUE_X + dx - 0.02, 0.95, QUEUE_Z0), V(QUEUE_X + dx + 0.02, 0.99, QUEUE_Z1)), M.stackB);
    // street lamps
    for (let z = -120; z <= 120; z += 16) for (const s of [-1, 1]) {
      b.add(cyl(0.07, 0.09, 6.2, 8), M.iron, T4(s * 6.6, 3.1, z));
      b.add(boxGeo(V(s * 6.6 - (s > 0 ? 1.4 : 0), 6.1, z - 0.06), V(s * 6.6 + (s > 0 ? 0 : 1.4), 6.22, z + 0.06)), M.iron);
      b.add(boxGeo(V(s * 5.3 - 0.25, 5.95, z - 0.15), V(s * 5.3 + 0.25, 6.1, z + 0.15)), M.chrome);
    }
    // parked cars + the sports cars
    const car = (bb: Batch, x: number, z: number, yaw: number, col: string, sport = false, rust = false) => {
      const m = lam("car" + col, () => ({ color: col })), tr = T4(x, 0, z, yaw);
      const add = (g: THREE.BufferGeometry, mm: THREE.Material) => bb.add(g, mm, tr);
      if (sport) {
        add(boxGeo(V(-2.1, 0.3, -0.9), V(2.1, 0.85, 0.9)), m); add(boxGeo(V(-0.9, 0.85, -0.75), V(0.6, 1.2, 0.75)), M.glass);
        add(boxGeo(V(-2.15, 1.0, -0.85), V(-1.85, 1.08, 0.85)), m); add(boxGeo(V(-2.05, 0.85, -0.6), V(-1.95, 1.0, 0.6)), M.tire);
      } else {
        add(boxGeo(V(-2.2, 0.35, -0.9), V(2.2, 1.05, 0.9)), m); add(boxGeo(V(-1.2, 1.05, -0.82), V(0.9, 1.7, 0.82)), rust ? m : M.glass);
        add(boxGeo(V(-1.25, 1.7, -0.85), V(0.95, 1.78, 0.85)), m);
      }
      for (const [wx, wz] of [[1.4, 0.88], [1.4, -0.88], [-1.4, 0.88], [-1.4, -0.88]]) add(cyl(0.36, 0.36, 0.22, 14).rotateX(Math.PI / 2).translate(wx, 0.36, wz), M.tire);
    };
    const CARC = ["#8c3b4a", "#3f6fb5", "#e8e3da", "#5d7a3a", "#4a4f5a", "#d9a441", "#2f5f6a"];
    for (let z = -118; z < 118; z += 7.5) for (const s of [-1, 1]) {
      if (hh(z, s) < 0.3) continue;
      const busy = (s > 0 && ((z > SPORT[2] - 4 && z < SPORT[2] + 4) || (z > SHOWROOM_Z - 4 && z < SHOWROOM_Z + 22) || (z > SUBWAY[2] - 6 && z < SUBWAY[2] + 8) || (z > BOOKS[2] - 8 && z < BOOKS[2] + 4) || (z > 0 && z < 16)))
        || (s < 0 && ((z > QUEUE_Z0 - 4 && z < QUEUE_Z1 + 3) || (z > SHOP2[2] - 6 && z < SHOP2[2] + 3) || (z > 0 && z < 16)));
      if (busy) continue;
      car(b, s * 4.8, z, Math.PI / 2, CARC[Math.floor(hh(z, s + 3) * 7)]);
    }
    car(b, SPORT[0], SPORT[2], Math.PI / 2, "#d8352a", true);
    ["#d8352a", "#f2c230", "#2f6fd0", "#2f9a5a", "#f08a2c"].forEach((c, k) => car(b, 4.6, SHOWROOM_Z + k * 4.3, Math.PI / 2 + 0.35, c, true));

    // ---- power plants: halls, stacks, a cooling tower ----
    b.add(quadUp(PLANT[0] - 90, PLANT[0] + 90, PLANT[2] - 60, PLANT[2] + 60, 20, 12, 0.01), M.walk);
    for (let k = 0; k < 3; k++) {
      const x = PLANT[0] - 35 + 35 * k;
      b.add(boxGeo(V(x - 12, 0, PLANT[2] - 10), V(x + 12, 14, PLANT[2] + 10)), M.brick);
      b.add(cyl(2.4, 3.0, 46, 16), lam("stack", () => ({ color: "#e8e3da" })), T4(x + 8, 23, PLANT[2] - 4));
      for (const h of [36, 42]) b.add(cyl(2.55, 2.6, 2.5, 16), M.stackB, T4(x + 8, h, PLANT[2] - 4));
    }
    const cool = new THREE.LatheGeometry(Array.from({ length: 12 }, (_, i) => new THREE.Vector2(14 - 6 * Math.sin((i / 11) * Math.PI * 0.8), i * 3)), 28);
    b.add(cool, lam("cool", () => ({ color: "#cfc9bd", side: THREE.DoubleSide })), T4(PLANT[0] + 60, 0, PLANT[2] + 30));
    // ---- porch (beans) ----
    house(b, PORCH[0] + 0.5, PORCH[2] - 6.2, 0, 9, 7, 3.3, 2, 0);
    b.add(boxGeo(V(PORCH[0] - 4, 0, PORCH[2] - 2.7), V(PORCH[0] + 5, DECK_H, PORCH[2] + 2.2), 0), M.deck);
    const SX = PORCH[0] + 1.6, SZ = PORCH[2] - 1.35, SY = DECK_H + 0.2;
    const sofa = lam("sofaL", () => ({ color: "#a84a3c" })), sofaDk = lam("sofaDkL", () => ({ color: "#843a30" }));
    b.add(boxGeo(V(SX - 1.0, SY, SZ - 0.45), V(SX + 1.0, SY + 0.3, SZ + 0.45)), sofa);
    b.add(boxGeo(V(SX - 1.0, SY + 0.3, SZ - 0.45), V(SX + 1.0, SY + 0.9, SZ - 0.2)), sofaDk);
    for (const s of [-1, 1]) b.add(boxGeo(V(SX + s * 1.0 - 0.13, SY, SZ - 0.45), V(SX + s * 1.0 + 0.13, SY + 0.55, SZ + 0.45)), sofaDk);
    b.add(boxGeo(V(SX - 0.5, DECK_H, SZ + 0.75), V(SX + 0.5, DECK_H + 0.45, SZ + 1.3)), M.wood); // coffee table
    for (let k = 0; k < 7; k++) b.add(cyl(0.05, 0.05, 0.12, 12), M.can, T4(SX - 0.35 + 0.11 * k, DECK_H + 0.51 + (k > 4 ? 0.12 : 0), SZ + 0.95 + (k % 2) * 0.12));
    b.add(boxGeo(V(PORCH[0] - 1.45, DECK_H, PORCH[2] + 0.3), V(PORCH[0] - 0.75, DECK_H + 0.35, PORCH[2] + 0.8)), M.wood); // rotten crate
    for (let k = 0; k < 9; k++) b.add(new THREE.SphereGeometry(0.09, 10, 8), k % 3 ? M.rot : lam("rot2", () => ({ color: "#4a3a22" })), T4(PORCH[0] - 1.35 + 0.12 * (k % 5), DECK_H + 0.4, PORCH[2] + 0.45 + 0.15 * Math.floor(k / 5)));

    // ---- beach: sand, wet band, sea, bucket ----
    b.add(quadUp(BEACH[0] - 6, BEACH[0] + 60, BEACH[2] - 60, BEACH[2] + 60, 1, 1, 0.02), M.sand);
    b.add(quadUp(BEACH[0] - 9, BEACH[0] - 2.5, BEACH[2] - 60, BEACH[2] + 60, 1, 1, 0.015), M.wet);
    b.add(quadUp(BEACH[0] - 400, BEACH[0] - 6.5, BEACH[2] - 400, BEACH[2] + 400, 1, 1, 0.03), M.ocean);
    b.add(cyl(0.16, 0.12, 0.25, 14), M.stackB, T4(BEACH[0] + 1.2, 0.14, BEACH[2] + 0.9));

    // ---- overgrown highway ----
    b.add(quadUp(HIGHWAY[0] - 150, HIGHWAY[0] + 250, HIGHWAY[2] - 6, HIGHWAY[2] + 6, 400 / 12, 1, 0.01), M.crack);
    b.add(quadUp(HIGHWAY[0] - 150, HIGHWAY[0] + 250, HIGHWAY[2] - 60, HIGHWAY[2] - 6, 40, 6, 0.008), M.grass);
    b.add(quadUp(HIGHWAY[0] - 150, HIGHWAY[0] + 250, HIGHWAY[2] + 6, HIGHWAY[2] + 60, 40, 6, 0.008), M.grass);
    const tree = (x: number, z: number, s: number, i: number) => {
      b.add(cyl(0.12 * s, 0.22 * s, 3.2 * s, 7), M.bark, T4(x, 1.6 * s, z));
      for (let k = 0; k < 4; k++) { const a = hh(i, k) * 6.28; b.add(new THREE.IcosahedronGeometry(1, 0), k % 2 ? M.leaf : M.leafDk, T4(x + Math.cos(a) * 0.7 * s, (3.4 + 0.8 * hh(i, k + 4)) * s, z + Math.sin(a) * 0.7 * s, a, [1.5 * s, 1.2 * s, 1.5 * s])); }
    };
    for (let i = 0; i < 70; i++) {
      const x = HIGHWAY[0] - 40 + i * 3.6 + 2 * hh(i, 1), z = HIGHWAY[2] + (hh(i, 2) - 0.5) * (i % 3 ? 30 : 9);
      if (Math.abs(z - HIGHWAY[2]) < 2.6 && x < HIGHWAY[0] + 6 && x > HIGHWAY[0] - 20) continue;
      tree(x, z, 0.8 + 0.9 * hh(i, 3), i);
      b.add(new THREE.SphereGeometry(1, 8, 5, 0, 6.3, 0, Math.PI / 2), M.leafDk, T4(x + 2, 0, z + 1.5, 0, [1.1, 0.7, 1.0]));
    }
    for (let i = 0; i < 8; i++) car(b, HIGHWAY[0] - 10 + i * 9, HIGHWAY[2] + (i % 2 ? 2.4 : -2.4), 0.2 * (hh(i, 7) - 0.5), "#8a5236", false, true);

    b.build(this.root);

    // ---- shot 8: a mountain of food on the porch table; shot 10: a convertible ----
    const fb8 = new Batch(), food = [lam("bread", () => ({ color: "#d9a05a" })), lam("melon", () => ({ color: "#4f9a3a" })), M.can, lam("cheese", () => ({ color: "#f2c230" })), lam("apple", () => ({ color: "#d8352a" }))];
    for (let i = 0; i < 70; i++) {
      const r = 0.55 * Math.sqrt(hh(i, 1)), a = hh(i, 2) * 6.28, y = DECK_H + 0.5 + 0.3 * (1 - r / 0.6) * hh(i, 3), k = i % 5;
      const g = k === 0 ? boxGeo(V(-0.14, -0.06, -0.07), V(0.14, 0.06, 0.07)) : k === 1 ? new THREE.SphereGeometry(0.12, 10, 8) : k === 2 ? cyl(0.05, 0.05, 0.12, 10) : k === 3 ? boxGeo(V(-0.08, -0.05, -0.08), V(0.08, 0.05, 0.08)) : new THREE.SphereGeometry(0.05, 8, 6);
      fb8.add(g, food[k], T4(PORCH[0] + 1.6 + Math.cos(a) * r, y, PORCH[2] + 0.1 + Math.sin(a) * r * 0.45, a));
    }
    fb8.build(this.food8); this.root.add(this.food8);
    const cv = new Batch(), red = lam("convRed", () => ({ color: "#2f6fd0" }));
    cv.add(boxGeo(V(-0.9, 0.35, -2.2), V(0.9, 0.95, 2.2)), red); cv.add(boxGeo(V(-0.85, 0.95, 0.5), V(0.85, 1.25, 0.55)), M.glass);
    cv.add(boxGeo(V(-0.7, 0.6, -0.8), V(0.7, 1.0, -0.6)), lam("seat", () => ({ color: "#5a3b2a" })));
    for (const [wx, wz] of [[0.88, 1.4], [-0.88, 1.4], [0.88, -1.4], [-0.88, -1.4]]) cv.add(cyl(0.36, 0.36, 0.22, 14).rotateZ(Math.PI / 2).translate(wx, 0.36, wz), M.tire);
    cv.build(this.conv); this.root.add(this.conv);

    // ---- dynamic / per-shot sets ----
    this.water = new THREE.Mesh(quadUp(SX0, SX1, SZ0, SZ1, 1, 1, 0), M.water); this.root.add(this.water);
    // the plants' window strips (lit, then dark one by one)
    for (let k = 0; k < 3; k++) {
      const m = new THREE.MeshBasicMaterial({ color: "#ffd772" }), x = PLANT[0] - 35 + 35 * k;
      const w = new THREE.Mesh(new THREE.BoxGeometry(20, 1.4, 0.1), m); w.position.set(x, 9, PLANT[2] - 10.06); w.layers.set(NOINK);
      this.root.add(w); this.windows.push(m);
    }
    // waves and the sandcastle
    for (let k = 0; k < 2; k++) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 120), M.foam); f.layers.set(NOINK); this.root.add(f); this.foam.push(f); }
    const cb = new Batch(), CS = new THREE.Group();
    cb.add(cyl(0.75, 0.85, 0.35, 20), M.sand, T4(0, 0.17, 0));
    cb.add(boxGeo(V(-0.5, 0.35, -0.5), V(0.5, 0.75, 0.5)), M.sand);
    for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) { cb.add(cyl(0.16, 0.18, 0.6, 12), M.sand, T4(x, 0.65, z)); cb.add(new THREE.ConeGeometry(0.19, 0.24, 12), M.sand, T4(x, 1.07, z)); }
    cb.add(cyl(0.22, 0.26, 0.5, 12), M.sand, T4(0, 1.0, 0)); cb.add(new THREE.ConeGeometry(0.26, 0.32, 12), M.sand, T4(0, 1.41, 0));
    cb.build(CS); CS.position.set(BEACH[0], 0.02, BEACH[2]); this.root.add(CS); this.castle = CS;
    // paper: the pile (shot 13) and the whole street full (shot 14)
    const pb = new Batch(), ps = new THREE.BoxGeometry(0.6, 0.3, 0.45);
    for (let i = 0; i < 900; i++) {
      const r = 5.2 * Math.sqrt(hh(i, 1)), a = hh(i, 2) * 6.28, top = PILE_H * (1 - (r / 5.4) ** 2);
      for (let y = 0; y < top; y += 0.3) pb.add(ps, M.paper, T4(PAPER[0] + Math.cos(a) * r, y + 0.15, PAPER[2] + Math.sin(a) * r, hh(i, 3) * 3));
    }
    pb.build(this.paperPile); this.root.add(this.paperPile);
    const fb = new Batch();
    for (let i = 0; i < 1600; i++) {
      const x = -24 + 48 * hh(i, 11), z = PAPER[2] - 60 + 120 * hh(i, 12), n = 1 + Math.floor(9 * hh(i, 13));
      if (Math.hypot(x - PAPER[0], z - PAPER[2]) < 5.6) continue;
      for (let k = 0; k < n; k++) fb.add(ps, M.paper, T4(x, 0.15 + k * 0.3, z, hh(i, 14) * 3));
    }
    fb.build(this.paperFlood); this.root.add(this.paperFlood);
    // the night sky: Milky Way dome
    this.stars = new THREE.Mesh(new THREE.SphereGeometry(1050, 48, 24), new THREE.MeshBasicMaterial({ map: starTex(), side: THREE.BackSide, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, color: new THREE.Color(1.6, 1.6, 1.6) }));
    this.stars.renderOrder = -0.9; this.stars.frustumCulled = false; this.stars.layers.set(NOINK); this.root.add(this.stars);

  }

  /** camera-relative sun, frozen per shot: the shot's mean view direction turned by az toward screen right, lifted by el */
  private shotSun(id: number, s: ShotDef, L: LightPreset) {
    let v = this.sunCache.get(id);
    if (v) return v;
    let fx = 0, fz = 0;
    for (let f = s.a; f < s.b; f += 3) {
      const c = camAt(id, f), x = c.look[0] - c.pos[0], z = c.look[2] - c.pos[2], n = Math.hypot(x, z) || 1;
      fx += x / n; fz += z / n;
    }
    const n = Math.hypot(fx, fz) || 1; fx /= n; fz /= n;
    const ss = s as ShotDef & { sunAz?: number; sunEl?: number };
    const az = THREE.MathUtils.degToRad(ss.sunAz ?? SUN_SHOT[id]?.az ?? L.az), el = THREE.MathUtils.degToRad(ss.sunEl ?? SUN_SHOT[id]?.el ?? L.el);
    const hx = fx * Math.cos(az) - fz * Math.sin(az), hz = fz * Math.cos(az) + fx * Math.sin(az); // screen right = (-fz, fx)
    v = new THREE.Vector3(hx * Math.cos(el), Math.sin(el), hz * Math.cos(el)).normalize();
    this.sunCache.set(id, v);
    return v;
  }

  private actor(i: number) { while (this.actors.length <= i) this.actors.push(new Actor(this.root)); return this.actors[i]; }
  private emuA(i: number) { while (this.emus.length <= i) this.emus.push(new Actor(this.root, EMU_GEO)); return this.emus[i]; }
  private fx(i: number) { while (this.fxs.length <= i) this.fxs.push(new Fx(this.root)); return this.fxs[i]; }

  update(id: number, f: number, cam: THREE.PerspectiveCamera, scene: THREE.Scene) {
    const t = f / FPS, s = SHOTS[id - 1], L = LIGHTS[s.light];
    // ---- camera ----
    const c = camAt(id, f);
    cam.position.set(...c.pos); cam.up.set(0, 1, 0); cam.lookAt(...c.look); cam.rotateZ(c.roll);
    cam.fov = c.fov; cam.near = 0.2; cam.far = 1500; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const focus = V(...c.look), dist = cam.position.distanceTo(focus);
    cam.layers.enable(NOINK); // sky, clouds, smoke and sun sprites live on the no-ink layer but are still rendered
    // ---- light rig (lighting.md 9.4): camera-relative sun frozen per shot, two-tone uniforms, shadow fit ----
    const K = LOOK[s.light], sunDir = this.shotSun(id, s, L);
    this.hemi.color.set(L.sky); this.hemi.groundColor.set(L.ground); this.hemi.intensity = L.hemiI;
    this.sun.color.set(L.sunCol); this.sun.intensity = L.sunI;
    let Rr = THREE.MathUtils.clamp(dist * 1.15 + 7, 12, 95);
    if (s.light === "golden") Rr = Math.max(Rr, 30); // el 7: 2 m cards throw ~16 m shadows, houses much longer
    this.sun.position.copy(focus).addScaledVector(sunDir, 220); this.sun.target.position.copy(focus);
    const sc = this.sun.shadow.camera;
    sc.left = -Rr; sc.right = Rr; sc.top = Rr; sc.bottom = -Rr; sc.near = 20; sc.far = 480; sc.updateProjectionMatrix();
    this.sun.shadow.bias = L.bias; this.sun.shadow.normalBias = L.normalBias * (Rr / 12);
    this.fill.intensity = 0; // not used by the two-tone shading
    TONE.uLitCol.value.set(...L.lit); TONE.uShadeCol.value.set(...L.shade); TONE.uShadeLift.value.set(...L.lift);
    TONE.uLambert.value = L.lambert; TONE.uSideK.value = L.sideK; TONE.uTerm.value = L.term; TONE.uBounce.value.set(...LOOK[s.light].bounce); TONE.uSat.value = LOOK[s.light].sat;
    CHAR.uCharTint.value.set(...L.charTint); CHAR.uCharShade.value = L.charShade; CHAR.uGrad.value = L.charGrad;
    CHAR.uBodyGrad.value = L.bodyGrad; CHAR.uSideTint.value.set(...L.sideTint);
    // ---- sky, fog (colour = horizon colour, linear fogNear -> fogFar), sun disc + halo, clouds ----
    const su = this.skyMat.uniforms;
    K.sky.c.forEach((h, i) => untone(h, su["c" + i].value));
    const e = K.sky.e.map((deg) => THREE.MathUtils.degToRad(deg));
    su.e.value.set(e[1], e[2], e[3], e[4]);
    this.sky.position.copy(cam.position);
    untone(L.fog, this.fog.color); this.fog.near = L.fogNear; this.fog.far = L.fogFar;
    scene.fog = this.fog; scene.background = null;
    const showSun = s.light === "golden";
    this.sunDisc.visible = this.sunHalo.visible = showSun;
    if (showSun) {
      this.sunDisc.position.copy(cam.position).addScaledVector(sunDir, 900);
      this.sunDisc.scale.setScalar(2 * 900 * Math.tan(THREE.MathUtils.degToRad(1.7)));
      this.sunHalo.position.copy(this.sunDisc.position); this.sunHalo.scale.setScalar(2 * 900 * Math.tan(THREE.MathUtils.degToRad(24)));
      (this.sunHalo.material as THREE.SpriteMaterial).color.set(L.sunDisc).multiplyScalar(1.3);
    }
    for (let i = 0; i < this.clouds.length; i++) {
      const m = this.clouds[i], mat = m.material as THREE.MeshBasicMaterial;
      m.lookAt(cam.position.x, m.position.y, cam.position.z);
      mat.map = this.cloudMaps[s.light === "golden" ? "golden" : "day"][i % 4];
    }
    this.food8.visible = id === 8;
    this.conv.visible = id === 10; this.conv.position.set(1.6, 0, carZ(t));
    const night = s.light === "night" || s.light === "candle";
    this.stars.visible = night; this.stars.position.copy(cam.position);
    for (const c of this.clouds) c.visible = !night;
    this.water.visible = false; this.water.position.y = floodY(t);
    
    this.castle.visible = false;
    this.castle.scale.set(1 + 0.2 * erosion(t), Math.max(0.12, 1 - 0.9 * erosion(t)), 1 + 0.2 * erosion(t));
    this.foam.forEach((f, k) => { f.visible = false; const w = waveX(t + k * 0.45); f.position.set(BEACH[0] - 6 + 5.6 * w, 0.03, BEACH[2]); f.scale.x = 0.5 + 2 * w; });
    this.paperPile.visible = false; this.paperFlood.visible = false;
    const FOG_SHOT: Record<number, [number, number]> = { 7: [120, 900] };
    if (FOG_SHOT[id]) { this.fog.near = FOG_SHOT[id][0]; this.fog.far = FOG_SHOT[id][1]; }
    // ---- cast + effects ----
    const right = V(0, 0, 0).setFromMatrixColumn(cam.matrixWorld, 0);
    const st = stage(id, t, { pos: cam.position, right });
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let ai = 0, ei = 0;
    const used: Actor[] = [];
    for (const p of st.places) {
      const sc2 = p.scale ?? 1, isEmu = (p as { geo?: string }).geo === "emu";
      if (!this.frustum.intersectsSphere(this.sph.set(this.v.set(p.x, p.y + 1.1 * sc2, p.z), 3.5))) continue;
      const a = isEmu ? this.emuA(ei++) : this.actor(ai++);
      const [w, h, k] = p.size ?? [300, 500, 0.5];
      a.r = this.pool.req(p.key, w, h, k, p.draw);
      a.mesh.visible = true;
      a.mesh.position.set(p.x, p.y, p.z);
      a.mesh.rotation.set(0, p.yaw ?? Math.atan2(cam.position.x - p.x, cam.position.z - p.z), p.roll ?? 0);
      a.mesh.scale.set(p.mirror ? -sc2 : sc2, sc2, sc2);
      a.mesh.castShadow = L.actorShadow;
      used.push(a);
    }
    for (let i = ai; i < this.actors.length; i++) this.actors[i].mesh.visible = false;
    for (let i = ei; i < this.emus.length; i++) this.emus[i].mesh.visible = false;
    let fi = 0;
    const fused: Fx[] = [];
    for (const p of st.fx) {
      if (!this.frustum.intersectsSphere(this.sph.set(this.v.set(p.x, p.y, p.z), Math.max(p.w, p.h)))) continue;
      const e = this.fx(fi++);
      e.r = this.pool.req(p.key, p.cw, p.ch, 1, p.draw);
      e.use(!!p.soft);
      e.mesh.visible = true;
      e.mesh.position.set(p.x, p.y, p.z);
      if (p.flat) e.mesh.rotation.set(-Math.PI / 2, 0, p.rot ?? 0);
      else { e.mesh.quaternion.copy(cam.quaternion); e.mesh.rotateZ(p.rot ?? 0); }
      e.mesh.scale.set(p.w, p.h, 1);
      fused.push(e);
    }
    for (let i = fi; i < this.fxs.length; i++) this.fxs[i].mesh.visible = false;
    this.pool.flush();
    for (const a of used) a.bind();
    for (const e of fused) e.bind();
    return focus;
  }
}
