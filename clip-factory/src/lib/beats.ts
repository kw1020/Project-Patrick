// v2.0.0 Edits: the music folder (timing tracks) and the beat finder (scripts/beats.py) + a click track for previews.
// A timing track is ONLY used to find beats (and mixed into the "preview with the beat" file). It never goes into the edit.
import fs from "node:fs";
import path from "node:path";
import { run } from "./media";
import { MUSIC_EXT } from "./edit-vibes";
import type { TrackBeats } from "./edit-plan";

/** Where Krew drops songs: /music in Docker (read-only mount of clip-factory/music), ./music otherwise. */
export function musicDir() {
  return path.resolve(process.env.MUSIC_DIR || "./music");
}

/** Song files in the music folder (name + size), newest first. Never throws. */
export function listMusic(): { name: string; mb: number }[] {
  try {
    return fs.readdirSync(musicDir(), { withFileTypes: true })
      .filter((d) => d.isFile() && MUSIC_EXT.test(d.name))
      .map((d) => ({ name: d.name, st: fs.statSync(path.join(musicDir(), d.name)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .map((x) => ({ name: x.name, mb: Math.round((x.st.size / 1024 ** 2) * 10) / 10 }));
  } catch { return []; }
}

/** A file name from the form -> its full path in the music folder, or null (no paths, only real song files there). */
export function musicPath(name: string | null | undefined): string | null {
  if (!name || name !== path.basename(name) || !MUSIC_EXT.test(name)) return null;
  const p = path.join(musicDir(), name);
  return fs.existsSync(p) ? p : null;
}

export const BEAT_SR = 22050;

/** Decode the song to 22 kHz mono PCM with ffmpeg and run scripts/beats.py on it (numpy only). */
export async function findTrackBeats(file: string, workDir: string): Promise<TrackBeats & { ms?: number; confidence?: number }> {
  fs.mkdirSync(workDir, { recursive: true });
  const pcm = path.join(workDir, "song.pcm");
  try {
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-t", "600", "-vn", "-ac", "1", "-ar", String(BEAT_SR), "-f", "s16le", pcm], { timeoutMs: 120_000 });
    const py = process.env.PYTHON || "python3";
    const { stdout } = await run(py, [path.resolve(process.cwd(), "scripts/beats.py"), pcm, String(BEAT_SR)], { timeoutMs: 180_000 });
    const j = JSON.parse(stdout.trim().split("\n").pop()!);
    if (j.error) throw new Error(j.error);
    if (!Array.isArray(j.beats) || j.beats.length < 8) throw new Error("couldn't find a steady beat in that song");
    return { tempo: Number(j.tempo), beats: j.beats, downbeats: j.downbeats ?? [], drops: j.drops ?? [], duration: Number(j.duration), ms: j.ms, confidence: j.confidence };
  } finally {
    fs.rmSync(pcm, { force: true });
  }
}

/**
 * A click track as a 48 kHz stereo 16-bit WAV: a short 1 kHz blip on every beat, 1.6 kHz + louder on downbeats (every 4th).
 * Used in the "preview with the beat" when no song was picked, so the sync can be checked by ear.
 */
export function metronomeWav(beats: number[], duration: number, out: string) {
  const sr = 48000, n = Math.ceil(duration * sr);
  const data = new Int16Array(n * 2);
  beats.slice(0, -1).forEach((t, k) => {
    const f = k % 4 === 0 ? 1600 : 1000, amp = k % 4 === 0 ? 0.55 : 0.35;
    const i0 = Math.round(t * sr), len = Math.round(0.04 * sr);
    for (let i = 0; i < len && i0 + i < n; i++) {
      const v = Math.round(32767 * amp * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / sr / 0.01));
      data[(i0 + i) * 2] = data[(i0 + i) * 2 + 1] = v;
    }
  });
  const buf = Buffer.alloc(44 + data.byteLength);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + data.byteLength, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(data.byteLength, 40);
  Buffer.from(data.buffer).copy(buf, 44);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
}

/** "0:12.4" — where to start the sound in TikTok so it lines up with the edit. */
export function songTime(t: number) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
