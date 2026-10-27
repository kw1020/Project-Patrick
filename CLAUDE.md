# Project Patrick — notes for Claude sessions

Owner: Krew Sutherland. Krew hates repeating themself — read this first.

## Two different "Claudes"
- **Patrick (local)** runs on Krew's own computer. It has its own tools, including
  `watch_video` (added 2026-09-19), Kokoro voice, Patrick's Gmail and calendar.
  Its memory backups land in Google Drive daily as `patrick-mind-YYYYMMDD-HHMM.zip`
  (chatlog/, patrick_memory.md, profile.md, goals.md, jobs.json).
- **Cloud Claude Code sessions** (like this repo's sessions) do NOT have `watch_video`;
  they use the `watch` skill below instead.

## Watching videos in cloud sessions: the `watch` skill
- `.claude/skills/watch/` is the MIT-licensed watch skill from
  github.com/bradautomates/claude-video (copied at commit 03ceb42). When Krew sends a
  video, USE IT: `python3 .claude/skills/watch/scripts/watch.py "<url-or-path>" --question "..."`
  then Read every frame it lists. Full instructions are in its SKILL.md.
- URLs need yt-dlp: if `command -v yt-dlp` finds nothing, `pip install yt-dlp` first.
- Local files work out of the box (ffmpeg frames, verified 2026-10-27). Audio needs
  either the Gemini engine (`GEMINI_API_KEY` env var + generativelanguage.googleapis.com
  allowed) or a Groq/OpenAI key; WhisperX can't install here (huggingface.co blocked).
- Krew's videos usually sit in Google Drive. The Drive connector caps downloads at
  **10 MB** and drive.google.com is blocked by default, so a big Drive video needs
  drive.google.com + drive.usercontent.google.com allowed in the environment's network
  settings and the file shared as "anyone with the link"; then pass the link to watch.py.
- If those aren't set up, fall back to local Patrick, or screenshots / a Google Doc.
- Patrick's Gmail (connected here) is krew2128@gmail.com; Krew sends from krew252@gmail.com.
