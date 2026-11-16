# Clip Factory — notes for Claude sessions

Krew's GTA 6 clip pipeline (part of Project Patrick). Krew hates repeating themself: the full
original brief is below, and the status section says what's done. Read both before changing anything.

## Status (2026-11-16)
- **Built:** Phase 1 (Scout, Clips poller, Grabber, Cutter, dashboard), Phase 2 (spike detector, Judge,
  YouTube upload), Phase 3 (TikTok drafts, multiple accounts, Analytics, Judge learns from results).
- **Launch hardening in progress:** see `PLAN.md` (step-by-step, each with its test).
- Tests: `npm test` (unit, real ffmpeg renders, workers against Redis, Judge/YouTube/TikTok against the
  stand-in servers in `test/mocks.ts`). `npx tsx test/mocks.ts 4010` prints env vars to run the app on stand-ins.
- **Never run against the real services** (no keys in the build sandbox): Twitch Helix/chat/yt-dlp, the real
  Claude API, YouTube, TikTok, the Docker build, Whisper on real speech. `npm run doctor` (PLAN step 6) is
  Krew's one-command check of all of these on his machine; run it before Thursday.

## Launch-day load (why the limits below exist)
- **Throughput:** one cut ≈ 30–40s CPU + Whisper ≈ 10–20s → about **1 clip/min**. Inputs must be capped to
  match: the line stops taking new moments when ≥ `MAX_BACKLOG` (12) clips are in progress.
- **Disk:** a 60s 1080p60 Twitch clip is 30–60 MB raw + ~10 MB final. Uncapped that's ~25 GB/hour.
  Retention: raw deleted 12h after its clip is cut; finals of rejected/failed clips after 24h; finals of
  posted clips after 7 days. Grabber pauses below `MIN_FREE_GB` (5) free and the Live page warns.
- **Twitch Helix:** 800 points/min per app token. Retry 429s after `Ratelimit-Reset`. `/streams?game_id` only
  returns the top 500 (5 pages); approved streamers are also looked up by `user_id` so a small approved
  streamer is never missed.
- **Twitch chat (anonymous):** max 20 JOINs per 10s → join in batches of ≤15 every 10s.
- **SQLite:** web + worker write at once → WAL mode + busy timeout, batched chat-heat writes.
- **yt-dlp** breaks when Twitch changes things: `docker compose build --pull --no-cache worker` on launch
  morning gets the newest. Spike clips cut from an in-progress VOD are the least proven path.

## Chat spike detector (design; code in `src/lib/chat.ts`, `src/workers/spike.ts`)
Runs every 5s per approved live streamer whose chat we read (anonymous IRC with `twitch.tv/tags twitch.tv/commands`).

**Counting (what goes into a 1-second bucket):**
- Drop bots: known bot names (nightbot, streamelements, streamlabs, moobot, fossabot, wizebot, sery_bot,
  soundalerts, botrixoficial, kofistreambot, own streamer's account) and any message starting with `!`.
- Cap each chatter at **2 messages per 10s window** (stops one spammer or copy-paste flood from counting).
- Track distinct chatters per bucket and hype messages (`LMAO`, `KEKW`, `OMEGALUL`, `LUL`, `Pog*`,
  `clip it/that`, `no way`, a lone `W`).

**Formula (all rates in counted messages/sec):**
- `W` = counted messages in the last 10s ÷ 10.
- `B` = **median** of the counted rate across the previous 10s windows in the last 5 min (needs ≥ 12
  windows = 2 min of listening). Median, not mean, so an earlier spike doesn't raise the bar.
- `S = W / max(B, 0.3)` (0.3 msg/s floor so a near-silent chat can't spike on a handful of messages).
- **Volume spike:** `S ≥ k` (Settings → Spike sensitivity, default 3) **and** ≥ 6 distinct chatters in the window.
- **Hype spike:** ≥ 50% of counted messages are hype **and** ≥ 6 hype messages from ≥ 4 distinct chatters
  **and** `S ≥ max(1.5, k/2)`.

**Muting (no spikes while chat is reacting to something that isn't gameplay):**
- **Raid** (`USERNOTICE msg-id=raid`): mute 120s; raider messages also don't enter the baseline.
- **Sub train / gift bomb:** ≥ 3 sub/resub/subgift notices in 30s, or one `submysterygift` with
  `msg-param-mass-gift-count ≥ 5` → mute 60s.
- **Warm-up:** no spikes in the first 2 min after joining a channel.
- **Cooldown:** one moment per streamer per 3 min.
- **Reaction lag:** the moment is placed 12s before detection; grab waits 150s for the live VOD to catch up.

## Rules that must not break
- The Grabber only pulls from `Streamer.approved = true`. Approving needs a written reason.
- Nothing posts without Krew pressing Approve. The Poster refuses clips that aren't approved; "auto-upload"
  only means the Approve click also uploads. Uploads are single-attempt so a retry can't double-post.
- Every caption credits the streamer (name + twitch.tv link); the credit is also burned into the video.
- Secrets live in `.env` (gitignored). Never commit it.

## Gotchas found while building
- Tailwind 4: custom classes in `app/globals.css` must be `@utility`, not plain classes.
- ioredis must match BullMQ's bundled version (5.11.1) or TypeScript breaks.
- faster-whisper's own audio loader breaks on newer PyAV; `scripts/transcribe.py` reads the WAV itself.
- YouTube (checked 2026-11-16): API uploads are no longer forced private; 100 uploads/day per project.
- The dashboard has no login. Fine on localhost; add a passcode before hosting it anywhere public.
- DB stores media paths relative to `STORAGE_DIR` so web + worker containers agree.

---

## Original brief (from Krew)

**What we're building:** a web app + agent pipeline that finds hype moments from Twitch streamers
playing GTA 6, cuts them into vertical short-form clips, and queues them for TikTok / YouTube Shorts / Reels.
GTA 6 launches Thursday Nov 19, 2026 (PS5 / Xbox). Phase 1 MUST work by launch day. Ship simple first, polish later.

**Ground rules:** approved streamers only (opted in, paid clipping campaign, or publicly allows clippers;
the scout can discover anyone, the grabber only pulls approved) · human approval in the dashboard before
anything posts · always credit the streamer (name + channel link) in the caption · secrets in `.env`.

**Production line:**
1. Scout — every 2 min, Helix `GET /streams?game_id=<GTA VI>`; track viewers; join chat (anonymous, read-only) for approved live streamers.
2. Spike detector — flag when chat msgs/sec ≥ 3× the 5-min rolling average, or hype words/emotes flood (LMAO, KEKW, OMEGALUL, "clip it", "W", "no way"). Also poll `GET /clips?game_id=...&started_at=...`.
3. Grabber — prefer an existing Twitch clip; else ~45s around the timestamp from the VOD via `yt-dlp --download-sections`. Save to `/storage/raw`.
4. Cutter — ffmpeg: 15–45s, 9:16 (blurred fill or center crop + facecam on top), burned captions (faster-whisper or OpenAI Whisper API).
5. Judge — transcript + chat stats → Claude (`claude-sonnet-5-5`) → `{score 1-10, hook_text, title, hashtags, reason}`; auto-reject < 6.
6. Poster — after approval: YouTube Data API v3 upload (Shorts). TikTok needs app review, so Phase 1 = Download + Copy caption.

**Dashboard:** Live (who's live, viewers, approved, chat-heat) · Queue (preview, score, editable title/caption, Approve/Reject/Download) · Posted (where, views) · Streamers (add/remove + why) · Settings (spike sensitivity, min score, clip length). Dark, clean, fast, big previews.

**Stack:** Next.js App Router + Tailwind · Node workers, BullMQ + Redis (one queue per stage) · SQLite via Prisma (Postgres later) · ffmpeg, yt-dlp, faster-whisper · `docker compose up`.

**Phases:** 1 (before Nov 19): Scout + Clips polling + Grabber + Cutter + Queue with Download. 2 (launch week): spike detector, Judge, YouTube upload. 3: TikTok API, performance analytics → Judge prompt, multi-account.

**Done for Phase 1:** open the dashboard, see GTA 6 streamers live, and within a few minutes see vertical captioned clips from approved streamers in the Queue to download and post.
