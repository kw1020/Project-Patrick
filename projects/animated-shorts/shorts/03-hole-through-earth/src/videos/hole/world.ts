// "What if you jumped into a hole through the Earth?": the template's sky + light rig (plus space and core looks and
// a star dome), then our sets: a backyard with the hole, an Arctic drill rig, a cutaway Earth in space (glowing
// layers on the cut faces, the tunnel along its axis), the exit hole in the open ocean, a bowl with a marble, and the
// inside of the core.
import * as THREE from "three";
import { Batch, boxGeo, V, lam, house, Kit } from "./build";
import { ctex, rep, cloudHD } from "./paint";
import { Pen } from "./toon";
import { LIGHTS, LOOK, LightPreset } from "./lights";
import { TONE, CHAR, twoTone, untone } from "./shade";
import { NOINK } from "./ink";
import { Pool, Actor, Fx, stage, SU } from "./cast";
import { quadUp, disc, T4, cyl, beamBetween, discTex, haloTex } from "./kit";
import { FPS, SHOTS, camAt, V3, hh, smooth, clamp01, ShotDef, YARD, RIG, EARTH, ER, OCEAN, BOWL, CORE, marbleA } from "./story";

export const loadKit = () => Promise.resolve({} as Kit);
const SUN_SHOT: Record<number, { az?: number; el?: number }> = {};

const globeTex = () => ctex("globe", 2048, 1024, (g, r) => {
  g.fillStyle = "#2f7fc4"; g.fillRect(0, 0, 2048, 1024);
  for (let i = 0; i < 26; i++) {
    const cx = r() * 2048, cy = 200 + r() * 620, n = 6 + Math.floor(r() * 8);
    for (let k = 0; k < n; k++) { g.fillStyle = r() < 0.3 ? "#c9a66b" : "#5aa04a"; g.beginPath(); g.ellipse(cx + (r() - 0.5) * 180, cy + (r() - 0.5) * 120, 30 + r() * 90, 20 + r() * 60, r() * 3, 0, 6.3); g.fill(); }
  }
  g.fillStyle = "#f4f8ff"; g.fillRect(0, 0, 2048, 70); g.fillRect(0, 954, 2048, 70);
  for (let i = 0; i < 40; i++) { g.fillStyle = "rgba(255,255,255,0.55)"; g.beginPath(); g.ellipse(r() * 2048, r() * 1024, 60 + r() * 120, 12 + r() * 20, 0, 0, 6.3); g.fill(); }
});
const layersTex = () => ctex("layers", 1024, 1024, (g) => {
  const c = 512, R = 512;
  const ring = (f: number, col: string) => { g.fillStyle = col; g.beginPath(); g.arc(c, c, R * f, 0, 6.3); g.fill(); };
  ring(1.0, "#7a4e30"); ring(0.955, "#e07a3a"); ring(0.8, "#d8602a"); ring(0.55, "#f5a623"); ring(0.19, "#fff1a0");
  g.strokeStyle = "rgba(60,30,10,0.6)"; g.lineWidth = 6; for (const f of [0.955, 0.55, 0.19]) { g.beginPath(); g.arc(c, c, R * f, 0, 6.3); g.stroke(); }
});
const lavaTex = () => ctex("lava", 1024, 512, (g, r) => {
  g.fillStyle = "#ff8a2a"; g.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 500; i++) { g.fillStyle = r() < 0.5 ? "rgba(255,220,120,0.5)" : "rgba(200,60,20,0.5)"; g.beginPath(); g.ellipse(r() * 1024, r() * 512, 10 + 50 * r(), 6 + 20 * r(), r() * 3, 0, 6.3); g.fill(); }
});
const starTex = () => ctex("stars", 4096, 2048, (g, r) => {
  g.fillStyle = "#000000"; g.fillRect(0, 0, 4096, 2048);
  for (let i = 0; i < 9000; i++) { const s = r() < 0.03 ? 3 : r() < 0.2 ? 2 : 1; g.fillStyle = `rgba(255,${235 + 20 * r()},${215 + 40 * r()},${0.5 + 0.5 * r()})`; g.fillRect(r() * 4096, r() * 2048, s, s); }
});


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
  private earth = new THREE.Group(); private marble!: THREE.Mesh; private stars!: THREE.Mesh;
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
    M.lawn = lam("lawnH", () => ({ color: "#7fae55" }));
    M.dirt = lam("dirtH", () => ({ color: "#8a5a3a" }));
    M.dark = lam("darkH", () => ({ color: "#1a1418" }));
    M.wood = lam("woodH", () => ({ color: "#9a6a3a" }));
    M.iron = twoTone(new THREE.MeshPhongMaterial({ color: "#c0453a", specular: "#888888", shininess: 30 }), 0.15);
    M.steel = twoTone(new THREE.MeshPhongMaterial({ color: "#9aa0a8", specular: "#bbbbbb", shininess: 40 }), 0.15);
    M.snow = lam("snowH", () => ({ color: "#eef3fa" }));
    M.hut = lam("hutH", () => ({ color: "#5a7fa8" }));
    M.ocean = lam("oceanH", () => ({ color: "#2f8fb5" }));
    M.stone = lam("stoneH", () => ({ color: "#a39a8c" }));
    M.bowl = lam("bowlH", () => ({ color: "#f2efe6", side: THREE.DoubleSide }));
    M.table = lam("tableH", () => ({ color: "#b07a4a" }));
    M.red = lam("redH", () => ({ color: "#e8453c" }));
    // ---- backyard: lawn with an opening, the pit, a dirt pile, a shovel, the house ----
    const HR = 0.8;
    for (const [x0, x1, z0, z1] of [[-1000, YARD[0] - HR, -1000, 1000], [YARD[0] + HR, 1000, -1000, 1000], [YARD[0] - HR, YARD[0] + HR, -1000, YARD[2] - HR], [YARD[0] - HR, YARD[0] + HR, YARD[2] + HR, 1000]] as const)
      b.add(quadUp(x0, x1, z0, z1, (x1 - x0) / 4, (z1 - z0) / 4, 0), M.lawn);
    const pit = cyl(HR, HR, 6, 24, ); pit.translate(0, -3, 0);
    b.add(pit, lam("pitH", () => ({ color: "#2a1d18", side: THREE.BackSide })), T4(YARD[0], 0, YARD[2]));
    b.add(disc(HR + 0.25, 0.01).translate(YARD[0], 0, YARD[2]), M.dirt);
    b.add(new THREE.SphereGeometry(1, 14, 8, 0, 6.3, 0, Math.PI / 2), M.dirt, T4(YARD[0] + 2.0, 0, YARD[2] + 0.8, 0, [1.3, 0.8, 1.1]));
    b.add(cyl(0.025, 0.025, 1.3, 8), M.wood, new THREE.Matrix4().compose(V(YARD[0] + 1.5, 0.85, YARD[2] + 0.4), new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), 0.35), V(1, 1, 1)));
    b.add(boxGeo(V(-0.12, -0.18, -0.02), V(0.12, 0.12, 0.02)), M.steel, T4(YARD[0] + 1.73, 0.18, YARD[2] + 0.4));
    house(b, YARD[0] + 0.5, YARD[2] + 7, Math.PI, 9, 7, 3.3, 2, 0);
    for (let x = -12; x <= 12; x += 1.6) b.add(boxGeo(V(YARD[0] + x - 0.05, 0, YARD[2] - 12), V(YARD[0] + x + 0.05, 1.1, YARD[2] - 11.9)), M.wood);
    // ---- the Arctic drill rig ----
    b.add(quadUp(RIG[0] - 300, RIG[0] + 300, RIG[2] - 300, RIG[2] + 300, 1, 1, 0.02), M.snow);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.add(beamBetween(V(RIG[0] + sx * 3, 0, RIG[2] + sz * 3), V(RIG[0] + sx * 0.6, 24, RIG[2] + sz * 0.6), 0.2), M.iron);
    for (let h = 3; h < 24; h += 3) { const k = 3 - (2.4 * h) / 24; for (const [ax, az, bx, bz] of [[-k, -k, k, -k], [k, -k, k, k], [k, k, -k, k], [-k, k, -k, -k]]) b.add(beamBetween(V(RIG[0] + ax, h, RIG[2] + az), V(RIG[0] + bx, h, RIG[2] + bz), 0.1), M.iron); }
    b.add(boxGeo(V(RIG[0] - 1.2, 24, RIG[2] - 1.2), V(RIG[0] + 1.2, 25.2, RIG[2] + 1.2)), M.iron);
    b.add(cyl(0.12, 0.12, 22, 10), M.steel, T4(RIG[0], 12, RIG[2]));
    b.add(boxGeo(V(RIG[0] + 5, 0, RIG[2] - 3), V(RIG[0] + 13, 3.5, RIG[2] + 3)), M.hut);
    for (let k = 0; k < 12; k++) b.add(cyl(0.12, 0.12, 6, 10).rotateZ(Math.PI / 2), M.steel, T4(RIG[0] - 6, 0.15 + 0.24 * (k % 4), RIG[2] - 3 + 0.25 * Math.floor(k / 4) * 2));
    // ---- the bowl and the table ----
    b.add(boxGeo(V(BOWL[0] - 1.2, 0, BOWL[2] - 0.8), V(BOWL[0] + 1.2, 0.02, BOWL[2] + 0.8)), M.table);
    const bowl = new THREE.LatheGeometry(Array.from({ length: 16 }, (_, i) => { const a = (i / 15) * Math.PI * 0.45; return new THREE.Vector2(0.6 * Math.sin(a) + 0.001, 0.6 - 0.6 * Math.cos(a)); }), 40);
    b.add(bowl, M.bowl, T4(BOWL[0], 0.02, BOWL[2]));
    // ---- the exit: a stone rim in the middle of the sea ----
    b.add(quadUp(OCEAN[0] - 1500, OCEAN[0] + 1500, OCEAN[2] - 1500, OCEAN[2] + 1500, 1, 1, 0.05), M.ocean);
    b.add(new THREE.TorusGeometry(1.0, 0.18, 10, 32).rotateX(Math.PI / 2), M.stone, T4(OCEAN[0], 0.12, OCEAN[2]));
    b.add(disc(1.0, 0.07).translate(OCEAN[0], 0, OCEAN[2]), M.dark);
    b.build(this.root);

    // ---- the cutaway Earth (a quarter wedge opened toward -z), tunnel and the tiny red borehole ----
    const E = this.earth;
    const gm = lam("globeM", () => ({ map: globeTex() }));
    const globe = new THREE.Mesh(new THREE.SphereGeometry(ER, 96, 64, (7 * Math.PI) / 4, (3 * Math.PI) / 2), gm); E.add(globe);
    const lm = new THREE.MeshBasicMaterial({ map: layersTex(), side: THREE.DoubleSide, color: new THREE.Color(1.15, 1.1, 1.05) });
    for (const th of [(3 * Math.PI) / 4, Math.PI / 4]) { const face = new THREE.Mesh(new THREE.CircleGeometry(ER, 96, -Math.PI / 2, Math.PI), lm); face.rotation.y = th; E.add(face); }
    const tun = new THREE.Mesh(cyl(0.7, 0.7, 2 * ER + 0.4, 12), new THREE.MeshBasicMaterial({ color: "#140c10" })); tun.position.z = -0.3; E.add(tun);
    const tick = new THREE.Mesh(cyl(0.3, 0.3, 1.2, 10), M.red); tick.position.set(0, ER - 0.4, -0.9); E.add(tick);
    E.position.set(...EARTH); this.root.add(E);
    // ---- inside the core ----
    const core = new THREE.Mesh(new THREE.SphereGeometry(30, 48, 24), new THREE.MeshBasicMaterial({ map: lavaTex(), side: THREE.BackSide, color: new THREE.Color(1.25, 1.05, 0.9), fog: false }));
    core.position.set(...CORE); core.layers.set(NOINK); this.root.add(core);
    // ---- the marble ----
    this.marble = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), twoTone(new THREE.MeshPhongMaterial({ color: "#3c7be8", specular: "#ffffff", shininess: 80 }), 0.2));
    this.marble.castShadow = true; this.root.add(this.marble);
    // ---- star dome for the space shots ----
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
    const space = s.light === "space";
    this.stars.visible = space; this.stars.position.copy(cam.position);
    for (const c of this.clouds) c.visible = !space && s.light !== "core";
    this.earth.rotation.y = 0;
    const a = marbleA(t);
    this.marble.position.set(BOWL[0] + 0.55 * Math.sin(a), 0.02 + 0.6 - 0.55 * Math.cos(a) + 0.05, BOWL[2]);
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
