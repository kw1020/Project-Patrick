# Channel 1: True & Ridiculous

Set up 2026-11-16. Niche: crazy true history stories, animated (Krew said yes to the niche).
Name picked by Patrick because Krew hadn't chosen one; swap it any time (change `channels.json` too).

| | |
|---|---|
| Name | **True & Ridiculous** |
| Handle | **@TrueAndRidiculous** (was free on 2026-11-16) |
| Backups if taken | History Misfires @MisfireHistory · The Unlucky History @TheUnluckyHistory · History Flops @TheHistoryFlops |
| Logo | `avatar.png` (800x800) |
| Banner | `banner.png` (2560x1440, text inside the phone-safe area) |
| Posting | 1 Short a day, 5:00 PM Mountain (7 PM Eastern), automatic (see `../autopost/README.md`) |

Art is placeholder. Once the Emu War Short is rendered, a frame of the smug emu makes a better logo.
Regenerate with `python make_art.py`.

## Description (paste into YouTube Studio > Customization > Basic info)

```
History is stranger than anything anyone could make up.

Armies that lost to birds. A marathon won on rat poison. A warship that sank before it left the harbour.
Every Short here is a real story, fact-checked and animated.

New Short every day.
```

## Keywords (Studio > Settings > Channel > Basic info)
`history, true stories, animated history, history shorts, funny history, weird history, history facts, true story animation`

## Settings to set once (Studio > Settings)
- **Channel > Advanced settings > Audience:** "No, set this channel as not made for kids". (Cartoons get
  flagged as kids' content otherwise, which kills comments and ad money.)
- **Upload defaults > Advanced:** category Education, language English.
- **Channel > Basic info > Country:** United States.
- **Verify the channel** (youtube.com/verify, a phone code) so custom thumbnails work.

## Channel 2 (after week 1)
Krew's call: start with one channel; after week one, start a second. `channels.json` already has a
`channel2` slot, switched off. At the week-1 review we look at channel 1's numbers
(`python autopost.py stats`) and pick channel 2's niche, then flip `enabled` to true and run `auth channel2`.
