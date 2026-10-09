"""Email in, edited video out.

Email a clip (and optionally a music file) to the Patrick inbox. The subject/body can hold
plain-English requests like "mute, trim 0:03-0:15, music: chill". The edited video is
emailed back to you.

Run:  python email_worker.py        (settings come from environment variables, see .env.example)
"""
from __future__ import annotations

import email
import imaplib
import logging
import os
import smtplib
import tempfile
import threading
import time
from email.message import EmailMessage
from email.policy import default as default_policy
from email.utils import parseaddr
from pathlib import Path

import editor
from editor import AUDIO_EXTS, VIDEO_EXTS, EditError

log = logging.getLogger("patrick.email")
MAX_REPLY_BYTES = 24 * 1024 * 1024  # Gmail's limit is 25 MB including encoding overhead


def sender_authenticated(msg: EmailMessage) -> bool:
    """The From header is trivial to forge, so also require the receiving server to have
    verified the sender (DKIM or SPF pass)."""
    results = " ".join(str(h) for h in msg.get_all("Authentication-Results", [])).lower()
    return "dkim=pass" in results or "spf=pass" in results


def _attachments(msg: EmailMessage):
    for part in msg.iter_attachments():
        name = part.get_filename()
        if name:
            yield Path(name).name, part


def handle_message(msg: EmailMessage, workdir: Path, music_dir: Path,
                   allowed: set[str], require_auth: bool = True) -> EmailMessage | None:
    """Turn one incoming email into a reply (or None to stay silent). No network access here."""
    sender = parseaddr(msg.get("From", ""))[1].lower()
    if sender not in allowed or (require_auth and not sender_authenticated(msg)):
        log.warning("Ignoring email from %r", sender)
        return None  # strangers get no reply, so Patrick can't be used to spam anyone

    video = music = None
    for name, part in _attachments(msg):
        ext = Path(name).suffix.lower()
        if ext in VIDEO_EXTS and video is None:
            video = workdir / f"input{ext}"
            video.write_bytes(part.get_payload(decode=True))
        elif ext in AUDIO_EXTS and music is None:
            music = workdir / f"music{ext}"
            music.write_bytes(part.get_payload(decode=True))

    reply = EmailMessage()
    reply["To"] = sender
    reply["Subject"] = "Re: " + (msg.get("Subject") or "your video")
    if msg.get("Message-ID"):
        reply["In-Reply-To"] = reply["References"] = msg["Message-ID"]

    if video is None:
        reply.set_content("I didn't find a video attached. Attach an MP4 or MOV and send it again.\n"
                          "Tip: emails max out around 25 MB. For bigger files use the web app.")
        return reply

    body = msg.get_body(preferencelist=("plain",))
    text = (msg.get("Subject") or "") + "\n" + (body.get_content() if body else "")
    opts, notes = editor.parse_commands(text, music_dir)
    if music is not None:
        opts.music = music
        notes.append("Added the music file you attached")
    if not notes:
        notes.append("Made it vertical 9:16 (no other edits requested)")

    try:
        out = workdir / "output.mp4"
        result = editor.process(video, out, opts)
    except EditError as e:
        reply.set_content(f"I couldn't edit that video: {e}")
        return reply

    if result.get("audio_note"):
        notes.append(result["audio_note"])
    summary = "\n".join(f"• {n}" for n in notes)
    if result["size_bytes"] > MAX_REPLY_BYTES:
        reply.set_content(f"Your video is edited, but it's too big to email back "
                          f"({result['size_bytes'] // 1_000_000} MB).\n{summary}\n\n"
                          "Try a shorter clip, or use the web app for long videos.")
        return reply
    reply.set_content(f"Here's your edited video ({result['duration']}s).\n\n{summary}\n")
    reply.add_attachment(out.read_bytes(), maintype="video", subtype="mp4", filename="patrick-edit.mp4")
    return reply


def _settings() -> dict:
    s = {k: os.environ.get(k, "") for k in ("EMAIL_ADDRESS", "EMAIL_APP_PASSWORD", "ALLOWED_SENDERS")}
    if not all(s.values()):
        raise SystemExit("Set EMAIL_ADDRESS, EMAIL_APP_PASSWORD and ALLOWED_SENDERS (see .env.example).")
    s["allowed"] = {a.strip().lower() for a in s["ALLOWED_SENDERS"].split(",") if a.strip()}
    s["imap_host"] = os.environ.get("IMAP_HOST", "imap.gmail.com")
    s["smtp_host"] = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    s["poll"] = int(os.environ.get("POLL_SECONDS", 30))
    s["music_dir"] = Path(os.environ.get("MUSIC_DIR", Path(__file__).parent / "music"))
    s["require_auth"] = os.environ.get("REQUIRE_AUTH_RESULTS", "1") != "0"
    return s


def check_inbox(cfg: dict) -> int:
    handled = 0
    with imaplib.IMAP4_SSL(cfg["imap_host"]) as imap:
        imap.login(cfg["EMAIL_ADDRESS"], cfg["EMAIL_APP_PASSWORD"])
        imap.select("INBOX")
        _, data = imap.search(None, "UNSEEN")
        for num in data[0].split():
            _, fetched = imap.fetch(num, "(RFC822)")  # also marks it read, so it's never processed twice
            msg = email.message_from_bytes(fetched[0][1], policy=default_policy)
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    reply = handle_message(msg, Path(tmp), cfg["music_dir"], cfg["allowed"], cfg["require_auth"])
                    if reply is not None:
                        reply["From"] = cfg["EMAIL_ADDRESS"]
                        with smtplib.SMTP_SSL(cfg["smtp_host"]) as smtp:
                            smtp.login(cfg["EMAIL_ADDRESS"], cfg["EMAIL_APP_PASSWORD"])
                            smtp.send_message(reply)
                        handled += 1
            except Exception:
                log.exception("Failed on one email; continuing")
    return handled


def email_configured() -> bool:
    return all(os.environ.get(k) for k in ("EMAIL_ADDRESS", "EMAIL_APP_PASSWORD", "ALLOWED_SENDERS"))


def run_forever(cfg: dict) -> None:
    log.info("Watching %s for videos from %s", cfg["EMAIL_ADDRESS"], ", ".join(sorted(cfg["allowed"])))
    while True:
        try:
            n = check_inbox(cfg)
            if n:
                log.info("Edited and replied to %d email(s)", n)
        except Exception:
            log.exception("Inbox check failed; will retry")
        time.sleep(cfg["poll"])


def start_background() -> threading.Thread | None:
    """Start the watcher as a daemon thread (used by the web service). No-op if email isn't set up."""
    if not email_configured():
        log.info("Email settings not set; email watcher not started")
        return None
    thread = threading.Thread(target=run_forever, args=(_settings(),), name="email-watcher", daemon=True)
    thread.start()
    return thread


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    run_forever(_settings())


if __name__ == "__main__":
    main()
