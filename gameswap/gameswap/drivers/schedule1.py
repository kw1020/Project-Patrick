"""Schedule I, started through Steam.

Phase 2: asks Steam to launch the game (steam.exe -applaunch 3164500, Steam's
own supported command), then detects the game's process and window.
Phase 4 will load your save, verify gameplay, and use the in-game save
and quit controls you confirm on your PC.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .. import steam, winapi
from ..procmon import ProcessMonitor, WindowInfo
from .base import StepResult
from .real_base import RealGameDriver


class UnityExeMatcher:
    """Matches processes started from the game's install folder."""

    def __init__(self, exes: list[Path]):
        self.exes = {str(p).lower() for p in exes}
        self.names = {p.name.lower() for p in exes}

    def wants_name(self, name: str) -> bool:
        return name in self.names

    def inspect(self, proc) -> dict | None:
        exe = proc.exe()
        return {"exe": exe} if exe.lower() in self.exes else None

    def pick_window(self, windows):
        return pick_unity_window(windows)


def pick_unity_window(windows: list[WindowInfo]) -> WindowInfo | None:
    """Unity games draw into a window of class UnityWndClass."""
    unity = [w for w in windows if w.class_name == "UnityWndClass"]
    return (unity or [w for w in windows if w.title] or [None])[0]


class Schedule1Driver(RealGameDriver):
    mode_label = "Real - Phase 2 (launch + detect)"
    phase_for_load = "Phase 4"
    phase_for_save = "Phase 4"

    def __init__(self, key, cfg, monitor: ProcessMonitor):
        super().__init__(key, cfg, monitor)
        self.steam_dir: Path | None = None
        self.install_dir: Path | None = None
        self.exes: list[Path] = []
        self.locate()

    def locate(self) -> list[str]:
        """Find Steam, the game folder and the game program. Returns problems."""
        problems = []
        self.steam_dir = steam.find_steam_dir(self.cfg.launch_path)
        if self.cfg.game_folder:
            self.install_dir = Path(self.cfg.game_folder)
        elif self.steam_dir:
            self.install_dir = steam.find_install_dir(self.steam_dir, self.cfg.steam_app_id)
        self.exes = steam.unity_game_exes(self.install_dir) if self.install_dir else []
        self.monitor.register(self.key, UnityExeMatcher(self.exes))
        if self.steam_dir is None:
            problems.append("Schedule I: Steam wasn't found. Set steam.exe in Settings > Games.")
        elif self.install_dir is None:
            problems.append(f"Schedule I: Steam app {self.cfg.steam_app_id} isn't installed in any Steam library.")
        elif not self.exes:
            problems.append(f"Schedule I: no game program found in {self.install_dir}.")
        return problems

    def pick_window(self, windows):
        return pick_unity_window(windows)

    def preflight(self) -> list[str]:
        if not self.cfg.steam_app_id.strip().isdigit():
            return ["Schedule I: the Steam App ID must be a number (3164500)."]
        return self.locate()

    def start_game(self, abort: threading.Event) -> StepResult:
        exe = steam.steam_exe(self.steam_dir) if self.steam_dir else None
        target = [str(exe), "-applaunch", self.cfg.steam_app_id] if exe else [f"steam://rungameid/{self.cfg.steam_app_id}"]
        try:
            winapi.open_target(target)
        except OSError as e:
            return StepResult(False, f"couldn't ask Steam to launch the game: {e}")
        self.status = "Steam is starting Schedule I..."
        return StepResult(True, "asked Steam to launch it")
