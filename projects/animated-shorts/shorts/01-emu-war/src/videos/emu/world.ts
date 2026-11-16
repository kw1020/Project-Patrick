// The Emu War world as one three.js scene: sky + light rig from the bridge template (camera-relative sun frozen per
// shot, two-tone shading, painted clouds), then our own set: wheat farms, a red-dirt track with bumps, the waterhole,
// a windpump, a farmhouse + porch with marbles, gum trees, a fence, a 1930s army truck, Lewis guns, ammo crates and
// the rock. update(id, f, camera) poses everything for shot `id` at frame f (pure function of id + f).
import * as THREE from "three";
import { Batch, boxGeo, V, lam, house, Kit } from "./build";
import { ctex, rep, cloudHD, beam, planksHD } from "./paint";
import { Pen } from "./toon";
import { LIGHTS, LOOK, LightPreset } from "./lights";
import { TONE, CHAR, twoTone, untone } from "./shade";
import { NOINK } from "./ink";
import { Pool, Actor, Fx, stage, SU } from "./cast";
import {
  FPS, SHOTS, camAt, V3, hh, smooth, clamp01, ShotDef, GUN0, HOUSE, CRATES3, TRUCK3, DAM, DAM_R, GUN5, TRACK_Z, CRATES9, FLOCK, PORCH, DECK_H,
  MAJOR13, FARMER14, ROCK, ROCK_TOP, ABANDONED, truckX, truckBounce, truckPitch, T_SPILL, EMU_CU, MAJOR3, MAJOR9,
} from "./story";

export const loadKit = () => Promise.resolve({} as Kit);
const SUN_SHOT: Record<number, { az?: number; el?: number }> = {};

const wheatTex = () => ctex("wheat", 1024, 1024, (g, r) => {
  g.fillStyle = "#d9b45c"; g.fillRect(0, 0, 1024, 1024);
  for (let y = 0; y < 1024; y += 32) { g.fillStyle = "rgba(170,120,40,0.35)"; g.fillRect(0, y + 22, 1024, 6); }
  for (let i = 0; i < 2600; i++) {
    const x = r() * 1024, y = r() * 1024, l = 8 + r() * 16;
    g.strokeStyle = r() < 0.5 ? "rgba(240,210,120,0.8)" : "rgba(180,130,50,0.6)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 6, y - l); g.stroke();
  }
});
const dryTex = () => ctex("dry", 1024, 1024, (g, r) => {
  g.fillStyle = "#b9a564"; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 1800; i++) {
    const x = r() * 1024, y = r() * 1024;
    g.fillStyle = r() < 0.5 ? "rgba(150,140,70,0.5)" : "rgba(214,196,120,0.6)";
    g.beginPath(); g.ellipse(x, y, 6 + r() * 18, 3 + r() * 8, r() * 3, 0, Math.PI * 2); g.fill();
  }
});
const dirtTex = () => ctex("dirt", 1024, 1024, (g, r) => {
  g.fillStyle = "#c27a48"; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 2200; i++) {
    const x = r() * 1024, y = r() * 1024;
    g.fillStyle = r() < 0.5 ? "rgba(150,85,45,0.55)" : "rgba(220,150,100,0.5)";
    g.beginPath(); g.ellipse(x, y, 2 + r() * 9, 2 + r() * 6, r() * 3, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = "rgba(120,70,40,0.35)"; g.lineWidth = 10;
  for (const y of [380, 640]) { g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= 1024; x += 64) g.lineTo(x, y + 8 * Math.sin(x * 0.02)); g.stroke(); }
});
const crateTex = () => ctex("crate", 256, 256, (g, r) => {
  g.fillStyle = "#8a6a3e"; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 64) { g.fillStyle = "rgba(60,40,20,0.8)"; g.fillRect(0, y, 256, 4); }
  g.strokeStyle = "#5a4024"; g.lineWidth = 14; g.strokeRect(7, 7, 242, 242);
  g.fillStyle = "#e9dcb8"; g.fillRect(80, 100, 96, 56); // stencil plate (no lettering)
  g.fillStyle = "#3a2a18"; for (let i = 0; i < 5; i++) g.fillRect(92 + i * 16, 116, 8, 24);
  for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(60,40,20,${0.2 * r()})`; g.fillRect(r() * 256, r() * 256, 18, 2); }
});
const discTex = () => ctex("sunDisc", 128, 128, (g) => {
  const gr = g.createRadialGradient(64, 64, 58, 64, 64, 64); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
});
const haloTex = () => ctex("sunHalo", 256, 256, (g) => {
  const im = g.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const u = Math.hypot(x - 127.5, y - 127.5) / 128;
    const a = (0.55 * Math.exp(-((u / 0.25) ** 2)) + 0.35 * Math.exp(-((u / 0.6) ** 2))) * (1 - Math.min(1, Math.max(0, (u - 0.8) / 0.2)));
    const i = (y * 256 + x) * 4; im.data[i] = im.data[i + 1] = im.data[i + 2] = 255; im.data[i + 3] = Math.round(255 * Math.min(1, a));
  }
  g.putImageData(im, 0, 0);
});
/** horizontal quad at height y covering x0..x1, z0..z1 with uv repeats (u, v) */
const quadUp = (x0: number, x1: number, z0: number, z1: number, u: number, v: number, y = 0) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, u, 0, u, v, 0, 0, u, v, 0, v], 2));
  return g;
};
const disc = (r: number, y: number, seg = 48) => { const g = new THREE.CircleGeometry(r, seg); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return g; };
const T4 = (x: number, y: number, z: number, ry = 0, s: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), ry), V(...s));
const cyl = (r0: number, r1: number, h: number, n = 10) => new THREE.CylinderGeometry(r0, r1, h, n);
const beamBetween = (a: THREE.Vector3, b: THREE.Vector3, th: number) => {
  const g = new THREE.BoxGeometry(th, a.distanceTo(b), th);
  const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()), V(1, 1, 1));
  return g.applyMatrix4(m);
};

/** camera segments of every shot: things placed on them would block the view */
const SIGHT: { o: THREE.Vector3; l: THREE.Vector3 }[] = [];
const sightInit = () => {
  if (SIGHT.length) return;
  for (const s of SHOTS) for (let f = s.a; f < s.b; f += 6) { const c = camAt(s.id, f); SIGHT.push({ o: V(...c.pos), l: V(...c.look) }); }
};
const blocks = (x: number, z: number, r: number) => {
  const p = V(x, 1.5, z);
  for (const { o, l } of SIGHT) {
    const d = l.clone().sub(o), L2 = d.lengthSq(), u = clamp01(p.clone().sub(o).dot(d) / L2);
    if (o.clone().addScaledVector(d, u).distanceTo(p) < r + 4 && u > 0.02) return true;
    if (p.distanceTo(o) < r + 9) return true;
  }
  return false;
};

/** Lewis gun pointing local +x, pivot at the origin */
const lewisGun = (M: Record<string, THREE.Material>) => {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rz = 0, rx = 0) => {
    const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.rotation.set(rx, 0, rz); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh);
  };
  add(cyl(0.07, 0.07, 0.86, 12), M.gunmetal, 0.55, 0.0, 0, Math.PI / 2);   // cooling shroud
  add(cyl(0.025, 0.025, 0.3, 8), M.gunmetal, 1.1, 0.0, 0, Math.PI / 2);   // muzzle
  add(new THREE.BoxGeometry(0.46, 0.12, 0.1), M.gunmetal, -0.1, -0.01, 0);  // receiver
  add(cyl(0.18, 0.18, 0.05, 20), M.pan, -0.05, 0.1, 0);                    // pan magazine
  add(new THREE.BoxGeometry(0.42, 0.11, 0.06), M.gunwood, -0.52, -0.05, 0, 0.12); // stock
  add(new THREE.BoxGeometry(0.06, 0.16, 0.05), M.gunwood, -0.2, -0.12, 0, -0.3);  // grip
  return g;
};


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
  private crates3 = new THREE.Group(); private crates9 = new THREE.Group(); private crates10 = new THREE.Group();
  private truck = new THREE.Group(); private gunPost = new THREE.Group();
  private marbles: THREE.Mesh[] = [];
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4(); private v = new THREE.Vector3(); private sph = new THREE.Sphere();

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

    // ---- ground ----
    sightInit();
    const b = new Batch(), M: Record<string, THREE.Material> = {};
    M.dry = lam("dryM", () => ({ map: rep(dryTex(), 1, 1) }));
    M.wheat = lam("wheatM", () => ({ map: rep(wheatTex(), 1, 1) }));
    M.dirt = lam("dirtM", () => ({ map: rep(dirtTex(), 1, 1) }));
    M.mud = lam("mudM", () => ({ color: "#8a6446" }));
    M.water = lam("waterM", () => ({ color: "#4f98ad" }));
    M.olive = lam("olive", () => ({ color: "#6b7542" }));
    M.oliveDk = lam("oliveDk", () => ({ color: "#4f5732" }));
    M.tyre = lam("tyre", () => ({ color: "#2a2a2e" }));
    M.glass = lam("glass", () => ({ color: "#2b3a44" }));
    M.chrome = lam("chrome", () => ({ color: "#b8b4a8" }));
    M.wood = lam("woodM", () => ({ map: beam() }));
    M.deck = lam("deckM", () => ({ map: rep(planksHD(), 1, 1) }));
    M.crate = lam("crateM", () => ({ map: crateTex() }));
    M.crateIn = lam("crateIn", () => ({ color: "#4a3620" }));
    M.bark = lam("bark", () => ({ color: "#e6ddcb" }));
    M.leaf = lam("leaf", () => ({ color: "#6f8a52" }));
    M.leafDk = lam("leafDk", () => ({ color: "#55703f" }));
    M.rock = lam("rockM", () => ({ color: "#b0643c" }));
    M.tuft = lam("tuftM", () => ({ color: "#dcb85e" }));
    M.tuftDk = lam("tuftDk", () => ({ color: "#c49a44" }));
    M.iron = twoTone(new THREE.MeshPhongMaterial({ color: "#8f969c", specular: "#9a9a9a", shininess: 40 }), 0.15);
    M.tank = twoTone(new THREE.MeshPhongMaterial({ color: "#a9b0b5", specular: "#bbbbbb", shininess: 30 }), 0.15);
    M.gunmetal = twoTone(new THREE.MeshPhongMaterial({ color: "#3d414a", specular: "#8a8a8a", shininess: 50 }), 0.15);
    M.rust = twoTone(new THREE.MeshPhongMaterial({ color: "#7a4a32", specular: "#5a4a40", shininess: 10 }), 0.15);
    M.pan = twoTone(new THREE.MeshPhongMaterial({ color: "#2c2f35", specular: "#777777", shininess: 40 }), 0.15);
    M.gunwood = lam("gunwood", () => ({ color: "#7a5232" }));
    M.sofa = lam("sofa", () => ({ color: "#a84a3c" }));
    M.sofaDk = lam("sofaDk", () => ({ color: "#843a30" }));
    for (const k of ["dry", "wheat", "dirt", "deck"]) { const m = M[k] as THREE.MeshLambertMaterial; if (m.map) { m.map.anisotropy = 16; m.map.needsUpdate = true; } }

    b.add(quadUp(-1000, 1000, -1000, 1000, 120, 120, 0), M.dry);
    // wheat paddocks (slightly raised so they win the depth test)
    for (const [x0, x1, z0, z1] of [[-60, 70, -12, 140], [-260, -140, 140, 260], [-330, -270, -270, -200], [-70, -10, -26, 20], [40, 130, 250, 330]] as const)
      b.add(quadUp(x0, x1, z0, z1, (x1 - x0) / 12, (z1 - z0) / 12, 0.015), M.wheat);
    // red-dirt track for the chase, and a dirt yard around the army camp
    b.add(quadUp(-100, 1400, TRACK_Z - 7, TRACK_Z + 7, 1500 / 14, 1, 0.02), M.dirt);
    b.add(quadUp(-6, 18, -14, 2, 2, 1.4, 0.025), M.dirt);
    // bumps on the track (the "bumpiest ground")
    for (let i = 0; i < 220; i++) {
      const x = 110 + i * 5.3 + 2 * hh(i, 1), z = TRACK_Z + (hh(i, 2) - 0.5) * 12;
      const s = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      b.add(s, M.dirt, T4(x, 0, z, 0, [1.2 + hh(i, 3), 0.18 + 0.2 * hh(i, 4), 1.2 + hh(i, 5)]));
    }
    // the waterhole: mud ring, water
    b.add(disc(DAM_R + 4, 0.02).translate(DAM[0], 0, DAM[2]), M.mud);
    b.add(disc(DAM_R, 0.04).translate(DAM[0], 0, DAM[2]), M.water);
    // windpump by the dam
    const WP = V(DAM[0] + 20, 0, DAM[2] - 6);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.add(beamBetween(V(WP.x + sx * 1.3, 0, WP.z + sz * 1.3), V(WP.x + sx * 0.25, 9, WP.z + sz * 0.25), 0.12), M.iron);
    for (const h of [2.5, 5, 7.5]) { const k = 1.3 - (1.05 * h) / 9; b.add(boxGeo(V(WP.x - k, h, WP.z - k), V(WP.x + k, h + 0.08, WP.z + k)), M.iron); }
    for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; b.add(beamBetween(V(WP.x - 0.4, 9.6, WP.z), V(WP.x - 0.4, 9.6 + Math.sin(a) * 1.8, WP.z + Math.cos(a) * 1.8), 0.08), M.iron); }
    b.add(boxGeo(V(WP.x - 0.3, 9.4, WP.z - 0.12), V(WP.x + 2.4, 9.8, WP.z + 0.12)), M.iron);
    b.add(cyl(2.2, 2.2, 2.6, 24), M.tank, T4(WP.x + 6, 1.3, WP.z + 3));
    // farmhouse + tank, and the porch house
    house(b, HOUSE[0], HOUSE[2], -0.4, 11, 8, 3.4, 1, 0);
    b.add(cyl(1.8, 1.8, 2.4, 24), M.tank, T4(HOUSE[0] + 9, 1.2, HOUSE[2] + 3));
    house(b, PORCH[0] + 0.5, PORCH[2] - 6.2, 0, 9, 7, 3.3, 2, 0);
    b.add(boxGeo(V(PORCH[0] - 4, 0, PORCH[2] - 2.7), V(PORCH[0] + 5, DECK_H, PORCH[2] + 2.2), 0), M.deck);
    for (const x of [-3.9, 4.9]) b.add(boxGeo(V(PORCH[0] + x - 0.08, DECK_H, PORCH[2] + 2.0), V(PORCH[0] + x + 0.08, 3.1, PORCH[2] + 2.16)), M.wood);
    b.add(boxGeo(V(PORCH[0] - 4.2, 3.1, PORCH[2] - 2.8), V(PORCH[0] + 5.2, 3.22, PORCH[2] + 2.4)), M.oliveDk);
    // sofa on the porch: base, back, arms, legs (marbles roll under it)
    const SX = PORCH[0] + 1.6, SZ = PORCH[2] - 1.35, SY = DECK_H + 0.2;
    b.add(boxGeo(V(SX - 1.0, SY, SZ - 0.45), V(SX + 1.0, SY + 0.3, SZ + 0.45)), M.sofa);
    b.add(boxGeo(V(SX - 1.0, SY + 0.3, SZ - 0.45), V(SX + 1.0, SY + 0.9, SZ - 0.2)), M.sofaDk);
    for (const s of [-1, 1]) b.add(boxGeo(V(SX + s * 1.0 - 0.13, SY, SZ - 0.45), V(SX + s * 1.0 + 0.13, SY + 0.55, SZ + 0.45)), M.sofaDk);
    for (const [lx, lz] of [[-0.9, -0.35], [0.9, -0.35], [-0.9, 0.35], [0.9, 0.35]]) b.add(boxGeo(V(SX + lx - 0.04, DECK_H, SZ + lz - 0.04), V(SX + lx + 0.04, SY, SZ + lz + 0.04)), M.wood);
    // fence behind the farmer
    for (let x = FARMER14[0] - 30; x <= FARMER14[0] + 30; x += 2.6) b.add(boxGeo(V(x - 0.07, 0, FARMER14[2] + 2.4), V(x + 0.07, 1.25, FARMER14[2] + 2.55)), M.wood);
    for (const h of [0.55, 0.95, 1.2]) b.add(boxGeo(V(FARMER14[0] - 30, h, FARMER14[2] + 2.46), V(FARMER14[0] + 30, h + 0.025, FARMER14[2] + 2.49)), M.iron);
    // the rock of the ending
    const rk = new THREE.IcosahedronGeometry(1, 1);
    b.add(rk, M.rock, T4(ROCK[0], 0, ROCK[2], 0.4, [3.2, ROCK_TOP, 2.8]));
    b.add(rk, M.rock, T4(ROCK[0] + 3.4, 0, ROCK[2] + 1.5, 1.1, [1.6, 1.1, 1.4]));
    // gum trees around every set (white trunks, clumpy grey-green crowns), never on a sight line
    const tree = (x: number, z: number, s: number, seed: number) => {
      if (blocks(x, z, 3 * s)) return;
      b.add(cyl(0.16 * s, 0.32 * s, 6 * s, 7), M.bark, T4(x, 3 * s, z));
      b.add(beamBetween(V(x, 4 * s, z), V(x + 1.6 * s, 6.4 * s, z + 0.4 * s), 0.18 * s), M.bark);
      const crown = new THREE.IcosahedronGeometry(1, 0);
      for (let k = 0; k < 4; k++) {
        const a = hh(seed, k) * 6.28, d = (0.8 + hh(seed, k + 9)) * s;
        b.add(crown, k % 2 ? M.leaf : M.leafDk, T4(x + Math.cos(a) * d, (6.2 + 1.6 * hh(seed, k + 3)) * s, z + Math.sin(a) * d, a, [1.9 * s, 1.3 * s, 1.9 * s]));
      }
    };
    const ring = (cx: number, cz: number, r0: number, r1: number, n: number, seed: number) => {
      for (let i = 0; i < n; i++) { const a = hh(i, seed) * 6.28, r = r0 + (r1 - r0) * hh(i, seed + 1); tree(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.9 + 0.5 * hh(i, seed + 2), i + seed); }
    };
    ring(10, 40, 70, 130, 26, 3); ring(DAM[0], DAM[2], 40, 70, 14, 5); ring(PORCH[0], PORCH[2], 14, 40, 10, 7); ring(MAJOR13[0], MAJOR13[2], 40, 90, 14, 9);
    ring(FARMER14[0], FARMER14[2], 30, 60, 10, 11); ring(ROCK[0], ROCK[2], 22, 60, 12, 13); ring(FLOCK[0], FLOCK[2], 60, 110, 14, 15);
    for (let i = 0; i < 40; i++) tree(-60 + i * 30 + 10 * hh(i, 17), TRACK_Z + 30 + 25 * hh(i, 18), 1, 200 + i);
    b.build(this.root);

    // ---- wheat tufts and grass clumps (no world ink: they read as texture) ----
    const tb = new Batch(), cone = new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    const tufts = (x0: number, x1: number, z0: number, z1: number, n: number, seed: number, h = 1) => {
      for (let i = 0; i < n; i++) {
        const x = x0 + (x1 - x0) * hh(i, seed), z = z0 + (z1 - z0) * hh(i, seed + 1);
        if ((Math.abs(x - GUN0[0]) < 6 && z - GUN0[2] < 12) || Math.hypot(x - ABANDONED[0], z - ABANDONED[2]) < 4.5) continue;
        const r = 0.22 + 0.2 * hh(i, seed + 4);
        tb.add(cone, hh(i, seed + 2) < 0.5 ? M.tuft : M.tuftDk, T4(x, 0, z, hh(i, seed + 5) * 6, [r * 1.3, h * r * (1.1 + 0.8 * hh(i, seed + 3)), r]));
      }
    };
    tufts(-30, 32, 4, 75, 1500, 31); tufts(-10, 40, 60, 140, 900, 33); tufts(ABANDONED[0] - 10, ABANDONED[0] + 10, ABANDONED[2] - 10, ABANDONED[2] + 8, 500, 35, 0.55);
    tufts(FARMER14[0] - 20, FARMER14[0] + 20, FARMER14[2] + 3, FARMER14[2] + 30, 900, 37); tufts(MAJOR13[0] - 25, MAJOR13[0] + 25, MAJOR13[2] + 3, MAJOR13[2] + 45, 900, 39);
    const tg = new THREE.Group(); tb.build(tg, false); tg.traverse((o) => o.layers.set(NOINK)); this.root.add(tg);

    // ---- crates: shot 3 stack, shot 9 mountain, shot 10 empties ----
    const crate = new THREE.BoxGeometry(0.7, 0.42, 0.45);
    const stack = (g: THREE.Group, c: V3, nx: number, nz: number, ny: number, pyramid: boolean) => {
      const sb = new Batch();
      for (let y = 0; y < ny; y++) {
        const ix = pyramid ? nx - y : nx, iz = pyramid ? nz - y : nz;
        for (let i = 0; i < ix; i++) for (let k = 0; k < iz; k++)
          sb.add(crate, M.crate, T4(c[0] + (i - (ix - 1) / 2) * 0.74, 0.21 + y * 0.43, c[2] + (k - (iz - 1) / 2) * 0.49, (hh(i + k * 7, y) - 0.5) * 0.06));
      }
      sb.build(g); this.root.add(g);
    };
    stack(this.crates3, CRATES3, 3, 2, 3, false);
    stack(this.crates9, CRATES9, 8, 5, 5, true);
    const eb = new Batch();
    for (let i = 0; i < 5; i++) {
      const x = CRATES9[0] - 2 + 1.1 * i + hh(i, 61), z = CRATES9[2] - 1 + 1.5 * hh(i, 62), r = hh(i, 63) * 2;
      eb.add(new THREE.BoxGeometry(0.7, 0.04, 0.45), M.crateIn, T4(x, 0.02, z, r));
      for (const [dx, dz, w, d] of [[0, -0.21, 0.7, 0.03], [0, 0.21, 0.7, 0.03], [-0.335, 0, 0.03, 0.45], [0.335, 0, 0.03, 0.45]] as const)
        eb.add(new THREE.BoxGeometry(w, 0.42, d), M.crate, new THREE.Matrix4().multiplyMatrices(T4(x, 0.21, z, r), T4(dx, 0, dz)));
    }
    eb.build(this.crates10); this.root.add(this.crates10);

    // ---- the truck (local +x forward), with a Lewis gun on a post on the tray ----
    const tk = new Batch();
    tk.add(boxGeo(V(-2.5, 0.55, -0.9), V(2.5, 0.78, 0.9)), M.tyre);
    tk.add(boxGeo(V(0.2, 0.78, -0.88), V(1.55, 2.15, 0.88)), M.olive);          // cab
    tk.add(boxGeo(V(0.1, 2.15, -0.98), V(1.7, 2.25, 0.98)), M.oliveDk);          // cab roof
    tk.add(boxGeo(V(1.55, 1.38, -0.72), V(1.57, 1.98, 0.72)), M.glass);         // windscreen
    for (const s of [-1, 1]) tk.add(boxGeo(V(0.45, 1.4, s * 0.88 - 0.01), V(1.35, 1.95, s * 0.88 + 0.01)), M.glass);
    tk.add(boxGeo(V(1.55, 0.78, -0.62), V(2.7, 1.48, 0.62)), M.olive);           // bonnet
    tk.add(boxGeo(V(2.7, 0.82, -0.58), V(2.78, 1.46, 0.58)), M.chrome);          // radiator
    for (const s of [-1, 1]) {
      tk.add(boxGeo(V(1.45, 0.95, s * 0.95 - 0.18), V(2.65, 1.05, s * 0.95 + 0.18)), M.oliveDk); // front mudguards
      tk.add(cyl(0.13, 0.13, 0.12, 12).rotateZ(Math.PI / 2), M.chrome, T4(2.82, 1.25, s * 0.42)); // lamps
    }
    tk.add(boxGeo(V(-2.6, 0.78, -1.02), V(0.15, 1.05, 1.02)), M.wood);           // tray floor (top at 1.05)
    for (const s of [-1, 1]) tk.add(boxGeo(V(-2.6, 1.05, s * 1.02 - 0.05), V(0.15, 1.35, s * 1.02 + 0.05)), M.wood);
    tk.add(boxGeo(V(-2.65, 1.05, -1.02), V(-2.55, 1.35, 1.02)), M.wood);
    tk.add(cyl(0.05, 0.05, 0.62), M.gunmetal, T4(-1.65, 1.36, -0.6));             // gun post
    tk.build(this.truck);
    for (const [x, z] of [[1.95, 0.95], [1.95, -0.95], [-1.6, 0.95], [-1.6, -0.95]]) {
      const w = new THREE.Mesh(cyl(0.44, 0.44, 0.26, 18).rotateX(Math.PI / 2), M.tyre); w.position.set(x, 0.44, z); w.castShadow = true; this.truck.add(w);
      const hub = new THREE.Mesh(cyl(0.16, 0.16, 0.28, 10).rotateX(Math.PI / 2), M.chrome); hub.position.set(x, 0.44, z); this.truck.add(hub);
    }
    const tg2 = lewisGun(M); tg2.position.set(-1.65, 1.72, -0.6); this.truck.add(tg2);
    this.truck.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    this.root.add(this.truck);

    // ---- ground gun on a tripod (moves between shots), gun on the crates, abandoned gun ----
    const gun = lewisGun(M); gun.position.y = 0.95; this.gunPost.add(gun);
    for (const a of [0.5, 2.6, 4.7]) this.gunPost.add(new THREE.Mesh(beamBetween(V(0, 0.95, 0), V(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55), 0.035), M.gunmetal));
    this.gunPost.traverse((o) => { o.castShadow = true; });
    this.root.add(this.gunPost);
    const g3 = lewisGun(M); g3.position.set(CRATES3[0] - 0.1, 3 * 0.43 + 0.12, CRATES3[2]); g3.rotation.y = -0.5; this.crates3.add(g3);
    const ab = lewisGun({ ...M, gunmetal: M.rust, pan: M.rust }); ab.position.set(ABANDONED[0], 0.12, ABANDONED[2]); ab.rotation.set(1.35, 0.6, 0.05); this.root.add(ab);

    // ---- marbles (shot 12) ----
    const cols = ["#e8453c", "#3c7be8", "#f2c230", "#3cb371", "#9b59d0", "#ff8c3a", "#ffffff", "#2ec4c4"];
    for (let i = 0; i < 26; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.036, 14, 10), twoTone(new THREE.MeshPhongMaterial({ color: cols[i % cols.length], specular: "#ffffff", shininess: 80 }), 0.2));
      m.castShadow = true; m.visible = false; this.marbles.push(m); this.root.add(m);
    }

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
      mat.map = this.cloudMaps[s.light][i % 4];
    }
    const FOG_SHOT: Record<number, [number, number]> = { 2: [140, 900], 5: [90, 700], 11: [140, 900], 15: [60, 600] };
    if (FOG_SHOT[id]) { this.fog.near = FOG_SHOT[id][0]; this.fog.far = FOG_SHOT[id][1]; }
    // ---- set pieces per shot ----
    this.crates3.visible = id === 3;
    this.crates9.visible = id === 9;
    this.crates10.visible = id === 10;
    const gp: Record<number, [V3, number]> = { 1: [GUN0, -Math.PI / 2], 4: [GUN0, -Math.PI / 2], 5: [GUN5, Math.PI * 0.75] };
    this.gunPost.visible = !!gp[id];
    if (gp[id]) { this.gunPost.position.set(...gp[id][0]); this.gunPost.rotation.y = gp[id][1]; }
    const truckOn = id === 3 || (id >= 6 && id <= 8);
    this.truck.visible = truckOn;
    if (id === 3) { this.truck.position.set(...TRUCK3); this.truck.rotation.set(0, 0, 0); }
    else if (truckOn) {
      this.truck.position.set(truckX(id, t), truckBounce(id, t), TRACK_Z);
      this.truck.rotation.set(0.04 * Math.sin(t * 7.3) * (id === 6 ? 0 : 1), 0, truckPitch(id, t));
    }
    // marbles: burst out of the bag, roll and slow down; the ones heading for the sofa end up under it
    for (let i = 0; i < this.marbles.length; i++) {
      const m = this.marbles[i], tau = t - T_SPILL;
      m.visible = id === 12 && tau > 0 && !(i === 0 && t > 1462 / FPS);
      if (!m.visible) continue;
      const a = -0.9 + (hh(i, 71) - 0.5) * 2.6, v = 0.7 + 1.0 * hh(i, 72), T = Math.min(tau, v / 0.5), d = v * T - 0.25 * T * T;
      const fall = Math.max(0, 0.42 - 3.2 * tau * tau) + (tau < 0.6 ? 0.05 * Math.abs(Math.sin(tau * 14)) * (1 - tau / 0.6) : 0);
      let x = PORCH[0] - 0.35 + Math.cos(a) * d, z = PORCH[2] + 0.5 + Math.sin(a) * d;
      x = Math.max(PORCH[0] - 3.9, Math.min(PORCH[0] + 4.9, x)); z = Math.max(PORCH[2] - 1.7, Math.min(PORCH[2] + 2.1, z));
      m.position.set(x, DECK_H + 0.036 + fall, z);
    }
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
