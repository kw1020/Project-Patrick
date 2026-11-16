#!/usr/bin/env python3
"""Patrick's YouTube autoposter: one Short a day per channel, hands-off.

How it works: every rendered Short goes into a queue. `run` uploads each queued Short as a
private video with a publish time (status.publishAt) on the next free daily slot, so YouTube
itself publishes one a day. The PC only has to be on when uploading, not at posting time.
Since 2 Nov 2026, uploads from unaudited API projects can be public or scheduled.

Commands:
  python autopost.py auth  <channel>                    one-time Google sign-in for a channel
  python autopost.py add   <video.mp4> --meta <meta.json> [--channel <id>]
  python autopost.py run   [--dry-run]                   upload + schedule everything queued
  python autopost.py status                              calendar, queue, alerts
  python autopost.py stats [--channel <id>]              views/likes/comments per posted Short

Files (all next to this script):
  channels.json               channel settings (which are on, post time, timezone)
  client_secret.json          Google OAuth client (Desktop app) - Krew downloads it once
  state/<channel>/token.json  sign-in for that channel (never commit)
  state/<channel>/posted.json every upload: video id, title, publish time
  queue/<channel>/<NNN-slug>/ video.mp4 + meta.json (+ optional thumb.jpg/png), posted in name order
  done/<channel>/             queue folders move here after upload
  state/ALERTS.txt            problems Patrick should tell Krew about (low buffer, sign-in expired)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]
MAX_SHORT_SECONDS = 180


# ---------------------------------------------------------------- config / state

def load_channels() -> dict:
    return json.loads((BASE / "channels.json").read_text(encoding="utf-8"))


def channel_cfg(cid: str) -> dict:
    chans = load_channels()["channels"]
    if cid not in chans:
        sys.exit(f"Unknown channel '{cid}'. Known: {', '.join(chans)}")
    return chans[cid]


def default_channel() -> str:
    chans = load_channels()["channels"]
    on = [c for c, v in chans.items() if v.get("enabled")]
    return (on or list(chans))[0]


def is_live(cfg: dict, today: dt.date) -> bool:
    """A channel posts once it's enabled and its start_date (if any) has arrived."""
    if not cfg.get("enabled"):
        return False
    start = cfg.get("start_date")
    return not start or dt.date.fromisoformat(start) <= today


def state_dir(cid: str) -> Path:
    d = BASE / "state" / cid
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_posted(cid: str) -> list[dict]:
    p = state_dir(cid) / "posted.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def write_posted(cid: str, rows: list[dict]) -> None:
    (state_dir(cid) / "posted.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")


def alert(msg: str) -> None:
    (BASE / "state").mkdir(exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(BASE / "state" / "ALERTS.txt", "a", encoding="utf-8") as f:
        f.write(f"[{stamp}] {msg}\n")
    print(f"ALERT: {msg}")


# ---------------------------------------------------------------- scheduling

def next_slots(posted: list[dict], cfg: dict, now: dt.datetime, count: int) -> list[dt.datetime]:
    """The next `count` free daily posting times (aware datetimes in the channel's timezone).

    One Short per day at cfg["post_time"]. Starts the day after the latest scheduled post,
    or today if today's slot is still at least `min_lead_minutes` away (YouTube needs time to
    process the upload before publishAt).
    """
    tz = ZoneInfo(cfg.get("timezone", "America/Denver"))
    hh, mm = (int(x) for x in cfg.get("post_time", "17:00").split(":"))
    lead = dt.timedelta(minutes=int(cfg.get("min_lead_minutes", 90)))
    now = now.astimezone(tz)

    taken = {dt.datetime.fromisoformat(r["publish_at"]).astimezone(tz).date()
             for r in posted if r.get("publish_at")}
    day = now.date()
    if taken:
        day = max(day, max(taken) + dt.timedelta(days=1))
    slots = []
    while len(slots) < count:
        t = dt.datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)
        if t - now >= lead and day not in taken:
            slots.append(t)
        day += dt.timedelta(days=1)
    return slots


def days_buffered(posted: list[dict], now: dt.datetime) -> int:
    """How many future posts are already scheduled on YouTube."""
    return sum(1 for r in posted
               if r.get("publish_at") and dt.datetime.fromisoformat(r["publish_at"]) > now)


# ---------------------------------------------------------------- video checks

def probe(video: Path) -> dict | None:
    """Width, height, seconds via ffprobe; None if ffprobe isn't installed."""
    if not shutil.which("ffprobe"):
        return None
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:format=duration", "-of", "json", str(video)],
        capture_output=True, text=True)
    if out.returncode != 0:
        return {"error": out.stderr.strip() or "ffprobe failed"}
    j = json.loads(out.stdout)
    s = (j.get("streams") or [{}])[0]
    return {"width": s.get("width"), "height": s.get("height"),
            "seconds": float(j.get("format", {}).get("duration", 0))}


def short_problems(info: dict | None) -> list[str]:
    if info is None:
        return []
    if "error" in info:
        return [f"unreadable video: {info['error']}"]
    probs = []
    if info["width"] and info["height"] and info["width"] > info["height"]:
        probs.append(f"horizontal ({info['width']}x{info['height']}), YouTube won't treat it as a Short")
    if info["seconds"] > MAX_SHORT_SECONDS:
        probs.append(f"{info['seconds']:.0f}s long, Shorts max is {MAX_SHORT_SECONDS}s")
    return probs


def validate_meta(meta: dict) -> list[str]:
    probs = []
    title = meta.get("title", "")
    if not title:
        probs.append("meta.json has no title")
    if len(title) > 100:
        probs.append(f"title is {len(title)} chars (max 100)")
    if re.search(r"[<>]", title + meta.get("description", "")):
        probs.append("title/description contain < or >, which YouTube rejects")
    if len(meta.get("description", "").encode("utf-8")) > 5000:
        probs.append("description over 5000 bytes")
    if sum(len(t) + 2 for t in meta.get("tags", [])) > 500:
        probs.append("tags over 500 characters total")
    return probs


# ---------------------------------------------------------------- Google API

def youtube(cid: str, interactive: bool = False):
    from google.auth.exceptions import RefreshError
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    tok = state_dir(cid) / "token.json"
    creds = Credentials.from_authorized_user_file(str(tok), SCOPES) if tok.exists() else None
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except RefreshError:
            creds = None
    if not creds or not creds.valid:
        if not interactive:
            alert(f"[{cid}] YouTube sign-in missing or expired. Run: python autopost.py auth {cid}")
            return None
        from google_auth_oauthlib.flow import InstalledAppFlow
        secret = BASE / "client_secret.json"
        if not secret.exists():
            sys.exit(f"Missing {secret}. Follow step 2 in autopost/README.md to download it.")
        flow = InstalledAppFlow.from_client_secrets_file(str(secret), SCOPES)
        creds = flow.run_local_server(port=0, prompt="consent",
                                      authorization_prompt_message="Opening Google sign-in: pick the channel's account.")
    tok.write_text(creds.to_json(), encoding="utf-8")
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def upload(yt, video: Path, meta: dict, publish_at: dt.datetime | None, thumb: Path | None) -> str:
    from googleapiclient.http import MediaFileUpload

    body = {
        "snippet": {
            "title": meta["title"],
            "description": meta.get("description", ""),
            "tags": meta.get("tags", []),
            "categoryId": str(meta.get("category_id", "27")),
            "defaultLanguage": meta.get("language", "en"),
            "defaultAudioLanguage": meta.get("language", "en"),
        },
        "status": {
            # Scheduled posts must be uploaded private; YouTube flips them public at publishAt.
            "privacyStatus": "private" if publish_at else meta.get("privacy", "public"),
            "selfDeclaredMadeForKids": bool(meta.get("made_for_kids", False)),
            "containsSyntheticMedia": bool(meta.get("synthetic_media", False)),
            "embeddable": True,
            "license": "youtube",
        },
    }
    if publish_at:
        body["status"]["publishAt"] = publish_at.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    media = MediaFileUpload(str(video), mimetype="video/mp4", chunksize=8 * 1024 * 1024, resumable=True)
    req = yt.videos().insert(part="snippet,status", body=body, media_body=media, notifySubscribers=True)
    resp = None
    while resp is None:
        status, resp = req.next_chunk(num_retries=5)
        if status:
            print(f"    {int(status.progress() * 100)}%")
    vid = resp["id"]
    if thumb:
        try:
            yt.thumbnails().set(videoId=vid, media_body=MediaFileUpload(str(thumb))).execute()
        except Exception as e:  # thumbnail is a nice-to-have; never fail the post over it
            print(f"    thumbnail skipped: {e}")
    return vid


# ---------------------------------------------------------------- commands

def queue_items(cid: str) -> list[Path]:
    q = BASE / "queue" / cid
    return sorted(p for p in q.iterdir() if p.is_dir()) if q.exists() else []


def find_thumb(item: Path) -> Path | None:
    for name in ("thumb.jpg", "thumb.jpeg", "thumb.png"):
        if (item / name).exists():
            return item / name
    return None


def cmd_auth(a) -> None:
    channel_cfg(a.channel)
    yt = youtube(a.channel, interactive=True)
    me = yt.channels().list(part="snippet", mine=True).execute().get("items", [])
    if not me:
        sys.exit("Signed in, but that Google account has no YouTube channel. Create the channel first.")
    ch = me[0]
    handle = ch["snippet"].get("customUrl", "")
    print(f"Signed in to '{ch['snippet']['title']}' {handle} ({ch['id']})")
    expected = channel_cfg(a.channel).get("handle", "").lower()
    if expected and handle and handle.lower() != expected:
        print(f"WARNING: channels.json expects {expected}. If this is the wrong channel, delete "
              f"state/{a.channel}/token.json and run auth again, choosing the right channel.")
    (state_dir(a.channel) / "channel.json").write_text(json.dumps(
        {"id": ch["id"], "title": ch["snippet"]["title"], "handle": handle}, indent=2), encoding="utf-8")


def cmd_add(a) -> None:
    cid = a.channel or default_channel()
    channel_cfg(cid)
    video, meta_path = Path(a.video), Path(a.meta)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    probs = validate_meta(meta) + short_problems(probe(video))
    if probs:
        sys.exit("Not queued:\n  - " + "\n  - ".join(probs))
    q = BASE / "queue" / cid
    q.mkdir(parents=True, exist_ok=True)
    taken = [p.name for p in queue_items(cid)] + [p.name for p in (BASE / "done" / cid).glob("*")]
    nums = [int(n[:3]) for n in taken if n[:3].isdigit()]
    slug = re.sub(r"[^a-z0-9]+", "-", meta["title"].lower()).strip("-")[:40]
    item = q / f"{(max(nums) + 1 if nums else 1):03d}-{slug}"
    item.mkdir()
    shutil.copy2(video, item / "video.mp4")
    (item / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    if a.thumb:
        shutil.copy2(a.thumb, item / ("thumb" + Path(a.thumb).suffix.lower()))
    print(f"Queued {item.relative_to(BASE)}. `python autopost.py run` will schedule it.")


def cmd_run(a) -> None:
    chans = load_channels()["channels"]
    now = dt.datetime.now(dt.timezone.utc)
    for cid, cfg in chans.items():
        if not is_live(cfg, now.astimezone(ZoneInfo(cfg.get("timezone", "UTC"))).date()):
            print(f"[{cid}] not live yet, skipping")
            continue
        posted = read_posted(cid)
        items = queue_items(cid)
        horizon = int(cfg.get("max_days_ahead", 30))
        slots = next_slots(posted, cfg, now, len(items))
        print(f"[{cid}] {len(items)} queued, {days_buffered(posted, now)} already scheduled")
        yt = None
        si = 0  # a slot is only used up by a Short that actually gets scheduled
        for item in items:
            slot = slots[si]
            if (slot - now).days > horizon:
                print(f"  {item.name}: next slot {slot:%a %d %b} is past max_days_ahead, leaving it queued")
                break
            meta = json.loads((item / "meta.json").read_text(encoding="utf-8"))
            video = item / "video.mp4"
            probs = validate_meta(meta) + short_problems(probe(video))
            if probs:
                alert(f"[{cid}] {item.name} not posted: " + "; ".join(probs))
                continue
            print(f"  {item.name} -> {slot:%a %d %b %H:%M %Z}: {meta['title']}")
            if a.dry_run:
                si += 1
                continue
            yt = yt or youtube(cid)
            if yt is None:
                break
            try:
                vid = upload(yt, video, meta, slot, find_thumb(item))
            except Exception as e:
                alert(f"[{cid}] upload failed for {item.name}: {e}")
                break
            posted.append({"video_id": vid, "title": meta["title"], "item": item.name,
                           "publish_at": slot.isoformat(), "uploaded_at": now.isoformat()})
            write_posted(cid, posted)
            dest = BASE / "done" / cid
            dest.mkdir(parents=True, exist_ok=True)
            shutil.move(str(item), str(dest / item.name))
            si += 1
            print(f"    uploaded https://youtube.com/shorts/{vid}")
        left = days_buffered(posted, now) + (len(queue_items(cid)) if a.dry_run else 0)
        warn = int(cfg.get("warn_when_days_left", 3))
        if left < warn:
            alert(f"[{cid}] only {left} day(s) of Shorts left. Render more and `add` them.")


def cmd_status(a) -> None:
    now = dt.datetime.now(dt.timezone.utc)
    for cid, cfg in load_channels()["channels"].items():
        tz = ZoneInfo(cfg.get("timezone", "UTC"))
        posted = read_posted(cid)
        live = "LIVE" if is_live(cfg, now.astimezone(tz).date()) else "off"
        print(f"\n[{cid}] {cfg.get('name')} {cfg.get('handle', '')} ({live})")
        for r in posted[-14:]:
            t = dt.datetime.fromisoformat(r["publish_at"]).astimezone(tz)
            mark = "posted " if t <= now else "planned"
            print(f"  {mark} {t:%a %d %b %H:%M}  {r['title']}  https://youtube.com/shorts/{r['video_id']}")
        print(f"  {days_buffered(posted, now)} scheduled ahead, {len(queue_items(cid))} waiting in queue")
    alerts = BASE / "state" / "ALERTS.txt"
    if alerts.exists() and alerts.read_text(encoding="utf-8").strip():
        print("\nAlerts (state/ALERTS.txt):\n" + "".join(alerts.read_text(encoding="utf-8").splitlines(True)[-10:]))


def cmd_stats(a) -> None:
    cids = [a.channel] if a.channel else [c for c, v in load_channels()["channels"].items() if v.get("enabled")]
    for cid in cids:
        posted = read_posted(cid)
        if not posted:
            print(f"[{cid}] nothing posted yet")
            continue
        yt = youtube(cid)
        if yt is None:
            continue
        ids = [r["video_id"] for r in posted]
        stats = {}
        for i in range(0, len(ids), 50):
            for v in yt.videos().list(part="statistics,status", id=",".join(ids[i:i + 50])).execute()["items"]:
                stats[v["id"]] = v
        print(f"\n[{cid}] views  likes  comments  title")
        for r in posted:
            v = stats.get(r["video_id"])
            if not v:
                print(f"  (missing)  {r['title']}")
                continue
            s = v["statistics"]
            print(f"  {int(s.get('viewCount', 0)):>6} {int(s.get('likeCount', 0)):>6} "
                  f"{int(s.get('commentCount', 0)):>8}  {r['title']} [{v['status']['privacyStatus']}]")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("auth"); s.add_argument("channel"); s.set_defaults(fn=cmd_auth)
    s = sub.add_parser("add"); s.add_argument("video"); s.add_argument("--meta", required=True)
    s.add_argument("--channel"); s.add_argument("--thumb"); s.set_defaults(fn=cmd_add)
    s = sub.add_parser("run"); s.add_argument("--dry-run", action="store_true"); s.set_defaults(fn=cmd_run)
    s = sub.add_parser("status"); s.set_defaults(fn=cmd_status)
    s = sub.add_parser("stats"); s.add_argument("--channel"); s.set_defaults(fn=cmd_stats)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
