import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCaption, checkFile, checkOriginality, platformCheck, postBlockReason, TEXT_SAFE, SAFE_Y_BOTTOM, SAFE_Y_TOP, type FileFacts, type RenderFacts } from "../src/lib/platform-rules";
import { overlayPlace, watermarkPlace, HOOK_H, CREDIT_H, CAP_HALF, WATERMARK_SIZE, type Rect } from "../src/lib/layout";
import { buildStyledAss } from "../src/lib/edit";
import { buildAss, type Word } from "../src/lib/media";
import { unsafeText, moovFirst } from "../src/lib/platform-file";
import { audioSummary, chatInSource, chatPeak, loudnessDigits } from "../src/lib/audio-summary";
import { detectScenes, pickFrameTimes, JUDGE_FRAME_MAX } from "../src/lib/frames";
import { tightenWindow, windowFromJudgeFlags, LEAD_MAX } from "../src/lib/window";
import { candidateScore, deadAir, eventGate, oldCandidateScore, rankCandidates, twitchClipRank, oldTwitchClipRank, judgePriority, type Candidate } from "../src/lib/rank";
import { keepBest, funnelCounts, funnelLine, vodSpan, type KeepClip } from "../src/lib/funnel";
import { judgeClip, judgeContent, namedPayoff, VerdictSchema, JUDGE_SYSTEM } from "../src/lib/judge";
import { brandedCaption } from "../src/lib/social";
import { costCents } from "../src/lib/pricing";
import { assBBox } from "./helpers-bbox";
import { toV196Schema } from "./schema-v173";

// v1.9.8: the Judge "watches" (audio summary, smarter frames, hook/payoff checks), better clip finding (event gate,
// velocity-aware ranking, dedupe, per-creator cap), the Platform check (format, length, safe zones, originality, caption).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-v198-"));
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");

before(() => {
  Object.assign(process.env, { DATABASE_URL: `file:${path.join(dir, "test.db")}`, STORAGE_DIR: path.join(dir, "storage"), REDIS_URL: "redis://localhost:6379/4", WHISPER_ENGINE: "off", ANTHROPIC_API_KEY: "" });
});
after(async () => {
  const { redis } = await import("../src/lib/queues");
  await redis().flushdb();
  redis().disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const W = (word: string, start: number, end = start + 0.3): Word => ({ word, start, end });
const okFile: FileFacts = { width: 1080, height: 1920, vcodec: "h264", acodec: "aac", fps: 30, seconds: 28, bytes: 18_000_000, kbps: 5200, faststart: true };
const okRender: RenderFacts = { captions: true, hook: true, credit: true, watermark: "@ViceCityClips", styled: true, layout: "split", unsafeText: [], sourceHost: "clips.twitch.tv" };
const creditOk = true;
const goodCaption = brandedCaption({ hook: "He was sure the cops didn't see him", streamer: { login: "kai", name: "Kai" }, extras: ["GTA6Clips"], game: "Grand Theft Auto VI" });

// ---------- C. Platform check ----------
test("platform check: our standard clip passes everything; plain-English hard fails and warnings", () => {
  const ok = platformCheck({ caption: goodCaption, title: "Kai jumps the bridge", creditOk, info: { file: okFile, render: okRender } });
  assert.equal(ok.fails, 0, JSON.stringify(ok.items.filter((i) => i.level !== "ok")));
  assert.equal(ok.warns, 0, JSON.stringify(ok.items.filter((i) => i.level !== "ok")));
  assert.equal(ok.summary, "Ready for Shorts, TikTok and Reels");

  const f = (p: Partial<FileFacts>) => checkFile({ ...okFile, ...p }).filter((i) => i.level === "fail").map((i) => i.text).join(" | ");
  assert.match(f({ width: 1920, height: 1080 }), /isn't vertical/);
  assert.match(f({ vcodec: "hevc" }), /H\.264/);
  assert.match(f({ acodec: "opus" }), /AAC/);
  assert.match(f({ fps: 120 }), /at most 60/);
  assert.match(f({ seconds: 181 }), /3:00/);
  assert.match(f({ seconds: 2 }), /at least 3s/);
  assert.match(f({ kbps: 30_000 }), /25 Mbps/);
  assert.match(f({ bytes: 400 * 1024 ** 2 }), /Instagram Reels's limit/);
  assert.equal(checkFile({ ...okFile, faststart: false }).find((i) => i.level === "warn")?.text, "File index is at the end (Instagram wants it at the front); re-cut to fix");
  assert.equal(checkFile(null)[0].level, "warn", "older clips without facts: a warning, never a block");

  const cap = (caption: string, title = "t", credit = true) => checkCaption({ caption, title, creditOk: credit }).filter((i) => i.level === "fail").map((i) => i.text);
  assert.deepEqual(cap(goodCaption), []);
  assert.match(cap("GTA 6 LEAK footage\n\n@kai\n#GTA6").join(), /says "leak"/);
  assert.match(cap("follow for follow\n@kai").join(), /fake engagement/);
  assert.match(cap(`${goodCaption} #a #b #c`).join(), /Instagram won't post more than 5/);
  assert.match(cap("x".repeat(2300) + " @kai").join(), /2,200/);
  assert.match(cap(goodCaption, "y".repeat(101)).join(), /YouTube allows 100/);
  assert.match(cap("no credit here", "t", false).join(), /doesn't credit/);

  const orig = (p: Partial<RenderFacts>) => checkOriginality({ ...okRender, ...p });
  assert.match(orig({ hook: false, styled: false, layout: "blur" }).find((i) => i.level === "fail")!.text, /Too little editing to count as original \(only captions\)/);
  assert.equal(orig({ hook: false, styled: false, layout: "blur", captions: false }).find((i) => i.level === "fail")!.text.includes("a plain re-upload"), true);
  assert.equal(orig({ hook: true, styled: false, layout: "blur" }).filter((i) => i.level === "fail").length, 0, "a hook alone is real editing");
  assert.match(orig({ sourceHost: "www.tiktok.com" }).find((i) => i.level === "fail")!.text, /carries that app's watermark/);
  assert.match(orig({ watermark: "@ClipsTikTok" }).find((i) => i.level === "fail")!.text, /names another app/);
  assert.match(orig({ unsafeText: ["hook"] }).find((i) => i.level === "warn")!.text, /under the app buttons/);
});

test("post block: hard fails block posting (only on the platform they apply to), warnings never do", () => {
  const leak = platformCheck({ caption: "the GTA 6 leak\n\n@kai", title: "t", creditOk, info: { file: okFile, render: okRender } });
  assert.match(postBlockReason(leak, "youtube")!, /^Platform check failed: Caption\/title says "leak"/);
  const tags = platformCheck({ caption: `${goodCaption} #a #b #c #d`, title: "t", creditOk, info: { file: okFile, render: okRender } });
  assert.equal(postBlockReason(tags, "youtube"), null, "the hashtag limit is Instagram's");
  assert.match(postBlockReason(tags, "instagram")!, /more than 5/);
  const nocredit = platformCheck({ caption: "hook only", title: "t", creditOk: false, info: { file: okFile, render: okRender } });
  assert.equal(postBlockReason(nocredit, "youtube"), null, "YouTube uploads add the credit line themselves");
  assert.match(postBlockReason(nocredit, "tiktok")!, /credit/);
  const old = platformCheck({ caption: goodCaption, title: "t", creditOk, info: null });
  assert.equal(postBlockReason(old, "tiktok"), null, "older clips (no facts) only warn");
  assert.ok(old.warns > 0);
});

test("captions never say 'leak': brandedCaption strips it from the Judge's hook", () => {
  const c = brandedCaption({ hook: "Leaked GTA 6 mission goes wrong", streamer: { login: "kai", name: "Kai" } });
  assert.doesNotMatch(c.split("\n")[0], /leak/i);
  assert.match(c, /@kai/);
});

// ---------- C. Safe zones ----------
const faces: (Rect | null)[] = [null, { x: 420, y: 80, w: 200, h: 220 }, { x: 420, y: 300, w: 220, h: 260 }, { x: 380, y: 600, w: 300, h: 360 }, { x: 400, y: 1000, w: 260, h: 300 }, { x: 300, y: 200, w: 480, h: 600 }];
test("overlayPlace + watermarkPlace: every text box inside the safe box for every layout and face position", () => {
  for (const layout of ["blur", "split", "fullcam"] as const) {
    for (const face of faces) {
      const p = overlayPlace(layout, face);
      assert.deepEqual(unsafeText(p), [], `${layout} ${JSON.stringify(face)} ${JSON.stringify(p)}`);
      const wm = watermarkPlace(p);
      assert.ok(wm.y - WATERMARK_SIZE >= SAFE_Y_TOP && wm.y <= SAFE_Y_BOTTOM, `watermark ${layout} ${wm.y}`);
      assert.match(wm.tag, new RegExp(`\\\\pos\\(${1080 - TEXT_SAFE.right},`));
      // the watermark never sits on the captions or the credit
      const capTop = p.capY - CAP_HALF, capBottom = p.capY + CAP_HALF;
      assert.ok(wm.y < capTop || wm.y - WATERMARK_SIZE > capBottom, `watermark vs captions ${layout} ${wm.y} ${p.capY}`);
      const credit = p.creditAlign === 8 ? [p.creditY, p.creditY + CREDIT_H] : [p.creditY - CREDIT_H, p.creditY];
      assert.ok(wm.y <= credit[0] + 2 || wm.y - WATERMARK_SIZE >= credit[1] - 2, `watermark vs credit ${layout} ${wm.y} ${credit}`);
      void HOOK_H;
    }
  }
});

test("real renders: credit, hook, captions and watermark land inside the safe box (styled + plain, long text shrunk to fit)", { timeout: 60_000 }, () => {
  const words = [W("UNBELIEVABLE", 0.1, 0.25), W("WHATTTT", 0.25, 0.35), W("HAPPENED", 0.35, 0.45)];
  const credit = "twitch.tv/averyveryverylongstreamername_xx", hook = "He was sure the cops didn't see him coming at all";
  const inside = (b: { x1: number; y1: number; x2: number; y2: number } | null, what: string) => {
    assert.ok(b, `${what}: something drawn`);
    assert.ok(b!.x1 >= TEXT_SAFE.left - 2 && b!.x2 <= 1080 - TEXT_SAFE.right + 2 && b!.y1 >= SAFE_Y_TOP - 2 && b!.y2 <= SAFE_Y_BOTTOM + 2, `${what}: ${JSON.stringify(b)}`);
  };
  for (const layout of ["blur", "split", "fullcam"] as const) {
    for (const style of ["hype", "clean", "meme"] as const) {
      inside(assBBox(buildStyledAss({ words, credit, duration: 3, layout, hook, style, place: overlayPlace(layout, null), watermark: "ViceCityClips" }), dir, `s-${layout}-${style}`), `${layout}/${style}`);
      inside(assBBox(buildStyledAss({ words: [W("MMMMMMMMMMMMMMMMMM", 0.1, 0.5)], credit, duration: 3, layout, hook: null, style, place: overlayPlace(layout, null), watermark: null }), dir, `w-${layout}-${style}`), `wide caption ${layout}/${style}`);
    }
    inside(assBBox(buildAss({ words, credit, duration: 3, layout, hook, place: overlayPlace(layout, null), watermark: "ViceCityClips" }), dir, `p-${layout}`), `plain ${layout}`);
  }
  // Before v1.9.8 the credit sat at y=110 and the watermark at y=1890: both now inside.
  const only = buildStyledAss({ words: [], credit: "twitch.tv/kai", duration: 3, layout: "blur", hook: null, style: "hype", watermark: "ViceCityClips" });
  const b = assBBox(only, dir, "creditmark")!;
  assert.ok(b.y1 >= SAFE_Y_TOP - 2 && b.y2 <= SAFE_Y_BOTTOM + 2, JSON.stringify(b));
});

test("moovFirst: our renders put the index at the front (Instagram's 'moov atom at the front')", () => {
  const f = path.join(dir, "fs.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x240:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-movflags", "+faststart", f]);
  assert.equal(moovFirst(f), true);
  const g = path.join(dir, "nofs.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x240:d=1", "-c:v", "libx264", "-preset", "ultrafast", g]);
  assert.equal(moovFirst(g), false);
});

// ---------- A. The Judge "watches" ----------
/** 100ms levels: a talker at -24 dB with gaps, a 10 dB scream at `spikeAt`, silence from `silentFrom`. */
function levelsWith(o: { secs: number; spikeAt?: number; silentFrom?: number; silentTo?: number; bed?: number }) {
  return Array.from({ length: o.secs * 10 }, (_, i) => {
    const t = i / 10;
    if (o.silentFrom != null && t >= o.silentFrom && t < (o.silentTo ?? o.secs)) return -70;
    if (o.spikeAt != null && t >= o.spikeAt && t < o.spikeAt + 1.5) return -10;
    return (o.bed ?? -24) + (i % 7 === 0 ? -2 : 0);
  });
}

test("audio summary: loudness digits per 0.5s, labelled spikes, speech/silence, chat lined up with the sound", () => {
  const levels = levelsWith({ secs: 40, spikeAt: 30, silentFrom: 12, silentTo: 16 });
  const words = [W("so", 5), W("we", 5.4), W("go", 5.8), W("in", 6.2), W("now.", 6.6), W("no", 30.2), W("way", 30.6), W("bro!", 31)];
  // Chat series: 12 buckets of 5s ending 12s after the moment, the moment at 30s in the source.
  const chat = chatInSource({ heat: [3, 2, 4, 3, 2, 3, 3, 2, 4, 3, 25, 31], step: 5, endAt: 0 }, 30);
  assert.equal(chat.length, 9, "buckets before the source starts are dropped");
  assert.equal(chat[8].at, 37, "last bucket starts 5s before detection (moment + 12s)");
  const a = audioSummary({ levels, words, window: { start: 4, end: 38 }, chat });
  assert.match(a.text, /^<audio_summary>/);
  assert.match(a.text, /Loudness from 4\.0s, one digit per 0\.5s/);
  const digits = a.text.split("\n").filter((l) => /^\d+\.\ds [0-9]+$/.test(l)).map((l) => l.split(" ")[1]).join("");
  assert.equal(digits.length, 68, "34s / 0.5s");
  assert.equal(digits.slice(16, 24), "00000000", "the silence 12-16s reads as 0s");
  assert.ok(digits.slice(52, 55).includes("9"), `the scream at 30s is the loudest: ${digits}`);
  assert.match(a.text, /Sound spikes: 30\.0s \+\d+ dB shouting \("no /);
  assert.match(a.text, /Real silence: 12\.0-16\.\ds/);
  assert.match(a.text, /Chat peaked at \d+s .*chat and sound react to the SAME moment/);
  assert.equal(a.coincide, true);
  assert.ok(a.peaks.includes(30) && a.peaks.length === 2, `frames go to the scream and the chat peak: ${a.peaks}`);
  assert.ok(a.text.length < 900, `compact (${a.text.length} chars)`);
  assert.equal(chatPeak([{ at: 0, n: 3 }, { at: 5, n: 4 }, { at: 10, n: 3 }]), null, "no clear chat peak");
  assert.equal(loudnessDigits([], 0, 2).digits, "0000");
  // Chat spiking over nothing: they don't line up.
  const flat = audioSummary({ levels: levelsWith({ secs: 40 }), words, window: { start: 4, end: 38 }, chat });
  assert.equal(flat.coincide, false);
  assert.match(flat.text, /no sound spike near it/);
});

test("frames: up to 12, extra ones at the sound/chat peaks (+1s reaction) and scene changes; v1.9.4 pick unchanged without them", () => {
  const base = pickFrameTimes({ start: 0, end: 30, payoffAt: 20 });
  assert.equal(base.length, 8);
  const t = pickFrameTimes({ start: 0, end: 30, payoffAt: 20, peaks: [9, 25], scenes: [4, 14, 27.5] });
  assert.equal(t.length, JUDGE_FRAME_MAX);
  for (const x of [9, 10, 25, 26, 4.2, 14.2, 27.7]) assert.ok(t.includes(x), `${x} in ${t}`);
  assert.ok(pickFrameTimes({ start: 0, end: 30, payoffAt: 20, peaks: [1, 2, 3, 4], scenes: [5, 6, 7, 8, 9] }).length <= JUDGE_FRAME_MAX);
});

test("detectScenes: finds a hard cut in a real video (ffmpeg scene score), none in a static one", { timeout: 60_000 }, async () => {
  const cut = path.join(dir, "cut.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=640x360:d=3:r=30", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=3:r=30",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", cut]);
  const s = await detectScenes(cut, 1, 4.5);
  assert.equal(s.length, 1, `${s}`);
  assert.ok(Math.abs(s[0] - 3) <= 0.2, `${s}`);
  const still = path.join(dir, "still.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=640x360:d=4:r=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", still]);
  assert.deepEqual(await detectScenes(still, 0, 4), []);
});

test("Judge schema: observations, payoff, hook/payoff checks before the score; audio summary in the message; prompt asks for them", () => {
  const keys = Object.keys(VerdictSchema.shape);
  assert.deepEqual(keys.slice(0, 5), ["observations", "payoff", "hook_lands", "payoff_in_window", "payoff_at"]);
  assert.ok(keys.indexOf("payoff_at") < keys.indexOf("score"));
  const text = judgeContent({ streamer: "Kai", durationSec: 20, source: "twitch_clip", transcript: "x", minScore: 7, audioSummary: "<audio_summary>\nLoudness…\n</audio_summary>" }) as string;
  assert.match(text, /<audio_summary>/);
  for (const re of [/audio summary/, /hook_lands/, /payoff_in_window/, /capped at 4/, /random gameplay/, /mid-sentence chatter/, /1–3 seconds before the setup/, /up to 12 still frames/]) assert.match(JUDGE_SYSTEM, re);
});

test("Judge: no named payoff = score capped at 4 (enforced in code), with the reason saying so", async () => {
  assert.equal(namedPayoff("he jumps the car onto a moving train", 31), true);
  assert.equal(namedPayoff("", 31), false);
  assert.equal(namedPayoff("he jumps the car onto a moving train", null), false);
  assert.equal(namedPayoff("Nothing really happens", 12), false);
  assert.equal(namedPayoff("just gameplay", 12), false);
  const fake = (out: Record<string, unknown>) => ({ beta: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: out, usage: { input_tokens: 4000, output_tokens: 300 } }) } } });
  const base = { observations: "o", hook_lands: true, payoff_in_window: true, score: 8, hook_text: "h", title: "t", hashtags: [], extra_hashtags: [], reason: "Looks fun.", category: "gaming", channel: "", best_start: null, best_end: null };
  const input = { streamer: "Kai", durationSec: 20, source: "twitch_clip" as const, transcript: "x", minScore: 7 };
  const capped = await judgeClip(input, null, fake({ ...base, payoff: "", payoff_at: null }) as never);
  assert.equal(capped!.score, 4);
  assert.match(capped!.reason, /^No clear payoff, so capped at 4\./);
  const kept = await judgeClip(input, null, fake({ ...base, payoff: "he lands the car on the train", payoff_at: 14 }) as never);
  assert.equal(kept!.score, 8);
  assert.equal(kept!.payoff, "he lands the car on the train");
  assert.equal(kept!.reason, "Looks fun.");
});

test("window from the Judge's checks: payoff outside → new window around it; weak hook → starts at the next sentence", () => {
  const words = [W("Hey", 0.5), W("chat.", 0.9), W("So", 5), W("anyway.", 5.4), W("Watch", 9), W("this", 9.4), W("jump.", 9.8), W("No", 21), W("way!", 21.4)];
  const o = { duration: 40, words, minSec: 12, maxSec: 30 };
  const moved = windowFromJudgeFlags({ ...o, win: { start: 0, end: 15 }, hookLands: true, payoffIn: false, payoffAt: 21, currentPayoff: 10 })!;
  assert.match(moved.why, /payoff at 21s was outside/);
  assert.ok(moved.window.start < 21 && moved.window.start + moved.window.length > 22, JSON.stringify(moved));
  const hook = windowFromJudgeFlags({ ...o, win: { start: 0, end: 24 }, hookLands: false, payoffIn: true, payoffAt: 21, currentPayoff: 21 })!;
  assert.equal(hook.window.start, 4.75, "the 'So anyway' sentence, not 'Hey chat'");
  assert.match(hook.why, /weak opening/);
  assert.equal(windowFromJudgeFlags({ ...o, win: { start: 0, end: 24 }, hookLands: true, payoffIn: true, payoffAt: 21, currentPayoff: 21 }), null);
});

test("tighter cuts: open on the setup (<= 12s before the payoff), end after the reaction, no dead air at either end, >= min length", () => {
  const words = [W("blah", 1), W("blah.", 1.4), W("Okay", 14), W("watch", 14.4), W("me", 14.8), W("jump.", 15.2), W("No", 25.2), W("way!", 25.6), W("Haha.", 26.2)];
  const levels = levelsWith({ secs: 45, spikeAt: 25, silentFrom: 29.5, silentTo: 45 });
  const w = tightenWindow({ start: 0, length: 34 }, { payoff: 25, words, levels, minSec: 12, maxSec: 35, duration: 45 });
  assert.equal(w.start, 12.8, "1.2s before the setup sentence");
  assert.ok(25 - w.start <= LEAD_MAX + 1.5);
  const end = w.start + w.length;
  assert.ok(end <= 30 && end >= 26.5, `trailing silence trimmed, reaction kept: ${end}`);
  // Leading dead air is trimmed too (never into the payoff), and min length is restored from the start.
  const lv2 = levelsWith({ secs: 40, spikeAt: 20, silentFrom: 0, silentTo: 6 });
  const w2 = tightenWindow({ start: 2, length: 22 }, { payoff: 20, words: [], levels: lv2, minSec: 15, maxSec: 35, duration: 40 });
  assert.ok(w2.start >= 5.9 || w2.length >= 15, JSON.stringify(w2));
  assert.ok(w2.length >= 15 - 1e-6, JSON.stringify(w2));
});

// ---------- B. Clip finding: offline scorer on labelled fixtures ----------
const base = 200;
const T = (id: string, label: string, good: boolean, views: number, ageHours: number, m: Partial<Candidate>): Candidate => ({ id, label, good, source: "twitch_clip", streamer: "kai", views, base, ageHours, ...m });
const FIXTURES: Candidate[] = [
  T("t1", "fresh fail, viewers clipping it right now", true, 1500, 1.5, { vodId: "v1", from: 100, to: 130, audioJumpDb: 12, reactNear: 3, wordsNear: 6, silenceShare: 0.05, speechShare: 0.5, wordCount: 40, coincide: null }),
  T("t2", "big clip from yesterday, a real moment", true, 3000, 40, { audioJumpDb: 10, reactNear: 2, wordsNear: 5, silenceShare: 0.05, speechShare: 0.5, wordCount: 35 }),
  T("t3", "BRB screen clipped as a joke (AFK)", false, 2500, 5, { audioJumpDb: 0, reactNear: 0, wordsNear: 0, silenceShare: 0.8, speechShare: 0.02, wordCount: 0, sceneChanges: 0 }),
  T("t4", "just chatting about his settings", false, 1800, 3, { audioJumpDb: 2, reactNear: 0, wordsNear: 9, silenceShare: 0.02, speechShare: 0.9, wordCount: 80 }),
  T("t5", "menu / loading screen", false, 1200, 2, { audioJumpDb: 0, reactNear: 0, wordsNear: 1, silenceShare: 0.3, speechShare: 0.1, wordCount: 6, sceneChanges: 0 }),
  T("t6", "clutch escape, quiet but he shouts", true, 900, 1, { audioJumpDb: 7, reactNear: 1, wordsNear: 4, silenceShare: 0.1, speechShare: 0.4, wordCount: 30 }),
  { id: "c1", label: "chat 7x over a donation, nothing on screen", good: false, source: "chat", streamer: "kai", chatRatio: 7, chatX: 4, audioJumpDb: 1, coincide: false, reactNear: 0, wordsNear: 2, silenceShare: 0.05, speechShare: 0.6, wordCount: 50 },
  { id: "c2", label: "chat 3.2x + a scream at the same second", good: true, source: "chat", streamer: "kai", chatRatio: 3.2, chatX: 3.5, audioJumpDb: 11, coincide: true, reactNear: 2, wordsNear: 4, silenceShare: 0.05, speechShare: 0.4, wordCount: 30 },
  { id: "c3", label: "chat 4x laughing with him", good: true, source: "chat", streamer: "kai", chatRatio: 4, chatX: 3, audioJumpDb: 8, coincide: true, reactNear: 3, wordsNear: 6, silenceShare: 0.02, speechShare: 0.6, wordCount: 45 },
  { id: "c4", label: "chat 5x while he's muted", good: false, source: "chat", streamer: "kai", chatRatio: 5, chatX: 3, audioJumpDb: 0, coincide: false, reactNear: 0, wordsNear: 0, silenceShare: 0.65, speechShare: 0.03, wordCount: 1 },
  { id: "c5", label: "chat spike on the SAME moment as t1 (duplicate)", good: false, source: "chat", streamer: "kai", chatRatio: 4, chatX: 3, vodId: "v1", from: 105, to: 135, audioJumpDb: 12, coincide: true, reactNear: 3, wordsNear: 6, silenceShare: 0.05, speechShare: 0.5, wordCount: 40 },
  { id: "y1", label: "YouTube replay peak: a real crash", good: true, source: "youtube", streamer: "kai", replay: 0.9, audioJumpDb: 9, reactNear: 2, wordsNear: 5, silenceShare: 0.05, speechShare: 0.5, wordCount: 30 },
  { id: "y2", label: "YouTube replay peak on the intro music", good: false, source: "youtube", streamer: "kai", replay: 0.95, audioJumpDb: 0, reactNear: 0, wordsNear: 1, silenceShare: 0.1, speechShare: 0.15, wordCount: 5 },
];
const precisionAt = (ranked: { c: Candidate }[], k: number) => ranked.slice(0, k).filter((x) => x.c.good).length / k;

test("offline scorer: the v1.9.8 ranking beats the v1.9.4 one on labelled fixtures; the gate drops the random pieces", () => {
  const good = FIXTURES.filter((c) => c.good).length;
  const oldR = rankCandidates(FIXTURES, oldCandidateScore, false);
  const newR = rankCandidates(FIXTURES, candidateScore, true).filter((x) => x.score > 0);
  const pOld = precisionAt(oldR, good), pNew = precisionAt(newR, good);
  const dropped = FIXTURES.filter((c) => candidateScore(c) === 0).map((c) => `${c.id} ${c.label}: ${eventGate({ silenceShare: c.silenceShare!, speechShare: c.speechShare!, wordCount: c.wordCount ?? 0, audioJumpDb: c.audioJumpDb ?? 0, chatX: c.chatX ?? null, reactNear: c.reactNear!, wordsNear: c.wordsNear ?? 0, sceneChanges: c.sceneChanges ?? null }).reason}`);
  console.log(`# offline scorer: precision@${good} old ${pOld.toFixed(2)} (top: ${oldR.slice(0, good).map((x) => x.c.id).join(" ")}) → new ${pNew.toFixed(2)} (top: ${newR.slice(0, good).map((x) => x.c.id).join(" ")})`);
  for (const d of dropped) console.log(`# dropped by the gate: ${d}`);
  console.log(`# deduped: c5 (same VOD stretch as t1) → kept ${newR.some((x) => x.c.id === "c5") ? "c5 too (BUG)" : "t1 only"}`);
  assert.ok(pNew > pOld, `new ${pNew} vs old ${pOld}`);
  assert.equal(pNew, 1, "every kept top pick is a good clip");
  assert.deepEqual(new Set(FIXTURES.filter((c) => candidateScore(c) === 0).map((c) => c.id)), new Set(["t3", "t4", "t5", "c1", "c4", "y2"]));
  assert.ok(!newR.some((x) => x.c.id === "c5"), "the duplicate of t1 is dropped");
  // Obvious pairs: chat + scream at the same moment beats a bigger chat spike over nothing.
  assert.ok(candidateScore(FIXTURES[7]) > candidateScore(FIXTURES[6]));
  assert.ok(oldCandidateScore(FIXTURES[7]) < oldCandidateScore(FIXTURES[6]), "the old ranking had it backwards");
});

test("Twitch ranking: a clip taking off right now beats an older one with more views; the old rank had it backwards", () => {
  const nowClip = { views: 600, base: 100, ageHours: 1 }, older = { views: 1200, base: 100, ageHours: 30 };
  assert.ok(twitchClipRank(nowClip) > twitchClipRank(older));
  assert.ok(oldTwitchClipRank(nowClip) < oldTwitchClipRank(older));
  assert.ok(twitchClipRank({ ...nowClip, byStreamer: true }) > twitchClipRank(nowClip), "the streamer clipped it themselves");
  assert.ok(judgePriority(10) < judgePriority(1));
});

test("event gate: kinds of clips that get dropped, in plain English", () => {
  const ok = { silenceShare: 0.05, speechShare: 0.5, wordCount: 30, audioJumpDb: 10, chatX: null, reactNear: 2, wordsNear: 5, sceneChanges: 3 };
  assert.equal(eventGate(ok).pass, true);
  assert.equal(eventGate({ ...ok, audioJumpDb: 2 }).kind, "no_spike");
  assert.match(eventGate({ ...ok, audioJumpDb: 2 }).reason!, /just talking, nothing happens/);
  assert.match(eventGate({ ...ok, audioJumpDb: 2, speechShare: 0.1 }).reason!, /a random piece/);
  assert.equal(eventGate({ ...ok, audioJumpDb: 2, chatX: 3 }).pass, true, "chat well over its own usual counts as the spike");
  assert.equal(eventGate({ ...ok, audioJumpDb: 7, reactNear: 0, wordsNear: 0 }).kind, "no_reaction");
  assert.equal(eventGate({ ...ok, audioJumpDb: 10, reactNear: 0, wordsNear: 0 }).pass, true, "a scream-level spike is its own reaction");
  assert.equal(eventGate({ ...ok, silenceShare: 0.7, speechShare: 0.02, wordCount: 2 }).kind, "dead_air");
  assert.equal(eventGate({ ...ok, speechShare: 0.01, wordCount: 0, audioJumpDb: 0, sceneChanges: 0 }).kind, "afk");
  assert.equal(deadAir({ silenceShare: 0.1, speechShare: 0.5, wordCount: 30, soundSpikes: 1, sceneChanges: 2 }), null);
});

// ---------- B/(5). Near-duplicates + per-creator hourly cap, keeping the best ----------
test("keepBest: near-duplicates keep the better clip; at most N per creator per hour, a better one replaces the worst pending", () => {
  const now = 10_000_000;
  const k = (id: string, score: number, o: Partial<KeepClip> = {}): KeepClip => ({ id, streamerId: "s", score, status: "pending", createdAt: now - 600_000, vodId: null, from: null, to: null, at: now - 600_000 - Number(id.replace(/\D/g, "")) * 120_000, ...o });
  const me = k("n0", 8, { vodId: "v", from: 100, to: 125, at: now });
  // same VOD stretch, worse → it is replaced; same stretch, better → I'm set aside
  assert.deepEqual(keepBest(me, [k("a1", 7, { vodId: "v", from: 110, to: 140 })], 3, now).demote.map((d) => d.id), ["a1"]);
  assert.match(keepBest(me, [k("a1", 9, { vodId: "v", from: 110, to: 140 })], 3, now).reason!, /Near-duplicate/);
  assert.equal(keepBest(me, [k("a1", 7, { vodId: "v", from: 110, to: 140, status: "approved" })], 3, now).keep, false, "never touch an approved clip");
  // no VOD: moments within 45s are the same
  assert.equal(keepBest({ ...me, vodId: null }, [k("b1", 9, { at: now - 30_000 })], 3, now).keep, false);
  // cap: 3 this hour already
  const three = [k("c1", 7.5), k("c2", 9), k("c3", 7)];
  const r = keepBest(me, three, 3, now);
  assert.equal(r.keep, true);
  assert.deepEqual(r.demote.map((d) => d.id), ["c3"], "the worst pending one makes room");
  assert.match(keepBest({ ...me, score: 6.5 }, three, 3, now).reason!, /already has 3 better clips this hour/);
  assert.equal(keepBest(me, [k("d1", 9, { createdAt: now - 2 * 3600_000 }), ...three.slice(0, 2)], 3, now).keep, true, "older than an hour doesn't count");
  assert.deepEqual(vodSpan({ source: "chat", vodId: "v", vodOffset: 500 }, 10, 20), { vodId: "v", from: 480, to: 500 });
});

test("funnel line: X found, Y kept, and why the rest were set aside", () => {
  const rows = [
    { status: "pending", judgeReason: "Great." }, { status: "approved", judgeReason: "ok" }, { status: "posted", judgeReason: null },
    { status: "rejected", judgeReason: "Set aside by the clip finder (the Judge was not asked): a random piece" },
    { status: "rejected", judgeReason: "Set aside by the clip finder (the Judge was not asked): just talking" },
    { status: "rejected", judgeReason: "No clear payoff, so capped at 4." }, { status: "rejected", judgeReason: "Near-duplicate: a better clip" },
    { status: "rejected", judgeReason: "This creator already has 3 better clips this hour" }, { status: "processing", judgeReason: null },
  ];
  const c = funnelCounts(rows, "Set aside by the clip finder");
  assert.deepEqual(c, { found: 9, kept: 3, finder: 2, judge: 1, dupes: 2, working: 1 });
  assert.equal(funnelLine(c), "Last 24h: 9 found, 3 kept (2 nothing happening, 1 below the Judge's cut-off, 2 duplicates or over the hourly cap, 1 still in the line)");
  assert.equal(funnelLine(funnelCounts([], "x")), "Last 24h: no clips found yet");
});

// ---------- Cost per clip ----------
test("cost per clip: tokens and $ for a 12-frame Judge call (src/lib/pricing.ts)", () => {
  // Image tokens ≈ width x height / 750 (Anthropic vision docs); our stills are 640x360.
  const imageTokens = Math.ceil((640 * 360) / 750);
  const words = Array.from({ length: 120 }, (_, i) => W(i % 9 === 0 ? "no way!" : "word", i * 0.3));
  const audio = audioSummary({ levels: levelsWith({ secs: 60, spikeAt: 40 }), words, window: { start: 15, end: 50 }, chat: [] }).text;
  const text = judgeContent({ streamer: "Kai", durationSec: 30, source: "chat", transcript: "x", minScore: 7, audioSummary: audio, sourceLength: 60, window: { start: 15, end: 50 },
    timedTranscript: words.map((w) => `[${w.start.toFixed(1)}s] ${w.word}`).join("\n").slice(0, 2500), stats: { chat: Array.from({ length: 40 }, () => "KEKW no way") } }) as string;
  const chars = JUDGE_SYSTEM.length + text.length + 12 * 20; // + frame labels
  const inTok = Math.round(chars / 3.6) + 12 * imageTokens, outTok = 450; // ~400-500 output tokens (structured verdict, medium effort)
  const cents = costCents(inTok, outTok);
  console.log(`# Judge cost estimate: ~${inTok} input tokens (12 x ${imageTokens} image + text) + ~${outTok} output = ${cents.toFixed(2)}¢ per clip; 8 frames: ${costCents(inTok - 4 * imageTokens, outTok).toFixed(2)}¢`);
  assert.ok(cents < 3, `${cents}¢`);
});

// ---------- The gate in the real line ----------
test("runJudge: a steady-tone 'random piece' is set aside by the clip finder before any Judge call (score 2, reason, audio kept)", { timeout: 120_000 }, async () => {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const { prisma } = await import("../src/lib/db");
  const { runJudge } = await import("../src/workers/judge");
  const raw = path.join(dir, "storage", "raw", "flat.mp4");
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=30", "-f", "lavfi", "-i", "sine=frequency=300:duration=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", raw]);
  const s = await prisma.streamer.create({ data: { twitchId: "t-flat", login: "flat", name: "Flat", approved: true } });
  const m = await prisma.moment.create({ data: { streamerId: s.id, timestamp: new Date(), source: "twitch_clip", sourceViews: 900, spikeScore: 3 } });
  const words = JSON.stringify([W("so", 3), W("yeah", 3.5), W("anyway", 9), W("um", 14)]);
  const c = await prisma.clip.create({ data: { momentId: m.id, rawPath: "raw/flat.mp4", status: "processing", stage: "judge", title: "t", caption: "c", winStart: 5, winLength: 20, duration: 20, payoffAt: 15, wordsFull: true, words } });
  const msg = await runJudge(c.id);
  assert.match(msg, /set aside by the clip finder, no Judge call \((a random piece: no spike in sound or chat|nothing happens: no talking, no sound spikes)/);
  const after = await prisma.clip.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.score, 2);
  assert.match(after.judgeReason!, /^Set aside by the clip finder \(the Judge was not asked\): (a random piece|nothing happens)/);
  assert.match(after.judgeAudio!, /^<audio_summary>/);
  assert.equal(after.stage, "cut");
});

// ---------- DB push upgrade ----------
test("db push upgrade from the v1.9.6 schema (7fb3948) with rows: no prompt, rows kept, new columns null/defaulted", () => {
  const now = fs.readFileSync(SCHEMA, "utf8");
  const old = toV196Schema(now);
  const git = spawnSync("git", ["show", "7fb3948:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: ROOT });
  if (git.status === 0) assert.equal(old, git.stdout, "derived schema is exactly the 7fb3948 one");
  const uniques = (s: string) => (s.match(/@unique|@@unique/g) ?? []).length;
  assert.equal(uniques(now), uniques(old), "no new unique constraints");
  const up = path.join(dir, "upgrade");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "old.prisma"), old);
  const env = { ...process.env, DATABASE_URL: `file:${path.join(up, "krew.db")}` };
  const push = (schema: string) => spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schema], { env, encoding: "utf8" });
  const first = push(path.join(up, "old.prisma"));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const sql = (q: string) => execFileSync(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(env.DATABASE_URL)} } } });
    p.$queryRawUnsafe(${JSON.stringify(q)}).then((r) => { console.log(JSON.stringify(r, (k, v) => typeof v === "bigint" ? Number(v) : v)); return p.$disconnect(); });
  `], { encoding: "utf8", cwd: ROOT });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, 0, 0)`);
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'twitch_clip', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, score, judgeReason, judgeFrames, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 6, 'meh', 8, 0, 0)`);
  sql(`INSERT INTO Settings (id, minScore, channelName) VALUES ('main', 6, 'MyClips')`);
  const second = push(SCHEMA);
  const outp = second.stdout + second.stderr;
  assert.equal(second.status, 0, outp);
  assert.doesNotMatch(outp, /data loss|accept-data-loss|unique constraint/i);
  assert.match(outp, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, score, judgeReason, judgeFrames, judgeHookOk, judgePayoffIn, judgePayoff, judgeAudio, platformInfo FROM Clip")),
    [{ id: "c1", score: 6, judgeReason: "meh", judgeFrames: 8, judgeHookOk: null, judgePayoffIn: null, judgePayoff: null, judgeAudio: null, platformInfo: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT channelName, minScore, maxPerCreatorPerHour, migratedMinScore7 FROM Settings")),
    [{ channelName: "MyClips", minScore: 6, maxPerCreatorPerHour: 3, migratedMinScore7: false }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});

test("migrateV198Settings: min score 6 -> 7 once; a later manual change sticks", async () => {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });
  const { prisma } = await import("../src/lib/db");
  const { migrateV198Settings } = await import("../src/workers/migrate");
  await prisma.settings.upsert({ where: { id: "main" }, update: { minScore: 6, migratedMinScore7: false }, create: { id: "main", minScore: 6 } });
  assert.equal(await migrateV198Settings(), "min score moved 6 -> 7 (v1.9.8)");
  assert.equal((await prisma.settings.findUnique({ where: { id: "main" } }))!.minScore, 7);
  await prisma.settings.update({ where: { id: "main" }, data: { minScore: 6 } });
  assert.equal(await migrateV198Settings(), null);
  assert.equal((await prisma.settings.findUnique({ where: { id: "main" } }))!.minScore, 6, "Krew's own choice sticks");
  await prisma.$disconnect();
});
