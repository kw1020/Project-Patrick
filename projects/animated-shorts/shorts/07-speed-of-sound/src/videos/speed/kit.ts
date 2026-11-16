import * as THREE from "three";
import { V } from "./build";
import { ctex } from "./paint";
import { V3 } from "./story";
export const discTex = () => ctex("sunDisc", 128, 128, (g) => {
  const gr = g.createRadialGradient(64, 64, 58, 64, 64, 64); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
});
export const haloTex = () => ctex("sunHalo", 256, 256, (g) => {
  const im = g.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const u = Math.hypot(x - 127.5, y - 127.5) / 128;
    const a = (0.55 * Math.exp(-((u / 0.25) ** 2)) + 0.35 * Math.exp(-((u / 0.6) ** 2))) * (1 - Math.min(1, Math.max(0, (u - 0.8) / 0.2)));
    const i = (y * 256 + x) * 4; im.data[i] = im.data[i + 1] = im.data[i + 2] = 255; im.data[i + 3] = Math.round(255 * Math.min(1, a));
  }
  g.putImageData(im, 0, 0);
});
/** horizontal quad at height y covering x0..x1, z0..z1 with uv repeats (u, v) */
export const quadUp = (x0: number, x1: number, z0: number, z1: number, u: number, v: number, y = 0) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, u, 0, u, v, 0, 0, u, v, 0, v], 2));
  return g;
};
export const disc = (r: number, y: number, seg = 48) => { const g = new THREE.CircleGeometry(r, seg); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return g; };
export const T4 = (x: number, y: number, z: number, ry = 0, s: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), ry), V(...s));
export const cyl = (r0: number, r1: number, h: number, n = 10) => new THREE.CylinderGeometry(r0, r1, h, n);
export const beamBetween = (a: THREE.Vector3, b: THREE.Vector3, th: number) => {
  const g = new THREE.BoxGeometry(th, a.distanceTo(b), th);
  const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()), V(1, 1, 1));
  return g.applyMatrix4(m);
};

