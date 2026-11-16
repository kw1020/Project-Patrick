# Autopost: one Short a day, automatically

Built 2026-11-16 because Krew said: make the channel, auto-upload a video every day, start with one
channel and add a second after week one.

**How it works.** When a Short finishes rendering on Krew's PC, it goes into a queue. Every day at
3 PM, Windows runs `autopost.py run`. That uploads everything queued and gives each Short its own
day at **5:00 PM Mountain**. YouTube then publishes them one per day. The PC only needs to be on to
upload, not at posting time: with a week of Shorts uploaded, the channel keeps posting with the PC off.

Uses the official YouTube Data API. Since 2 Nov 2026, uploads from unaudited personal API projects
can be public or scheduled (before that they were stuck on private). The free quota is 100 uploads a day.

## Krew: one-time setup (about 20 minutes, on your PC)

**1. Make the channel** (2 min)
YouTube > your picture > Settings > "Add or manage your channel(s)" > Create a channel.
Name **True & Ridiculous**, handle **@TrueAndRidiculous**. Then follow `../channel/CHANNEL.md`
(logo, banner, description, and "not made for kids").

**2. Get the Google key file** (10 min, once ever; it covers channel 2 too)
1. console.cloud.google.com > New project > name it `Patrick Autopost`.
2. APIs & Services > Library > **YouTube Data API v3** > Enable.
3. Google Auth Platform > Get started: app name `Patrick Autopost`, your email, Audience **External**.
4. Audience > **Publish app** (to "In production"). This matters: in "Testing" mode Google signs
   you out every 7 days and uploads stop.
5. Clients > Create client > **Desktop app** > Download JSON. Save it in this folder as
   `client_secret.json`.

**3. Sign in** (2 min)
```bash
pip install -r requirements.txt
```
```bash
python autopost.py auth history
```
A browser opens. Google will say the app isn't verified (it's your own app): Advanced > Go to
Patrick Autopost. **Pick the True & Ridiculous channel**, not your personal one.

**4. Turn on the daily run** (1 min, PowerShell in this folder)
```bash
powershell -ExecutionPolicy Bypass -File install_windows_task.ps1
```

## Every new Short (Patrick does this after each render)
```bash
python autopost.py add <rendered.mp4> --meta meta/01-emu-war.json
```
Titles, descriptions and tags for batch 01 are in `meta/`. Copy one for each new Short.
`add` refuses horizontal videos and anything over 3 minutes, since those wouldn't count as Shorts.
To post right away instead of waiting for 3 PM, run `python autopost.py run`.

## Checking on it
- `python autopost.py status`: what's posted, what's scheduled, what's queued, any alerts.
- `python autopost.py stats`: views, likes and comments per Short (for the week-1 review).
- `state/ALERTS.txt`: written when fewer than 3 days of Shorts are left, an upload fails, or the
  sign-in expires. Local Patrick should read it daily and tell Krew.
- `python autopost.py run --dry-run`: shows what would be scheduled, uploads nothing.

## Adding channel 2 (after week 1)
In `channels.json`, fill in channel2's name and handle and set `"enabled": true`. Then:
```bash
python autopost.py auth channel2
```
Queue its Shorts with `--channel channel2`. It posts at 6 PM so the two channels don't land at the same minute.

## Files
`autopost.py` the tool · `channels.json` settings · `meta/` per-video titles · `test_autopost.py`
tests (`python -m unittest test_autopost.py`) · `install_windows_task.ps1` daily task.
Never committed (see `.gitignore`): `client_secret.json`, `state/` (sign-ins, history), `queue/`, `done/`.
