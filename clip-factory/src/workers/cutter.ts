import fs from "node:fs";
import { prisma, getSettings } from "../lib/db";
import { buildAss, extractAudio, hasAudio, parseFacecam, pickWindow, probeDuration, renderVertical } from "../lib/media";
import { resolveStored, storagePath } from "../lib/paths";
import { transcribe } from "../lib/transcribe";

/** Cutter: trim to 15–45s, make it 9:16, burn captions + streamer credit. */
export async function runCut(clipId: string) {
  const clip = await prisma.clip.findUnique({ where: { id: clipId }, include: { moment: { include: { streamer: true } } } });
  if (!clip) return "clip deleted";
  if (!clip.rawPath) throw new Error("No raw video to cut (grab step didn't finish)");
  const settings = await getSettings();
  const streamer = clip.moment.streamer;
  const raw = resolveStored(clip.rawPath);

  const duration = await probeDuration(raw);
  const win = pickWindow(duration, settings.clipMinSec, settings.clipMaxSec);
  const facecam = settings.layout === "facecam" ? parseFacecam(streamer.facecam) : null;
  const layout = facecam ? "facecam" : "blur";

  const wav = storagePath("work", `${clipId}.wav`);
  const assPath = storagePath("work", `${clipId}.ass`);
  let transcript: string | null = null;
  let words: { start: number; end: number; word: string }[] = [];
  try {
    if (settings.captions && (await hasAudio(raw))) {
      await extractAudio(raw, wav, win.start, win.length);
      const t = await transcribe(wav);
      if (t) { transcript = t.text; words = t.words; }
    }
    fs.writeFileSync(assPath, buildAss({ words, credit: `twitch.tv/${streamer.login}`, duration: win.length, layout }));
    const finalRel = `final/${clipId}.mp4`;
    await renderVertical({ input: raw, output: storagePath(finalRel), start: win.start, length: win.length, facecam, assPath });

    await prisma.clip.update({
      where: { id: clipId },
      data: {
        finalPath: finalRel, duration: win.length, transcript, stage: null, error: null,
        // Re-cuts of an already-reviewed clip keep their review status.
        status: clip.status === "processing" || clip.status === "failed" ? "pending" : clip.status,
      },
    });
    return `cut ${win.length}s ${layout}${words.length ? " + captions" : ""}`;
  } finally {
    for (const f of [wav, assPath]) fs.rmSync(f, { force: true });
  }
}
