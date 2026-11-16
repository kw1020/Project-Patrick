# Launch plan — Clip Factory (GTA 6 launches Thu 2026-11-19)

Phases 1–3 are built. This plan hardens the build for launch-day load. Each step: what, files, test.
Run every test with Redis up (`redis-server --daemonize yes`). A step is done only when its test AND the
full `npm test` pass and `npx tsc --noEmit` is clean.

- [ ] **1. Spike detector v2 (false-spike guards)** — implement the design in `CLAUDE.md` → "Chat spike
  detector": IRC tags/commands caps, USERNOTICE raid/sub parsing + mutes, bot + `!command` filter, per-user cap,
  distinct chatters, median baseline, throttled JOINs (≤15 per 10s).
  Files: `src/lib/chat.ts`, `src/workers/spike.ts`. Test: `test/spike.test.ts` — steady chat → no spike; 3x
  real chatters → volume spike; one user spamming 50 msgs → none; bot/`!` commands flood → none; raid notice
  then flood → none for 120s, spike possible after; gift bomb → muted 60s; hype flood → hype spike; JOIN of 40
  channels is sent in batches ≤15 spaced ≥10s (fake timers / injected clock + fake socket).
- [ ] **2. Judge prompt from file** — `src/lib/judge.ts` reads the SYSTEM block of `prompts/judge.md` (between
  `## SYSTEM` and `## END SYSTEM`) once at load; Dockerfile already copies the repo. Test: unit test that the
  loaded prompt equals the file block and the existing judge tests still pass.
- [ ] **3. Twitch robustness** — `helix()` retries 429 after `Ratelimit-Reset` (max 2 retries, max wait 60s)
  and 5xx once; Scout also fetches `/streams?user_id=` for all approved streamers (100 ids per call) so they are
  tracked even outside the top 500. Files: `src/lib/twitch.ts`, `src/workers/scout.ts`. Test: `test/twitch.test.ts`
  with a stubbed `fetch`: 429 then 200 succeeds and waits; approved streamer missing from game pages is still
  marked live; non-GTA streams from the user_id lookup are ignored.
- [ ] **4. Backlog + disk guards** — `MAX_BACKLOG` (env, default 12): clips poller and spike detector add
  nothing new while ≥ that many clips are `processing` (poller still adds the highest-view clips first when
  there's room). `MIN_FREE_GB` (env, default 5): grabber delays (re-queues with 5 min delay, no failure) when free
  space on STORAGE_DIR is below it; status `disk` shown on the Live page. Hourly retention job per CLAUDE.md
  (clears DB paths it deletes; dashboard shows "video expired" instead of a broken player).
  Files: `src/workers/clips.ts`, `src/workers/spike.ts`, `src/workers/grabber.ts`, new `src/workers/retention.ts`,
  `src/workers/index.ts`, `app/page.tsx`, `src/components/ClipCard.tsx`. Test: `test/guards.test.ts` — backlog
  full → poller adds 0; retention deletes the right files only (old raw yes, fresh raw no, rejected final >24h
  yes, pending final no); low-disk path re-queues instead of failing (inject the free-space function).
- [ ] **5. SQLite under load** — WAL + `busy_timeout=5000` set at startup in worker and web (shared helper in
  `src/lib/db.ts`); chat-heat flush done in one transaction; `CUT_CONCURRENCY` env (default 1).
  Test: `test/db-load.test.ts` — 2 processes (or 2 Prisma clients) doing 300 interleaved writes each finish
  with no "database is locked".
- [ ] **6. `npm run doctor`** — one command Krew runs on his machine before launch: env keys present; ffmpeg,
  yt-dlp (prints version, warns if > 14 days old), faster-whisper import; Redis; DB; Twitch token + GTA 6 game id
  + live stream count; downloads the top GTA 6 Twitch clip and renders it vertical into `storage/doctor/`;
  one Judge call (if key); refresh each connected YouTube/TikTok account's token. Prints ✅/⚠️/❌ with a fix
  hint per line, exit code 1 if any ❌. Files: `scripts/doctor.ts`, `package.json`, Twitch stand-ins in
  `test/mocks.ts`. Test: doctor run against the stand-ins passes all non-network checks and reports the
  Twitch checks as ✅ (mock Helix), with download/render step skipped via `--no-download` flag.

## After the steps (manager)
- Launch check: review against CLAUDE.md under load; fix top issues; README "Launch day" section.
