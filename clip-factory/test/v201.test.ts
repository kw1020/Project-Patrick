import { test } from "node:test";
import assert from "node:assert/strict";
import { balancedChannel } from "../src/lib/channels";

const t = (n: number) => new Date(2026, 10, 19, 0, n);
const channels = [
  { id: "main", name: "ViceCityClips", kinds: "gaming,funny,edits", focus: "gta", createdAt: t(0) },
  { id: "streamheist", name: "StreamHeistClips", kinds: "funny", focus: "any", createdAt: t(1) },
  { id: "wantedlevel", name: "WantedLevelClips", kinds: "gaming", focus: "any", createdAt: t(2) },
  { id: "clipfactorygg", name: "ClipFactoryGG", kinds: "edits", focus: "any", createdAt: t(3) },
];

function spread(n: number, clip: { category: string; gta: boolean }) {
  const load: Record<string, number> = {};
  for (let i = 0; i < n; i++) { const c = balancedChannel(channels, clip, load)!; load[c.id] = (load[c.id] ?? 0) + 1; }
  return load;
}

test("v2.0.1: funny GTA clips spread ~2:1 between ViceCityClips and StreamHeistClips", () => {
  assert.deepEqual(spread(9, { category: "funny", gta: true }), { main: 6, streamheist: 3 });
});

test("v2.0.1: gaming GTA clips spread ~2:1 between ViceCityClips and WantedLevelClips", () => {
  assert.deepEqual(spread(9, { category: "gaming", gta: true }), { main: 6, wantedlevel: 3 });
});

test("v2.0.1: non-GTA clips never go to the GTA channel", () => {
  assert.deepEqual(spread(4, { category: "funny", gta: false }), { streamheist: 4 });
  assert.deepEqual(spread(4, { category: "gaming", gta: false }), { wantedlevel: 4 });
});

test("v2.0.1: the first clip still goes to ViceCityClips, and Krew's own pick always wins", () => {
  assert.equal(balancedChannel(channels, { category: "funny", gta: true }, {})!.id, "main");
  assert.equal(balancedChannel(channels, { channelId: "wantedlevel", category: "funny", gta: true }, { wantedlevel: 99 })!.id, "wantedlevel");
});
