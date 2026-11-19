import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTime, videoIdOf } from "../scripts/clip-link";

test("v2.0.7: clip-link reads m:ss, h:mm:ss and plain seconds", () => {
  assert.equal(parseTime("2:15"), 135);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(parseTime("90"), 90);
  assert.equal(parseTime("abc"), null);
});

test("v2.0.7: clip-link finds the video id in every link shape", () => {
  assert.equal(videoIdOf("https://www.youtube.com/watch?v=ymCHX_Dcc-U"), "ymCHX_Dcc-U");
  assert.equal(videoIdOf("https://youtu.be/ymCHX_Dcc-U?t=3"), "ymCHX_Dcc-U");
  assert.equal(videoIdOf("https://www.youtube.com/shorts/ymCHX_Dcc-U"), "ymCHX_Dcc-U");
  assert.equal(videoIdOf("nope"), null);
});
