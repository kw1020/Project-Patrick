# Project: Animated YouTube Shorts

Started 2026-11-16. Krew's call: post animated content on YouTube Shorts.

**Decision 2026-11-16: Brism is too expensive (Krew checked the Whop page). Use the free
claude-animated-shorts skill instead (see "Main tool" below).** Brism notes kept for reference.

## What Brism is (researched 2026-11-16)
- Made by Dominik Sabo (@sabodominik_ on Instagram). Tagline: "Faceless YouTube videos with Claude."
- **Runs on your own Claude subscription.** It gives Claude an "animation studio" that goes from
  script to final render: every shot, the voice and the sound.
- Styles shown: 8-bit pixel art, liminal horror, Lego, PS1 game, 2D cartoon, low-poly 3D, Roblox,
  3D cutaway, motion graphics, 3D map/terrain explainers. "Show it any video and Claude makes that style."
- Formats he's pushing: Roblox stories, 3D "how a pile of bamboo becomes a house" survival builds,
  3D lazy-river style scenes, map explainers.
- Access: waitlist / early access at **whop.com/brism/brism-57** (or comment BRISM on his posts).
  Said "launches this week" on 2026-11-06. Price not public yet.
- His claims (unverified, they're marketing): ~800K views/month on one channel, $1,000+ in two weeks
  after monetizing; 9M+ views/month across his automated channels.
- Unknown until we have access: whether it's a Claude Code plugin/skill or an MCP connector, whether
  it renders locally (likely, so it'd run on **local Patrick**, not cloud sessions), and its price.

## Main tool: claude-animated-shorts (free)
- github.com/mromidev/claude-animated-shorts, MIT. Checked 2026-11-16: repo is real, 36 MB,
  SKILL.md + full source of a proven 67 s short ("The Bridge That Fell for a Song").
- Look: flat 2D cartoon characters in a painted 3D world, ink outlines, gliding cameras, music + SFX.
  55-70 s vertical. Best fit: true history / science stories.
- Needs: Node + Remotion (`@remotion/three`), Python 3, ffmpeg. Install to `~/.claude/skills/cartoon-3d-short/`.
- Voice: any `voice.wav` + word timings. Free options: Krew's own voice (best for YouTube's
  "authentic content" rule) or local Patrick's Kokoro voice, then free Whisper for timings.
- Runs on local Patrick (Kokoro + big disk). Set `REMOTION_TMP` to a big drive (~1.3 GB per bundle).
- Cost per video: $0 beyond the Claude subscription Krew already has.

## Test render (cloud session, 2026-11-16): it works
- `remotion-setup/` holds a working Remotion project shell: `package.json` with exact versions,
  `src/index.ts`, `src/Root.tsx` (BridgeShort + a "Cube" WebGL sanity test) and `stills.mjs`.
  Setup: `npm install`, copy the skill's `templates/bridge/` to `src/videos/bridge/`, then
  `node stills.mjs out/x_ 100,400 0.5`.
- **Must pin `@react-three/postprocessing` to 3.0.4.** Version 3.2.x builds the effect composer one
  tick late, so every single-frame render comes out as a blank sky-blue frame.
- Missing Kenney `.glb` props just 404 and get skipped; the scene still renders.
- Speed: in a cloud session (4 CPUs, no GPU, `GL=swangle`) a half-size frame takes ~15-45 s, so a full
  short (~2,000 frames) would take ~19 h. **Render finals on local Patrick with a GPU (`GL=angle`).**
  The skill's author gets ~4 fps at 2K on a GPU (~10 min per short).
- `test-render-sheet.jpg`: six frames of the skill's own bridge example rendered here. It's the
  author's example, for checking the look only; never post it.

## Other free backups
- **claude-faceless-shorts-creator** (learnwithhasan, MIT, free): Claude Code + Remotion + ElevenLabs.

## Rules YouTube enforces (these decide if we get paid)
- Shorts = vertical, up to 3 minutes. Over 1 minute, any Content ID music claim blocks the video,
  so use our own or licensed music.
- YouTube Partner Program demonetizes **"inauthentic" / mass-produced, repetitive** content. Every
  Short needs a real story, original script and our own characters, not a template with swapped words.
- Animation doesn't need the "altered or synthetic content" label (only realistic fakes do).
- Don't copy other creators' characters, IP or Roblox/Lego trademarks in a way that looks official.
- YPP for Shorts: 1,000 subs + 10M Shorts views in 90 days (or 4,000 watch hours long-form).

## Plan
1. **Install the free skill on local Patrick**: clone github.com/mromidev/claude-animated-shorts to
   `~/.claude/skills/cartoon-3d-short/`, install Remotion + `@remotion/three`, Node, Python 3, ffmpeg.
2. **Pick one niche + one style** and stick to it for 30 videos. Candidates: survival builds
   (3D, "how X becomes a house"), Roblox-style story drama, map/history explainers, liminal horror.
3. **Make a new channel** for it (not Krew's personal one), with name, logo, banner.
4. **Cadence:** 1-3 Shorts a day for 30 days. Patrick writes scripts and renders, Krew reviews
   and posts (or schedules in YouTube Studio).
5. **Track** views, retention (% viewed vs swiped away) and subs per video; double down on what
   works after ~15 videos.
6. **Later:** once the system works, sell it (done-for-you channels, templates or a course),
   which is Krew's bigger plan for Project Patrick.

## Open decisions (Krew)
- Niche: **true history stories** (Krew said yes, 2026-11-16).
- Approve scripts in `scripts/SCRIPTS-batch-01.md` (Emu War, 1904 marathon, Pisa, Vasa, Molasses Flood).
- Channel name.
- Voice: Krew's own voice or Patrick's Kokoro voice.

## Log
- 2026-11-16: niche = true history. Wrote batch 01 (5 scripts, 62-66 s). Test-rendered the skill's
  template in the cloud: works after pinning @react-three/postprocessing 3.0.4; too slow without a GPU.
- 2026-11-16: Brism ruled out on price; switched to claude-animated-shorts.
- 2026-11-16: project started; Brism researched; no Brism access yet (nothing in Patrick's Gmail).
