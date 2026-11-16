# usage: assemble_world.py <bridge world.ts> <parts.txt> <out world.ts> "<extra class fields>"
import sys, re
tw = open(sys.argv[1]).read(); parts = open(sys.argv[2]).read(); extra = sys.argv[4] if len(sys.argv) > 4 else ""
P = {m.group(1): m.group(2) for m in re.finditer(r'// ==== PART: (\w+) ====\n(.*?)(?=// ==== PART: |\Z)', parts, re.S)}
def between(s, a, b): i = s.index(a); return s[i:s.index(b, i)]
sky = between(tw, "    // ---- sky + light ----", "    // ---- ground, river, quays (static batch) ----")
meth = between(tw, "  /** camera-relative sun, frozen per shot", "  update(id: number, f: number")
meth = meth.replace("  private actor(i: number) { while (this.actors.length <= i) this.actors.push(new Actor(this.root)); return this.actors[i]; }",
  "  private actor(i: number) { while (this.actors.length <= i) this.actors.push(new Actor(this.root)); return this.actors[i]; }\n  private emuA(i: number) { while (this.emus.length <= i) this.emus.push(new Actor(this.root, EMU_GEO)); return this.emus[i]; }")
upd = between(tw, "  update(id: number, f: number, cam", "    // ---- river colours")
upd = upd.replace("const t = f / FPS, s = SHOTS[id - 1], tau = s.tau(t), b = bridgeState(id, t), L = LIGHTS[s.light];", "const t = f / FPS, s = SHOTS[id - 1], L = LIGHTS[s.light];")
upd = upd.replace("this.cloudMaps[s.light][i % 4]", 'this.cloudMaps[s.light === "golden" ? "golden" : "day"][i % 4]')
cast = open(sys.argv[0].replace("assemble_world.py", "castloop.ts.txt")).read()
head = '''
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
''' + extra + '''
  constructor(_kit: Kit) {
    const R = this.root;
'''
open(sys.argv[3], "w").write(P["imports"] + P["helpers"] + head + sky + P["build"] + "  }\n\n" + meth + upd + P["pose"] + cast)
print("ok")
