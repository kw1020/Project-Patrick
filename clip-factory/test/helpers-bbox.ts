import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * v1.9.8: render an ASS file on a black 1080x1920 frame at `t` seconds and return the bounding box of everything drawn
 * (pixels brighter than 40 in a raw gray frame), or null when nothing was drawn. Used to prove burned-in text stays inside
 * the apps' safe zone.
 */
export function assBBox(assText: string, dir: string, name: string, t = 0.3): { x1: number; y1: number; x2: number; y2: number } | null {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.ass`);
  fs.writeFileSync(f, assText);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=1080x1920:d=" + (t + 0.2), "-vf",
    `ass=${path.basename(f)}`, "-ss", String(t), "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"], { cwd: dir, maxBuffer: 1 << 23 });
  const px = r.stdout as Buffer;
  if (!px || px.length < 1080 * 1920) throw new Error("ffmpeg gave no frame: " + String(r.stderr).slice(-400));
  let x1 = 1080, y1 = 1920, x2 = -1, y2 = -1;
  for (let y = 0; y < 1920; y++) {
    const row = y * 1080;
    for (let x = 0; x < 1080; x++) {
      if (px[row + x] > 40) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
    }
  }
  return x2 < 0 ? null : { x1, y1, x2, y2 };
}
