# Patrick Video Editor

Send a video in, get a Reel-ready video back. Two ways in:

- **Web app**: open it on your phone, upload, pick edits, download.
- **Email**: send a clip to the Patrick inbox with plain-English instructions; the edited video comes back by email.

Every edit outputs a 1080×1920 (9:16) H.264/AAC MP4 with loudness set for Instagram.

## What it can do

| Edit | Notes |
|---|---|
| Remove original audio | The reliable way to get rid of people talking in the background. Pair it with music. |
| Clean up noise | High-pass + FFT denoise. Fixes hiss, wind, hum. **It cannot reliably remove speech.** |
| Add music | Pick from `music/`, upload your own, or attach it to the email. Loops to fit, fades out, and ducks under the original audio when both are kept. |
| Trim, speed (0.5–2×) | |
| Vertical reframe | "Keep all" puts the full frame over a blurred background; "fill" crops to 9:16. |

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

## Tests
```bash
.venv/bin/python -m unittest discover -s tests -v
```

## Not built yet (good next steps)
- Auto-captions (speech-to-text, burned in): big for watch time since most people watch muted.
- Real speech separation (e.g. Demucs) to pull out background voices while keeping the dog or main sound.
- Auto-posting to Instagram via Meta's Graph API (needs a Business/Creator account linked to a Facebook Page).
