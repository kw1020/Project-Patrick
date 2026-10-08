# Project Patrick

Owner: Krew Sutherland. **He doesn't want to repeat himself: read this file and `docs/` before asking questions he's already answered.**

## Vision
A personal "Jarvis" that runs a team of AI agents to help Krew make money (apps, websites, products, content), and
later a business selling these AI services to others. Build in small working steps, test for real, push to GitHub.

## Current goal
Krew made an **Instagram account for his dog** and wants to earn from views. He edits videos on his phone and often
works from **school**, so everything must work from a phone and a school computer.

## What exists
- `video-editor/`: Flask + ffmpeg editor. Upload a video (or **email** one with plain-English instructions),
  get back a 1080x1920 MP4. Remove/clean audio, add music, trim, speed, vertical reframe. Read `video-editor/README.md`.
  Tests: `cd video-editor && .venv/bin/python -m unittest discover -s tests` (39 tests, needs ffmpeg).
- `video-editor/drive_worker.py`: watches a shared Google Drive folder; edits videos using instructions in the file name,
  writes `<name> [edited].mp4` back. Setup in `video-editor/DRIVE_SETUP.md`. (Chat Drive connector can't carry real videos: base64 through context.)
- `render.yaml` + `video-editor/Dockerfile`: deploy to Render as one service (website + email + Drive watchers).
- `docs/instagram-playbook.md`: how views/monetization work, settings, 30-day growth plan.

## Status / what's NOT done
- **Not deployed yet.** Krew must make a Render account and apply the blueprint (steps in `video-editor/README.md`).
  Dockerfile is untested (no Docker daemon in the build sandbox); the gunicorn entry point was tested.
- **Drive watcher untested against real Drive** (logic tested with a fake Drive; Google client libs import fine). Needs OAuth setup by Krew.
- **Email watcher untested against real Gmail.** Needs a dedicated Gmail + App Password. Logic is tested with simulated emails.
- Background *voices* can't be reliably removed (only muted or noise-reduced).
- Work is on branch `claude/confident-cannon-9805ak`; no PR opened (only open one when Krew asks).

## Next ideas (ask Krew which first)
1. Help him deploy and test from his phone.
2. Auto-captions (speech-to-text, burned in): biggest watch-time win.
3. Speech separation (Demucs) to remove background voices.
4. Caption/hashtag drafting in the dog's voice; weekly Insights summary.
5. Start the "team of agents" layer once the editor is live.

## Rules
- Never claim something works unless it was run. Say what wasn't tested.
- Don't suggest copyrighted music; monetization depends on original content.
- Keep the editor simple: Krew asked for "super basic".
