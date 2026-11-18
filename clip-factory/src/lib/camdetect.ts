import path from "node:path";
import { run } from "./media";
import type { CamInfo } from "./layout";

/**
 * Find the streamer's face / webcam in [start, start+length] of a video with scripts/detect_cam.py (OpenCV Haar cascades,
 * ~10 frames, ~2-3s). Never throws: a missing Python/OpenCV or a bad file gives found=false with `error` set, and the clip
 * is then cut in the blurred layout. CAM_DETECT=off skips it.
 */
export async function detectCam(file: string, start: number, length: number): Promise<CamInfo> {
  const base: CamInfo = { v: 1, winStart: start, winLength: length, found: false, faceBox: null, hitRate: 0, faceAreaFrac: 0, region: null, camBox: null, snapped: 0, frame: [0, 0], track: [] };
  if ((process.env.CAM_DETECT || "").toLowerCase() === "off") return { ...base, error: "CAM_DETECT=off" };
  try {
    const script = path.resolve(process.cwd(), "scripts/detect_cam.py");
    const py = process.env.PYTHON || "python3";
    const { stdout } = await run(py, [script, path.resolve(file), String(start), String(length)], { timeoutMs: 60_000 });
    const j = JSON.parse(stdout.trim().split("\n").pop()!);
    return {
      ...base, found: Boolean(j.found), faceBox: j.faceBox ?? null, hitRate: Number(j.hitRate) || 0, faceAreaFrac: Number(j.faceAreaFrac) || 0,
      region: j.region ?? null, camBox: j.camBox ?? null, snapped: Number(j.snapped) || 0, frame: j.frame ?? [0, 0], track: Array.isArray(j.track) ? j.track : [], ms: j.ms,
    };
  } catch (e) {
    console.warn("[camdetect] face check failed, using the blurred layout:", (e as Error).message);
    return { ...base, error: (e as Error).message.slice(0, 300) };
  }
}
