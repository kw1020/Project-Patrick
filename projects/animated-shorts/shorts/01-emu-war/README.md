# Short 01: The Great Emu War (1932)

Script: `../../scripts/SCRIPTS-batch-01.md` #01 (approved by Krew 2026-11-16).
Built 2026-11-16 in a cloud session on top of the claude-animated-shorts look engine.

## What's here
- `voice/`: narration. `voice.wav` = Kokoro **af_heart** at speed 1.25 (65.4 s), made by `tts.py` from `lines.txt`.
  `words.json` = word timings (syllable split snapped to quiet gaps, made by `words.py`). Everything is timed to it.
- `src/videos/emu/`: the Remotion composition `EmuShort` (1080x1920, 30 fps, 1990 frames = 66.3 s).
  - `story.ts`: shots, cuts, cameras, kicks, lens blur, story kinematics (chase, scatter, marbles).
  - `world.ts`: the 3D set (farms, track, waterhole, windpump, houses, porch, truck, Lewis guns, crates, rock, gum trees).
  - `cast.ts` + `cast_base.ts`: who's on screen per shot. `emu.ts`: our own emu drawing. `toon.ts`: + slouch hat,
    DIGGER / MAJOR / FARMER outfits.
  - `ink.ts lensblur.ts grade.ts shade.ts lights.ts cardshade.ts paint.ts build.ts Bridge.tsx`: the template's look
    engine, unchanged (MIT, github.com/mromidev/claude-animated-shorts).
- `audio/emu_audio.py`: original march score + synthesized SFX timed to the cut, ducked under the voice, mixed to
  -14 LUFS. `mix.m4a` is the finished mix. Needs `numpy scipy`. Rebuild: `python3 audio/emu_audio.py voice/voice.wav audio/mix.wav`.

## Final 2K render (local Patrick, with a GPU)
From `projects/animated-shorts/remotion-setup/`:

```bash
npm install
```

```bash
mkdir -p src/videos && cp -r ../shorts/01-emu-war/src/videos/emu src/videos/
```

```bash
npx remotion render src/index.ts EmuShort out/emu/video.mp4 --codec h264 --crf 16 --scale 1.3333 --gl angle
```

```bash
ffmpeg -i out/emu/video.mp4 -i ../shorts/01-emu-war/audio/mix.m4a -map 0:v:0 -map 1:a:0 -c:v copy -c:a copy -shortest emu-war-final.mp4
```

Expect ~10 min on a GPU. Without a GPU, `GL=swangle node video.mjs out.mp4 0 1989 0.5 0.5 2` makes a 540x960
preview in ~45 min (that's how the preview was made).

## Preview
- `emu-war-preview.mp4`: 540x960 preview with the final sound mix (cloud render, 2026-11-16).

## Upload
- Title: **The Australian Army Lost a War to Emus**
- Description: In 1932, Australia sent soldiers with machine guns to fight 20,000 emus. The emus won.
  Sources: Australian War Memorial; Wikipedia "Emu War". #shorts #history #emuwar #australia #funnyhistory
- No "altered or synthetic content" label needed (cartoon animation, not realistic).
