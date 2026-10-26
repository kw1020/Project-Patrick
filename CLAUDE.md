# Project Patrick — notes for Claude sessions

Owner: Krew Sutherland. Krew hates repeating themself — read this first.

## Two different "Claudes"
- **Patrick (local)** runs on Krew's own computer. It has its own tools, including
  `watch_video` (added 2026-09-19), Kokoro voice, Patrick's Gmail and calendar.
  Its memory backups land in Google Drive daily as `patrick-mind-YYYYMMDD-HHMM.zip`
  (chatlog/, patrick_memory.md, profile.md, goals.md, jobs.json).
- **Cloud Claude Code sessions** (like this repo's sessions) do NOT have `watch_video`.

## Videos in cloud sessions — what actually works
- Drive connector: reads Docs, PDFs, PNG/JPEG only; downloads capped at **10 MB**.
- drive.google.com and huggingface.co are blocked by the network policy, so no
  direct download and no Whisper models (no audio transcription).
- ffmpeg is available: a video under 10 MB in Drive can be downloaded and split into
  frames to read what's on screen (no audio).
- Anything bigger, or where the audio matters: send it to **local Patrick** to watch,
  or ask Krew for screenshots / a Google Doc / pasted text.
- Patrick's Gmail (connected here) is krew2128@gmail.com; Krew sends from krew252@gmail.com.
