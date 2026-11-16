# Clip Factory — notes for Claude sessions

Krew's GTA 6 clip pipeline (part of Project Patrick). Krew hates repeating themself: the full
original brief is below, and the status section says what's done. Read both before changing anything.

## Status (2026-11-16)
- **Phase 1 built:** Scout, Twitch Clips poller, Grabber, Cutter, full dashboard (Live / Queue / Posted /
  Streamers / Settings), docker compose. Tests: `npm test` (unit + real ffmpeg renders).
- Chat heat is tracked (msgs/sec, 5-min avg, hype-word rate in `src/lib/chat.ts`), but nothing flags spikes yet.
- **Next = Phase 2:** spike detector (read `ChatHeat.stats()`, create `Moment{source:"chat"}` with
  `vodId`/`vodOffset` from the live stream's VOD; the Grabber already handles VOD sections), Judge
  (`claude-sonnet-5-5`, JSON `{score, hook_text, title, hashtags, reason}`, auto-reject below
  `Settings.minScore`; `Clip.score` exists), YouTube Data API upload after approval.
- Not verified yet: a real Twitch run (needs Krew's Twitch keys). The Grabber's yt-dlp call and the
  Helix calls are written against the documented APIs but haven't hit live data.

## Rules that must not break
- The Grabber only pulls from `Streamer.approved = true`. Approving needs a written reason.
- Nothing posts without Krew pressing Approve. No auto-posting.
- Every caption credits the streamer (name + twitch.tv link); the credit is also burned into the video.
- Secrets live in `.env` (gitignored). Never commit it.

## Gotchas found while building
- Tailwind 4: custom classes in `app/globals.css` must be `@utility`, not plain classes.
- ioredis must match BullMQ's bundled version (5.11.1) or TypeScript breaks.
- faster-whisper's own audio loader breaks on newer PyAV; `scripts/transcribe.py` reads the WAV itself.
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
