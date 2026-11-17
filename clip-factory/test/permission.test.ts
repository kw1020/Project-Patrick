import { test } from "node:test";
import assert from "node:assert/strict";
import { findPermission, findPermissionEvidence, approvalReasonFromEvidence } from "../src/lib/permission";

test("permission: positive phrases are found, with the matched phrase", () => {
  const cases: [string, RegExp][] = [
    ["Clips welcome!", /^Clips welcome$/],
    ["clips are welcome here, tag me", /^clips are welcome$/],
    ["Clipping is allowed", /^Clipping is allowed$/],
    ["clips encouraged", /clips encouraged/],
    ["clips ok :)", /^clips ok$/],
    ["Clips okay, credit me", /^Clips okay$/],
    ["Feel free to clip and post anywhere", /^Feel free to clip$/],
    ["feel free to repost my stuff", /^feel free to repost$/],
    ["Clippers welcome", /^Clippers welcome$/],
    ["clippers wanted - DM me", /^clippers wanted$/],
    ["Join my clipping campaign", /^clipping campaign$/],
    ["Official clip program on Discord", /^clip program$/],
    ["Monthly CLIP CONTEST, $500 prize", /^CLIP CONTEST$/],
    ["reposts allowed", /^reposts allowed$/],
    ["Reposting is ok with credit", /^Reposting is ok$/],
    ["Earn with Content Rewards", /^Content Rewards$/],
    ["Clip me: https://whop.com/streamerx-clips", /^whop\.com\/streamerx-clips$/],
    ["clips ’re fine? yes: Clips are fine", /Clips are fine/], // curly apostrophe is normalised
  ];
  for (const [text, want] of cases) {
    const hit = findPermission(text);
    assert.ok(hit, `expected a hit in: ${text}`);
    assert.match(hit!.match, want, text);
    assert.ok(hit!.snippet.includes(hit!.match), text);
  }
});

test("permission: negatives cancel and unrelated text is ignored", () => {
  const none = [
    "No clips please",
    "Don't clip my stream",
    "Dont clip me, clips welcome on my own channel only", // any negative cancels the whole text
    "do not repost my content",
    "Clips not allowed",
    "clips are not welcome",
    "clips aren't allowed",
    "Clipping is prohibited. Clippers welcome? no.",
    "You are not allowed to clip or repost",
    "I don’t run a clipping program",
    "reposts are banned",
    "no reuploads, no clips",
    "Never repost. Feel free to clip in chat though",
    "Variety streamer. Business: mgmt@example.com",
    "Playing GTA 6 all day! !discord !socials",
    "I love clipping my nails", // "clip" without permission wording
    "",
  ];
  for (const t of none) assert.equal(findPermission(t), null, t);
  assert.equal(findPermission(null), null);
  assert.equal(findPermission(undefined), null);
});

test("permission: snippet keeps context from the same line and stays <= 160 chars", () => {
  const long = "a".repeat(30) + " " + "word ".repeat(40) + "clips welcome " + "more ".repeat(60);
  const hit = findPermission(long)!;
  assert.ok(hit.snippet.length <= 160, String(hit.snippet.length));
  assert.match(hit.snippet, /word clips welcome more/);
  assert.ok(!hit.snippet.startsWith(" ") && !hit.snippet.endsWith(" "));

  const multi = "Daily streams 6pm EST\nClippers welcome, just credit the channel\nBusiness: x@y.com";
  assert.equal(findPermission(multi)!.snippet, "Clippers welcome, just credit the channel");

  const whop = "Join https://whop.com/" + "x".repeat(400);
  assert.ok(findPermission(whop)!.snippet.length <= 160);
});

test("permission: bio first, then title; reason pre-fill only from real evidence", () => {
  const bio = findPermissionEvidence("Clips welcome!", "Feel free to clip today");
  assert.equal(bio?.source, "bio");
  const title = findPermissionEvidence("Just a guy", "GTA 6 day one | clip contest live");
  assert.equal(title?.source, "title");
  assert.equal(title?.match, "clip contest");
  assert.equal(findPermissionEvidence("No clips please", "clips welcome"), null); // a "no" in the bio beats the title
  assert.equal(findPermissionEvidence("Variety", "GTA 6"), null);

  assert.equal(approvalReasonFromEvidence({ evidence: "Clips welcome!", evidenceSource: "bio" }), 'Bio says: "Clips welcome!"');
  assert.equal(approvalReasonFromEvidence({ evidence: "clip contest live", evidenceSource: "title" }), 'Stream title says: "clip contest live"');
  assert.equal(approvalReasonFromEvidence({ evidence: null, evidenceSource: null }), "");
});
