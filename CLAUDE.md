# Project Patrick

Owner: Krew Sutherland. **He doesn't want to repeat himself: read this file and `docs/` before asking questions he's already answered.**

## Vision
A personal "Jarvis" that runs a team of AI agents to help Krew make money (apps, websites, products, content), and
later a business selling these AI services to others. Build in small working steps, test for real, push to GitHub.

## Current goal
Krew made an **Instagram account for his dog** and wants to earn from views. He edits videos on his phone and often
works from **school**, so everything must work from a phone and a school computer.
**The main purpose of the editor (his words): remove background talking and keep only the dog's sounds** (breathing,
whining, etc.). That's `dogaudio.py`, the default audio mode everywhere.

## What exists
- `video-editor/`: Flask + ffmpeg editor. Upload a video (or **email** one with plain-English instructions),
  get back a 1080x1920 MP4. Remove/clean audio, add music, trim, speed, vertical reframe. Read `video-editor/README.md`.
  Tests: `cd video-editor && .venv/bin/python -m unittest discover -s tests` (59 tests, needs ffmpeg; 8 end-to-end audio tests need `pip install espeakng-loader` or they skip).
- `video-editor/drive_worker.py`: watches a shared Google Drive folder; edits videos using instructions in the file name,
  writes `<name> [edited].mp4` back. Setup in `video-editor/DRIVE_SETUP.md`. (Chat Drive connector can't carry real videos: base64 through context.)
- `render.yaml` + `video-editor/Dockerfile`: deploy to Render as one service (website + email + Drive watchers).
- `docs/instagram-playbook.md`: how views/monetization work, settings, 30-day growth plan.

## Status / what's NOT done
- **Not deployed yet.** Krew must make a Render account and apply the blueprint (steps in `video-editor/README.md`).
  Dockerfile is untested (no Docker daemon in the build sandbox); the gunicorn entry point was tested.
- **Drive watcher untested against real Drive** (logic tested with a fake Drive; Google client libs import fine). Needs OAuth setup by Krew.
- **Email watcher untested against real Gmail.** Needs a dedicated Gmail + App Password. Logic is tested with simulated emails.
- **Dog-sounds mode (`video-editor/dogaudio.py`) is NOT validated on real dog audio.** It uses Silero VAD to silence
  talking moments (it can't separate overlapping sounds, and may cut voice-like whines). Tested only on espeak speech
  + synthetic whine/breathing. The sandbox could reach only PyPI, so no real recordings were available. First priority:
  get Krew's real feedback ("voices still audible?" -> strict; "dog sounds cut?" -> gentle) and tune `LEVELS` in dogaudio.py.
  Chat Drive connector can't carry real videos, so can't test on his footage in-session unless tiny.
- Lesson from this build: a unit test passed while bridging was broken (padding hid it). Check numbers, not just "OK".
- Work is on branch `claude/confident-cannon-9805ak`; no PR opened (only open one when Krew asks).

## Krew's deployment checklist (update the current step when he reports progress)
**Current step: 1** (he has not confirmed anything yet; Claude can't see his screen, only what he tells it).
1. Make a Render account (render.com, sign in with GitHub, let it see `kw1020/Project-Patrick`).
2. New+ > Blueprint > pick the repo and branch `claude/confident-cannon-9805ak`.
3. Set `PATRICK_PASSWORD` (long); leave `EMAIL_*` and `GDRIVE_*` blank for now.
4. Wait for the build; copy the `.onrender.com` address. Dockerfile has never been built: if it fails, get the error text and fix it.
5. Open it on his phone, log in, upload a short clip.
6. Try "dog sounds only" on a real clip; he reports what he hears (voices left -> strict, dog cut -> gentle).
Later, optional: email setup (dedicated Gmail + App Password), Drive setup (`video-editor/DRIVE_SETUP.md`).
He asked Claude to control his screen. The session he used had no computer-use tools and the account has only the one
cloud environment. To get screen control he needs the Claude desktop app (Computer use on) or claude.ai with a Device picked.

## Next ideas (ask Krew which first)
1. Help him deploy and test from his phone.
2. Auto-captions (speech-to-text, burned in): biggest watch-time win.
3. Tune dog-sounds mode on real footage; maybe add pitch cues so high-pitched whines are protected from the VAD.
4. Caption/hashtag drafting in the dog's voice; weekly Insights summary.
5. Start the "team of agents" layer once the editor is live.

## Rules
- Never claim something works unless it was run. Say what wasn't tested.
- Don't suggest copyrighted music; monetization depends on original content.
- Keep the editor simple: Krew asked for "super basic".
