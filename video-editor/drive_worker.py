"""Google Drive in, edited video out.

Drop a video into the shared "Patrick" Drive folder. Patrick edits it and puts
"<name> [edited].mp4" next to it. Put instructions in the file NAME, in plain English:

    zoomies mute music: chill trim 0:03-0:15.mp4

If something goes wrong you get "<name> [error].txt" explaining why. Nothing is ever deleted or overwritten.

Needs Google OAuth credentials for a dedicated Patrick Google account (see DRIVE_SETUP.md).
"""
from __future__ import annotations

import logging
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import editor
from editor import EditError

log = logging.getLogger("patrick.drive")
EDITED, ERROR = " [edited]", " [error]"
SETTLE_SECONDS = 30  # ignore files modified very recently, in case an upload is still finishing
SCOPES = ["https://www.googleapis.com/auth/drive"]
FOLDER_ID = re.compile(r"^[A-Za-z0-9_-]{10,}$")


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

    def upload(self, folder_id: str, path: Path, name: str, mimetype: str) -> None:
        from googleapiclient.http import MediaFileUpload
        media = MediaFileUpload(str(path), mimetype=mimetype, resumable=True)
        self._svc.files().create(body={"name": name, "parents": [folder_id]}, media_body=media,
                                 fields="id", supportsAllDrives=True).execute()


def _stem(name: str) -> str:
    return Path(name).stem


def _is_settled(modified: str, now: datetime) -> bool:
    try:
        when = datetime.fromisoformat(modified.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now - when).total_seconds() >= SETTLE_SECONDS


def poll_once(drive, folder_id: str, music_dir: Path, max_mb: int = 500, now: datetime | None = None) -> int:
    """Edit every new video in the folder. Returns how many files were handled (edited or errored)."""
    now = now or datetime.now(timezone.utc)
    children = drive.list_children(folder_id)
    names = [c["name"] for c in children]
    handled = 0

    for f in children:
        name = f["name"]
        if not f.get("mimeType", "").startswith("video/") or EDITED in name or ERROR in name:
            continue
        stem = _stem(name)
        if any(n.startswith(stem + EDITED) or n.startswith(stem + ERROR) for n in names):
            continue  # already done (or already failed once; rename the file to retry)
        if not _is_settled(f.get("modifiedTime", ""), now):
            continue

        log.info("Editing %s", name)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            try:
                if int(f.get("size", 0)) > max_mb * 1024 * 1024:
                    raise EditError(f"That video is over {max_mb} MB. Trim or compress it and try again.")
                src = tmp / ("input" + (Path(name).suffix.lower() or ".mp4"))
                drive.download(f["id"], src)
                opts, notes = editor.parse_commands(stem, music_dir)
                result = editor.process(src, tmp / "out.mp4", opts)
                drive.upload(folder_id, tmp / "out.mp4", f"{stem}{EDITED}.mp4", "video/mp4")
                log.info("Done %s (%ss): %s", name, result["duration"], "; ".join(notes) or "default edit")
            except Exception as e:  # tell the user in Drive instead of failing silently
                reason = str(e) if isinstance(e, EditError) else "Something went wrong while editing."
                if not isinstance(e, EditError):
                    log.exception("Failed on %s", name)
                note = tmp / "error.txt"
                note.write_text(f"Couldn't edit {name}.\n{reason}\n\nRename the file and it will be tried again.\n")
                drive.upload(folder_id, note, f"{stem}{ERROR}.txt", "text/plain")
        handled += 1
    return handled


def drive_configured() -> bool:
    return all(os.environ.get(k) for k in
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
    music_dir = Path(os.environ.get("MUSIC_DIR", Path(__file__).parent / "music"))
    poll = int(os.environ.get("POLL_SECONDS", 30))
    max_mb = int(os.environ.get("DRIVE_MAX_MB", 500))
    drive = GoogleDrive(os.environ["GDRIVE_CLIENT_ID"], os.environ["GDRIVE_CLIENT_SECRET"],
                        os.environ["GDRIVE_REFRESH_TOKEN"])

    def loop() -> None:
        log.info("Watching Drive folder %s", folder_id)
        while True:
            try:
                poll_once(drive, folder_id, music_dir, max_mb)
            except Exception:
                log.exception("Drive check failed; will retry")
            time.sleep(poll)

    thread = threading.Thread(target=loop, name="drive-watcher", daemon=True)
    thread.start()
    return thread
