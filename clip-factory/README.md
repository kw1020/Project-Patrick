# Clip Factory — GTA 6 launch build

Finds hype moments from approved GTA 6 streamers on Twitch, cuts them into vertical captioned
clips, and queues them for you to approve and post on TikTok / Shorts / Reels.

**Phase 1 (built):** Scout · Twitch Clips poller · Grabber · Cutter · dashboard (Live, Queue, Posted, Streamers, Settings).
**Phase 2 (built):** chat spike detector · Judge (Claude scores each clip, writes the hook/title/hashtags) · YouTube upload after you approve.
**Phase 3 (built):** TikTok drafts · multiple accounts · Analytics page · the Judge learns from your results.

## 1. One-time setup (≈10 min)

1. **Install Docker Desktop**: https://www.docker.com/products/docker-desktop/ (open it once so it's running).
2. **Make a free Twitch developer app**: https://dev.twitch.tv/console/apps → *Register Your Application*
   - Name: anything (e.g. `krew-clip-factory`)
   - OAuth Redirect URL: `http://localhost:3000`
   - Category: *Application Integration* · Client type: *Confidential*
   - Copy the **Client ID**, click *New Secret*, copy the **Client Secret**.
3. In this folder, copy `.env.example` to `.env` and paste the two Twitch values in.
4. **Judge (optional but recommended):** paste an `ANTHROPIC_API_KEY` from https://console.anthropic.com into `.env`.
   Without it, clips still arrive, just unscored.
5. **YouTube upload (optional):** see "Connect YouTube" below.

## 2. Run it

```bash
docker compose up --build
```

Open **http://localhost:3000**. First build takes a few minutes; the first clip also downloads the
Whisper caption model (~150 MB) once.

## 3. Use it

1. **Live** shows every GTA 6 streamer live right now (Scout checks every 2 min, or hit *Scan now*).
2. Click **Approve…** next to a streamer you're allowed to clip, and write *why* (opted in, paid
   clipping campaign, their panels say clippers welcome). Only approved streamers ever get clipped.
3. Within a few minutes their best Twitch clips show up in **Queue** as 9:16 videos with burned-in
   captions and a `twitch.tv/name` credit.
4. Edit the title/caption, **Approve**, **Download**, **Copy caption**, post it, then press **Posted**
   (paste the post link) so it shows up on the **Posted** page.

Finished files are also in `storage/final/` on your computer.

### Editing styles

Settings -> Clips -> **Editing style** picks how new clips are edited (default **Hype**):

- **Hype**: captions pop in word by word with the spoken word in yellow, silences cut out (jump cuts), a zoom
  on every cut and a zoom punch on the loudest moment, a whoosh on the hook and a boom on the punch, pink progress bar.
- **Clean**: white word-by-word captions and jump cuts, a simple fade-in hook, no zooms or sound effects.
- **Meme**: bigger tilted captions with the spoken word in green, harder zoom punch, yellow hook, sound effects.

Every style keeps the `twitch.tv/name` / `youtube.com/@name` credit burned in at the top. Jump cuts (Settings -> Clips ->
**Jump cuts**: Light by default, Normal or Off) only remove pauses where the audio is really silent, never game sound,
music or talking the captions missed; Light cuts pauses of 1.2s+ only, at most 4 per clip and 15% of it, never right
before the payoff. They never make a clip shorter than the minimum clip length and are skipped when there is little talking.
**Re-cut -> ... without jump cuts** re-makes one clip with none. To try another style on one clip,
open **Re-cut** on its Queue card (works while the original video is still kept, about 12 hours). If a styled edit ever
fails, the clip is made with the plain edit instead and the card says so.

### How clips are picked (v1.8.0)

- **Which creators:** every approved, not-paused creator, in any game (Settings -> Which games can go back to GTA 6 only).
- **Which Twitch clips:** each creator's viewer-made clips from the last 7 days (Settings -> Look back). A clip counts as
  *standout* when its views are at least 2x that creator's usual (median) clip views, and at least *Min Twitch clip views*.
  A creator's single best clip is also allowed if it has 5x the minimum. Newer clips rank higher.
- **No repeats:** viewers often clip the same moment several times; only the most-viewed one is taken, and moments the
  chat spike detector already caught are skipped.
- **Fair mix:** each scan takes one clip from each creator in turn (best first), at most 2 per creator (Settings), until
  the line is full. The Live page says e.g. "picked 9 standout clips from 6 creators · 4 had nothing standout".
- **Which part:** the whole source is transcribed, then the cut is placed on the payoff: the loudest moment in the last
  70% of a viewer clip (people clip right after something happens), a burst of reactions ("oh no", "bro", "what"), the
  chat spike's moment or the YouTube most-replayed point. The payoff sits about two-thirds in, the clip starts on a word
  (not dead air) and ends after the reaction, 15-35 seconds.
- **The Judge** (needs `ANTHROPIC_API_KEY`) reads the whole timed transcript, scores strictly ("would a stranger keep
  watching past 3 seconds?") and may choose a better start and end itself. Without a key every clip arrives unscored.

## Install with automatic updates (Windows, once)

After this, you never download a ZIP again: the **Clip Factory** desktop icon checks for updates,
downloads only what changed, rebuilds, starts, and opens the dashboard.

1. Install Git (PowerShell): `winget install --id Git.Git -e --source winget`, then close and reopen PowerShell.
2. `cd $HOME\Documents`
3. `git clone -b claude/adoring-mendel-at7ood https://github.com/kw1020/Project-Patrick.git`
   (a browser window asks you to sign in to GitHub the first time).
4. Copy your keys from the old ZIP folder into `Documents\Project-Patrick\clip-factory\.env`.
5. Open `Documents\Project-Patrick\clip-factory` and double-click **Clip Factory** (the .bat file).
   It puts a **Clip Factory** icon on your desktop. Use that from then on.

Your approved streamers, settings and clips history carry over (same Docker volumes, because the folder is
still called `clip-factory`).

**Using it day to day.** The **Clip Factory** icon starts a small tray app: a pink **CF** icon at the
bottom-right of the screen, by the clock. No black window. It checks for updates, starts Docker, starts
Clip Factory in the background and opens the dashboard in its **own app window** (no tabs, no address
bar). Closing that window does not stop anything: clips keep coming in. Hover over the CF icon to see if
it's *starting*, *running*, *stopped* or has an *error*.

- **Can't see the CF icon?** Windows hides new tray icons. Click the small **^** arrow by the clock, then
  drag the CF icon down onto the taskbar so it always shows.
- **Click the CF icon** to open the app window again.
- **Right-click the CF icon** for the menu:
  - **Open Clip Factory**: opens the app window.
  - **Start** / **Stop**: Stop shuts it down; your clips, streamers and settings are kept.
  - **Update now**: stops, downloads the newest version, rebuilds and starts again (a few minutes).
  - **Start when Windows starts**: tick it and Clip Factory starts by itself when you sign in
    (quietly, no window). Untick to turn it off.
  - **Show log**: opens a text file of what the launcher did (`clip-factory\storage\launcher.log`).
    Send it to Claude when something goes wrong.
  - **Quit (keep running in background)**: removes the CF icon; clips keep coming in.
  - **Stop and quit**: stops Clip Factory and removes the icon.
- Opening Clip Factory again while it's already running just opens the app window.
- **Stop Clip Factory** (desktop icon, if you have it) still works too.
- Something wrong and the log doesn't help? Double-click **Clip Factory (show details).bat** in the
  `clip-factory` folder: it does the same steps in a visible window, so you can screenshot it.

## Check everything before launch: `npm run doctor`

Run this on your computer once your keys are in `.env` (Wednesday at the latest):

```bash
npm run doctor
```

It checks your keys, ffmpeg, yt-dlp, Whisper, Redis, the database, Twitch (logs in, finds the GTA 6
category, counts live streams), downloads the top GTA 6 clip and turns it vertical into
`storage/doctor/vertical.mp4` (open it and look), asks the Judge to score a test clip, and refreshes
each connected YouTube/TikTok account. Every line is ✅ / ⚠️ / ❌ with a one-line fix. With Docker:

```bash
docker compose run --rm worker npm run doctor
```

## Launch day (Thursday)

1. Get the newest yt-dlp (Twitch changes often break old versions):
   ```bash
   docker compose build --pull --no-cache
   ```
2. `docker compose up`, open http://localhost:3000, check the Live page cards are green.
3. Approve your streamers early, before they go live, so their chat is read from the start (the spike
   detector needs 2 minutes of normal chat before it can spot a spike).
4. Raise **Min Twitch clip views** in Settings (e.g. 200) once clips pour in, so only the best get made.
5. Built-in safety limits: the line takes no new moments while 12 clips are in progress, grabbing pauses
   when less than 5 GB of disk is free (the Live page says so), and clips you don't use are deleted automatically
   (see "Storage" below). Change with `MAX_BACKLOG` / `MIN_FREE_GB` in `.env`.
6. A faster computer = more clips. One cut takes about a minute on a normal laptop. With 8+ CPU cores, set
   `CUT_CONCURRENCY=2` in `.env`.

## TikTok (≈15 min, once)

TikTok only lets apps that passed its audit post publicly, and its rules rule out clip re-upload tools,
so Clip Factory sends each approved clip to your TikTok **inbox as a draft**: open TikTok, tap the
notification, paste the caption (Copy caption button), post. Limit: 5 waiting drafts per account per day.

1. https://developers.tiktok.com → Manage apps → Connect an app. Add products **Login Kit** and
   **Content Posting API**. Scopes: `user.info.basic`, `user.info.profile`, `video.upload`, `video.list`.
2. Switch the app to **Sandbox**, create a sandbox, and add your TikTok account(s) under Target users
   (up to 10). Sandbox needs no app review.
3. Login Kit → platform **Desktop**, redirect URI `http://localhost:3000/api/tiktok/callback`.
4. Put the Client key and Client secret in `.env` as `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`, restart.
5. Settings → **Connect a TikTok account**. Repeat to add more accounts. Tick "Send draft when I approve"
   to send automatically on Approve.

Not yet confirmed: whether TikTok's sandbox allows inbox drafts. If the first draft fails with a
permission error, submit the app for review (TikTok says several days to two weeks).

## Analytics + the Judge learning

The **Analytics** page compares every post with that account's typical post (2× = twice its usual
views) and breaks results down by Judge score, how the moment was found, streamer, account, length and
posting time. Once 6 posts are a day old, the Judge is shown your best and worst posts with every new
clip, so its scores follow what actually works on your accounts. The exact text it sees is at the bottom
of the Analytics page. Turn it off in Settings → "Learn from my results".

## Phase 2: what changed in the line

Grabber → **Transcribe** → **Judge** → Cutter. The Judge reads the transcript plus the audience
reaction (chat-spike numbers and sample chat, or the Twitch clip's views) and returns a score, an
on-screen hook, a title and hashtags. Clips under **Min score** (default 6) land in the Rejected
tab with the Judge's reason, where you can still rescue them. The Queue is sorted best score first.

**Chat spikes:** every 5 seconds the detector compares the last 10s of each approved live
streamer's chat to the previous ~5 minutes. At 3× (your *Spike sensitivity*), or on a flood of
hype words, it marks the moment, waits ~2.5 min for Twitch's VOD to catch up, and grabs ~45s
around it. It needs the streamer to have past broadcasts (VODs) switched on; if they don't, the
Live page says so and you still get their viewer-made Twitch clips.

## Connect YouTube (≈10 min, once)

1. https://console.cloud.google.com → create a project → *APIs & Services → Library* → enable **YouTube Data API v3**.
2. *OAuth consent screen*: External, fill in the app name and your email, add yourself as a test user.
   Then press **Publish app** (otherwise Google signs you out every 7 days). You'll see an
   "unverified app" warning when you sign in; that's normal for your own app: *Advanced → Go to app*.
3. *Credentials → Create credentials → OAuth client ID → Web application*.
   Authorized redirect URI: `http://localhost:3000/api/youtube/callback`
4. Paste the Client ID and Secret into `.env` as `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`, restart.
5. Dashboard → **Settings → Connect YouTube**, pick your channel.
6. Optional: tick **Post to YouTube when I approve**. The Approve button then reads
   "Approve + post to YouTube", so one click = your sign-off + the upload. Left off, each approved
   clip gets an "Upload to YouTube" button instead.

Good to know: Google allows 100 uploads a day per project. Uploads go out as Shorts (vertical,
under 60s) with the streamer credit and `#Shorts` in the description. Start with visibility set to
**Unlisted** for your first clip to check it looks right, then switch to Public. YouTube view
counts show up on the Posted page every 15 minutes. TikTok and Reels are still Download + Copy caption.

## Captions + branding (v1.9.1)

Every caption is built the same way (`brandedCaption` in `src/lib/social.ts`):

```
<short hook>

🎥 @<streamer>

#GTA6 #GTAVI #ViceCity #GTA6Clips
```

- The hook is the Judge's hook (60 characters max, no hashtags or emoji). The clip's title is set to it too.
- `#GTA6 #GTAVI #ViceCity` are always first. The Judge picks 1 or 2 more from `#GTA6Clips #GTA6Funny #Gaming #StreamerMoments`.
  Without the Judge: funny clips get `#GTA6Funny`, GTA 6 clips `#GTA6Clips`, anything else `#StreamerMoments`.
- YouTube creators are credited with their @handle. The burned-in credit on the video (`twitch.tv/name` / `youtube.com/@name`)
  is unchanged, and YouTube uploads still get the channel link added to the description.
- **Rebuild caption** on a Queue card writes the caption again in this format (after you change a creator's campaign, say).
- Settings → **Your channel**: the channel name (shown in the header, default `ViceCityClips`) and the **watermark**: a small
  see-through `@ViceCityClips` burned into the bottom-right corner of new clips (and re-cuts). Untick it to turn it off.

## Campaign mode (v1.9.1, Whop Content Rewards)

1. Streamers page → **Campaigns** → **+ New campaign**: name, Whop link, the campaign's caption rules (paste them in the box),
   lines that must be in every caption (one per line, e.g. `@kaicenat`, `#ad`, `#KaiCenatClips`), banned words, max length.
2. Pick the campaign in the **Campaign** select next to the creator (Streamers page or their card on the Creators page).
   "+ New campaign…" there makes one named after the creator with their @name already required.
3. New clips from that creator follow the rules by themselves: required lines are added (hashtags go on the hashtag line,
   after `#GTA6 #GTAVI #ViceCity`), banned words are taken out of the hook, the hook is shortened to fit the max length,
   and the Judge reads the rules box when it writes the hook.
4. Each Queue card shows the campaign's checks (✅ / ⚠️). Nothing is blocked: you decide.
5. When you've submitted a post on Whop, paste the link in **Campaign link** on the Posted page (or in the "Posted" form on the
   card). The Posted page can be filtered by campaign.

## The Judge (v1.9.4)

The Judge (Claude) now **looks at the clip**: 8 still frames from the video (2 from the first seconds, 3 around
the big moment, the rest spread out) plus the transcript. It first writes what it sees ("Saw: ..." on each card in
the Queue), then scores on a fixed scale:

| Score | Means |
|---|---|
| 1-3 | nothing happens: menus, loading, AFK, dead talk |
| 4-5 | mildly interesting, no payoff |
| 6 | decent but forgettable |
| 7 | a clear moment a fan would enjoy |
| 8 | a strong moment a stranger would watch to the end |
| 9-10 | rare, instantly shareable |

Most raw clips are not good, so expect many 3-5s. If its last scores all bunch up on one number it gets told to use
the full range. **Analytics** shows how the last 50 scores spread out, the Live page shows "Judge: last 50 clips scored
avg 5.4, range 2-9", and Settings → Judge shows what it costs (roughly 2-4 US cents per clip on Claude Sonnet 5.5; the real number shows there once clips are scored).
If a frame can't be taken, the clip is scored from the text alone (never held up).

## Storage (v1.9.4): auto-delete + another drive

**Clips you don't use delete themselves** (change the times in Settings → Storage):

- Rejected clips (also the ones the Judge scored below the min score): after **6 hours**.
- Clips nobody reviewed: the video after **2 days**; the clip moves to Queue → **Expired**.
- Approved but never posted: the video after **5 days** (the card says "video expired").
- Posted clips: the video after **3 days** (it's on TikTok/YouTube already).
- Raw downloads: as soon as you approve or reject the clip, and at most 6 hours after it was cut. Re-cut needs the raw,
  so re-cut before you decide.
- Rejected and expired clips disappear from the Queue after 7 days. Clips you posted are kept.
- When the drive gets nearly full (under 2 × `MIN_FREE_GB`, so 10 GB), the clean-up runs at once with every time halved
  and deletes the oldest unreviewed videos until there's room again. **Free up space now** on Settings → Storage does the same.

Settings → Storage also shows how much the clips take (raw / finished / edits / work files) and how much is free.

**Store the clips on another drive** (e.g. a big D: drive):

1. Make the folder, e.g. `D:\ClipFactory\storage`.
2. Open `clip-factory\.env` and set this line (forward slashes, no quotes, nothing after it):
   ```
   CLIP_STORAGE_DIR=D:/ClipFactory/storage
   ```
3. Restart Clip Factory (tray icon → Stop, then open it again). Settings → Storage shows the new folder.
4. Optional: to keep the clips you already have, copy the `raw` and `final` folders from the old
   `clip-factory\storage` into the new folder before restarting.

Leave `CLIP_STORAGE_DIR=` empty to keep using `clip-factory\storage`. The tray's own small files (launcher.log, the
icon, flags) stay in `clip-factory\storage` either way. With Docker Desktop on WSL 2 (the default) other drives work
without any File sharing setting.

**Move Docker's own disk too.** Docker's images and the database/Whisper volumes live in Docker Desktop's disk image,
which is on C: by default, and that's usually what fills C:. Docker Desktop → Settings → Resources → Advanced →
**Disk image location** → pick a folder on D: → Apply & restart (Docker moves it for you; it can take a few minutes).

`npm run doctor` prints the storage folder and the free space.
## Channels + Upload (v1.9.5)
- **Channels** (Settings → Channels): a channel is one of your brands, e.g. **ViceCityClips**, with up to one YouTube, one
  TikTok and one Instagram account. What goes on its YouTube goes on its TikTok and Instagram too. Each slot is either
  **Connect** (YouTube / TikTok login, posts for you) or **Add handle** (an account you post to yourself; Instagram is always
  by hand). To add many accounts quickly use **Add an account by handle** at the top: platform + @handle + channel, Add,
  then type the next one. On first start (only when there are no channels yet) Clip Factory sets up your 4 brands with their
  handles: **ViceCityClips** (GTA 6, every type), **StreamHeistClips** (funny), **WantedLevelClips** (gaming), **ClipFactoryGG**
  (edits; its Instagram is switched **Off** because Instagram disabled it: appeal in the app, then press Turn on). Accounts you
  already connected take their brand's slot. Turn off any account (Settings → Channels) and Post to all skips it.
- **Focus + types**: a GTA 6 channel gets every GTA 6 clip (funny, gaming, edits). An "Any game" channel gets clips of the
  types you tick. A clip that fits no channel shows in a "No channel" column on Upload: use its Move to… menu.
- **Upload** (menu, right after Queue; badge = clips still to post): one column per channel (ViceCityClips | StreamHeistClips |
  WantedLevelClips | ClipFactoryGG), each headed by its 3 handles (green dot = connected, amber = by hand, grey = off) and
  "X waiting". Approved clips sit in their channel's column, best first (GTA 6 → ViceCityClips, funny → StreamHeistClips,
  gaming → WantedLevelClips, edits → ClipFactoryGG; **Move to…** on a card moves it), each with its caption + hashtags (copy
  button, campaign checks) and one row per account. **Post to all** uploads to the channel's connected YouTube and sends the
  TikTok draft (one try each, never a second upload); for by-hand accounts press **Download + copy caption** (downloads the
  video and copies the caption in one click), post it in the app, then **Mark posted** (post link + campaign link optional).
  Each connected row also has its own Post to YouTube / Send to TikTok button. A clip leaves the column (and shows on Posted)
  when every account of its channel has it. On a narrow screen (Chromebook) the columns scroll sideways; on a phone they stack.
  The Queue is now mainly for Approve / Reject; its post buttons still work.
- **Posted** and **Analytics** can be filtered by channel (and Posted by platform). Views of YouTube posts you made yourself
  are read from the post link every 15 minutes when `YOUTUBE_API_KEY` is set; type in views for TikTok and Instagram posts you
  made by hand.
- **Suggestions by followers**: Settings → **Connect Twitch (for follower counts)** once (read-only). In your Twitch app
  (dev.twitch.tv → your app) the OAuth Redirect URL must be exactly `http://localhost:3000`. Then suggestions show
  "6.2M followers" with **5M+ / 2M+** badges, "Big only (2M+)" is on by default, "GTA 6 now" shows who is in GTA 6, and
  your top 21 are pinned first when found. Without it suggestions are ranked by viewers. The Creators page shows followers too.

## Settings worth knowing

- **Min Twitch clip views** (default 25): raise it on launch day when there are thousands of clips.
- **Layout**: see "Layouts" below. Auto is the default.

## Layouts

Settings → Clips → **Layout** decides how the wide stream fits the tall video:

- **Auto (recommended)**: looks for the streamer's face in each clip (about 2-3 seconds) and picks one of the three below.
  No face → Blurred background. A big face or a face in the middle (Just Chatting, IRL, face-cam-only streams) → Full
  streamer cam. A small face in a corner (a webcam over the game) → Cam on top + game below. A funny clip with a big
  webcam also gets Full streamer cam; a small corner webcam stays Cam + game (blown up to full screen it would be blurry),
  with the zoom on the streamer's reaction instead.
- **Cam on top + game below**: the webcam fills the top third, the game the rest. The webcam box is found automatically;
  the game part moves a little sideways so no slice of the webcam shows in it. Captions sit just under the line between
  the two, the hook and the credit stay off the face. Zoom: on the cam for funny clips, on the game otherwise.
- **Full streamer cam**: the whole screen is the streamer, face about 40% from the top, following the face slowly if they
  move. Captions sit lower (about 72% down) so they never cover the face.
- **Blurred background**: the whole frame in the middle with a blurred copy behind it (the old default).

Each creator's webcam spot is remembered after a confident find (Streamers and Creators pages show "webcam spot found
automatically" with a **reset** button). To set it yourself, type the box on the Streamers page as `x,y,w,h` fractions of
the frame (webcam in the top-right corner taking a quarter of the width and a third of the height = `0.74,0.02,0.25,0.33`);
a typed box always wins. Any clip can be re-cut in another layout from its Queue card (**Re-cut ▾**: style, layout,
jump cuts on/off). The face check uses OpenCV (installed in the Docker image); if it is missing, clips use the blurred
layout. `CAM_DETECT=off` in `.env` turns the check off.

## Any game

Settings → **Which games** → *Any game (approved streamers)* (the default since v1.8.0; older installs were moved
over once on update). The Scout still lists everyone live in GTA 6, but your **approved** streamers are now tracked (live, chat, spikes, Twitch clips) whatever they
play. The Live page shows the game next to anyone not in GTA 6. Titles and hashtags follow the game
(`#Fortnite` instead of `#GTA6`), and the Judge is told the game. Back to *GTA 6 only* any time.
Same rule as always: only approve streamers who allow clipping or run a clipping campaign.

## YouTube scanner

Clips the **most-replayed** moments of approved YouTube creators' new videos. No API key: it uses
yt-dlp and the "Most replayed" graph YouTube shows on the seek bar.

1. **Only approve creators who allow clipping or run a clipping campaign** (Whop/Vyro campaigns,
   "clips welcome" in their About page…). Same rule as Twitch: the note is your proof.
2. Streamers → **Approve a YouTube channel** → paste `@handle` (or the channel link) + why → Approve.
   It shows up in the approved list with a red *YouTube* badge.
3. Every 30 min (and right after you approve) the scanner looks at each channel's newest long
   videos (Videos tab, so no Shorts), and for each one it hasn't seen: picks the top peaks
   (at least 60s apart, not the first 15s or last 20s) and cuts ~45s around each. Videos without a
   "Most replayed" graph yet are skipped (checked again 6h later), never guessed.
4. Clips land in the Queue with a *YouTube peak* badge. Caption and burned-in credit say
   `youtube.com/@handle`. Nothing posts until you press Approve.

Settings → **YouTube scanner**: on/off, videos per channel (3), moments per video (3), max video
age in days (14). It respects the same backlog cap as the Twitch side. The Live page shows its last run.

## Suggestions

Streamers page → **Suggested for you**: people the agents think are worth approving, mainly big
streamers whose viewers clip a lot. **Nobody is approved automatically** — you still approve each one
yourself (one click).

- Every hour (first scan ~1 min after Clip Factory starts; **Scan now** runs one right away) it looks at
  the top 300 live streams on all of Twitch plus everyone the GTA Scout has seen this week, checks the
  40 biggest (clips viewers made in the last 7 days, top clip views, their Twitch bio) and keeps the best 25.
- Each card says why ("18.2K watching now (Just Chatting)", "viewers made 340 clips this week",
  "top clip 52K views") and whether their **bio or stream title** says clips are OK. Green = there's a
  quote (e.g. "Clips welcome!"), and Approve keeps it as the note. Amber = nothing public found:
  check their About panels / Discord first.
- **Approve** approves them right away (same as the Approve form). **Not now** hides them for 30 days.
- The Streamers tab shows a badge with how many suggestions are waiting; the Live page has a
  *Suggestions* card. Paused Scout (Settings) pauses this too.

### YouTube suggestions

The **YouTube** tab next to **Twitch** suggests big YouTube channels the same way (never approved
automatically, you still press Approve). Each hour, in the same scan, it reads YouTube's trending
charts (overall + Gaming + Entertainment + Comedy, country from Settings → *Suggestions country*, default US),
looks up those channels and keeps the best 25. Cards show subscribers, the trending video, why
("12.4M subscribers", "trending now: '…' (8.1M views)", "2 videos trending") and whether the
**channel description** says clips are OK (green quote = kept as the approval note; amber = check their About page
first). Channels without an @handle are skipped. Approving adds the channel to the YouTube scanner right away.

It needs a free **YouTube API key** (each scan uses ~6 of the 10,000 free daily units):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create or select a project.
2. APIs & Services → Library → search **YouTube Data API v3** → **Enable**.
3. APIs & Services → Credentials → **Create credentials** → **API key**.
4. (Optional) **Restrict key** → API restrictions → YouTube Data API v3 → Save.
5. Put it in `.env` as `YOUTUBE_API_KEY=your-key` (nothing else on the line) and restart Clip Factory.

Without the key the YouTube tab shows these steps and the Twitch part runs as normal. `npm run doctor`
checks the key. "Daily API quota used up" fixes itself at midnight Pacific.

## One-click approve

Approving a creator is one click everywhere: the Streamers forms, the suggestion cards, the **Approve**
button next to unapproved streamers on the Live page and in "Found by the Scout". The note box is optional.
Stored note: what you typed, else the permission quote from their suggestion card, else "Approved by Krew".
Clips still need your Approve in the Queue before anything posts, and every caption + video keeps the credit.

## Workroom

The **Workroom** tab is a live board of the production line (refreshes every 3 seconds): Finding (new
moments) → Downloading → Captions → Judge → Cutting → Ready for you → Posting → Posted. Each card shows
the creator, where the moment came from, the title, how long it has been in that step and the Judge score.
Clips that failed are listed under **Problems** with the error and a **Retry** button. The top strip shows
how many clips are in the line, ready for you, posted today and clips per hour (last 3 hours); when the
line is full (12 clips) it says so and new moments wait. The tab's badge = clips in the line right now.

## Add a list of creators

Streamers page → **Add a list of creators**: type names, one per line (or **Load Krew's top 21**), then
**Find them**. Each name is looked up on Twitch (channel search) and YouTube (with `YOUTUBE_API_KEY`: the
@handle, then a search, biggest matching channel wins; without a key: `youtube.com/@NameWithoutSpaces`).
Exact matches come ticked; a "closest match" is left unticked for you to check. Press **Approve all
ticked** or a row's **Approve**. Nothing is approved until you press one of those.
A creator with the same name on both (e.g. "kaicenat") gets both approved: names only have to be unique per
platform. Running it again is safe: rows that are already approved are left exactly as they are.
Kick isn't supported yet.

## Funny and gaming moments

Every moment and clip is labelled **Funny** (comedy, banter, reactions, funny fails; doesn't have to be a
game) or **Gaming** (plays, clutches, chases). The first guess comes from the source: a chat spike where
laughs (LMAO, KEKW, "I can't", 😂 💀…) are at least half of chat's reactions is funny; a Twitch clip from
Just Chatting / IRL / podcasts / music / art (or with "lmao", "dead", 💀 in its title) is funny; a YouTube
peak is gaming when YouTube files the video under Gaming or its title says gameplay, GTA, Fortnite… and
funny otherwise. The Judge then labels the clip itself, and its label wins.
Settings → **What to clip** has a switch for each kind. Switched off: no new moments of that kind, and
clips already in the line that the Judge labels that kind go to Rejected ("Funny clips are off in Settings").
"Which games" still decides which Twitch streamers are followed; pick **Any game** to get Just Chatting
funny moments. The Queue has **All · Funny · Gaming** tabs and Analytics a **By type** chart.

## Creators page

The **Creators** tab shows everyone you approved, Twitch and YouTube: picture, a live dot and the game when
they're live, when you approved them and your note, and their numbers (moments found, clips made, clips you
approved, posted, views, last clip). Live creators come first, then the ones with the most clips. Search by
name or filter All · Twitch · YouTube · Live now. Per creator: **Open channel**, **See clips** (the Queue
showing only them), **Pause** (stays approved, but no new clips until you press Resume) and **Remove**
(asks once more on the card before taking them off the approved list; clips already made stay).

## Run without Docker (dev)

Needs Node 20+, Redis, ffmpeg, `pip install yt-dlp faster-whisper`.

```bash
npm install && npx prisma db push
```

```bash
npm run worker
```

```bash
npm run build && npm start
```

`npm run db:seed-demo` fills the dashboard with demo clips (remove with `npm run db:seed-demo -- --clear`).
`npm test` runs the tests (includes real ffmpeg renders).

## How it's built

| Agent | File | What it does |
|---|---|---|
| Scout | `src/workers/scout.ts` | Every 2 min: Helix `/streams` for GTA 6, tracks viewers, joins chat (anonymous, read-only) for approved live streamers → chat-heat meter |
| Clips poller | `src/workers/clips.ts` | Every 2 min: Helix `/clips` game-wide + per approved streamer; new clips over the view threshold → Grabber |
| Grabber | `src/workers/grabber.ts` | `yt-dlp` the Twitch clip (or a VOD section) into `storage/raw` |
| Spike detector | `src/workers/spike.ts` | Every 5s: last 10s of chat vs the 5-min baseline → chat Moment with a VOD offset |
| Transcribe + Cutter | `src/workers/cutter.ts` | Whisper transcript, then ffmpeg: 15–45s, 9:16 (Auto / cam + game / full cam / blur, face check in `scripts/detect_cam.py`), captions + hook + credit burned in |
| Judge | `src/workers/judge.ts`, `src/lib/judge.ts` | Claude (`claude-sonnet-5-5`) → `{score, hook_text, title, hashtags, reason}`; below min score = auto-reject |
| Poster | `src/workers/poster.ts`, `src/lib/youtube.ts` | Uploads approved clips to YouTube; syncs view counts |

BullMQ + Redis, one queue per stage. SQLite via Prisma (`prisma/schema.prisma`). Next.js App Router + Tailwind dashboard in `app/`.
