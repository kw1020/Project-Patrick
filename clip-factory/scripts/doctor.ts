// `npm run doctor` — Krew's one-command check before launch. Tries every outside piece the pipeline
// needs (keys, ffmpeg, yt-dlp, Whisper, Redis, the database, Twitch, the Judge, connected accounts)
// and prints one line each: ✅ fine, ⚠️ works but worth a look, ❌ broken (with a plain-English fix).
// `npm run doctor -- --no-download` skips the slow download + render test.
import fs from "node:fs";
import path from "node:path";

type Status = "ok" | "warn" | "fail";
type Result = { status: Status; detail: string; fix?: string };
const ICON: Record<Status, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

/** Parse a .env file: KEY=value lines, # comments, optional quotes, trailing " # comment" on unquoted values. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    const q = v.match(/^(["'])(.*)\1\s*(#.*)?$/);
    if (q) v = q[2];
    else v = v.replace(/(^|\s+)#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

/** Load .env into process.env without overriding anything already set. Returns whether the file exists. */
export function loadEnv(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  for (const [k, v] of Object.entries(parseEnvFile(fs.readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined && v !== "") process.env[k] = v;
  }
  return true;
}

/** yt-dlp versions are dates (2026.11.03, 2026.11.03.1, nightly 2026.11.03.232215). Age in whole days, or null. */
export function ytDlpAgeDays(version: string, now = new Date()): number | null {
  const m = version.trim().match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - released) / 86_400_000);
}

const oneLine = (s: string, max = 220) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer after ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const counts: Record<Status, number> = { ok: 0, warn: 0, fail: 0 };

function print(name: string, r: Result) {
  counts[r.status]++;
  console.log(`${ICON[r.status]} ${name} — ${r.detail}`);
  if (r.status !== "ok" && r.fix) console.log(`     fix: ${r.fix}`);
}

/** Run one check with its own timeout; an error becomes a ❌ line instead of stopping the rest. */
async function check(name: string, ms: number, fn: () => Promise<Result> | Result, failFix: string | ((msg: string) => string)) {
  let r: Result;
  try {
    r = await withTimeout(Promise.resolve().then(fn), ms);
  } catch (e) {
    let raw = (e as Error).message || String(e);
    // Prisma errors start with a code excerpt; the reason is an "error: …" line, or else the last line.
    if (raw.trimStart().startsWith("Invalid `prisma")) {
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      raw = lines.find((l) => /^error:/i.test(l))?.replace(/^error:\s*/i, "") ?? lines.pop() ?? raw;
    }
    const msg = oneLine(raw);
    r = { status: "fail", detail: msg, fix: typeof failFix === "function" ? failFix(msg) : failFix };
  }
  print(name, r);
  return r;
}

const section = (t: string) => console.log(`\n${t}`);

async function main() {
  const noDownload = process.argv.includes("--no-download");
  const envFound = loadEnv(path.resolve(".env"));

  // Imported after .env is loaded: some modules read env vars when they load.
  const { run, probeDuration, pickWindow, buildAss, renderVertical } = await import("../src/lib/media");
  const { prisma, getSettings } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/queues");
  const { storagePath } = await import("../src/lib/paths");
  const { twitchConfigured, getGameId, getLiveStreams, getClips } = await import("../src/lib/twitch");
  const { judgeConfigured, judgeClip, JUDGE_MODEL } = await import("../src/lib/judge");
  const yt = await import("../src/lib/youtube");
  const tt = await import("../src/lib/tiktok");

  console.log("Clip Factory doctor — checking everything the pipeline needs.\n");

  // ---------- 1. Keys ----------
  section("Keys (.env)");
  print(".env file", envFound
    ? { status: "ok", detail: `found at ${path.resolve(".env")}` }
    : { status: "warn", detail: "no .env file here (using only what's already set in the environment)", fix: "Copy .env.example to .env in the clip-factory folder and fill in the keys." });
  print("Twitch keys", twitchConfigured()
    ? { status: "ok", detail: "TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set" }
    : { status: "fail", detail: "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing — nothing can be found or downloaded",
        fix: "Make an app at dev.twitch.tv/console/apps, then paste its Client ID and a New Secret into .env." });
  print("Claude key (Judge)", judgeConfigured()
    ? { status: "ok", detail: "ANTHROPIC_API_KEY is set" }
    : { status: "warn", detail: "ANTHROPIC_API_KEY missing — clips will go to review unscored",
        fix: "Get a key at console.anthropic.com (API keys) and put it in .env as ANTHROPIC_API_KEY." });
  print("YouTube keys", yt.youtubeConfigured()
    ? { status: "ok", detail: "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are set" }
    : { status: "warn", detail: "not set — YouTube upload is off (optional)", fix: "Only needed to post to YouTube: follow the YouTube steps in README.md." });
  print("TikTok keys", tt.tiktokConfigured()
    ? { status: "ok", detail: "TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are set" }
    : { status: "warn", detail: "not set — TikTok drafts are off (optional)", fix: "Only needed to send TikTok drafts: follow the TikTok steps in README.md." });

  // ---------- 2. Tools ----------
  section("Tools");
  await check("ffmpeg", 30_000, async () => {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-version"]);
    await run("ffprobe", ["-hide_banner", "-version"]);
    return { status: "ok", detail: oneLine(stdout.split("\n")[0], 80) };
  }, "Install ffmpeg (Mac: `brew install ffmpeg`, Windows: `winget install ffmpeg`), then open a new terminal.");

  const ytdlp = process.env.YTDLP || "yt-dlp";
  await check("yt-dlp", 30_000, async () => {
    const { stdout } = await run(ytdlp, ["--version"]);
    const v = stdout.trim();
    const age = ytDlpAgeDays(v);
    if (age === null) return { status: "warn", detail: `version ${v} (couldn't tell how old it is)`, fix: "Update it to be safe: `yt-dlp -U` (or `pip install -U yt-dlp`)." };
    if (age > 14) return { status: "warn", detail: `version ${v} is ${age} days old — Twitch changes often break old versions`,
      fix: "Update it: `yt-dlp -U` (or `pip install -U yt-dlp`; with Docker: `docker compose build --pull --no-cache worker`)." };
    return { status: "ok", detail: `version ${v} (${age} day${age === 1 ? "" : "s"} old)` };
  }, "Install yt-dlp (`pip install -U yt-dlp`, Mac: `brew install yt-dlp`), then open a new terminal.");

  await check("Captions (Whisper)", 60_000, async () => {
    const engine = (process.env.WHISPER_ENGINE || "local").toLowerCase();
    if (engine === "off") return { status: "warn", detail: "WHISPER_ENGINE=off — clips get no captions", fix: "Set WHISPER_ENGINE=local in .env to burn in captions." };
    if (engine === "openai") return process.env.OPENAI_API_KEY
      ? { status: "ok", detail: "using the OpenAI Whisper API (OPENAI_API_KEY is set)" }
      : { status: "warn", detail: "WHISPER_ENGINE=openai but OPENAI_API_KEY is empty — no captions", fix: "Add OPENAI_API_KEY to .env, or set WHISPER_ENGINE=local." };
    const py = process.env.PYTHON || "python3";
    try {
      const { stdout } = await run(py, ["-c", "import faster_whisper; print(faster_whisper.__version__)"], { timeoutMs: 50_000 });
      return { status: "ok", detail: `faster-whisper ${stdout.trim()} (local)` };
    } catch (e) {
      return { status: "warn", detail: `faster-whisper won't load with ${py} — clips get no captions (${oneLine((e as Error).message, 100)})`,
        fix: `Run \`${py} -m pip install faster-whisper\`, or set WHISPER_ENGINE=openai with an OPENAI_API_KEY.` };
    }
  }, "Run `python3 -m pip install faster-whisper`.");

  // ---------- 3. Redis + database ----------
  section("Redis + database");
  const r = redis();
  r.on("error", () => {}); // a down Redis is reported by the check below, not as a stack trace
  await check("Redis", 10_000, async () => {
    const pong = await r.ping();
    return { status: "ok", detail: `${pong} from ${process.env.REDIS_URL || "redis://localhost:6379"}` };
  }, "Start Redis (`docker compose up -d redis`, or `redis-server`) and check REDIS_URL in .env.");

  await check("Database", 30_000, async () => {
    const s = await getSettings();
    return { status: "ok", detail: `settings row OK (Judge cut-off ${s.minScore}, clips ${s.clipMinSec}-${s.clipMaxSec}s, ${s.gameMode === "gta6" ? "GTA 6 only" : "any game"}, standout clips ${s.standoutMin}x the creator's usual, max ${s.maxPerCreatorPerRun} per creator per scan, jump cuts ${s.jumpCuts})` };
  }, "Run `npm run db:push` in the clip-factory folder to create the database, and check DATABASE_URL in .env.");

  // ---------- 4. Twitch ----------
  section("Twitch");
  let gameId: string | null = null;
  if (!twitchConfigured()) {
    print("Twitch", { status: "warn", detail: "skipped — the Twitch keys are missing", fix: "Add the Twitch keys first (see the Keys section above)." });
  } else {
    const r1 = await check("Twitch login + GTA 6 category", 30_000, async () => {
      gameId = await getGameId();
      return { status: "ok", detail: `token OK, GTA 6 category id ${gameId}` };
    }, (msg) => /token request failed|unauthorized|401|403/i.test(msg)
      ? "Twitch rejected the keys: re-copy the Client ID and click New Secret at dev.twitch.tv/console/apps, then update .env."
      : /GTA 6 category/i.test(msg)
        ? "Find the GTA 6 category id on Twitch and set TWITCH_GAME_ID in .env."
        : "Check the internet connection and the Twitch keys in .env.");
    if (r1.status === "ok" && gameId) {
      const gid: string = gameId;
      await check("Live GTA 6 streams", 30_000, async () => {
        const streams = await getLiveStreams(gid);
        if (!streams.length) return { status: "warn", detail: "0 live right now", fix: "Normal before launch day; run the doctor again once GTA 6 is out." };
        const top = [...streams].sort((a, b) => b.viewer_count - a.viewer_count)[0];
        return { status: "ok", detail: `${streams.length >= 500 ? "500+" : streams.length} live (biggest: ${top.user_name}, ${top.viewer_count.toLocaleString("en-US")} viewers)` };
      }, "Check the internet connection; if it keeps failing, Twitch may be having problems (status.twitch.com).");
    }
  }
  await check("Approved streamers", 30_000, async () => {
    const n = await prisma.streamer.count({ where: { approved: true } });
    return n > 0
      ? { status: "ok", detail: `${n} approved streamer${n === 1 ? "" : "s"}` }
      : { status: "warn", detail: "0 approved — nothing will be clipped", fix: "Open the dashboard and approve some on the Streamers page." };
  }, "Fix the Database line above first.");

  // ---------- 4b. YouTube suggestions (API key) ----------
  section("YouTube suggestions");
  const yts = await import("../src/workers/suggest-youtube");
  if (!yts.youtubeKeyConfigured()) {
    print("YouTube API key", { status: "warn", detail: "YOUTUBE_API_KEY missing — the Streamers page shows Twitch suggestions only",
      fix: "Free key: console.cloud.google.com → APIs & Services → Library → YouTube Data API v3 → Enable → Credentials → Create credentials → API key; put it in .env as YOUTUBE_API_KEY= and restart." });
  } else {
    await check("YouTube API key", 30_000, async () => {
      let region = "US";
      try { region = (await getSettings()).ytSuggestRegion || "US"; } catch { /* the Database line says why */ }
      const j = await yts.ytApi<{ items?: { snippet?: { title?: string } }[] }>("/videos", { part: "snippet", chart: "mostPopular", regionCode: region, maxResults: "1" });
      const top = j.items?.[0]?.snippet?.title;
      return { status: "ok", detail: `key works (trending #1 in ${region}: "${oneLine(top ?? "—", 60)}")` };
    }, (msg) => /quota/i.test(msg)
      ? "Today's free quota is used up; it resets at midnight Pacific. Run the doctor again tomorrow."
      : "Check YOUTUBE_API_KEY in .env, and that YouTube Data API v3 is enabled for its Google project.");
  }

  // ---------- 5. Download + render ----------
  section("Download + render");
  if (noDownload) {
    print("Download + render", { status: "warn", detail: "skipped (--no-download)", fix: "Run `npm run doctor` without --no-download to test a real download and render." });
  } else if (!gameId) {
    print("Download + render", { status: "warn", detail: "skipped — needs the Twitch checks above to pass", fix: "Fix the Twitch lines above, then run the doctor again." });
  } else {
    const gid: string = gameId;
    const dir = storagePath("doctor");
    let source: { file: string; credit: string } | null = null;
    await check("Download top GTA 6 clip", 3 * 60_000, async () => {
      const clips = await getClips({ game_id: gid, started_at: new Date(Date.now() - 24 * 3600_000).toISOString() }, 1);
      if (!clips.length) return { status: "warn", detail: "no GTA 6 clips on Twitch in the last 24h to test with", fix: "Normal before launch day; run the doctor again once people are clipping GTA 6." };
      const top = [...clips].sort((a, b) => b.view_count - a.view_count)[0];
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (f.startsWith("source.")) fs.rmSync(path.join(dir, f), { force: true });
      const { stdout } = await run(ytdlp, ["-f", "best[ext=mp4]/best", "--no-playlist", "--no-part", "--no-progress", "--quiet", "--merge-output-format", "mp4",
        "-o", path.join(dir, "source.%(ext)s"), "--print", "after_move:filepath", top.url], { timeoutMs: 3 * 60_000 - 5_000 });
      const file = stdout.trim().split("\n").filter(Boolean).pop();
      if (!file || !fs.existsSync(file)) throw new Error("yt-dlp finished but no file was written");
      source = { file, credit: `twitch.tv/${top.broadcaster_name.toLowerCase()}` };
      const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
      return { status: "ok", detail: `"${oneLine(top.title, 60)}" by ${top.broadcaster_name} (${top.view_count.toLocaleString("en-US")} views), ${mb} MB` };
    }, "Update yt-dlp (`yt-dlp -U`) and try again; Twitch changes often break old versions.");

    if (source) {
      const src: { file: string; credit: string } = source;
      await check("Render vertical", 3 * 60_000, async () => {
        const win = pickWindow(await probeDuration(src.file), 15, 45);
        const assPath = path.join(dir, "credit.ass");
        fs.writeFileSync(assPath, buildAss({ words: [], credit: src.credit, duration: win.length, layout: "blur" }));
        const out = path.join(dir, "vertical.mp4");
        await renderVertical({ input: src.file, output: out, start: win.start, length: win.length, facecam: null, assPath });
        return { status: "ok", detail: `${win.length}s 1080x1920 clip written to ${out} — open it and check it looks right` };
      }, "Check ffmpeg works (see the Tools section); if it does, send this error to Claude.");
    }
  }

  // ---------- 6. Judge ----------
  section("Judge (Claude)");
  if (!judgeConfigured()) {
    print("Judge", { status: "warn", detail: "skipped — no ANTHROPIC_API_KEY, clips go to review unscored (boring ones aren't filtered out)", fix: "Add ANTHROPIC_API_KEY to .env to have Claude score clips and pick the best part of each." });
  } else {
    await check("Judge", 60_000, async () => {
      const v = await judgeClip({
        streamer: "doctor_test", durationSec: 30, source: "twitch_clip", sourceTitle: "he actually made the bridge jump",
        sourceViews: 1200, transcript: "no way no way he made that jump, chat did you see that", minScore: 6,
      });
      if (!v) return { status: "warn", detail: `${JUDGE_MODEL} answered but returned no usable score`, fix: "Run the doctor again; if it repeats, send this to Claude." };
      return { status: "ok", detail: `${JUDGE_MODEL} scored the test clip ${v.score}/10 ("${oneLine(v.hook_text, 50)}")` };
    }, (msg) => /401|authentication|api key/i.test(msg)
      ? "Claude rejected the key: make a new one at console.anthropic.com and update ANTHROPIC_API_KEY in .env."
      : /credit|billing|402/i.test(msg)
        ? "Add credit to the Anthropic account at console.anthropic.com (Billing)."
        : /model/i.test(msg)
          ? "Remove JUDGE_MODEL from .env (or set it to a model your account can use)."
          : "Check the internet connection and ANTHROPIC_API_KEY in .env.");
  }

  // ---------- 7. Accounts ----------
  section("Connected accounts");
  let accounts: Awaited<ReturnType<typeof prisma.account.findMany>> = [];
  try { accounts = await withTimeout(prisma.account.findMany({ orderBy: { createdAt: "asc" } }), 30_000); } catch { /* the Database line already says why */ }
  if (!accounts.length) {
    print("Accounts", { status: "warn", detail: "no YouTube or TikTok accounts connected", fix: "Optional: connect them on the Settings page so approved clips can be posted." });
  }
  for (const a of accounts) {
    const label = `${a.platform === "youtube" ? "YouTube" : a.platform === "tiktok" ? "TikTok" : a.platform}: ${a.channelTitle ?? a.channelId ?? a.id}`;
    await check(label, 30_000, async () => {
      if (a.platform === "youtube") {
        if (!yt.youtubeConfigured()) return { status: "fail", detail: "YouTube keys missing in .env, so this channel can't post", fix: "Put YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET back in .env." };
        await yt.checkAccount(a);
      } else if (a.platform === "tiktok") {
        if (!tt.tiktokConfigured()) return { status: "fail", detail: "TikTok keys missing in .env, so this account can't get drafts", fix: "Put TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET back in .env." };
        await tt.checkAccount(a);
      } else {
        return { status: "warn", detail: `unknown platform "${a.platform}"`, fix: "Remove it on the Settings page." };
      }
      return { status: "ok", detail: "sign-in refreshed, ready to post" };
    }, "Reconnect this account on the Settings page.");
  }

  // ---------- Summary ----------
  console.log(`\n${counts.ok} OK, ${counts.warn} to look at, ${counts.fail} broken.`);
  console.log(counts.fail ? "Fix the ❌ lines above, then run `npm run doctor` again." : "Ready to go. ⚠️ lines are worth a look but won't stop the pipeline.");

  await prisma.$disconnect().catch(() => {});
  r.disconnect();
  return counts.fail ? 1 : 0;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/doctor.ts")) {
  main().then((code) => process.exit(code), (e) => { console.error("❌ doctor crashed:", e); process.exit(1); });
}
