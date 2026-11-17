import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildStyledAss, buildStyledFilter, chunkWordsDetailed, cutPoints, fitSize, loudestSecond, parseLoudness, pickPeak, planEdit,
  planJumpCuts, punchAt, remapTime, remapWords, renderOrFallback, renderStyled, segsDuration, splitHook, zoomExpr, CAPTION_Y, STYLES,
} from "../src/lib/edit";
import { EDIT_STYLES, parseEditStyle } from "../src/lib/edit-styles";
import { probeDuration, run, type Word } from "../src/lib/media";

// v1.7.3 editing styles: jump cuts, word-by-word captions, zooms, hook, SFX, progress bar.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edit-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Words with a talking burst at each [start, n] (0.3s per word). */
function talk(...bursts: [number, number][]): Word[] {
  const out: Word[] = [];
  for (const [s, n] of bursts) for (let i = 0; i < n; i++) out.push({ word: `w${out.length}`, start: s + i * 0.3, end: s + i * 0.3 + 0.28 });
  return out;
}

test("parseEditStyle defaults to hype; three styles listed", () => {
  assert.equal(parseEditStyle("meme"), "meme");
  assert.equal(parseEditStyle("clean"), "clean");
  assert.equal(parseEditStyle("nope"), "hype");
  assert.equal(parseEditStyle(null), "hype");
  assert.deepEqual(EDIT_STYLES.map((s) => s.key), ["hype", "clean", "meme"]);
  assert.equal(STYLES.clean.sfx, false);
  assert.equal(STYLES.clean.punch, 0);
  assert.ok(STYLES.meme.punch > STYLES.hype.punch);
});

test("planJumpCuts removes long silences between words with 0.15s padding", () => {
  const words = talk([1, 6], [6, 6], [12, 6]); // bursts end at 2.78, 7.78, 13.78
  const segs = planJumpCuts({ words, length: 20, minSec: 8 });
  // gaps 2.78→6 and 7.78→12 removed (padded and snapped to 1/30s); leading and trailing silence kept
  assert.equal(segs.length, 3);
  assert.equal(segs[0].start, 0);
  assert.ok(Math.abs(segs[0].end - 2.933) < 0.02, String(segs[0].end));
  assert.ok(Math.abs(segs[1].start - 5.85) < 0.02, String(segs[1].start));
  assert.equal(segs[2].end, 20);
  for (const s of segs) for (const v of [s.start, s.end]) assert.ok(Math.abs(v * 30 - Math.round(v * 30)) < 0.05, "frame aligned (to the ms)");
  // never inside a word
  for (const w of words) assert.ok(segs.some((s) => w.start >= s.start && w.end <= s.end), `word at ${w.start} kept whole`);
});

test("planJumpCuts never goes under the minimum, skips quiet clips and protects the peak", () => {
  const words = talk([1, 6], [6, 6], [12, 6]);
  // 20s with min 16: only the smaller gap fits... the bigger (3.92s → 3.62 removed) would go to 16.38, the next would go under.
  const a = planJumpCuts({ words, length: 20, minSec: 16 });
  assert.ok(segsDuration(a) >= 16, String(segsDuration(a)));
  assert.equal(a.length, 2);
  assert.ok(a[0].end > 7.7 && a[1].start < 12, "the biggest gap was the one removed");
  assert.equal(planJumpCuts({ words, length: 20, minSec: 19.5 }).length, 1, "no room at all");
  assert.deepEqual(planJumpCuts({ words: talk([1, 5]), length: 20, minSec: 5 }), [{ start: 0, end: 20 }], "< 6 words = gameplay, no cuts");
  const p = planJumpCuts({ words, length: 20, minSec: 5, protect: { start: 9, end: 10.5 } });
  assert.equal(p.length, 2, "the gap holding the peak stays");
  assert.ok(p.some((s) => s.start <= 9 && s.end >= 10.5));
});

test("remapTime / remapWords move words onto the edited timeline", () => {
  const segs = [{ start: 0, end: 3 }, { start: 6, end: 8 }, { start: 12, end: 20 }];
  assert.equal(remapTime(1, segs), 1);
  assert.equal(remapTime(6.5, segs), 3.5);
  assert.equal(remapTime(4, segs), 3, "inside a cut → start of the next part");
  assert.equal(remapTime(12, segs), 5);
  assert.equal(remapTime(25, segs), 13);
  assert.deepEqual(cutPoints(segs), [3, 5]);
  assert.equal(segsDuration(segs), 13);
  const w = remapWords([{ word: "a", start: 6.2, end: 6.5 }, { word: " ", start: 7, end: 7.1 }, { word: "b", start: 12.5, end: 13 }, { word: "late", start: 21, end: 22 }], segs);
  assert.deepEqual(w, [{ word: "a", start: 3.2, end: 3.5 }, { word: "b", start: 5.5, end: 6 }]);
});

test("loudness parsing and peak choice", () => {
  const out = "frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-30.1\nframe:1\nlavfi.astats.Overall.RMS_level=-12.5\nframe:2\nlavfi.astats.Overall.RMS_level=-inf\n";
  assert.deepEqual(parseLoudness(out), [-30.1, -12.5, -Infinity]);
  assert.equal(loudestSecond([-30, -12, -40]), 1);
  assert.equal(loudestSecond([-80, -70]), null, "silence = no peak");
  assert.equal(pickPeak({ source: "twitch_clip", vodOffset: null, winStart: 5, length: 30, levels: [-30, -20, -10, -25] }), 2.2);
  // chat spike from a VOD: the moment is 30s into the raw section (vodOffset 500), window starts at 7.5 → 22.5
  assert.equal(pickPeak({ source: "chat", vodId: "v1", vodOffset: 500, winStart: 7.5, length: 30, levels: [-10] }), 22.5);
  assert.equal(pickPeak({ source: "chat", vodId: "v1", vodOffset: 10, winStart: 0, length: 30, levels: [] }), 10, "VOD started early");
  assert.equal(pickPeak({ source: "youtube", vodOffset: 300, winStart: 0, length: 30, levels: [] }), null);
  assert.equal(punchAt(10, 30), 9.75);
  assert.equal(punchAt(29.9, 30), 28, "room to zoom back out");
  assert.equal(punchAt(null, 30), null);
  assert.equal(punchAt(1, 3), null, "too short");
});

test("zoomExpr: alternating 108% on cuts and a smooth punch-in; none for clean", () => {
  const z = zoomExpr({ cuts: [3, 5], alt: 0.08, punchStart: 9.75, punch: 0.15 })!;
  assert.match(z, /\(1\+0\.08\*mod\(gte\(t,3\)\+gte\(t,5\),2\)\)/);
  assert.match(z, /1\+0\.15\*/);
  assert.match(z, /11\.45/, "out by start + 1.7s");
  assert.equal(zoomExpr({ cuts: [3], alt: 0, punchStart: null, punch: 0 }), null);
  // evaluate it in JS to check the curve: 1 before, 1.15 while held, back to 1 after
  const at = (t: number) => Function("t", "const {min,max}=Math;const clip=(x,a,b)=>min(max(x,a),b);const mod=(a,b)=>a%b;const gte=(a,b)=>a>=b?1:0;return " + z)(t);
  assert.equal(at(1), 1);
  assert.ok(Math.abs(at(4) - 1.08) < 1e-9);
  assert.ok(Math.abs(at(10.5) - 1.15) < 1e-9);
  assert.ok(at(9.85) > 1 && at(9.85) < 1.15, "eases in");
  assert.equal(at(12), 1);
});

test("planEdit: clean has jump cuts but no zoom; hype zooms on the remapped peak", () => {
  const words = talk([1, 6], [6, 6], [12, 6]);
  const clean = planEdit({ style: "clean", words, length: 20, minSec: 8, peak: 9 });
  assert.equal(clean.zoom, null);
  assert.equal(clean.punchStart, null);
  const hype = planEdit({ style: "hype", words, length: 20, minSec: 8, peak: 15 });
  assert.ok(hype.segs.length > 1);
  assert.ok(hype.duration < 20 && hype.duration >= 8);
  assert.equal(hype.peak, remapTime(15, hype.segs));
  assert.ok(hype.zoom && hype.punchStart != null);
  assert.equal(hype.words.length, words.length);
});

test("chunkWordsDetailed + buildStyledAss: active word highlight, pop-in, credit, hook, no words", () => {
  const words: Word[] = [{ word: "no", start: 0.5, end: 0.8 }, { word: "{way}", start: 0.8, end: 1.1 }, { word: "bro!", start: 1.1, end: 1.5 }, { word: "again", start: 2, end: 2.4 }];
  const chunks = chunkWordsDetailed(words);
  assert.deepEqual(chunks.map((c) => c.words.length), [3, 1]);
  const hype = buildStyledAss({ words, credit: "twitch.tv/test", duration: 20, layout: "blur", hook: "He did WHAT in GTA 6 right now", style: "hype" });
  assert.match(hype, /Credit,,0,0,0,,twitch\.tv\/test/);
  assert.match(hype, /\{\\1c&H0035E1FF&\}NO\{\\1c&H00FFFFFF&\} WAY BRO!/, "first word yellow");
  assert.match(hype, /NO \{\\1c&H0035E1FF&\}WAY\{\\1c&H00FFFFFF&\} BRO!/, "then the second, braces escaped");
  assert.match(hype, /\\fscx80\\fscy80\\t\(0,60,\\fscx105\\fscy105\)\\t\(60,120,\\fscx100\\fscy100\)/, "pop-in");
  assert.equal((hype.match(/\\fscx80\\fscy80/g) ?? []).length, 2, "one pop per chunk, not per word");
  assert.match(hype, new RegExp(`\\\\pos\\(540,${CAPTION_Y}\\)`));
  assert.match(hype, /Hook,,0,0,0,,\{\\an8\\pos\(540,250\).*\\fscx0\\fscy0.*\\frz2.*\}He did WHAT in GTA\\N6 right now|Hook,.*\\N/);
  assert.match(hype, /Dialogue: 2,0:00:00\.00,0:00:03\.30,Hook/);
  // word lines are back to back: no flicker between words
  assert.match(hype, /Dialogue: 1,0:00:00\.50,0:00:00\.80,Cap/);
  assert.match(hype, /Dialogue: 1,0:00:00\.80,0:00:01\.10,Cap/);

  const clean = buildStyledAss({ words, credit: "c", duration: 20, layout: "blur", style: "clean" });
  assert.match(clean, /\{\\fscx112\\fscy112\}no\{\\fscx100\\fscy100\} way bro!/, "clean: as spoken, active word slightly bigger");
  assert.doesNotMatch(clean, /\\1c&H00/);
  assert.doesNotMatch(clean, /Hook,,/);
  const meme = buildStyledAss({ words, credit: "c", duration: 20, layout: "facecam", hook: "lol", style: "meme" });
  assert.match(meme, /\\frz-?[123]/, "tilted");
  assert.match(meme, /\\1c&H0014FF39&/, "green");
  assert.match(meme, /\}LOL$/m);
  assert.match(meme, /pos\(540,190\)/, "hook higher in facecam layout");
  assert.match(meme, /Style: Cap,DejaVu Sans,100,/);

  const none = buildStyledAss({ words: [], credit: "twitch.tv/x", duration: 10, layout: "blur", style: "hype" });
  assert.doesNotMatch(none, /,Cap,/);
  assert.match(none, /Credit,,0,0,0,,twitch\.tv\/x/);
  assert.equal(splitHook("short one"), "short one");
  assert.equal(splitHook("He actually jumped the bridge in GTA 6"), "He actually jumped\\Nthe bridge in GTA 6");
});

test("buildStyledFilter: trim+concat in sync, zoom on the foreground only, credit/captions after zoom, bar, audio chain", () => {
  const segs = [{ start: 0, end: 3 }, { start: 6, end: 8 }];
  const f = buildStyledFilter({ style: "hype", facecam: null, src: { w: 1920, h: 1080 }, segs, hasAudio: true, assFile: "x.ass", zoom: "(1+0.08*mod(gte(t,3),2))", duration: 5, sfx: { whooshAt: 0, boomAt: 2.5 } });
  assert.match(f, /\[0:v\]fps=30,split=2\[sv0\]\[sv1\]/);
  assert.match(f, /\[sv1\]trim=start=6:end=8,setpts=PTS-STARTPTS\[v1\]/);
  assert.match(f, /\[sa1\]atrim=start=6:end=8,asetpts=PTS-STARTPTS\[a1\]/);
  assert.match(f, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[cv\]\[ca\]/);
  assert.match(f, /\[cb1\]scale=w='2\*trunc\(1080\*/, "zoomed foreground");
  assert.match(f, /crop=1080:608:x='/);
  assert.match(f, /boxblur=10:2,scale=1080:1920,eq=brightness=-0\.07\[bg\]/, "background never zooms");
  assert.match(f, /eq=saturation=1\.15:contrast=1\.06,unsharp/);
  assert.ok(f.indexOf("ass=x.ass") > f.indexOf("overlay=0:656"), "text drawn after the zoomed layer");
  assert.match(f, /color=c=0xff3d81:s=1080x8/);
  assert.match(f, /overlay=x='-1080\+1080\*t\/5':y=1912:shortest=1\[v\]/);
  assert.match(f, /loudnorm=I=-14:TP=-1\.5:LRA=11/);
  assert.match(f, /\[1:a\]adelay=delays=0:all=1,volume=0\.35\[fx0\]/);
  assert.match(f, /\[2:a\]adelay=delays=2500:all=1/);
  assert.match(f, /amix=inputs=3:duration=first/);

  const one = buildStyledFilter({ style: "clean", facecam: { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, src: { w: 1920, h: 1080 }, segs: [{ start: 0, end: 20 }], hasAudio: false, zoom: null, duration: 20 });
  assert.doesNotMatch(one, /concat|trim|\[0:a\]|loudnorm/);
  assert.match(one, /\[cb1\]scale=2276:1280,crop=1080:1280\[bot\]/);
  assert.match(one, /color=c=white@0\.6/);
  assert.deepEqual(fitSize(1920, 1080, 1080, 1920, "contain"), { w: 1080, h: 608 });
  assert.deepEqual(fitSize(1080, 1920, 1080, 1280, "cover"), { w: 1080, h: 1920 });
});

test("renderOrFallback: a failed styled render falls back to the plain one with a warning", async () => {
  let plain = 0;
  const ok = await renderOrFallback("hype", async () => 42, async () => { plain++; });
  assert.deepEqual(ok, { result: 42, note: null });
  const bad = await renderOrFallback("meme", async () => { throw new Error("libass exploded"); }, async () => { plain++; });
  assert.equal(bad.result, null);
  assert.match(bad.note!, /The meme edit failed, so the plain edit was used: libass exploded/);
  assert.equal(plain, 1);
  await assert.rejects(renderOrFallback("hype", async () => { throw new Error("a"); }, async () => { throw new Error("plain too"); }), /plain too/);
});

// ---------- Real ffmpeg ----------
async function makeSource() {
  const src = path.join(dir, "talk.mp4");
  if (fs.existsSync(src)) return src;
  // Speech at 1s, 6s and 12s (flite when available, else tones), loud burst at 9-11s, 20s total.
  const hasFlite = (await run("ffmpeg", ["-hide_banner", "-filters"])).stdout.includes(" flite ");
  const voice = (t: string) => hasFlite ? `flite=text='${t}':voice=slt` : "sine=frequency=300:duration=1.8";
  await run("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60:duration=20",
    "-f", "lavfi", "-i", voice("okay chat watch this one"), "-f", "lavfi", "-i", voice("no way did you see that"), "-f", "lavfi", "-i", voice("chat clip that right now"),
    "-filter_complex", "[1:a]aresample=48000,adelay=1000:all=1[x];[2:a]aresample=48000,adelay=6000:all=1[y];[3:a]aresample=48000,adelay=12000:all=1[z];" +
    "anoisesrc=d=2:a=1:r=48000,volume=4,adelay=9000:all=1[n];[x][y][z][n]amix=inputs=4:normalize=0:duration=longest,apad=whole_dur=20[a]",
    "-map", "0:v", "-map", "[a]", "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
  return src;
}
const fakeWords = talk([1, 6], [6, 6], [12, 6]);
const probe = async (f: string, what: string) => (await run("ffprobe", ["-v", "error", ...what.split(" "), "-of", "csv=p=0", f])).stdout.trim();

for (const style of ["hype", "clean", "meme"] as const) {
  test(`renderStyled ${style}: 1080x1920, jump-cut duration, audio present (real ffmpeg)`, { timeout: 240_000 }, async () => {
    process.env.STORAGE_DIR = path.join(dir, "storage");
    const src = await makeSource();
    const out = path.join(dir, `${style}.mp4`);
    const plan = await renderStyled({
      input: src, output: out, start: 0, length: 20, facecam: style === "meme" ? { x: 0.7, y: 0.05, w: 0.28, h: 0.3 } : null, style,
      words: fakeWords, credit: "twitch.tv/test", hook: "He jumped the bridge in GTA 6", minSec: 8, hasAudio: true,
      peakHint: { source: "twitch_clip", vodOffset: null }, workDir: path.join(dir, "work"), id: style,
    });
    assert.equal(await probe(out, "-select_streams v -show_entries stream=width,height"), "1080,1920");
    assert.equal(await probe(out, "-select_streams a -show_entries stream=codec_name"), "aac");
    assert.ok(plan.segs.length >= 2, "jump cuts happened");
    const d = await probeDuration(out);
    assert.ok(Math.abs(d - plan.duration) < 0.25, `duration ${d} vs planned ${plan.duration}`);
    assert.ok(plan.duration < 19 && plan.duration >= 8);
    assert.ok(plan.peak != null && Math.abs(plan.peak - remapTime(10, plan.segs)) < 1.1, `peak ${plan.peak} near the burst`);
    if (style !== "clean") assert.ok(fs.existsSync(path.join(dir, "storage", "sfx", "boom-v1.wav")), "sfx cached");
    assert.ok(!fs.existsSync(path.join(dir, "work", `${style}.styled.ass`)), "temp ASS removed");
    if (process.env.CF_TEST_OUT) fs.cpSync(out, path.join(process.env.CF_TEST_OUT, `${style}.mp4`));
  });
}

test("renderStyled with no audio and no words still renders (no captions, no cuts)", { timeout: 120_000 }, async () => {
  process.env.STORAGE_DIR = path.join(dir, "storage");
  const src = path.join(dir, "silent.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30:duration=6", "-c:v", "libx264", "-preset", "ultrafast", src]);
  const out = path.join(dir, "silent-out.mp4");
  const plan = await renderStyled({ input: src, output: out, start: 0, length: 6, facecam: null, style: "hype", words: [], credit: "youtube.com/@x", hook: null, minSec: 5, hasAudio: false, workDir: path.join(dir, "work"), id: "silent" });
  assert.equal(plan.segs.length, 1);
  assert.equal(await probe(out, "-select_streams v -show_entries stream=width,height"), "1080,1920");
  assert.equal(await probe(out, "-select_streams a -show_entries stream=index"), "");
  assert.ok(Math.abs((await probeDuration(out)) - 6) < 0.2);
});

test("db push upgrade from the v1.7.2 schema (0684afb) with rows: no prompt, rows kept, editStyle defaults to hype", () => {
  const SCHEMA = path.join(__dirname, "..", "prisma", "schema.prisma");
  const now = fs.readFileSync(SCHEMA, "utf8");
  const derived = now.replace(/^ {2}(winLength|editStyle|editNote)\s.*\n/gm, "");
  const git = spawnSync("git", ["show", "0684afb:clip-factory/prisma/schema.prisma"], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  if (git.status === 0) assert.equal(derived, git.stdout, "only the three v1.7.3 columns were added");
  const uniques = (s: string) => (s.match(/@unique|@@unique|@@id/g) ?? []).length;
  assert.equal(uniques(now), uniques(derived), "no new unique constraints");
  const up = path.join(dir, "upgrade");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "old.prisma"), derived);
  const env = { ...process.env, DATABASE_URL: `file:${path.join(up, "krew.db")}` };
  const push = (schema: string) => spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schema], { env, encoding: "utf8" });
  const first = push(path.join(up, "old.prisma"));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const sql = (q: string) => execFileSync(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(env.DATABASE_URL)} } } });
    p.$queryRawUnsafe(${JSON.stringify(q)}).then((r) => { console.log(JSON.stringify(r, (k, v) => typeof v === "bigint" ? Number(v) : v)); return p.$disconnect(); });
  `], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  sql(`INSERT INTO Streamer (id, twitchId, login, name, platform, approved, createdAt, updatedAt) VALUES ('a', '2', 'kai', 'Kai', 'twitch', 1, 0, 0)`);
  sql(`INSERT INTO Moment (id, streamerId, timestamp, source, createdAt) VALUES ('m1', 'a', 0, 'chat', 0)`);
  sql(`INSERT INTO Clip (id, momentId, status, duration, createdAt, updatedAt) VALUES ('c1', 'm1', 'pending', 45, 0, 0)`);
  sql(`INSERT INTO Settings (id, layout) VALUES ('main', 'facecam')`);
  const second = push(SCHEMA);
  const out = second.stdout + second.stderr;
  assert.equal(second.status, 0, out);
  assert.doesNotMatch(out, /data loss|accept-data-loss|unique constraint/i);
  assert.match(out, /in sync/);
  assert.deepEqual(JSON.parse(sql("SELECT id, status, duration, winLength, editStyle, editNote FROM Clip")), [{ id: "c1", status: "pending", duration: 45, winLength: null, editStyle: null, editNote: null }]);
  assert.deepEqual(JSON.parse(sql("SELECT layout, editStyle FROM Settings")), [{ layout: "facecam", editStyle: "hype" }]);
  assert.equal(push(SCHEMA).status, 0, "pushing again is a no-op");
});
