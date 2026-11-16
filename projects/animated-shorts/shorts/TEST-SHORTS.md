# Test shorts (2026-11-16): three "What if" Shorts to see which kind does best

Krew asked for 3 test shorts after switching the niche to "What if". Built in one cloud session on the same look
engine as the Emu War. Each folder has `src/videos/<name>/` (the Remotion composition), `voice/` (Kokoro af_heart
x1.2 + word timings), `audio/` (original score + SFX script, finished `mix.m4a`), `meta.json` (title, description,
tags for the uploader) and a 540x960 `*-preview.mp4` with sound.

| Folder | Composition | Length | Test idea |
|---|---|---|---|
| `06-last-person-alive/` | `LastShort` (folder `last`) | 61 s | "you" + big emotional scenario, city set |
| `07-speed-of-sound/` | `SpeedShort` (folder `speed`) | 58 s | "you" + superpower, fast action |
| `03-hole-through-earth/` | `HoleShort` (folder `hole`) | 65 s | pure science, cutaway Earth visuals |

## Final 2K render (local Patrick, GPU), e.g. for 06
From `projects/animated-shorts/remotion-setup/` (after `npm install`):

```bash
mkdir -p src/videos && cp -r ../shorts/06-last-person-alive/src/videos/last src/videos/
```

```bash
npx remotion render src/index.ts LastShort out/last/video.mp4 --codec h264 --crf 16 --scale 1.3333 --gl angle
```

```bash
ffmpeg -i out/last/video.mp4 -i ../shorts/06-last-person-alive/audio/mix.m4a -map 0:v:0 -map 1:a:0 -c:v copy -c:a copy -shortest ../shorts/06-last-person-alive/final.mp4
```

Same for `speed` / `SpeedShort` / `07-speed-of-sound` and `hole` / `HoleShort` / `03-hole-through-earth`.
`src/Root.tsx` registers all four shorts, so copy every `src/videos/<name>` you render.

## Upload (autopost, from the sibling branch `claude/exciting-ptolemy-ju9nif`)
From `projects/animated-shorts/autopost/`:

```bash
python autopost.py add ../shorts/06-last-person-alive/final.mp4 --meta ../shorts/06-last-person-alive/meta.json
```

Post the three on different days, same time, and compare views + "viewed vs swiped away" after 48 h.

## Editing a world
`world.ts` is generated: edit `world_parts.ts.txt`, then from `remotion-setup/` run
`python3 tools/assemble_world.py <claude-animated-shorts>/templates/bridge/world.ts src/videos/<name>/world_parts.ts.txt src/videos/<name>/world.ts "<extra class fields>"`
(the extra fields are listed in the first lines of each `World` class).
