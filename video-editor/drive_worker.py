"""Google Drive in, edited video out.

Drop a video into the shared "Patrick" Drive folder. Patrick edits it and puts
"<name> [edited].mp4" next to it. Put instructions in the file NAME, in plain English:

    zoomies mute music: chill trim 0:03-0:15.mp4

If something goes wrong you get "<name> [error].txt" explaining why. Nothing is ever deleted or overwritten.

Needs Google OAuth credentials for a dedicated Patrick Google account (see DRIVE_SETUP.md).
"""
from __future__ import annotations

import io
import logging
import os
import re
import resource
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import editor
import email_worker
from editor import EditError

log = logging.getLogger("patrick.drive")
EDITED, ERROR, WORKING, ANALYSIS = " [edited]", " [error]", " [working]", " [analysis]"
SETTLE_SECONDS = 30  # ignore files modified very recently, in case an upload is still finishing
SCOPES = ["https://www.googleapis.com/auth/drive"]
FOLDER_ID = re.compile(r"^[A-Za-z0-9_-]{10,}$")
STATUS_NAME = "Patrick status.txt"
STARTED = time.time()
LAST_POLL: dict = {}      # what the most recent look at the Drive folder found
LAST_ERROR: dict = {}     # the most recent problem, if any
WATCH: dict = {}          # which folders this watcher was told to use (set at startup)
_published = {"stable": None, "at": 0.0}


class GoogleDrive:
    """Thin wrapper over the Drive API. The poller only uses these three methods, so tests can swap in a fake."""

    def __init__(self, client_id: str, client_secret: str, refresh_token: str):
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        creds = Credentials(None, refresh_token=refresh_token, client_id=client_id, client_secret=client_secret,
                            token_uri="https://oauth2.googleapis.com/token", scopes=SCOPES)
        self._svc = build("drive", "v3", credentials=creds, cache_discovery=False)

    def list_children(self, folder_id: str) -> list[dict]:
        files, token = [], None
        while True:
            resp = self._svc.files().list(
                q=f"'{folder_id}' in parents and trashed = false", pageSize=200, pageToken=token,
                fields="nextPageToken, files(id, name, mimeType, size, modifiedTime)",
                supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
            files += resp.get("files", [])
            token = resp.get("nextPageToken")
            if not token:
                return files

    def download(self, file_id: str, dest: Path) -> None:
        from googleapiclient.http import MediaIoBaseDownload
        request = self._svc.files().get_media(fileId=file_id, supportsAllDrives=True)
        with dest.open("wb") as fh:
            downloader = MediaIoBaseDownload(fh, request, chunksize=8 * 1024 * 1024)
            done = False
            while not done:
                _, done = downloader.next_chunk()

    def write_text(self, folder_id: str, name: str, text: str) -> None:
        """Create the file, or replace its contents if a file with that name is already in the folder."""
        from googleapiclient.http import MediaIoBaseUpload
        media = MediaIoBaseUpload(io.BytesIO(text.encode()), mimetype="text/plain")
        existing = [f for f in self.list_children(folder_id) if f["name"] == name]
        if existing:
            self._svc.files().update(fileId=existing[0]["id"], media_body=media, supportsAllDrives=True).execute()
        else:
            self._svc.files().create(body={"name": name, "parents": [folder_id]}, media_body=media,
                                     fields="id", supportsAllDrives=True).execute()

    def trash(self, file_id: str) -> None:
        self._svc.files().update(fileId=file_id, body={"trashed": True}, supportsAllDrives=True).execute()

    def upload(self, folder_id: str, path: Path, name: str, mimetype: str) -> str:
        from googleapiclient.http import MediaFileUpload
        media = MediaFileUpload(str(path), mimetype=mimetype, resumable=True)
        created = self._svc.files().create(body={"name": name, "parents": [folder_id]}, media_body=media,
                                           fields="id", supportsAllDrives=True).execute()
        return created["id"]


def _stem(name: str) -> str:
    return Path(name).stem


def _is_settled(modified: str, now: datetime) -> bool:
    try:
        when = datetime.fromisoformat(modified.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now - when).total_seconds() >= SETTLE_SECONDS


def poll_once(drive, folder_id: str, music_dir: Path, max_mb: int = 500, now: datetime | None = None,
              output_folder_id: str | None = None, notify=None) -> int:
    """Edit every new video in the folder. Returns how many files were handled (edited or errored).

    Results go to output_folder_id (or beside the original if not given). notify(subject, body), if given,
    is called once per finished video so you get told; if it breaks, the editing still counts.
    """
    now = now or datetime.now(timezone.utc)
    out_id = output_folder_id or folder_id
    children = drive.list_children(folder_id)
    names = [c["name"] for c in children] + ([c["name"] for c in drive.list_children(out_id)] if out_id != folder_id else [])
    handled = 0
    LAST_POLL.clear()
    LAST_POLL.update(at=now.strftime("%H:%M:%S UTC"), folder_items=len(children), videos=[], waiting=[])

    def tell(subject: str, body: str) -> None:
        if notify is None:
            return
        try:
            notify(subject, body)
        except Exception:
            log.exception("Couldn't send the notification (the video is still done)")

    for f in children:
        name = f["name"]
        if not f.get("mimeType", "").startswith("video/") or EDITED in name or ERROR in name:
            continue
        stem = _stem(name)
        if any(n.startswith(stem + m) for n in names for m in (EDITED, ERROR, ANALYSIS)):
            LAST_POLL["videos"].append(f"{name}: already done (a result or error note exists), skipped")
            continue  # already done (or already failed once; rename the file to retry)
        if not _is_settled(f.get("modifiedTime", ""), now):
            LAST_POLL["videos"].append(f"{name}: changed in the last {SETTLE_SECONDS}s (maybe still uploading), will retry")
            continue
        LAST_POLL["videos"].append(f"{name}: to do now")
        LAST_POLL["waiting"].append(name)

        log.info("Editing %s", name)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            marker = _put_marker(drive, out_id, tmp, stem)
            try:
                if int(f.get("size", 0)) > max_mb * 1024 * 1024:
                    raise EditError(f"That video is over {max_mb} MB. Trim or compress it and try again.")
                src = tmp / ("input" + (Path(name).suffix.lower() or ".mp4"))
                drive.download(f["id"], src)
                if re.search(r"\banalyz[es]e?\b", stem.lower()):  # report only: quick, and shows how the audio looks to the detector
                    import dogaudio
                    info = editor.probe(src)
                    report = dogaudio.format_analysis(dogaudio.analyze(src, 0, min(info.duration, dogaudio.MAX_SECONDS)))
                    (tmp / "analysis.txt").write_text(report)
                    new_id = drive.upload(out_id, tmp / "analysis.txt", f"{stem}{ANALYSIS}.txt", "text/plain")
                    log.info("Analysed %s", name)
                    link = f"https://drive.google.com/file/d/{new_id}/view" if isinstance(new_id, str) else "(in your finished folder)"
                    tell(f"Patrick analysed: {name}", f"The audio report is ready:\n{link}")
                    handled += 1
                    continue
                opts, notes = editor.parse_commands(stem, music_dir)
                result = editor.process(src, tmp / "out.mp4", opts)
                new_id = drive.upload(out_id, tmp / "out.mp4", f"{stem}{EDITED}.mp4", "video/mp4")
                summary = "\n".join([f"• {n}" for n in notes] + ([f"• {result['audio_note']}"] if result.get("audio_note") else []))
                if summary:  # a short "what I did" note next to the video, so you can check Patrick's work
                    (tmp / "notes.txt").write_text(f"What Patrick did to {name}:\n{summary}\n")
                    drive.upload(out_id, tmp / "notes.txt", f"{stem} [notes].txt", "text/plain")
                link = f"https://drive.google.com/file/d/{new_id}/view" if isinstance(new_id, str) else "(in your finished folder)"
                tell(f"Patrick finished: {name}",
                     f"Your edited video is ready:\n{link}\n\n{summary or 'Made it vertical (no other edits).'}\n\n"
                     "Watch it before you post it. If voices are audible or dog sounds got cut, tell Patrick and it can be redone.")
                log.info("Done %s (%ss): %s", name, result["duration"], "; ".join(notes) or "default edit")
            except Exception as e:  # tell the user in Drive instead of failing silently
                LAST_ERROR.update(at=now.strftime("%H:%M:%S UTC"), video=name, what=f"{type(e).__name__}: {str(e)[:300]}")
                reason = str(e) if isinstance(e, EditError) else "Something went wrong while editing."
                if not isinstance(e, EditError):
                    log.exception("Failed on %s", name)
                note = tmp / "error.txt"
                note.write_text(f"Couldn't edit {name}.\n{reason}\n\nRename the file and it will be tried again.\n")
                drive.upload(out_id, note, f"{stem}{ERROR}.txt", "text/plain")
                tell(f"Patrick couldn't edit: {name}", f"{reason}\n\nRename the file in Drive and Patrick will try again.")
            finally:
                _drop_marker(drive, marker)
        handled += 1
    return handled


def status_text() -> str:
    """A plain-text snapshot of what the watcher sees, so problems can be diagnosed without reading server logs."""
    p = LAST_POLL
    lines = [f"Patrick status (Drive watcher)",
             f"Updated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
             f"Version: {os.environ.get('RENDER_GIT_COMMIT', 'unknown')[:7]}",
             f"Uptime: {int(time.time() - STARTED)} seconds (a small number that keeps resetting means the server keeps restarting)",
             f"Memory used by the Python process: {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MB (limit on the free plan: 512 MB)",
             f"Drop folder (where you put videos) ends in: ...{WATCH.get('drop', '?')[-8:]}",
             f"Results go to the folder ending in: ...{WATCH.get('out', '?')[-8:]}",
             f"Last look at the drop folder: {p.get('at', 'not yet')}",
             f"Items in the drop folder: {p.get('folder_items', '?')}"]
    if WATCH.get("drop") and WATCH.get("drop") == WATCH.get("out"):
        lines.append("Note: results are saved in the same folder the videos come from (no separate finished folder is set).")
    lines += [f"  - {v}" for v in p.get("videos", [])] or ["  (no videos)"]
    if LAST_ERROR:
        lines.append(f"Last problem: {LAST_ERROR.get('at')} while handling {LAST_ERROR.get('video')}: {LAST_ERROR.get('what')}")
    else:
        lines.append("Last problem: none since this version started")
    return "\n".join(lines) + "\n"


def publish_status(drive, out_id: str) -> bool:
    """Write the status note to Drive when something changed, and at least every 5 minutes. Returns True if it wrote."""
    body = status_text()
    stable = "\n".join(l for l in body.splitlines() if not l.startswith(("Updated:", "Uptime:", "Memory used", "Last look")))
    if stable == _published["stable"] and time.time() - _published["at"] < 300:
        return False
    drive.write_text(out_id, STATUS_NAME, body)
    _published.update(stable=stable, at=time.time())
    log.info("Status: %s", " | ".join(l.strip() for l in stable.splitlines()[2:] if l.strip()))
    return True


def _put_marker(drive, out_id: str, tmp: Path, stem: str):
    """A tiny "[working]" note shows you Patrick has started, and tells a restarted Patrick that the last run was cut off."""
    try:
        note = tmp / "working.txt"
        note.write_text("Patrick is editing this video. This note disappears when it's done.\n")
        return drive.upload(out_id, note, f"{stem}{WORKING}.txt", "text/plain")
    except Exception:
        log.exception("Couldn't leave the working note (editing continues)")
        return None


def _drop_marker(drive, marker) -> None:
    if marker is None:
        return
    try:
        drive.trash(marker)
    except Exception:
        log.exception("Couldn't remove the working note")


def recover_interrupted(drive, out_id: str, notify=None) -> int:
    """Run once at startup. A leftover "[working]" note means the server stopped mid-edit (usually it ran out of memory).
    Say so in an error note and skip that video, instead of starting it again and crashing again."""
    files = drive.list_children(out_id)
    names = [f["name"] for f in files]
    fixed = 0
    for f in files:
        name = f["name"]
        if not name.endswith(WORKING + ".txt"):
            continue
        stem = name[: -len(WORKING + ".txt")]
        finished = any(n.startswith(stem + EDITED) or n.startswith(stem + ERROR) for n in names)
        if not finished:
            reason = ("The Patrick server stopped partway through editing this video, usually because it ran out of memory.\n"
                      "Try a shorter or smaller clip. Rename the video file in Drive and Patrick will try again.\n")
            with tempfile.TemporaryDirectory() as tmp:
                note = Path(tmp) / "error.txt"
                note.write_text(reason)
                drive.upload(out_id, note, f"{stem}{ERROR}.txt", "text/plain")
            if notify is not None:
                try:
                    notify(f"Patrick couldn't finish: {stem}", reason)
                except Exception:
                    log.exception("Couldn't send the notification")
            fixed += 1
        _drop_marker(drive, f["id"])
    return fixed


def drive_configured() -> bool:
    return all(editor.env_is_set(k) for k in
               ("GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN", "GDRIVE_FOLDER_ID"))


def start_background() -> threading.Thread | None:
    """Start the Drive watcher as a daemon thread. No-op if Drive isn't set up."""
    if not drive_configured():
        log.info("Google Drive settings not set; Drive watcher not started")
        return None
    folder_id = os.environ["GDRIVE_FOLDER_ID"].strip()
    if not FOLDER_ID.match(folder_id):
        log.error("GDRIVE_FOLDER_ID doesn't look right; Drive watcher not started")
        return None
    out_id = os.environ.get("GDRIVE_OUTPUT_FOLDER_ID", "").strip() if editor.env_is_set("GDRIVE_OUTPUT_FOLDER_ID") else None
    if out_id and not FOLDER_ID.match(out_id):
        log.error("GDRIVE_OUTPUT_FOLDER_ID doesn't look right; Drive watcher not started")
        return None
    notify = None
    if email_worker.email_configured():  # tell Krew by email when a video is finished
        notify = email_worker.send_notification
    music_dir = Path(os.environ.get("MUSIC_DIR", Path(__file__).parent / "music"))
    poll = int(os.environ.get("POLL_SECONDS", 30))
    max_mb = int(os.environ.get("DRIVE_MAX_MB", 500))
    drive = GoogleDrive(os.environ["GDRIVE_CLIENT_ID"], os.environ["GDRIVE_CLIENT_SECRET"],
                        os.environ["GDRIVE_REFRESH_TOKEN"])
    WATCH.update(drop=folder_id, out=out_id or folder_id)

    def loop() -> None:
        log.info("Watching Drive folder %s", folder_id)
        try:
            n = recover_interrupted(drive, out_id or folder_id, notify)
            if n:
                log.warning("Found %d video(s) the server was cut off while editing; marked them as errors", n)
        except Exception:
            log.exception("Startup check failed; continuing")
        while True:
            try:
                poll_once(drive, folder_id, music_dir, max_mb, output_folder_id=out_id, notify=notify)
            except Exception as e:
                LAST_ERROR.update(at=datetime.now(timezone.utc).strftime("%H:%M:%S UTC"), video="(checking the folder)",
                                  what=f"{type(e).__name__}: {str(e)[:300]}")
                log.exception("Drive check failed; will retry")
            try:
                publish_status(drive, out_id or folder_id)
            except Exception:
                log.exception("Couldn't write the status note (editing is not affected)")
            time.sleep(poll)

    thread = threading.Thread(target=loop, name="drive-watcher", daemon=True)
    thread.start()
    return thread
