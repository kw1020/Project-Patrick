import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { brokenVideo } from "../src/lib/media";
import { removeLeftovers } from "../src/workers/grabber";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v2010-"));
const good = path.join(dir, "good.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", good]);

test("v2.0.10: a whole video passes the check", async () => {
  assert.equal(await brokenVideo(good), null);
});

test("v2.0.10: a download cut off mid-way is caught (moov atom not found)", async () => {
  const cut = path.join(dir, "cut.mp4");
  fs.writeFileSync(cut, fs.readFileSync(good).subarray(0, 2000));
  assert.match((await brokenVideo(cut))!, /cut off|can't be read/);
});

test("v2.0.10: an audio-only file is caught (no video stream)", async () => {
  const audio = path.join(dir, "audio.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", good, "-vn", "-c:a", "copy", audio]);
  assert.equal(await brokenVideo(audio), "the download has no video in it");
});

test("v2.0.10: leftovers of an interrupted download are removed before downloading again", () => {
  const base = path.join(dir, "clip123");
  fs.writeFileSync(base + ".mp4", "x"); fs.writeFileSync(base + ".f137.mp4", "x"); fs.writeFileSync(path.join(dir, "other.mp4"), "x");
  removeLeftovers(base);
  assert.ok(!fs.existsSync(base + ".mp4") && !fs.existsSync(base + ".f137.mp4"));
  assert.ok(fs.existsSync(path.join(dir, "other.mp4")));
  fs.rmSync(dir, { recursive: true, force: true });
});
