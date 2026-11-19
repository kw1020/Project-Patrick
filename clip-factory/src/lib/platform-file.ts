// v1.9.8: the facts the Platform check needs about a finished clip (ffprobe + what the render put in). Node only; the pure
// rules are in src/lib/platform-rules.ts.
import fs from "node:fs";
import { run } from "./media";
import type { OverlayPlace } from "./layout";
import { CAP_HALF, CREDIT_H, HOOK_H } from "./layout";
import { SAFE_Y_BOTTOM, SAFE_Y_TOP, type FileFacts, type RenderFacts } from "./platform-rules";

/** Is the MP4's index (moov) before the media (mdat)? null when the file can't be read as MP4 boxes. */
export function moovFirst(file: string): boolean | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, head = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len < 8) return null;
      pos += len;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** ffprobe the finished clip. */
export async function probeFinal(file: string): Promise<FileFacts> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration,size,bit_rate", "-of", "json", file], { timeoutMs: 30_000 });
  const j = JSON.parse(stdout) as { streams?: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string }[]; format?: { duration?: string; size?: string; bit_rate?: string } };
  const v = j.streams?.find((s) => s.codec_type === "video"), a = j.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const seconds = Number(j.format?.duration ?? 0), bytes = Number(j.format?.size ?? 0);
  const kbps = Number(j.format?.bit_rate ?? 0) / 1000 || (seconds > 0 ? (bytes * 8) / seconds / 1000 : 0);
  return {
    width: v?.width ?? 0, height: v?.height ?? 0, vcodec: v?.codec_name ?? "none", acodec: a?.codec_name ?? null,
    fps: den ? Math.round((num / den) * 100) / 100 : 0, seconds: Math.round(seconds * 100) / 100, bytes, kbps: Math.round(kbps), faststart: moovFirst(file),
  };
}

/** Text boxes of a placement that leave the safe box (top/bottom; widths are fitted at render time). */
export function unsafeText(p: OverlayPlace): string[] {
  const out: string[] = [];
  const credit = p.creditAlign === 8 ? [p.creditY, p.creditY + CREDIT_H] : [p.creditY - CREDIT_H, p.creditY];
  const hook = p.hookAlign === 8 ? [p.hookY, p.hookY + HOOK_H] : [p.hookY - HOOK_H, p.hookY];
  const caps = [p.capY - CAP_HALF, p.capY + CAP_HALF];
  for (const [name, [a, b]] of [["creator credit", credit], ["hook", hook], ["captions", caps]] as const) {
    if (a < SAFE_Y_TOP - 1 || b > SAFE_Y_BOTTOM + 1) out.push(name);
  }
  return out;
}

export function renderFacts(o: { captions: boolean; hook: boolean; watermark: string | null; styled: boolean; layout: string | null; place: OverlayPlace; sourceUrl: string | null }): RenderFacts {
  let sourceHost: string | null = null;
  try { sourceHost = o.sourceUrl ? new URL(o.sourceUrl).hostname.toLowerCase() : null; } catch { /* not a URL */ }
  return { captions: o.captions, hook: o.hook, credit: true, watermark: o.watermark, styled: o.styled, layout: o.layout, unsafeText: unsafeText(o.place), sourceHost };
}
