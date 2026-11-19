import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPostTargets } from "../src/lib/channels";

const accts = [
  { id: "yt-vcc", homeChannelId: "main" },
  { id: "yt-heist", homeChannelId: "streamheist" },
  { id: "tt-vcc", homeChannelId: "main" },
  { id: "loose", homeChannelId: null },
];

test("v1.9.7: approving auto-posts only to the clip's own channel", () => {
  assert.deepEqual(autoPostTargets(accts, "main").map((a) => a.id), ["yt-vcc", "tt-vcc"]);
  assert.deepEqual(autoPostTargets(accts, "streamheist").map((a) => a.id), ["yt-heist"]);
});

test("v1.9.7: a clip with no channel auto-posts nowhere", () => {
  assert.deepEqual(autoPostTargets(accts, null), []);
});

test("v1.9.7: no channels set up at all keeps the old behaviour", () => {
  assert.equal(autoPostTargets(accts, undefined).length, 4);
});
