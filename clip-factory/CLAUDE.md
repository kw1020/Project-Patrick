# Clip Factory — notes for Claude sessions

Krew's GTA 6 clip pipeline (part of Project Patrick). Krew hates repeating themself: the full
original brief is below, and the status section says what's done. Read both before changing anything.

## Status (2026-11-16)
- **Built:** Phase 1 (Scout, Clips poller, Grabber, Cutter, dashboard), Phase 2 (spike detector, Judge,
  YouTube upload), Phase 3 (TikTok drafts, multiple accounts, Analytics, Judge learns from results).
- **Launch hardening done (2026-11-16):** all 6 `PLAN.md` steps (spike detector v2, Judge prompt file,
  Twitch 429/approved lookup, backlog + disk + retention, SQLite WAL, `npm run doctor`) plus launch-check
  fixes: stuck-clip sweeper (`sweepStuck` in `src/workers/retention.ts`, every 5 min) and a worker crash guard.
- **Any-game mode (2026-11-17):** Settings `gameMode` gta6|any (default "any" since v1.8.0). In "any", approved Twitch streamers are tracked
  live (Streamer.gameName) and their clips taken in every game (Moment.gameName, names via Helix `/games?id=`, cached);
  GTA-wide discovery unchanged. Text helpers in `src/lib/social.ts` (`momentGame`, `gameHashtags`) are game-aware.
- **YouTube scanner (2026-11-17):** approved YouTube channels are `Streamer` rows with `platform: "youtube"`,
  `twitchId: "yt:<channelId>"`, `login` = @handle (may equal a Twitch row's login since v1.7.1). `src/workers/youtube.ts` (queue "youtube", every 30 min) reads
  yt-dlp's `heatmap` (`src/lib/ytdlp.ts`, `pickPeaks`) → Moments with source "youtube"; seen videos in `YouTubeVideo`.
  Twitch code paths filter `platform: "twitch"`. All credit links come from `creatorUrl`/`creatorCreditText` in
  `src/lib/social.ts`. Sandbox smoke test: flat channel listing worked for real; per-video `-J` hit YouTube's bot check,
  so the `heatmap` shape is from yt-dlp's docs (fake yt-dlp in `test/youtube-scan.test.ts`). Unverified on Krew's PC.
- **Windows launcher verified on Krew's PC (2026-11-17):** installed via `git clone` into `Documents\Project-Patrick`;
  `Clip Factory.bat` → `scripts/windows/start.ps1` (git pull --ff-only, Docker check, `docker compose up -d --build`,
  waits for /api/health, opens the dashboard, makes desktop shortcuts). Updates = Stop + reopen. Push to branch
  `claude/adoring-mendel-at7ood` = what Krew gets on next launch, so never push a broken build there.
- **Verified on Krew's PC (2026-11-17, v1.5.0):** the Setup .bat (run locally; browsers block downloading .bat files,
  so don't send it as a download — tell Krew to `git pull` then run `clip-factory\setup\Clip Factory Setup.bat`),
  the tray started Clip Factory and opened the dashboard as an app window, Twitch Suggestions found 25 real candidates,
  YouTube scanner ran. The CF tray icon was hidden under the ^ overflow (Windows default for new icons).
- **Tray app (2026-11-17):** `Clip Factory.bat` (must stay <= 97 bytes, see
  `test/windows-scripts.test.ts`) starts `scripts/windows/tray.ps1` hidden: WinForms NotifyIcon, mutex
  `Local\ClipFactoryTray`, 1s timer state machine running each step (git pull, docker info, compose up/down)
  as a hidden `cmd /c` child, async /api/health polls, log `storage/launcher.log`, restarts itself if a pull
  changed tray.ps1/common.ps1. Opens the dashboard as a Chrome/Edge `--app` window (`common.ps1`, shared with
  `start.ps1`). Desktop shortcut + optional Startup shortcut -> powershell tray.ps1. `stop.ps1` writes
  `storage/launcher-stopped.flag` so the tray shows "stopped"; a 2nd launch writes `launcher-open.flag`.
  Visible fallback: `Clip Factory (show details).bat` -> `start.ps1`.
- **Version + patch notes (2026-11-17, v1.6.0):** `CHANGELOG.md` is the only source of the version (first `## x.y.z — date`
  heading; 3-6 plain-English ASCII bullets per entry, newest first; `test/version.test.ts` enforces it). `src/lib/version.ts`
  (`getVersion`/`getChangelog`) feeds the header chip `v1.6.0` (`src/components/VersionChip.tsx`, "NEW" dot until
  /whats-new is opened, localStorage `cf-seen-version`) and the `/whats-new` page. Tray: version in tooltip + "What's new (vX)"
  menu item; after a version change it shows "Updated to Clip Factory vX — click to see what's new" once Clip Factory is running
  (compares with `storage/launcher-version.txt`, so updates by start.ps1/the setup file/a self-restarted tray count; a fresh
  install, i.e. no launcher.log or .ico in storage, stays quiet). `start.ps1` prints the new version's notes; the setup file
  prints "Clip Factory vX is installed". PowerShell parts UNVERIFIED on Windows.
- **v1.7.0 (2026-11-17):** one-click approve everywhere (no reason; Live page + Scout list have a direct Approve button,
  `approveStreamer`); `/workroom` live board of the line (`src/lib/workroom.ts` `getWorkroom`, refresh 3s, Nav badge = clips
  processing; new additive column `Clip.stageAt`, set on every `stage` write, falls back to updatedAt; clips/hour = clips created
  in the last 3h that came out cut); "Add a list of creators" card (`src/lib/creator-lookup.ts`: Helix `/search/channels`,
  YouTube `forHandle` → `search` with the key or yt-dlp without; 4 at a time, 60s total; only exact matches pre-ticked;
  `KREW_TOP_21` in `src/lib/starter-creators.ts`). (The v1.7.0 "name clash" rule that skipped a YouTube channel whose
  @handle equalled a Twitch login is gone since v1.7.1, see below.) Unverified against real Helix search / YouTube API.
- **v1.7.1 (2026-11-17): login unique PER PLATFORM.** `Streamer.login` is no longer `@unique`; the schema has a plain
  `@@index([platform, login])` and `twitchId` stays `@unique` (the real identity). A DB-level `@@unique([platform, login])` was
  tried and `prisma db push` refuses it on existing DBs ("A unique constraint ... will be added" = data-loss warning, needs
  `--accept-data-loss`, even on an empty table), so per-platform uniqueness is kept by the app: every add flow calls
  `loginTakenBy(platform, login, twitchId)` (`src/lib/streamers.ts`) and only refuses a SAME-platform clash (old Twitch row
  after a rename / another YouTube channel on that @handle). Never look a streamer up by login alone: use twitchId/id, or
  login + platform. Add flows (`addStreamer`, `addYouTubeChannel`, `approveResolved`), YouTube suggestions and the Scout no longer
  skip cross-platform name matches. `approveResolved` is idempotent: already-approved rows are left untouched ("already
  approved"), so re-running "Approve all ticked" only adds the missing YouTube rows. `test/v171.test.ts` includes a real
  `db push` upgrade from the 04b05d1 schema with rows (no prompt, rows kept). (Alternative if a real constraint is ever wanted:
  create `Streamer_platform_login_key` with raw SQL before `db push`; then push is clean too — tested, not shipped.)
- **v1.7.2 (2026-11-17): funny + gaming moments, Creators page.** `Moment.category`/`Clip.category` ("funny"|"gaming", null on
  older rows), Settings `clipFunny`/`clipGaming`, `Streamer.paused` + `Streamer.approvedAt` (all additive, nullable/defaulted; `test/v172.test.ts`
  runs a real `db push` from the 5486a81 schema with rows). First guess per source in `src/lib/category.ts`: chat = laugh share (see the spike
  section); Twitch clip = non-game Twitch category (Just Chatting, IRL, Talk Shows & Podcasts, Pools Hot Tubs & Beaches, Music, Art, ASMR,
  Special Events; Sports = gaming) or laugh words in the clip title → funny; YouTube = yt-dlp `categories`: Gaming → gaming, Comedy → funny,
  else gaming words in the title (gameplay, GTA, Fortnite, Minecraft, speedrun…) → gaming, else funny. The Judge returns `category` (zod enum)
  and its label replaces the guess on the Clip. Switched-off kind: no new moments (status lines say "skipped N funny (off in Settings)";
  YouTube videos get status `off_funny`/`off_gaming` and are looked at again once it's back on); clips already in the line whose
  (Judge) category is off are auto-rejected by the Cutter with judgeReason "Funny clips are off in Settings". Queue `?cat=all|funny|gaming`
  and `?creator=<Streamer.id>` (`src/lib/queue-filter.ts`); chips on ClipCard/Workroom; Analytics "By type". `/creators`
  (`src/lib/creators.ts`): approved creators with stats, live first then most clips, search + All/Twitch/YouTube/Live chips, Pause
  (`setPaused`; paused = skipped by clips poller, spike detector, YouTube scanner and no chat join, but still tracked live) and a two-step Remove.
  Judge prompt now opens "You score short clips from streamers and YouTubers" (funny non-gaming clips are first-class). Unverified on real chat.
- **v1.7.3 (2026-11-17): editing styles** (Krew: "clips seem a little bland"). Settings `editStyle` hype|clean|meme (default hype);
  Clip `editStyle` (style it was last cut with, null = plain fallback), `winLength` (the window; `duration` is now the EDITED length, so
  re-cuts read `winLength ?? duration`), `editNote` (warning when the plain fallback was used). All additive; `test/edit.test.ts` runs a real
  `db push` from the 0684afb schema with rows. Code: `src/lib/edit.ts` (pure builders + `renderStyled`), style list in
  `src/lib/edit-styles.ts` (no Node imports, the client card uses it). One ffmpeg render per clip: fps=30 first, jump cuts as
  `trim/atrim` + `concat` (segments snapped to 1/30s), fg zoom = `scale eval=frame` to even sizes + `crop` whose x/y repeat the same
  expression (crop's in_w is the FIRST frame's size, so default centring breaks), blurred bg never zooms, `eq`+`unsharp`, ASS
  (credit top y=110, hook y=250 / 190 facecam, captions centred at y=1190 = 62%) drawn after the zoom, progress bar = an 8px `color`
  source overlaid with x='-W+W*t/D' (drawbox can't animate its width in ffmpeg 6.1), `loudnorm` I=-14 + SFX via `adelay`+`amix`.
  Jump cuts (`planJumpCuts`, v1.7.3 rules, made conservative + silence-checked in v1.8.0 below): gaps > 0.6s between words, 0.15s pad, biggest first, never under `clipMinSec`, never across the peak,
  none with < 6 words; leading/trailing silence is kept (may be gameplay). Peak (`pickPeak`): chat spike from a VOD = the moment
  (raw time min(30, vodOffset)); else the loudest second from one `astats` pass (~0.2s). Punch = 0.25s smoothstep in, 1.2s hold, 0.25s out.
  SFX (whoosh = filtered noise with `asendcmd` opening a low-pass, boom = 130->55 Hz sine drop) are made by ffmpeg once into
  `STORAGE_DIR/sfx/*-v1.wav`. Any styled-render error -> `renderOrFallback` makes the plain v1.7.1 edit and sets `editNote`.
  Queue card "Re-cut ▾" (`recutClip`) = stage "cut" + `enqueueCut(id, 1, style)` (job data `style`), status kept (a failed clip goes back
  to processing); only while `rawPath` exists. **Measured (this sandbox, 4 cores, 45s 1080p60 source, -preset veryfast):** plain v1.7.1
  render 19.2-20.2s; hype 17.8-18.5s, clean 15.9-16.2s, meme 18.7-19.6s, hype facecam 19.8s (outputs 32.7s after jump cuts; doing fps=30
  before scaling pays for the effects). Proof contact sheets in the session scratchpad only. Unverified on Krew's PC and on real Twitch audio.
- **v1.8.0 (2026-11-18): better moments** (Krew: "bland, only Kai and Hasan, wrong times, too GTA 6"; then "the editing is
  chopping"). All schema changes additive with defaults (`test/v180.test.ts` pushes from the bf79233 schema with rows; older
  upgrade tests derive their old schema via `test/schema-v173.ts`). Settings defaults: `gameMode` "any", `clipLookbackHrs` 168,
  `clipMaxSec` 35; new `standoutMin` 2, `maxPerCreatorPerRun` 2, `jumpCuts` "light" (off|light|normal), `migratedAnyGame`. One-time
  worker migration `migrateV180Settings` (`src/workers/migrate.ts`): gta6->any, 24->168, 45->35 only if still the old value, then
  sets the flag so later manual changes stick. Clips poller (`src/workers/clips.ts` + pure `src/lib/standout.ts`): per approved,
  not-paused Twitch creator one `/clips` page (own broadcaster_id only); `standout = views / max(creator median, minClipViews)`,
  `rank = standout / (1 + ageH/48)`; keep views >= minClipViews AND standout >= standoutMin, or the creator's single best if >= 5x
  minClipViews; dedupe same `video_id` overlapping ±20s (keep most-viewed; also vs existing moments of that streamer, chat ones
  as vodOffset-30..+15); round-robin by best rank, cap per creator, total min(15, backlogRoom()). "any" mode never runs the
  game-wide GTA `/clips` query (gta6 mode only). Moment.spikeScore = standout for twitch_clip. Status "picked N standout clips
  from M creators · K had nothing standout". Window (`src/lib/window.ts`, pure): `runTranscribe` now transcribes + measures
  100ms loudness of the WHOLE source (<= 180s) → `Clip.words` timed in the source with `Clip.wordsFull = true` (older rows:
  window-relative, false) → `findPayoff` → `pickSmartWindow` → `Clip.payoffAt` (source seconds; the cutter passes `payoffAt - winStart` as `renderStyled({ peakAt })`; outside the window → `windowPeak`: chat moment, else the same jump search on the window, else loudest second). Payoff/window rules: see "v1.8.0 review" below. Judge gets "Source video / Proposed window" + `<source_transcript>` ("[12.4s] …" lines) and returns
  nullable `best_start`/`best_end`; `validJudgeWindow` (length within [min, max], inside the source) → winStart/winLength/
  duration/transcript replaced. Order unchanged: grab → transcribe → judge → cut; re-cuts use the stored window.
  Jump cuts (`planJumpCuts`): only a run of 100ms frames (one `astats` pass, `measureLevels`) inside a word gap that are all under
  `silenceThreshold` = min(-45, speech median - 20 dB) (review: was -35/-15); no levels = no cuts. Presets `JUMP_PRESETS` light (gap >= 1.2s, pad 0.35,
  <= 15%, <= 4 cuts) / normal (0.8, 0.25, 25%, 6); never within 1s before the payoff through the punch. Queue Re-cut has
  "<style> without jump cuts" (`recutClip(id, style, "off")`, job data `jumpCuts`). Settings page: standout + per-creator knobs,
  lookback in days (`clipLookbackDays` form field, 1-30), jump cuts select, amber no-key note. Live heading "Live now" in any mode
  (game chip on everyone). Prompt: stricter scale (routine 3-5, real moment 7-10). Unverified on real Twitch audio/Whisper/Claude.
- **v1.8.0 review (2026-11-18, on top of 9489388; `test/v180-review.test.ts` + updated `test/v180.test.ts`, proof renders in the session
  scratchpad only).** Problems found: "loudest 1.5s" picks game noise (game audio is loud all the time); payoff landed ~2s late and the
  window ran 11s past it; jump cuts never cut a silence that shared a word gap with game audio, and the -35 dB cap let quiet game/music
  beds be cut; Judge windows could open/end mid-word and drop the payoff (stale punch-in); live Twitch clips (no `vod_offset` yet)
  were never deduped; Whisper writes laughter as single "Ha" tokens the reaction regex missed. Now (`src/lib/window.ts`):
  `scoreMoments` per 100ms frame: audio = (1s level - usual) clamped 0..15 + 0.25 x (1s level - median) clamped 0..20, where
  usual = max(p80 of the 1-8s before, p75 of the whole source) and median likewise (so a talker coming back after a pause scores ~0);
  react = 2.5 per reaction word starting in the next 3s once there are >= 2 (max 6). `findPayoff`: chat/YouTube hint sharpened within
  -3..+5s if score >= 6, else the hint; Twitch clip: best frame in the last 70% (+2 late bonus, then back to the start of that
  moment's plateau), needs score >= 5 (`CLUE_MIN`), else 70%; payoff = the onset. `reactionEnd`: while the 0.5s level stays >=
  max(usual - 3, bed + 6) (bed = p20 of the 8s before; dips <= 0.8s) and/or reaction words chain (gaps <= 1.2s), max payoff + 8s.
  `pickSmartWindow`: end = reaction end + 0.8, or the end of a "capper" sentence under way / starting within 2s that ends by
  payoff + 10s; never mid-word; >= payoff + 2. Start = the sentence start (0.25s early) closest to end - 80% of maxSec (28s at 35),
  >= 3s before the payoff; no words = that spot moved past real silence (< -50 dBFS, `SILENT_DB`). Result on the proof source:
  payoff at 64-65% of a 24s clip, ending right after the capper line. Jump cuts (`planJumpCuts` + `quietRuns`): only the truly quiet
  run INSIDE a word gap (>= maxGap long) is cut, pads kept next to words. Judge: the worker re-measures levels (`judgeMarks`:
  window edges, likely payoff, loudness jumps >= 6 dB, silences >= 1.5s as "[t] (sound: ...)" lines in `<source_transcript>`; the
  window's plain `<transcript>` is only sent for older clips), snaps its window (`snapWindowToWords`) and re-finds the payoff inside it
  when it was left out. Prompt rewritten (editor rules for best_start/best_end, hook without spoiling the payoff). Dedupe
  (`src/lib/standout.ts`): clips created within 30s (`SAME_MOMENT_SEC`) are one moment; existing chat moments block clips created
  -10..+60s around them, existing viewer clips +-30s. No schema change in the review.
- Docker image never built in the sandbox (no daemon); it builds fine on Krew's PC; a clean-copy `npm ci` + `next build` without `.env`
  (what the Dockerfile does) passes.
- **Suggestions (2026-11-17):** `src/workers/suggest.ts` (queue "suggest", hourly + once ~1 min after start,
  "Scan now" on Streamers) → `Suggestion` rows (one per streamer, top 25 pending). Candidates: top 300 live on all of
  Twitch + unapproved streamers the Scout saw in 7 days; excludes approved Twitch rows, fresh pending (<50 min),
  dismissed until `dismissedUntil` ("Not now" = 30 days). Top 40 by viewers get `/users` + one `/clips` page (7 days).
  `score = 2·log10(viewers+1) + 1.5·log10(clipCount+1) + 1.5·log10(topClipViews+1) + 2 if permission evidence`.
  Evidence = `src/lib/permission.ts` regexes on bio then title; any "no clips"/"don't clip" in either cancels.
  It NEVER approves: Approve on a card calls `approveSuggestion` → `setApproved` (one click since v1.7.0; the stored
  note is the real permission quote when there is one). Never touches `isLive`/`viewers` (the Scout owns them); `Suggestion.viewers/gameName`
  hold the snapshot. Unverified against real Helix (bio `description` field and all-Twitch `/streams` paging per docs).
- **YouTube suggestions (2026-11-17):** `src/workers/suggest-youtube.ts`, run inside the same hourly suggest job after
  Twitch (each half try/caught; per-half status `suggest_twitch` / `suggest_youtube` in Redis). Needs `YOUTUBE_API_KEY`
  (Data API v3, plain key; base URL `YOUTUBE_API_URL`); missing → skipped + setup card on the YouTube tab. `/videos?chart=mostPopular`
  (overall + categories 20/24/23, `Settings.ytSuggestRegion`) → `/channels` (50 ids/call); no `customUrl` → skipped; a @handle
  owned by another YouTube row → skipped with a log line (a Twitch row with the same name is fine since v1.7.1). `score = 2·log10(subs+1) + 1.5·log10(topTrendingVideoViews+1) +
  3·log10(trendingVideoCount+1) + 2 if evidence` (hidden subs → channel viewCount/1000, said in reasons). Evidence only from
  the channel description (`findDescriptionEvidence`). `Suggestion.platform` keeps separate top-25s; YouTube rows store
  `subscribers/videoId/videoTitle/videoViews`. Approve → `setApproved` (pokes the YouTube scanner). Unverified against the real API.
- Tests: `npm test` (unit, real ffmpeg renders, workers against Redis, Judge/YouTube/TikTok against the
  stand-in servers in `test/mocks.ts`). `npx tsx test/mocks.ts 4010` prints env vars to run the app on stand-ins.
- **First real run on Krew's Windows PC (2026-11-17), `npm run doctor` in Docker: 0 broken.** Verified for real:
  Docker build, Redis, DB, Twitch token, GTA 6 category (id `1867279146`, 179 live streams pre-launch),
  yt-dlp download of a real Twitch clip, ffmpeg 9:16 render. Still unverified: Judge (no key yet), chat/spike
  path, YouTube/TikTok, Whisper on real speech.
- Earlier status line, kept for history — **never run against the real services** (no keys in the build sandbox): Twitch Helix/chat/yt-dlp, the real
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
- Since v1.7.2 hype is split in two (`src/lib/chat.ts`): **`LAUGH`** (lmao/lmfao, kekw, omegalul, lul/lulw, icant/"i can't",
  "dead", hahah+, LOL any case, 😂 🤣 💀) and **`GAME_HYPE`** (lone W, Pog/PogU/Poggers/PogChamp, "clip it/that", "no way",
  "let's go"/"lets go", "holy"). `HYPE` = the union and is what the hype share/hype spike below counts (so the hype spike rule
  is unchanged apart from the bigger word list). A line matching both counts as a laugh (`reaction()`).

**Category (v1.7.2, classification only, does not change when a spike fires):** in the spike window,
`laughShare = laugh ÷ (laugh + gameHype)` messages; the spike is **"funny"** when `laughShare ≥ 0.5` **and** ≥ 4 laugh messages,
else **"gaming"** (`spikeCategory()`). `spike()` returns `laughShare` + `category`; the worker stores it on `Moment.category`/`Clip.category`
and in `Moment.stats` (the Judge sees the laugh share). A spike of a kind switched off in Settings → "What to clip" makes no moment
(counted in the status line; that streamer is quiet for 30s so one spike counts once; it does NOT use the 3-min cooldown).

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
- The Grabber only pulls from `Streamer.approved = true`. Creators are approved only by Krew's own click (nothing
  approves on its own schedule; Suggestions and the bulk lookup only suggest). Since 2026-11-17 (Krew: "I just want to hit
  approve and it gets approved") a reason is OPTIONAL: `approvalNote` = typed note, else the suggestion's permission quote,
  else "Approved by Krew" (`DEFAULT_APPROVAL_NOTE`, `src/lib/creator-lookup.ts`; logic in `setApproved`).
- Nothing posts without Krew pressing Approve. The Poster refuses clips that aren't approved; "auto-upload"
  only means the Approve click also uploads. Uploads are single-attempt so a retry can't double-post.
- Every caption credits the creator (name + twitch.tv / youtube.com/@ link, always via `creatorUrl` in `src/lib/social.ts`);
  the credit is also burned into the video.
- Secrets live in `.env` (gitignored). Never commit it.
- Every push to claude/adoring-mendel-at7ood bumps the version and adds a CHANGELOG.md entry in plain words (Krew sees it after updating).

## Gotchas found while building
- `.env.example` must never have `KEY=   # comment` lines: Docker Compose can read the comment as the value.
- Tailwind 4: custom classes in `app/globals.css` must be `@utility`, not plain classes.
- ioredis must match BullMQ's bundled version (5.11.1) or TypeScript breaks.
- faster-whisper's own audio loader breaks on newer PyAV; `scripts/transcribe.py` reads the WAV itself.
- YouTube (checked 2026-11-16): API uploads are no longer forced private; 100 uploads/day per project.
- The dashboard has no login. Fine on localhost; add a passcode before hosting it anywhere public.
- yt-dlp (2026.10) needs a JS runtime for YouTube: the Dockerfile copies deno 2.1.4 in and installs `yt-dlp[default]`.
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
