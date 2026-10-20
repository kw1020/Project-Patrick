# Patrick Studio

Patrick's content agent. From the **Studio** tab on your phone you can:

1. **Clip a long video.** Paste a link or upload a video. [OpenShorts](https://github.com/mutonby/openshorts) finds the best moments and cuts them into vertical 9:16 clips with captions burned in.
2. **Make a short from an idea.** Type a topic. Claude writes the script, and [short-video-maker](https://github.com/gyoridavid/short-video-maker) renders a faceless short with voiceover, captions, stock footage and music.
3. **Review.** Each video lands in a queue with TikTok, Instagram and YouTube captions Claude wrote for your niche. Watch it, edit the text, and pick the platforms.
4. **Approve.** Patrick hands the video to [Postiz](https://github.com/gitroomhq/postiz-app), which posts it now or at the time you picked.

Nothing gets posted without you tapping **Approve**.

## What you need

- A computer that stays on and runs [Docker](https://docs.docker.com/get-docker/), with at least **8 GB RAM** (16 GB is better) and **30 GB free disk**. An old PC at home works, or a VPS at about $20-40/month (for example a Hetzner CX42 or a DigitalOcean 16 GB droplet). The free Render plan can't run this, because the video tools need real CPU and RAM.
- Keys (all free except Anthropic, which is pay-per-use):
  - `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com). Writes scripts and captions.
  - `GEMINI_API_KEY` from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). OpenShorts uses it to pick the best moments.
  - `PEXELS_API_KEY` from [pexels.com/api](https://www.pexels.com/api/). Stock footage for faceless shorts.

## Start it

```bash
cd studio
./setup.sh                    # downloads the tools into studio/vendor and creates studio/.env
nano .env                     # fill in ANTHROPIC_API_KEY, PATRICK_PASSCODE, GEMINI_API_KEY, PEXELS_API_KEY
docker compose up -d --build  # the first build takes 10-20 minutes
```

- Patrick: `http://<machine>:3000`, Studio tab
- Postiz: `http://<machine>:4007`

`./setup.sh` also downloads the alternatives we looked at (AI-Youtube-Shorts-Generator, pendpost, Post Bridge, Taisly and PostLake) into `studio/vendor` so you have them for reference. Patrick doesn't run those. Use `./setup.sh --core` to skip them.

## Connect the platforms (one-time)

1. Open Postiz at `:4007`, create your account, then set `POSTIZ_DISABLE_REGISTRATION=true` in `.env` so nobody else can sign up.
2. Each platform needs its own developer app. Put its keys in `.env`, then run `docker compose up -d`. Postiz's own guides walk through each one: [docs.postiz.com/providers](https://docs.postiz.com/providers).
   - **YouTube:** create a Google Cloud project, enable the YouTube Data API v3, create an OAuth client and set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
   - **Instagram:** you need a Business or Creator account. Use a Meta developer app (`FACEBOOK_APP_ID`/`SECRET` for an account linked to a Facebook Page, or `INSTAGRAM_APP_ID`/`SECRET` for Instagram login).
   - **TikTok:** create an app at [developers.tiktok.com](https://developers.tiktok.com) with the Content Posting API and set `TIKTOK_CLIENT_ID` and `TIKTOK_CLIENT_SECRET`. **Until TikTok audits your app, posts can only be private**, which is why `STUDIO_TIKTOK_PRIVACY=SELF_ONLY` is the default. Change it to `PUBLIC_TO_EVERYONE` once TikTok approves the app.
   - TikTok and Meta require an **https** redirect URL. Put the machine behind a domain with HTTPS (Cloudflare Tunnel or Caddy are the easy options) and set `POSTIZ_PUBLIC_URL` to that address.
3. In Postiz, add the TikTok, Instagram and YouTube channels.
4. In Postiz, go to **Settings → Public API** and copy the key into `POSTIZ_API_KEY` in `.env`. Then run `docker compose up -d`.

The Studio tab shows a "Setup needed" card until every piece is connected.

## Settings (`studio/.env`)

| Variable | Purpose |
|---|---|
| `STUDIO_NICHE` | What your channel is about. Claude writes every script and caption for this niche. |
| `STUDIO_VOICE` | Voiceover for shorts: `am_michael`, `am_adam`, `am_eric`, `af_heart`, `bm_george`, and others. |
| `STUDIO_TIKTOK_PRIVACY` | `SELF_ONLY` until your TikTok app passes its audit, then `PUBLIC_TO_EVERYONE`. |
| `SHORTMAKER_TAG` | `latest-tiny` (default, light), `latest` (better quality, needs more RAM) or `latest-cuda` (NVIDIA GPU). |
| `WHISPER_MODEL` | OpenShorts transcription model: `base` is faster, `small` (default) is more accurate. |

## Rules that protect the money

- **Only clip what you own or have rights to.** OpenShorts makes you confirm this, and reposting other people's videos gets copyright strikes and banned accounts.
- **YouTube pays for originality.** Channels that post mass-produced, repetitive AI videos get removed from monetization. The faceless shorts are good for testing ideas. Clips of you, your finds and your commentary are what build a channel that earns.
- **AI labeling.** Patrick marks AI shorts as AI-generated on TikTok automatically. Also turn on YouTube's "altered or synthetic content" label in YouTube Studio for those.
- **Start private, then go public.** Review your first posts on each platform before you trust the pipeline.

## How it fits together

```
phone ── Patrick :3000 ──► OpenShorts      (long video → clips)
                    ├────► short-video-maker (script → short)
                    ├────► Claude API       (scripts, captions)
                    └────► Postiz :4007 ──► TikTok / Instagram / YouTube
```

Patrick checks render jobs every 15 seconds. Finished videos appear in the queue, and the queue is saved in the `patrick-data` volume.

## Troubleshooting

- **"Can't reach OpenShorts / short-video-maker / Postiz"**: run `docker compose ps`, then `docker compose logs -f <service>`.
- **A clip job sits on "rendering" for a long time**: on CPU, OpenShorts takes 5-8 minutes per 8 minutes of video. Watch progress with `docker compose logs -f openshorts`.
- **Postiz says a post failed**: open the post in Postiz to see the platform's own error. Usually a channel needs reconnecting, or TikTok is refusing public posts from an unaudited app.

## Licenses

OpenShorts and short-video-maker are MIT. Postiz is AGPL-3.0. Running it unmodified for yourself is fine, but if you change Postiz's code and offer it to other people as a service, you have to publish your changes. The tools are downloaded into `studio/vendor` (which git ignores), so their code is never copied into this repo.
