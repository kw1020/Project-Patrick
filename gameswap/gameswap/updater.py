"""Updates itself from GitHub, so you never download a new installer by hand.

Every new GameSwap build is published as a GitHub Release (tag
"gameswap-vX.Y.Z") with its installer and the installer's SHA-256.
On start, GameSwap asks GitHub whether there's a newer release. If there is,
it offers to update; you say yes and it:

1. downloads the installer into a temporary folder,
2. checks its size and SHA-256 against what the release says (so a broken
   or tampered download is never run),
3. runs it silently (it installs over the old version and keeps your
   settings, logs and backups), and closes GameSwap; the installer then
   starts the new GameSwap.

It never updates during a run, and only the installed GameSwap.exe updates
itself (not GameSwap run from the source code).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("gameswap.update")

REPO = "kw1020/Project-Patrick"
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases?per_page=30"
TAG_PREFIX = "gameswap-v"
SETUP_RE = re.compile(r"^GameSwap-Setup-[\w.\-]+\.exe$")
TIMEOUT = 10


@dataclass
class Update:
    version: str
    url: str
    name: str
    size: int
    sha256: str  # may be "" until fetched from the .sha256 file
    sha_url: str = ""
    page: str = ""


def version_tuple(v: str) -> tuple[int, ...]:
    """'0.8.10' -> (0, 8, 10). Anything unparsable sorts lowest."""
    parts = re.findall(r"\d+", v.split("-")[0].split("+")[0])
    return tuple(int(p) for p in parts[:4]) if parts else (0,)


def pick_update(releases: list[dict], current: str) -> Update | None:
    """The newest GameSwap release that's newer than `current`, with an installer."""
    best: Update | None = None
    for r in releases:
        tag = str(r.get("tag_name", ""))
        if r.get("draft") or r.get("prerelease") or not tag.startswith(TAG_PREFIX):
            continue
        version = tag[len(TAG_PREFIX):]
        if version_tuple(version) <= version_tuple(current):
            continue
        assets = {a.get("name", ""): a for a in r.get("assets", [])}
        setup = next((a for n, a in assets.items() if SETUP_RE.match(n)), None)
        if setup is None:
            continue
        digest = str(setup.get("digest") or "")
        sha_asset = assets.get(setup["name"] + ".sha256")
        u = Update(version=version, url=setup["browser_download_url"], name=setup["name"],
                   size=int(setup.get("size") or 0),
                   sha256=digest.split(":", 1)[1].lower() if digest.startswith("sha256:") else "",
                   sha_url=sha_asset["browser_download_url"] if sha_asset else "",
                   page=str(r.get("html_url", "")))
        if not u.sha256 and not u.sha_url:
            continue  # nothing to check the download against: don't offer it
        if best is None or version_tuple(u.version) > version_tuple(best.version):
            best = u
    return best


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "GameSwap-updater",
                                               "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def check(current: str, fetch=_get) -> Update | None:
    """Ask GitHub for a newer version. None if there's none (or no internet)."""
    try:
        releases = json.loads(fetch(RELEASES_URL))
    except Exception as e:
        log.info("Couldn't check for updates (%s).", e)
        return None
    if not isinstance(releases, list):
        return None
    u = pick_update(releases, current)
    if u:
        log.info("GameSwap %s is available (you have %s).", u.version, current)
    return u


def download(u: Update, folder: Path | None = None, fetch=_get) -> Path:
    """Download the installer and check it. Raises ValueError if it doesn't match."""
    sha = u.sha256
    if not sha:
        sha = fetch(u.sha_url).decode("ascii", "replace").split()[0].lower()
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise ValueError("the release's checksum is missing or unreadable")
    data = fetch(u.url)
    if u.size and len(data) != u.size:
        raise ValueError(f"the download is {len(data)} bytes, expected {u.size}")
    got = hashlib.sha256(data).hexdigest()
    if got != sha:
        raise ValueError("the download's checksum doesn't match the release - not installing it")
    folder = folder or Path(tempfile.mkdtemp(prefix="gameswap-update-"))
    path = folder / u.name
    path.write_bytes(data)
    return path


def install_command(installer: Path) -> list[str]:
    # /relaunch=1: the installer starts GameSwap again when it's done.
    return [str(installer), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/relaunch=1"]


def start_install(installer: Path) -> None:
    """Start the installer on its own; GameSwap must close right after."""
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(install_command(installer), creationflags=flags, close_fds=True)
