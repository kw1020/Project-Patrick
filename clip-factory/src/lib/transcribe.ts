import fs from "node:fs";
import path from "node:path";
import { run, type Word } from "./media";

export type Transcript = { text: string; words: Word[]; engine: string };

/** Transcribe a WAV. WHISPER_ENGINE=local (faster-whisper) | openai | off. Never throws: no captions beats no clip. */
export async function transcribe(wav: string): Promise<Transcript | null> {
  const engine = (process.env.WHISPER_ENGINE || "local").toLowerCase();
  try {
    if (engine === "off") return null;
    if (engine === "openai") return await openai(wav);
    return await local(wav);
  } catch (e) {
    console.warn(`[transcribe] ${engine} failed, continuing without captions:`, (e as Error).message);
    return null;
  }
}

async function local(wav: string): Promise<Transcript> {
  const script = path.resolve(process.cwd(), "scripts/transcribe.py");
  const py = process.env.PYTHON || "python3";
  const { stdout } = await run(py, [script, wav, process.env.WHISPER_MODEL || "base.en"], { timeoutMs: 10 * 60_000 });
  const j = JSON.parse(stdout.trim().split("\n").pop()!);
  return { text: j.text, words: j.words, engine: "faster-whisper" };
}

async function openai(wav: string): Promise<Transcript> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("WHISPER_ENGINE=openai but OPENAI_API_KEY is empty");
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!res.ok) throw new Error(`OpenAI Whisper ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { text: string; words?: Word[] };
  return { text: j.text, words: j.words ?? [], engine: "openai-whisper" };
}
