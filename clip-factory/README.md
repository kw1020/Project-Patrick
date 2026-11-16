# Clip Factory — GTA 6 launch build

Finds hype moments from approved GTA 6 streamers on Twitch, cuts them into vertical captioned
clips, and queues them for you to approve and post on TikTok / Shorts / Reels.

**Phase 1 (built):** Scout · Twitch Clips poller · Grabber · Cutter · dashboard (Live, Queue, Posted, Streamers, Settings).
**Phase 2 (built):** chat spike detector · Judge (Claude scores each clip, writes the hook/title/hashtags) · YouTube upload after you approve.
**Phase 3 (next):** TikTok API · analytics feeding the Judge · multiple accounts.

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

## Settings worth knowing

- **Min Twitch clip views** (default 25): raise it on launch day when there are thousands of clips.
- **Layout → Facecam on top**: set each streamer's webcam box on the Streamers page as `x,y,w,h`
  fractions of the frame. Example: webcam in the top-right corner taking a quarter of the width
  and a third of the height = `0.74,0.02,0.25,0.33`. Streamers without a box use the blurred layout.

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
| Transcribe + Cutter | `src/workers/cutter.ts` | Whisper transcript, then ffmpeg: 15–45s, 9:16 (blur fill or facecam stack), captions + hook + credit burned in |
| Judge | `src/workers/judge.ts`, `src/lib/judge.ts` | Claude (`claude-sonnet-5-5`) → `{score, hook_text, title, hashtags, reason}`; below min score = auto-reject |
| Poster | `src/workers/poster.ts`, `src/lib/youtube.ts` | Uploads approved clips to YouTube; syncs view counts |

BullMQ + Redis, one queue per stage. SQLite via Prisma (`prisma/schema.prisma`). Next.js App Router + Tailwind dashboard in `app/`.
