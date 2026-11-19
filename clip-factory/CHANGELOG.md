# Clip Factory patch notes

## 1.9.5 — 2026-11-19
- Channels: your 4 brands (ViceCityClips, StreamHeistClips, WantedLevelClips, ClipFactoryGG) are set up with their YouTube, TikTok and Instagram handles. Connect, change or add more in Settings.
- New Upload page next to the Queue: one column per channel with the clips you approved. Post to all uploads to YouTube and sends the TikTok draft; for the others it is Download + copy caption, then Mark posted. Move to... sends a clip to another channel.
- Posted and Analytics can be looked at per channel and per platform. YouTube views are now tracked from the post link, even for videos you posted yourself.
- Suggestions now put the biggest streamers first, with 5M+ and 2M+ follower badges and a Big only filter. Connect Twitch once in Settings to turn it on.

## 1.9.4 — 2026-11-19
- The Judge now looks at 8 frames of each clip, not just the words, and scores on a clear 1-10 scale. Expect real spread: lots of 3-5s, a few 8+, no more 6 for everything.
- Each clip card shows what the Judge saw ("Saw: ...") under its reason. Analytics shows how its scores spread out, and Settings shows what it costs per clip.
- Clips you don't use delete themselves: rejected after 6 hours, unreviewed after 2 days (they move to Queue > Expired), approved but not posted after 5 days, posted after 3 days.
- Settings > Storage shows how much space clips take and has a Free up space now button. When the drive gets nearly full, old clips are cleaned up early by themselves.
- Store clips on another drive with one line in .env, for example CLIP_STORAGE_DIR=D:/ClipFactory/storage (see README, Storage).

## 1.9.1 — 2026-11-18
- ViceCityClips captions: every caption is now a short hook, then the streamer's @name, then #GTA6 #GTAVI #ViceCity plus 1 or 2 extra hashtags the Judge picks.
- A small see-through @ViceCityClips watermark in the bottom-right corner of new clips. Turn it off or change the name in Settings.
- Campaign mode for Whop Content Rewards: tag a creator with a campaign on the Streamers or Creators page.
- Campaign caption rules are followed automatically (required lines and hashtags, banned words, max length), and each clip card shows a quick check.
- Add the Whop campaign link to posted clips on the Posted page, and filter the Posted page by campaign.

## 1.9.0 — 2026-11-18
- New layout: the streamer's camera on top and the game below. Clip Factory finds the webcam by itself, no box to type in.
- New layout: full streamer cam, where the whole screen is the streamer's face. Used for funny moments and Just Chatting.
- Auto (the new default) looks for the streamer's face in every clip and picks the best layout for it.
- Change the layout in Settings, or re-cut any clip in another layout from its card in the Queue.
- Remembers where each creator's webcam sits, so the next clips are faster. Reset it on the Creators page if they move it.

## 1.8.0 — 2026-11-18
- Any game for everyone by default: your approved creators are clipped whatever they play (you can switch back to GTA 6 only in Settings).
- A fair mix across all your creators: each scan takes at most 2 new clips per creator, one from each in turn, so one or two big channels can't fill the line.
- Only standout clips: a Twitch clip needs way more views than that creator's usual clips (2x by default), from the last 7 days.
- Smarter cut: it finds the reaction (a sudden jump in loudness, a scream, laughing, "no way") instead of just the loudest second, starts at the start of a sentence and ends right after the reaction, 15 to 35 seconds long.
- Stricter Judge that can pick the best part of the video itself. Without an Anthropic key, clips still come to you unscored.
- Jump cuts only cut real silence now (never game sound or music), and much less often; you can turn them off in Settings or re-cut one clip without them.

## 1.7.3 — 2026-11-17
- New editing styles: Hype, Clean and Meme. Pick one in Settings, under Clips. Hype is the new default.
- Captions now pop in word by word and light up the word being said.
- Silences are cut out automatically (jump cuts), so clips get to the point faster.
- Zooms on the big moment, whoosh and boom sound effects, and a progress bar along the bottom.
- Re-cut any clip in another style from its card in the Queue.

## 1.7.2 — 2026-11-17
- Clip Factory now clips funny moments too, not just gaming. Funny clips can come from any stream, like Just Chatting or IRL.
- Every clip gets a Funny or Gaming label. Turn either kind on or off in Settings, under "What to clip".
- When chat bursts out laughing (LMAO, KEKW, crying emojis), that moment is caught and labelled Funny.
- The Queue has new All, Funny and Gaming tabs so you can review one kind at a time.
- New Creators page: everyone you approved on Twitch and YouTube, who is live, and how many clips and views each one made.
- On the Creators page you can pause a creator (no new clips for now), see their clips, or remove them.

## 1.7.1 — 2026-11-17
- Creators with the same name on Twitch and YouTube can now be added on both, like Kai Cenat or IShowSpeed.
- If you added your top creators already, open Streamers, then Add a list, Load top 21, Find them and Approve all again. That adds their YouTube channels.
- Nothing you approved before changes. Running Approve all again never adds anyone twice.

## 1.7.0 — 2026-11-17
- Approving a creator is now one click. No reason needed; you can still add a note if you want.
- New Workroom page: watch every clip move through the line live, from finding to posted.
- The Workroom shows how long each clip has been in each step, and a Retry button for any that got stuck.
- Add a whole list of creators at once: type their names and Clip Factory finds them on Twitch and YouTube.
- Your top 21 creators are ready to load with one button. Tick the ones you want and press Approve.

## 1.6.0 — 2026-11-17
- Clip Factory now has a version number. You can see it at the top of the dashboard and on the tray icon.
- After an update, a little note by the clock tells you the new version. Click it to see what changed.
- New "What's new" page with every update in plain words. Open it from the version badge or the tray menu.
- A small dot on the version badge means there are patch notes you haven't read yet.

## 1.5.0 — 2026-11-17
- Clip Factory now lives by the clock as a pink CF icon. Click it to open the app in its own window.
- Right-click the CF icon to start, stop or update Clip Factory, or to see what it's doing.
- Option to start Clip Factory by itself when Windows starts.
- Suggestions now include trending YouTube channels worth approving. Nothing is approved without you.
- New "Clip Factory Setup" file installs everything and keeps it up to date in one double-click.

## 1.4.0 — 2026-11-17
- "Any game" mode: follow your approved streamers in every game they play, not just GTA 6.
- YouTube scanner: finds the most-replayed moments in approved YouTube channels' videos.
- Suggestions: Twitch streamers worth approving, with the reasons. You still decide.
- One-click launcher that checks for updates by itself every time you open it.

## 1.3.0 — 2026-11-16
- Smarter chat spike detection that ignores bots, raids and sub trains, so fewer fake moments.
- Safety limits so your disk doesn't fill up and the clip line never falls too far behind.
- Old videos are cleaned up automatically.
- A one-command check ("doctor") that tests everything is set up right before launch day.

## 1.2.0 — 2026-11-16
- TikTok: approved clips are sent to your TikTok drafts.
- Post to several YouTube and TikTok accounts.
- New Analytics page showing how your posted clips are doing.
- The Judge learns from your results and gets better at picking winners.

## 1.1.0 — 2026-11-16
- Chat spike detector: spots the moments when a streamer's chat goes wild and clips them.
- The Judge: Claude scores every clip and writes the hook, title and hashtags for you.
- Approved clips can upload straight to YouTube Shorts.

## 1.0.0 — 2026-11-16
- First version of Clip Factory.
- Finds GTA 6 streamers live on Twitch.
- Turns your approved streamers' clips into vertical videos with captions.
- Review queue where you watch each clip and download the ones you like.
