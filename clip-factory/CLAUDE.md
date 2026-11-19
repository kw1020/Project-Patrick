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
- **v1.9.0 (2026-11-18): layouts** (Krew: "streamer's camera up and game down. Or just a full streamer cam if it's like a funny
  moment"). Settings `layout` auto (new default) | split | fullcam | blur ("facecam" = old name of split, still read);
  `migrateV190Settings` moves blur -> auto ONCE (`migratedAutoLayout`). New additive columns: `Clip.layout`, `Clip.camInfo` (JSON
  detection + the window it was measured on), `Streamer.facecamAuto`; `test/v190.test.ts` pushes from the 9bf0915 schema with rows
  (`toV180Schema` in `test/schema-v173.ts`). **Detection** `scripts/detect_cam.py` (same Python as transcribe.py; Dockerfile pins
  `opencv-python-headless==4.10.0.84`, UNVERIFIED in the Docker image): 10 frames evenly over the window (parallel ffmpeg input
  seeks, scaled to 640 wide), Haar frontal cascade (equalized gray, minNeighbors 5) + profile cascade both ways as fallback,
  boxes clustered by position across frames (biggest steady cluster; stray game "faces" drop out), hitRate = frames in it / 10.
  region: large (face area >= 4% of the frame) / corner (centre x < .3 or > .7 AND y < .35 or > .65, or within .2 of an edge) /
  center. camBox: median face expanded to 3.6x face width at 16:9 (face centred across, 45% down), shifted inside the frame, then
  each side snapped (`snap_edges`) to the OUTERMOST line in a +-50% band that is a Canny edge (any colour channel, dilated 1px)
  over >= 55% of the side in >= 60% of the frames, then stepped in 0.6%/1% of the frame so no game shows at the rim. 1.5-2.7s
  per clip here (4 cores); `--summarize` mode takes injected boxes (tests). Pure rules in `src/lib/layout.ts`: `autoLayout` no
  face / hitRate < 0.4 -> blur; large or center -> fullcam; funny + hitRate >= 0.6 + cam box >= half the frame tall -> fullcam;
  corner -> split (a small corner cam is NOT blown up to full screen for funny clips: it stays split with the punch-in on the cam
  — deliberate deviation from the brief's "funny -> fullcam", the 5x upscale looked bad). `needsDetect`/`chooseLayout`: typed
  `Streamer.facecam` always wins; a remembered `facecamAuto` skips detection for auto/split (not in non-game categories like Just
  Chatting, `isNonGame`); cached `Clip.camInfo` is reused while the window is unchanged (failed checks aren't cached).
  `boxToRemember`: Twitch only, no typed box, split from this clip's detection, hitRate >= 0.6, corner, >= 2 sides snapped.
  Reset on Streamers rows + Creators cards (`resetFacecamAuto`). Render (`planLayout` -> `LayoutPlan`, used by `buildStyledFilter`
  AND the plain `buildFilter`): split = cam box cover-scaled into the top 640px, game cover-cropped below and moved up to 12% away
  from the cam (`splitGameShift`), 6px dark seam; zoom/punch on the cam for funny clips, on the game otherwise; fullcam = 9:16
  crop of the frame (or inside the cam box minus 2% per side), height down to 75% to put the face near 40% from the top, x static
  unless the face moves > 8% of the crop width, else keys per sampled frame (median of 3) cosine-eased (`cropXExpr`, key times
  remapped through jump cuts); zoom on the whole frame. Text (`overlayPlace`, face rect grown 25%): split captions centred at
  y=760 (just under the seam), hook above the seam if the face is high enough else under the captions, credit top unless the face
  reaches y<175 then bottom (y=1886); fullcam captions at 72% (lower if the chin is there), hook top or under the captions, credit
  top/bottom likewise. Cutter: plain fallback renders the layout too, and if that fails falls back to plain blur. Queue card:
  layout chip + Re-cut ▾ = style select + layout select + jump-cuts checkbox + Re-cut (`recutClip(id, style, jumps, layout)`, job
  data `layout`). Proof (session scratchpad only, scikit-image's public-domain astronaut.png as the face): renders 15-18s for all
  layouts (same as v1.8.0), corner cam found to within ~2px of its real border. Unverified on real Twitch webcams / Krew's PC.
- **v1.9.1 (2026-11-18): ViceCityClips captions + watermark, Campaign mode (Whop Content Rewards).** Captions: `brandedCaption`
  (see the credit rule below) used at moment creation (clips/spike/youtube workers, hook = `defaultTitle` cut to 60, extras =
  `defaultExtras`: funny → GTA6Funny, GTA 6 → GTA6Clips, else StreamerMoments), by the Judge (hook = `hook_text`, new structured
  field `extra_hashtags` = zod enum of the 4 extras, `cleanExtras` dedupes/max 2, empty → `defaultExtras`; Clip.title = hook;
  Clip.hashtags = the caption's hashtags) and by the Queue card's "Rebuild caption" (`rebuildCaption`). The old `defaultCaption`/
  `judgedCaption`/`cleanHashtags` stay only for old tests. Settings `channelName` ("ViceCityClips", header) + `watermark` (true):
  `watermarkStyle`/`watermarkPlace` in `src/lib/layout.ts`, one `Mark` style + dialogue in BOTH `buildAss` (plain) and
  `buildStyledAss`, 34px &H80 white, `\an3\pos(1044, 1890)` or 58px above a bottom credit, starts at 4.5s if a low hook could
  reach it. Campaign model (`name, source "whop", link, rules, requiredText (lines), bannedWords, maxCaptionChars, active`),
  `Streamer.campaignId` (SetNull), `Post.campaignLink`/`Post.campaignId` (plain id) — all additive, `test/v191.test.ts` pushes
  from 028c1be with rows (`toV190Schema`). Campaign rules in captions: required tag-only lines → hashtag line (may exceed 5),
  text lines appended if missing, banned words removed from the hook (fallback hook), hook trimmed to `maxCaptionChars`;
  the Judge's user message gets "Campaign caption rules: …" + banned words. `checkCampaignCaption` → ✅/⚠️ lines on ClipCard
  (blocks nothing). UI: `src/components/Campaigns.tsx` (Campaign select on Streamers rows + Creators cards, "+ New campaign…";
  Campaigns card with two-step delete), Posted page campaign select + link + `?campaign=<id>|none` filter, manual "Posted" form
  campaign link. Unverified against the real Claude API (enum arrays in structured outputs) and on Krew's PC.
- **v1.9.4 (2026-11-19, launch day): the Judge looks + full range, auto-delete, storage on another drive.** Krew: "The Judge is
  only giving every video a 6 out of 10", "my disk drive is getting full", "have them auto-delete". Judge (`src/workers/judge.ts`
  `judgeFrames` + `src/lib/frames.ts`): `pickFrameTimes` = 8 times in the proposed window (older clips: 0..duration) — 2 in the
  first 3s, payoff/-2/+2 (no payoff or outside → 60% in), the rest greedily farthest from the chosen ones, >= 0.4s apart; ONE
  ffmpeg run (input seek per frame, scale=640:-2, mjpeg q 6) → base64. User message (`judgeContent`) = per frame a text block
  `[frame at 31.2s]` + `image` block (base64 image/jpeg), then the text (which says the images are stills); no frames = the old
  plain-string content (+ "No frames could be taken…" line when ffmpeg failed; JUDGE_FRAMES=off skips). Zod `observations` FIRST
  (before `score`) → `Clip.judgeObservations` ("Saw: …" on ClipCard). Effort "low" → "medium" (fallbacks unchanged). Prompt SYSTEM
  rewritten: anchored rubric 1–3/4–5/6/7/8/9–10, "6 is not a safe default", "Most raw clips are NOT good", observe-then-score.
  Calibration: Redis list `cf:judge:recent` (newest first, kept 100); `calibrationNudge` (`src/lib/judge-stats.ts`): >= 10 of
  the last 30 with SD < 0.8 → line "Your recent scores have been very similar (mostly X). Use the full range." Usage →
  `Clip.judgeTokensIn` (input + cache read + cache write) / `judgeTokensOut`, `Clip.judgeFrames`; prices in `src/lib/pricing.ts`
  ($2/$10 per MTok) → Settings → Judge "~X¢ per clip (last 20)". Analytics `ScoreHistogram` (last 50), Live page line
  `scoreSummary`. Retention (`src/workers/retention.ts`, Settings `retain*`, defaults 6h/48h/5d/3d/raw 6h/rows 7d; `retentionWindows`):
  raw right away once cut AND approved/rejected/posted/expired, else retainRawHrs after the cut (`stageAt`), never while stage set;
  finals rejected 6h, approved (never posted) 5d, posted 3d, failed 24h; pending older than 48h → final+raw deleted, status
  **"expired"** (Queue "Expired" tab only; not in To review / backlog); rejected/expired rows deleted after 7d unless they have a Post
  (Moments kept: they're the twitchClipId dedupe); orphans in raw/final/work after 24h. Path clears use raw SQL so `updatedAt` (every
  window's clock) isn't bumped. Disk pressure (free < 2 × MIN_FREE_GB, checked every 10 min): all windows halved, then the oldest
  pending finals expire one by one until above. Settings → Storage card (`app/storage-actions.ts`, `src/lib/storage.ts`): fields,
  usage by raw/final/edits/work/other, free GB, host path, "Free up space now" (= pressure mode). docker-compose: `${CLIP_STORAGE_DIR:-./storage}:/storage`
  + env `CLIP_STORAGE_HOST_DIR: ${CLIP_STORAGE_DIR:-}`; verified with `docker compose config` here: empty `CLIP_STORAGE_DIR=` and
  a missing line both give `<project>/storage`, `D:/ClipFactory/storage` stays `D:/ClipFactory/storage` (short syntax handles the
  drive letter; `test/v194.test.ts` runs it when the docker CLI exists). Tray files stay in the repo's storage (scripts/windows use
  `$root\storage`). doctor: "Storage" line (folder, host folder, free GB; ❌ < MIN_FREE_GB, ⚠️ < 2x). All schema changes additive
  (`test/v194.test.ts` pushes from 1ac085c with rows; `toV191Schema` in `test/schema-v173.ts`). Unverified: the real Claude API
  with image blocks + medium effort, real cost, Docker on a D: drive on Krew's PC.
- **v1.9.5 (2026-11-19): Channels + Upload page, per-channel Posted/Analytics, Suggestions by followers.** All schema changes additive,
  no new uniques (`test/v195.test.ts` pushes from de19280 with rows; `toV194Schema` in `test/schema-v173.ts`; built as "1.9.2" before v1.9.4 landed). `Channel {name, kinds
  (gaming,funny,edits), focus (gta|any, free text), color}` = one brand with ONE YouTube + ONE TikTok + ONE Instagram slot (Krew: what
  goes on its YouTube goes on its TikTok + Instagram). `Account.homeChannelId` (NOT `Account.channelId`: that's the platform's own id,
  part of `@@unique([platform, channelId])`), `Account.mode` api|manual (manual = a handle Krew posts to himself, refreshToken ""),
  `Account.handle`; platform "twitch" (mode api) = the Twitch USER token, only for follower counts, never posts. `Clip.channelId`
  (Krew's pick; null = automatic), `Post.channelId` (from the account), `Streamer.followers/followersAt`, `Settings.migratedChannels`.
  `ensureChannels` (`src/lib/to-post.ts`, worker start + web layout, once, only if no Channel exists): seeds Krew's 4 brands
  (`src/lib/channel-seeds.ts`, fixed ids main/streamheist/wantedlevel/clipfactorygg: ViceCityClips gta all kinds, StreamHeistClips
  funny, WantedLevelClips gaming, ClipFactoryGG edits) with by-hand accounts for their public handles; an already-connected account
  matching a seed (`matchesSeed`: handle/username/title, YouTube channel id, or YouTube title = brand name) takes that slot instead;
  ClipFactoryGG's Instagram is seeded `Account.disabled` (+ note in `error`: Instagram disabled it). Leftover posting accounts go to a
  free slot of the first channel, else "Not in a channel yet". `Account.disabled`: skipped by `postToAll`, not waited for by
  `toPostItems`; Turn off/on in the Channels card (`setAccountDisabled`). Focus/kinds map onto v2.0's Account.purpose (gta+all = all). Routing `channelForClip` (`src/lib/channels.ts`, pure):
  pick > GTA 6 clip (momentGame/isGta6) → first gta channel taking its type > first non-gta channel taking its type > null ("No
  channel", Krew picks). Upload (Krew: "an upload page next to the queue with all columns of all four channels"; `app/upload/page.tsx`,
  `/to-post` redirects there; one column per channel + a "No channel" column, header = 3 handle dots + "X waiting"; md+ = side by side
  w-80 scrolling sideways, phone = stacked; `src/components/ToPostCard.tsx` with "Move to…" = `setClipChannel`; Nav badge `toPostCount`): approved clips +
  clips posted through this flow (a post with channelId) not yet on every slot account; `postToAll` queues every api YouTube/TikTok
  account (`enqueuePost`, single attempt), by-hand rows = Download + copy caption (`downloadAndCopy`: clipboard + `/api/media/<id>?download=1`)
  → `markPostedToAccount` (link + campaign link); "Post one" menu = `postToAccount`. Poster + `postToAccount` refuse manual/twitch
  accounts; Queue buttons / auto-post / stats sync / doctor only use api YouTube/TikTok. Settings Channels card
  (`src/components/ChannelsCard.tsx`): quick "Add an account by handle" (platform + handle + channel, form resets for the next),
  per channel name/focus/kinds + 3 slots (Connect = `/api/<yt|tiktok>/connect?channel=<id>` → cookie `cf_channel` → callback
  `assignHomeChannel`; or Add handle), "Not in a channel yet" list. Posted: `?channel=&platform=` + grouped by channel; views typed in
  only for by-hand posts. `syncManualYouTube` (in runStatsSync): by-hand posts with a YouTube link → `fetchPublicStats` with
  YOUTUBE_API_KEY (no OAuth). Analytics `?channel=` on every breakdown + "By platform"/"By channel". Twitch user token
  (`src/lib/twitch-user.ts`): `/api/twitch/connect` → id.twitch.tv authorize, scope moderator:read:followers, redirect_uri EXACTLY
  APP_URL (Krew registered http://localhost:3000) → Twitch returns to the Live page `/?code&state`, which `redirect()`s to
  `/api/twitch/callback` (`twitchReturnRedirect`; state cookie `tw_state`). Followers = Helix `/channels/followers?broadcaster_id&first=1`
  `total`, cached a day per streamer. Suggest scan: up to 150 lookups/scan (top 21 first, then viewers), deep-check pool = KREW_TOP_21
  found + top 40 by tier/followers; ranking `rankSuggestions` (`src/lib/suggest-rank.ts`): top 21 pinned in Krew's order, then tier
  5M+/2M+/below, then score; no token = peak viewers then score + note. Streamers page chips "Big only (2M+)" (default on, `?big=0`
  off) and "GTA 6 now" (`?gta=1`); also refreshes approved creators' followers (Creators page). Unverified against real Twitch
  user-token OAuth / followers API and on Krew's PC.
- **v1.9.6 (2026-11-19): Supreme Judge** (own files: `src/lib/supreme.ts`, `src/lib/qa.ts`, `src/lib/ai-spend.ts`, `src/lib/prompt-file.ts`,
  `src/workers/supreme.ts`, `prompts/supreme.md`, `prompts/supreme-qa.md`, `src/components/QaBox.tsx`; the per-clip Judge files are untouched).
  Additive schema (`test/v196.test.ts` pushes from d757285 = v1.9.5 with rows; `toV195Schema`; built as "1.9.3"): Clip `supremePick/supremeRank/supremeReason/supremeAt/
  supremeChannelId`, `qa` (JSON `QaResult`) + `qaAt`, `cutPlan` (JSON {segs in window seconds, punchStart, duration} written by the cutter on
  every cut; every cut clears `qa`); Settings `supremePerChannel` (5) + `supremeDailyCents` (25); model `AiSpend {day (local YYYY-MM-DD),
  model, purpose supreme|qa, cents}` (plain index on day). Queues "supreme" (scheduler every 8h, first run 10 min after the scheduler is
  first made; "Pick now" = `pokeSupreme`) and "qa" (`enqueueQa`; `enqueueCut(..., qaAfter)` → job data `qaAfter` → the cutter queues the check
  after the cut). `runSupreme`: no key / over budget / no channels → skipped with a status line; candidates = approved + pending clips with a
  video from the last 72h, best score first, max 40; channel context = focus, types, posts today (+ per creator), last-14-day breakdowns by
  creator/type/platform (`performance`); ONE `client.beta.messages.parse` on claude-opus-5-5 (effort medium, `zodOutputFormat(SupremePicks)`,
  betas server-side-fallback + `fallbacks: "default"`); refusal → no picks (old line-up kept). `enforcePicks` (safety net): known
  channels/clips, one channel per clip, <= min(perChannel, want), <= 2 per creator per channel per day counting today's posts, never a clip
  whose `qa` has issues. The new line-up replaces the old; unchecked picks get `enqueueQa`. `runQa`: ffmpeg one pass (blackdetect d=0.4,
  freezedetect d=1.5 → issue at >= 2s and not inside black, silencedetect -50dB → issue at >= 3s, ebur128 → < -30 LUFS), length vs
  `Clip.duration`, `planIssues` (cut boundary inside a word by > 0.05s, piece < 0.5s, window end inside a word → extend_end); then (key +
  budget) ~10 frames (`frameTimes`: hook 0.6s, cut + 0.25s, punch + 0.4s, last 0.4s, evenly to fill) grabbed by the v1.9.4 `extractFrames` (`src/lib/frames.ts`, new optional width arg = 540 → 540x960 JPEG) → claude-sonnet-5-5
  effort low with labelled image blocks + cut list + `transcriptAroundCuts` (`QaVerdict` enum types/fixes); model black/frozen duplicates
  dropped. `fixClip` (Fix it): all suggested fixes in one re-cut (`fixPlan`: no jump cuts / layout / clean / winLength + 2s capped at the raw
  length) via `enqueueCut(..., qaAfter=true)`; status kept. Spend = usage x `src/lib/pricing.ts` (Opus 5.5 added; all input tokens at the input price) recorded per call, refusals
  included. Unverified against the real Claude API (image blocks + structured output on Opus 5.5) and on Krew's PC.
- **v1.9.7 (2026-11-19): auto-post per channel.** `setClipStatus` approve → `autoPostTargets` (`src/lib/channels.ts`): with channels, only
  api accounts whose `homeChannelId` = `channelForClip(...)`, not disabled; clip with no channel → nothing; no channels at all → old
  behaviour. `test/v197.test.ts`. The quality build (better clips/platform rules) moves to 1.9.8.
- **v1.9.8 (2026-11-19, built as "1.9.7" on v1.9.4, rebased onto v1.9.7): fewer + better clips, the Judge "watches", Platform check.** Krew: "the clip finder to be better… the
  judge to actually be able to watch the videos… follow the guidelines of every social media", then "just random pieces taken out…
  lesser of the clips that are lower quality". All schema changes additive (`test/v198.test.ts` pushes from 7fb3948 = v1.9.6 = v1.9.7 schema, with rows;
  `toV196Schema` in `test/schema-v173.ts`): Clip `judgeHookOk/judgePayoffIn/judgePayoff/judgeAudio/platformInfo`, Settings
  `maxPerCreatorPerHour` (3), `migratedMinScore7`; `minScore` default 6 -> 7 (`migrateV198Settings` moves 6 -> 7 once).
  **Event gate** (`src/lib/rank.ts` `eventGate`/`gateInputs`, run in `runJudge` BEFORE the Claude call, `FINDER_GATE=off` skips):
  dead air (>= 50% real silence + < 10% speech + < 6 words) / AFK (no talk, no spike, 0 scene changes) / no spike (loudness jump
  < 6 dB over that stream's usual AND chat peak < 2.5x its own median) / no reaction (no reaction word 2s before-3s after the peak,
  < 3 words within +-3s, jump < 9 dB) → score 2, judgeReason `FINDER_PREFIX` + reason, cut at priority 10 (auto-rejected).
  **Judge input** (`src/lib/audio-summary.ts`): `<audio_summary>` = loudness digits 0-9 per 0.5s relative to the window,
  labelled spikes (`audioPeaks`), speech/silence stretches, chat heat per 5s (`ChatHeat.heat`, stored on chat-spike
  `Moment.stats.heat/heatStep/heatEnd`, mapped by `chatInSource`: detection = moment + 12s, moment at min(30, vodOffset) in the
  raw) and whether chat and sound peak together. Frames (`pickFrameTimes` peaks/scenes): + 2 per peak (at it, +1s), + up to 3
  ffmpeg scene changes (`detectScenes`, fps=10, 256px, `select=gt(scene,0.3)`), max 12; without them the v1.9.4 pick is unchanged.
  Schema adds `payoff` (one line), `hook_lands`, `payoff_in_window`, `payoff_at` before `score`; `namedPayoff` false (empty,
  vague, < 3 words, or no time) → score capped at 4 in code (`NO_PAYOFF_CAP`). No own window + flags → `windowFromJudgeFlags`
  (payoff outside → fresh window round payoff_at; weak hook → next sentence >= 1s later); Judge's payoff_at becomes the punch-in
  when inside. **Tighter cuts** (`tightenWindow`, after `pickSmartWindow` in runTranscribe and for flag windows): build-up
  <= `LEAD_MAX` 12s (opens 1.2s before the setup sentence), real silence trimmed at both ends (never into the payoff), not
  mid-word, >= minSec. **Ranking**: `twitchClipRank` = standout x (1 + 0.5 log2(1 + views-per-hour / (base/24))) x 1.2 if the
  streamer clipped it / (1 + age/48) (used by `scoreCreatorClips`); `candidateScore` (+ gate, chat+sound coincidence x1.6) sets
  the Judge queue priority (`judgePriority`, `enqueueJudge(id, priority)`). **Keep the best** (`src/lib/funnel.ts` `keepBest`,
  in the Cutter for fresh clips that would go to review): a near-duplicate (same VOD stretch, or moments <= 45s apart) of an
  equal/better clip is rejected, a worse PENDING duplicate is rejected instead; > maxPerCreatorPerHour in review in the last
  hour → the worst pending one makes room or the new one is rejected. Queue header: `funnelLine` "Last 24h: X found, Y kept (...)".
  **Platform check** (`src/lib/platform-rules.ts`, sources cited at the top): `checkFile` (1080x1920, H.264/AAC, 23-60 fps,
  <= 25 Mbps, size limits, 3s-3:00, moov first), `checkOriginality` (credit, hook/styled edit/new layout = real editing; captions
  alone or nothing = hard fail; no other app's watermark/source host), `checkCaption` (2,200 chars, <= 5 hashtags for IG,
  YouTube title 100, `BANNED_PHRASES` incl. "leak", credit for TikTok/IG). Facts on `Clip.platformInfo` from the Cutter
  (`probeFinal` + `renderFacts`); ClipCard "Platform check" (live with the edited caption); `runPost` refuses on a hard fail
  for that platform (`postBlockReason`), so auto-post after Approve shows "Posting failed: Platform check failed: …". Upload cards
  (`ToPostCard`, shared `PlatformCheckBox`) show it too; any hard fail disables Post to all and `postToAll` refuses ("Not posted. …").
  The v1.9.6 video check (`Clip.qa`, ffmpeg black/freeze/silence) is reused as warnings in the box, not re-run.
  **Safe zones**: `TEXT_SAFE` top 290 / bottom 480 / left 60 / right 190 (ad templates' tops, measured organic bottoms, widest
  right rail); all text centred on `TEXT_X` 475 and shrunk (`fitScale`, DejaVu Bold width estimate) to 830px; credit top y=290
  (or bottom y=1440 when a face is up there), hook under it at 360, watermark right-aligned at x=890 above y=1440 (or under the top
  credit when fullcam captions are low). `test/v198.test.ts` renders every layout x style (+ plain) with long text and checks
  the drawn pixels' bounding box. Measured cost estimate: ~6.5k input tokens (12 x ~308 per 640x360 still + text) + ~450
  output ≈ 1.75¢/clip at $2/$10 (8 frames ≈ 1.5¢). Unverified: real Claude with the new fields, real Twitch audio through the
  gate (thresholds from fixtures), scene detection speed on 1080p60 on Krew's PC, platform UI positions (from ad templates).
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
- **Judge verified for real on Krew's PC (2026-11-18, v1.9.0):** `npm run doctor` → claude-sonnet-5-5 scored the test clip 6/10
  (structured output with nullable best_start/best_end + category enum accepted). 493 live GTA 6 streams, 45 approved.
  Worker rebuilt with fresh yt-dlp (`docker compose build --pull --no-cache worker`, ~7 min).
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
  Retention (v1.9.4, Settings → Storage): raw once reviewed / 6h after the cut; rejected 6h; unreviewed 48h → "expired";
  approved-not-posted 5d; posted 3d; rejected/expired rows 7d; halved below 2 × MIN_FREE_GB. Grabber pauses below
  `MIN_FREE_GB` (5) free and the Live page warns. Clips can live on another drive (`CLIP_STORAGE_DIR` in .env).
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
- Every caption credits the creator. Since v1.9.1 (Krew's exact format) every caption is built by `brandedCaption` in
  `src/lib/social.ts`: `<hook>\n\n🎥 @<login>\n\n#GTA6 #GTAVI #ViceCity <1-2 of #GTA6Clips #GTA6Funny #Gaming #StreamerMoments>`
  (+ campaign-required lines). The channel-link credit (`creatorUrl`/`creatorCreditText`) is still burned into the video and
  appended to YouTube descriptions; the ClipCard warning and the YouTube poster accept the `@login` line or the link.
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

**Krew's standing requirements:** Clips must be genuinely entertaining with a clear payoff; fewer, higher-quality clips beat many random ones. (2026-11-19) Every clip must follow the rules of every platform it goes to (YouTube Shorts, TikTok, Instagram Reels).

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
