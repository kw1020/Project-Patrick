import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAss, buildFilter, chunkWords, parseFacecam, pickWindow, renderVertical, run, probeDuration } from "../src/lib/media";
import { ChatHeat, HYPE } from "../src/lib/chat";
import { defaultCaption, defaultTitle } from "../src/lib/social";

test("pickWindow keeps the middle and caps length", () => {
  assert.deepEqual(pickWindow(60, 15, 45), { start: 7.5, length: 45 });
  assert.deepEqual(pickWindow(20, 15, 45), { start: 0, length: 20 });
  assert.deepEqual(pickWindow(10, 15, 45), { start: 0, length: 10 });
});

test("parseFacecam validates fractions", () => {
  assert.deepEqual(parseFacecam("0.7, 0.05, 0.28, 0.3"), { x: 0.7, y: 0.05, w: 0.28, h: 0.3 });
  assert.equal(parseFacecam("0.8,0,0.5,0.3"), null); // runs off the right edge
  assert.equal(parseFacecam("a,b,c,d"), null);
  assert.equal(parseFacecam(""), null);
});

test("chunkWords makes short caption chunks and breaks on sentences", () => {
  const w = (word: string, start: number) => ({ word, start, end: start + 0.3 });
  const chunks = chunkWords([w("no", 0), w("way", 0.3), w("he", 0.6), w("did", 0.9), w("that!", 1.2), w("run", 1.6)]);
  assert.deepEqual(chunks.map((c) => c.text), ["no way he", "did that!", "run"]);
});

test("buildAss has credit line, escapes braces, uppercases captions", () => {
  const ass = buildAss({ words: [{ word: "{hi}", start: 0, end: 0.5 }, { word: "chat", start: 0.5, end: 1 }], credit: "twitch.tv/test", duration: 20, layout: "blur" });
  assert.match(ass, /Credit,,0,0,0,,twitch\.tv\/test/);
  assert.match(ass, /Cap,,0,0,0,,\{\\fad\(60,0\)\}HI CHAT/);
  assert.match(ass, /PlayResY: 1920/);
});

test("filters produce a single [v] output", () => {
  assert.match(buildFilter({ facecam: null, assFile: "a.ass" }), /ass=a\.ass\[v\]$/);
  assert.match(buildFilter({ facecam: { x: 0, y: 0, w: 0.3, h: 0.3 } }), /vstack.*null\[v\]$/);
});

test("HYPE matches hype chat, not normal chat", () => {
  for (const m of ["LMAOOO", "KEKW", "OMEGALUL", "clip it", "W", "WWW", "no wayyy"]) assert.ok(HYPE.test(m), m);
  for (const m of ["what is this", "hello chat", "wait"]) assert.ok(!HYPE.test(m), m);
});

test("ChatHeat rates", () => {
  const c = new ChatHeat();
  const now = 1_000_000_000;
  for (let i = 0; i < 120; i++) c.record("Streamer", i % 2 ? "KEKW" : "hi", now - (i % 60) * 1000);
  const s = c.stats("streamer", now);
  assert.equal(s.rate, 2);
  assert.equal(s.hype, 1);
  assert.equal(s.avg, 120 / 300);
});

test("social caption always credits the streamer", () => {
  const t = defaultTitle("", "Kai");
  assert.equal(t, "Kai in GTA 6");
  assert.match(defaultCaption(t, { name: "Kai", login: "kai_cenat" }), /twitch\.tv\/kai_cenat/);
});

test("renderVertical makes 1080x1920 clips in both layouts (real ffmpeg)", { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-"));
  const src = path.join(dir, "src.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=50",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=50", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
  const ass = path.join(dir, "c.ass");
  fs.writeFileSync(ass, buildAss({ words: [{ word: "no", start: 0.2, end: 0.5 }, { word: "way!", start: 0.5, end: 1 }], credit: "twitch.tv/test", duration: 45, layout: "blur" }));
  for (const fc of [null, { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }]) {
    const out = path.join(dir, `out-${fc ? "cam" : "blur"}.mp4`);
    const win = pickWindow(await probeDuration(src), 15, 45);
    await renderVertical({ input: src, output: out, start: win.start, length: win.length, facecam: fc, assPath: ass });
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
    assert.equal(stdout.trim(), "1080,1920");
    const d = await probeDuration(out);
    assert.ok(Math.abs(d - 45) < 0.5, `duration ${d}`);
  }
  if (process.env.CF_TEST_OUT) fs.cpSync(dir, process.env.CF_TEST_OUT, { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
