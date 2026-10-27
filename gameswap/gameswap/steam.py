"""Find Steam, its library folders, and where a game is installed.

Everything is read from Steam's own files:
  steamapps/libraryfolders.vdf      lists every Steam library folder
  steamapps/appmanifest_<id>.acf    says which folder a game is installed in
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from . import winapi

DEFAULT_STEAM_DIRS = [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"]

_TOKEN = re.compile(r'"((?:[^"\\]|\\.)*)"|([{}])')


def parse_vdf(text: str) -> dict:
    """Parse Valve's KeyValues text format (the .vdf / .acf files) into dicts."""
    tokens = []
    for quoted, brace in _TOKEN.findall(text):
        tokens.append(brace if brace else ("s", quoted.replace("\\\\", "\\").replace('\\"', '"')))
    root: dict = {}
    stack = [root]
    key = None
    for tok in tokens:
        if tok == "{":
            child: dict = {}
            stack[-1][key] = child
            stack.append(child)
            key = None
        elif tok == "}":
            if len(stack) > 1:
                stack.pop()
            key = None
        else:
            value = tok[1]
            if key is None:
                key = value
            else:
                stack[-1][key] = value
                key = None
    return root


def find_steam_dir(configured_exe: str = "") -> Path | None:
    """Steam's install folder: from Settings, the registry, or the usual places."""
    candidates = []
    if configured_exe.strip():
        candidates.append(Path(configured_exe.strip().strip('"')).parent)
    for root, path, value in (
        ("HKCU", r"Software\Valve\Steam", "SteamPath"),
        ("HKLM", r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
        ("HKLM", r"SOFTWARE\Valve\Steam", "InstallPath"),
    ):
        found = winapi.read_registry(root, path, value)
        if found:
            candidates.append(Path(found.replace("/", os.sep)))
    candidates += [Path(p) for p in DEFAULT_STEAM_DIRS]
    for c in candidates:
        if (c / "steamapps").is_dir():
            return c
    return None


def steam_exe(steam_dir: Path) -> Path | None:
    exe = steam_dir / "steam.exe"
    return exe if exe.exists() else None


def library_folders(steam_dir: Path) -> list[Path]:
    libs = [steam_dir]
    vdf = steam_dir / "steamapps" / "libraryfolders.vdf"
    try:
        data = parse_vdf(vdf.read_text(encoding="utf-8", errors="ignore"))
    except OSError:
        return libs
    folders = data.get("libraryfolders") or data.get("LibraryFolders") or {}
    for entry in folders.values():
        path = entry.get("path") if isinstance(entry, dict) else entry
        if isinstance(path, str) and path:
            p = Path(path)
            if p not in libs:
                libs.append(p)
    return libs


def find_install_dir(steam_dir: Path, app_id: str) -> Path | None:
    """The game's folder, e.g. ...\\steamapps\\common\\Schedule I, if installed."""
    for lib in library_folders(steam_dir):
        manifest = lib / "steamapps" / f"appmanifest_{app_id}.acf"
        try:
            data = parse_vdf(manifest.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        installdir = (data.get("AppState") or {}).get("installdir")
        if installdir:
            folder = lib / "steamapps" / "common" / installdir
            if folder.is_dir():
                return folder
    return None


def unity_game_exes(install_dir: Path) -> list[Path]:
    """Unity games ship 'Name.exe' next to a 'Name_Data' folder. That pairing
    finds the real game program without guessing its name, and skips helpers
    like UnityCrashHandler64.exe."""
    try:
        exes = [p for p in install_dir.iterdir() if p.suffix.lower() == ".exe" and p.is_file()]
    except OSError:
        return []
    paired = [p for p in exes if (install_dir / f"{p.stem}_Data").is_dir()]
    return sorted(paired or [p for p in exes if "crashhandler" not in p.name.lower()])
