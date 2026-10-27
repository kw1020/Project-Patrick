"""Schedule I save slots, and proof that a save really happened.

Schedule I keeps each save slot in a folder of JSON files:
  %USERPROFILE%\\AppData\\LocalLow\\TVGS\\Schedule I\\Saves\\<SteamID>\\SaveGame_<N>

A save is accepted only when, in the chosen slot:
  1. files were written after the moment we care about,
  2. nothing has changed for a few seconds (the game finished writing), and
  3. every JSON file written since then reads back as valid JSON.
That check doesn't depend on any menu, key or message in the game.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

MTIME_SLACK = 2.0  # file times can be rounded by the file system


def default_saves_root() -> Path:
    return Path(os.environ.get("USERPROFILE", "")) / "AppData" / "LocalLow" / "TVGS" / "Schedule I" / "Saves"


def default_player_log() -> Path:
    return Path(os.environ.get("USERPROFILE", "")) / "AppData" / "LocalLow" / "TVGS" / "Schedule I" / "Player.log"


@dataclass
class Slot:
    path: Path
    steam_id: str
    folder: str  # e.g. SaveGame_2
    name: str  # organisation name if the save says it, else the folder name
    last_written: float  # newest file time (seconds since 1970)

    @property
    def label(self) -> str:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(self.last_written)) if self.last_written else "?"
        shown = self.folder if self.name == self.folder else f"{self.name} ({self.folder})"
        return f"{shown} - last saved {when}"


def _org_name(slot_dir: Path) -> str:
    """The organisation (business) name, if any JSON file in the slot's top level has one."""
    try:
        files = sorted(slot_dir.glob("*.json"))
    except OSError:
        return ""
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            for key in ("OrganisationName", "OrganizationName"):
                if isinstance(data.get(key), str) and data[key].strip():
                    return data[key].strip()
    return ""


def snapshot(slot_dir: Path) -> tuple[float, int]:
    """(newest file time, number of files) in a slot."""
    newest, count = 0.0, 0
    for root, _dirs, files in os.walk(slot_dir):
        for name in files:
            try:
                m = os.stat(os.path.join(root, name)).st_mtime
            except OSError:
                continue
            count += 1
            newest = max(newest, m)
    return newest, count


def list_slots(saves_root: Path) -> list[Slot]:
    slots = []
    try:
        id_dirs = [d for d in saves_root.iterdir() if d.is_dir()]
    except OSError:
        return []
    for id_dir in sorted(id_dirs):
        try:
            slot_dirs = sorted(d for d in id_dir.iterdir() if d.is_dir() and d.name.lower().startswith("savegame"))
        except OSError:
            continue
        for d in slot_dirs:
            slots.append(Slot(d, id_dir.name, d.name, _org_name(d) or d.name, snapshot(d)[0]))
    return slots


def resolve_slot(saves_root: Path, wanted: str) -> Slot | str:
    """The 'Save to load' setting -> one slot. Accepts SaveGame_N, the
    organisation name, or a full folder path. Returns an error message otherwise."""
    wanted = wanted.strip().strip('"')
    if not wanted:
        return "no save is chosen. Pick one in Settings > Games > Save to load"
    slots = list_slots(saves_root)
    as_path = Path(wanted)
    matches = [s for s in slots if s.path == as_path or s.folder.lower() == wanted.lower()]
    if not matches:
        matches = [s for s in slots if s.name.lower() == wanted.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        ids = ", ".join(s.steam_id for s in matches)
        return f"'{wanted}' matches {len(matches)} saves (Steam accounts {ids}). Pick one in Settings"
    if not slots:
        return f"no Schedule I saves found in {saves_root}"
    return f"there is no save called '{wanted}'. Saves found: {', '.join(s.folder for s in slots)}"


def written_since(slot_dir: Path, since: float) -> list[Path]:
    out = []
    for root, _dirs, files in os.walk(slot_dir):
        for name in files:
            p = Path(root) / name
            try:
                if p.stat().st_mtime >= since - MTIME_SLACK:
                    out.append(p)
            except OSError:
                pass
    return out


def check_save(slot_dir: Path, since: float, quiet_seconds: float, now: float | None = None) -> tuple[bool, str]:
    """Has a complete save been written to this slot since `since`?
    Returns (done, explanation)."""
    now = time.time() if now is None else now
    newest, count = snapshot(slot_dir)
    if count == 0:
        return False, "the save folder is empty or missing"
    if newest < since - MTIME_SLACK:
        return False, "no save yet"
    if now - newest < quiet_seconds:
        return False, "the game is still writing the save"
    changed = written_since(slot_dir, since)
    for p in changed:
        if p.suffix.lower() == ".json":
            try:
                json.loads(p.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError) as e:
                return False, f"{p.name} isn't valid yet ({e.__class__.__name__})"
    age = max(0.0, now - newest)
    return True, f"{len(changed)} save files written {age:.0f} s ago and verified"
