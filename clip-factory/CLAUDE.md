# Clip Factory — notes for Claude sessions

Krew's GTA 6 clip pipeline (part of Project Patrick). Krew hates repeating themself: the full
original brief is below, and the status section says what's done. Read both before changing anything.

## Status (2026-11-16)
- **Phase 1 built:** Scout, Twitch Clips poller, Grabber, Cutter, dashboard (Live / Queue / Posted /
  Streamers / Settings), docker compose.
- **Phase 2 built:** spike detector (`src/workers/spike.ts`, logic in `ChatHeat.spike()`), Judge
  (`src/lib/judge.ts`, `claude-sonnet-5-5` via `client.beta.messages.parse` + zod, refusal fallbacks on),
  YouTube connect/upload/views (`src/lib/youtube.ts`, `src/workers/poster.ts`).
  Line order is now grab → transcribe → judge → cut, so the Judge's hook is burned into the video and
  auto-rejected clips render last (low queue priority).
- Tests: `npm test` (17: unit, real ffmpeg renders, spike worker against Redis, Judge + YouTube against
  the stand-in servers in `test/mocks.ts`). `npx tsx test/mocks.ts 4010` prints env vars to run the whole
  app against the stand-ins.
- **Not verified against the real services yet** (no keys in the build sandbox): Twitch (Helix, chat,
  yt-dlp clip + live-VOD section downloads), the real Claude API, the real YouTube API, a Docker build,
  Whisper on real speech. First real run should check those in that order.
- Spike timing constants to tune on real streams (`src/workers/spike.ts`): 12s reaction lag, 150s wait
  for the live VOD, 180s cooldown per streamer.
- **Next = Phase 3:** TikTok Content Posting API, analytics on which clips perform → Judge prompt,
  multi-account (`Account` table is ready for more rows).

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
