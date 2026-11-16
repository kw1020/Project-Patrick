# Clip Factory — GTA 6 launch build

Finds hype moments from approved GTA 6 streamers on Twitch, cuts them into vertical captioned
clips, and queues them for you to approve and post on TikTok / Shorts / Reels.

**Phase 1 (built):** Scout · Twitch Clips poller · Grabber · Cutter · dashboard (Live, Queue, Posted, Streamers, Settings).
**Phase 2 (next):** chat spike detector · Judge (Claude scores each clip) · YouTube auto-upload after approval.

## 1. One-time setup (≈10 min)

1. **Install Docker Desktop**: https://www.docker.com/products/docker-desktop/ (open it once so it's running).
2. **Make a free Twitch developer app**: https://dev.twitch.tv/console/apps → *Register Your Application*
   - Name: anything (e.g. `krew-clip-factory`)
   - OAuth Redirect URL: `http://localhost:3000`
   - Category: *Application Integration* · Client type: *Confidential*
   - Copy the **Client ID**, click *New Secret*, copy the **Client Secret**.
3. In this folder, copy `.env.example` to `.env` and paste the two Twitch values in.
   (`ANTHROPIC_API_KEY` and the YouTube keys are for Phase 2 — leave them empty for now.)

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
| Cutter | `src/workers/cutter.ts` | ffmpeg: trim to 15–45s, 9:16 (blur fill or facecam stack), Whisper captions + credit burned in |

BullMQ + Redis, one queue per stage. SQLite via Prisma (`prisma/schema.prisma`). Next.js App Router + Tailwind dashboard in `app/`.
