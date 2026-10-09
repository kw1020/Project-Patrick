# Patrick Video Editor

Send a video in, get a Reel-ready video back. Three ways in:

- **Web app**: open it on your phone, upload, pick edits, download.
- **Email**: send a clip to the Patrick inbox with plain-English instructions; the edited video comes back by email.
- **Google Drive**: drop a video in a shared folder (instructions in the file name); the edit appears next to it.
  Best for big files and school computers. Setup: [DRIVE_SETUP.md](DRIVE_SETUP.md).

Every edit outputs a 1080×1920 (9:16) H.264/AAC MP4 with loudness set for Instagram.

## What it can do

| Edit | Notes |
|---|---|
| **Dog sounds only** (default) | Silences the moments when people are talking and keeps everything else: breathing, whining, panting. See below. |
| Remove original audio | Mutes everything. Pair it with music. |
| Clean up noise | High-pass + FFT denoise. Fixes hiss, wind, hum. **It cannot reliably remove speech.** |
| Add music | Pick from `music/`, upload your own, or attach it to the email. Loops to fit, fades out, and ducks under the original audio when both are kept. |
| Trim, speed (0.5–2×) | |
| Vertical reframe | "Keep all" puts the full frame over a blurred background; "fill" crops to 9:16. |

## Dog sounds only: what it really does

A small speech detector listens for human talking. Those moments are faded out; the rest of the audio is untouched.
In email or a Drive file name add `gentle` or `strict` to tune it; on the website it's under "More options".

- **It removes moments, not voices.** If your dog whines *while* someone is talking, that whine is removed with the talking.
- **It can mistake a voice-like whine for speech** and cut it. `gentle` removes less and fixes most of this.
- **Voices still audible?** Use `strict`. Quiet, far-away talking is the hardest to catch.
- Every edit reports what it did ("Removed 12.4s of talking in 3 spots"), so you can sanity-check it. Check this the first few times.
- Gaps where talking was removed are silent. Add music (`music: name`) if that sounds odd.
- Tested only on synthetic stand-ins (computer speech plus made-up breathing/whining), **never on real dog recordings**.
  The test numbers: talking was removed completely and dog-like sounds kept; `normal` also clipped about half a second of a
  voice-like synthetic whine, `strict` clipped two harmless spots, `gentle` was clean. Real footage will differ. Tell me what you hear.
- Needs `numpy` and `pysilero-vad` (in `requirements.txt`). Uses roughly 100 MB of memory and under a second per clip.
- Loudness normalization is skipped in this mode; it would boost quiet breathing into loud hiss.

## Setup

```bash
cd video-editor
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # also needs ffmpeg installed
cp .env.example .env    # then edit it
```

### Web app
```bash
set -a; source .env; set +a
.venv/bin/python app.py          # http://localhost:8000
```
The app refuses to start without `PATRICK_PASSWORD`. Anyone who can reach it can run ffmpeg on uploads,
so don't expose it to the internet without that password, and put it behind HTTPS (Render, Fly.io, or a
Cloudflare Tunnel all do this) before using it away from home.

### Email
1. Make a **new Gmail account just for Patrick** (don't use your personal one).
2. Turn on 2-step verification, then create an **App Password** (Google Account → Security → App passwords).
3. Put the address and app password in `.env` (`EMAIL_ADDRESS`, `EMAIL_APP_PASSWORD`). `ALLOWED_SENDERS` is the
   list of addresses allowed to use it. Everyone else is ignored with no reply.
4. `.venv/bin/python email_worker.py` (must keep running; deploy it next to the web app).

Email instructions go in the subject or body, any order:

```
mute
music: chill
trim 0:03-0:15
speed 1.5
crop
```
Emails max out around 25 MB, so use the web app for long or high-res clips.

Forged "From" addresses are rejected: the receiving server must report DKIM or SPF pass
(`REQUIRE_AUTH_RESULTS=0` disables this, don't).

## Put it online (so it works from school, phone, any computer)

The app has to run on a server with a public address. One service runs both the website and the email watcher.
The repo includes a Dockerfile and a `render.yaml` blueprint for [Render](https://render.com):

1. Make a Render account (sign in with GitHub) and let it see the `kw1020/Project-Patrick` repo.
2. **New + → Blueprint →** pick the repo and the branch with this code → **Apply**.
3. When it asks for values, fill in:
   - `PATRICK_PASSWORD`: what you'll type to log in. Make it long.
   - `EMAIL_ADDRESS`, `EMAIL_APP_PASSWORD`, `ALLOWED_SENDERS`: the email setup above. Leave them blank for web-only.
4. Wait a few minutes for the build. Render gives you an address like `https://patrick-video-editor.onrender.com`.
   Open it on your phone, add it to your home screen, done.

**Free plan caveats** (Render's terms as of Oct 2026, check [render.com/docs/free](https://render.com/docs/free)):
- It **sleeps after 15 idle minutes** and takes about a minute to wake on the next visit. While asleep the email
  watcher is off too, so emails sit unread until it wakes.
- To keep it awake for email, either upgrade to the paid **Starter** instance (always on; change `plan: free` to
  `plan: starter` in `render.yaml`), or point a free uptime pinger (e.g. UptimeRobot) at `/healthz` every 5 minutes.
  Free instances get 750 hours/month, which is enough for one always-on service.
- Free instances have very little CPU. On a 4-core test machine a 20-second clip takes about 10 seconds to edit, and
  the video encode is the slow part, so expect several times longer on a free instance. Starter is faster. Measure it before relying on it.
- Files are deleted when it restarts. Download your edit when it finishes; there's no permanent storage.
- Music you want available by name (`music: chill`) must be committed to `music/` (remove the `music/*` line from `.gitignore`).
  Uploading a track with each video always works.

**From school:** school Wi-Fi sometimes blocks sites it doesn't recognise, and email attachments are capped near 25 MB.
If the site is blocked, use your phone's data or try email. If a clip is too big for email, use the website.

## Tests
```bash
.venv/bin/python -m unittest discover -s tests -v
```

## Not built yet (good next steps)
- Auto-captions (speech-to-text, burned in): big for watch time since most people watch muted.
- True source separation, to keep the dog's noises even while people are talking over them. This needs a large AI model
  (hundreds of MB, too heavy for a small free server), so it's a separate, later project.
- Auto-posting to Instagram via Meta's Graph API (needs a Business/Creator account linked to a Facebook Page).
