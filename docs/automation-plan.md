# Automation Plan — Patrick's Short-Form Channel Network

Status: **draft — Krew is still correcting this.**

## Decided (don't re-ask)

- **Platforms:** YouTube Shorts, Instagram Reels, TikTok. Every video goes to all three.
- **Format:** short-form only for now — vertical 9:16, ~30–60 seconds.
- **Quality bar:** every video has a strong hook, is genuinely entertaining
  (good animation, humor, sound), and the viewer clearly understands the lesson.
- **Multiple channels:** this is a network. "Video Games Explain the Real
  World" (Minecraft first) is channel #1, not the only one.

## How the network works

One shared pipeline + one config file per channel.

```
channels/
  games-explain-world/     <- channel #1
    channel.yaml           niche, host character, voice, art style, platforms,
                           posting schedule, content rules, account handles
    templates/             intro, caption style, chart style, outro
    clip-library/          labeled gameplay/animation clips
  <next-channel>/
    ...
```

Every agent reads the channel config, so the same Script Writer writes a
Minecraft-economics script for channel #1 and a completely different style
for channel #2. Launching a new channel = new folder + new accounts.

## The pipeline (per video, per channel)

```
Trend Scout → topic ideas → [Krew approves]
  → Script Writer + Fact Checker → 30–60s script with hook → [Krew approves]
  → Storyboard (shot list) → clips pulled from library / Krew records missing shots
  → Voice → Captions → Animated overlays & charts → Sound → Vertical cut
  → Hook & Clarity Critic (scores it; weak drafts go back)
  → Titles, hashtags, cover frame per platform → [Krew approves final]
  → Scheduled posting to YouTube Shorts, Instagram Reels, TikTok
  → Analyst: weekly stats per channel → feeds Trend Scout
```

Krew stays in the loop at 3 approval gates. This keeps quality high and
protects against platforms demonetizing "mass-produced" AI content. Gates can
be loosened per channel once it's proven.

## Tech stack (proposed)

| Job | Tool |
|---|---|
| Agent brains | Claude API / Claude Agent SDK |
| Content board + approvals | Notion or Google Sheets (open question) |
| Voice | ElevenLabs API (one voice per channel host) |
| Overlays, charts, captions, assembly | Remotion (video from code) + FFmpeg |
| Captions/transcripts | Whisper |
| Game footage | OBS + Replay Mod/Flashback, Mine-imator/Blender (see animation playbook) |
| Posting | YouTube Data API, Instagram Graph API (Business/Creator account), TikTok Content Posting API |
| Scheduling | Routines / GitHub Actions |
| Code, configs, plans | This repo |

## Phases

**Phase 0 — Setup (week 1)**
- Channel #1 name + host character.
- Accounts: YouTube, Instagram (Business/Creator), TikTok.
- API keys: Anthropic, ElevenLabs, Google Cloud (YouTube), Meta (Instagram), TikTok developer app.
- Content board. Repo structure with `channels/` configs.

**Phase 1 — Semi-automated first videos (weeks 2–4)**
- Agents produce topics, scripts, shot lists, captions, titles.
- Krew records and edits in CapCut. Post to all 3 platforms manually.
- Goal: ~15 Minecraft shorts; learn which hooks work.

**Phase 2 — Automated production (month 2)**
- Remotion templates (hook text, charts, captions, outro), voice via API,
  auto-assembled vertical cuts, Hook & Clarity Critic.

**Phase 3 — Automated posting + analytics (month 3)**
- Approved videos auto-post on schedule to all 3 platforms.
- Weekly per-channel report.

**Phase 4 — Expand the network (month 4+)**
- More games on channel #1 (Terraria, Roblox → Fortnite, CoD, Pokémon-style, Mario-style).
- Spin successful games into their own channels.
- Launch channel #2+ in new niches.

## Channel idea backlog (for Krew to pick from/correct)

- Video Games Explain the Real World — **live first**
- Per-game spin-offs (Minecraft-only, Fortnite-only, …) once proven
- *(more niches — Krew to decide)*

## Rough cost to start
~$30–75/month (Claude API + ElevenLabs; the rest free-tier). Grows per channel.

## Still open (Krew to answer)
1. Host voice: AI voice or Krew's own?
2. Approval gates: keep all 3?
3. What computer do you have (for recording/rendering)?
4. Content board: Notion or Google Sheets?
5. Posting volume per channel per week?
6. Monthly budget OK at ~$30–75 to start?
7. What other channel niches do you already have in mind?
