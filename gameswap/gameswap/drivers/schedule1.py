"""Schedule I, started through Steam.

Schedule I has no save key or pause-menu save. It saves only when you sleep
in your bed or use the save device by a property's door, and quitting does
NOT save. So GameSwap never pretends it can save for you. Instead:

Launch   Steam's own command (steam.exe -applaunch 3164500).
         Verified: the game's process and window appear.
Load     You pick your save (Continue > your save). GameSwap shows which one.
Ready    You press Ready (button or hotkey) once you're in the game. If a
         Player.log line is configured as the ready signal, it's automatic.
Save     At the save prompt (60 s left by default) you save in-game.
         Verified by GameSwap on disk: the save slot's files were just
         written, have stopped changing, and are valid JSON.
Exit     Only after a verified save: asks the window to close (same as
         clicking its X). Verified: the process exits. Never force-closed.
Backup   The save slot is zipped before every Start.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path

from .. import backup, s1saves, steam, winapi
from ..actions import Actions
from ..logfollow import LogFollower
from ..procmon import ProcessMonitor, WindowInfo
from .base import ReadyCheck, StepResult
from .real_base import RealGameDriver

log = logging.getLogger("gameswap.schedule1")

SAVE_QUIET_SECONDS = 3.0  # no file changes for this long = the game finished writing
SAVE_HINT = "sleep in bed or use the save device"


class PlayerLog(LogFollower):
    """Unity's Player.log for Schedule I. Keeps the newest lines and notices an
    optional 'ready' line (a regular expression from Settings)."""

    def __init__(self, path: Path, ready_pattern: str = "", clock=time.monotonic):
        self._clock = clock
        self.ready_re = re.compile(ready_pattern) if ready_pattern else None
        super().__init__(path)

    def reset_events(self) -> None:
        self.recent: list[str] = []
        self.ready_at = 0.0

    def handle(self, line: str) -> None:
        self.recent = (self.recent + [line])[-25:]
        if self.ready_re and not self.ready_at and self.ready_re.search(line):
            self.ready_at = self._clock()


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
    mode_label = "Real - Phase 4 (you save, GameSwap verifies)"
    automates_load = False
    save_needs_player = True  # keep the game scene on OBS while you walk to save

    def __init__(self, key, cfg, monitor: ProcessMonitor, actions: Actions | None = None,
                 wall_clock=time.time, clock=time.monotonic):
        super().__init__(key, cfg, monitor)
        self.actions = actions or Actions()
        self._wall = wall_clock
        self._clock = clock
        self.steam_dir: Path | None = None
        self.install_dir: Path | None = None
        self.exes: list[Path] = []
        self.player_log = PlayerLog(s1saves.default_player_log(), cfg.ready_log_pattern, clock)
        self.verified_save_at = 0.0
        self.locate()

    @property
    def manual_ready(self) -> bool:
        """True when you confirm gameplay yourself (no ready log line set)."""
        return not self.cfg.ready_log_pattern

    @property
    def save_hint(self) -> str:
        return SAVE_HINT

    # ---- where things are --------------------------------------------------------

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

    def saves_root(self) -> Path:
        return Path(self.cfg.save_folder) if self.cfg.save_folder else s1saves.default_saves_root()

    def slot(self) -> s1saves.Slot | str:
        return s1saves.resolve_slot(self.saves_root(), self.cfg.save_name)

    def pick_window(self, windows):
        return pick_unity_window(windows)

    # ---- Start checks + backup -----------------------------------------------------

    def preflight(self) -> list[str]:
        if not self.cfg.steam_app_id.strip().isdigit():
            return ["Schedule I: the Steam App ID must be a number (3164500)."]
        problems = self.locate()
        if self.cfg.ready_log_pattern:
            try:
                re.compile(self.cfg.ready_log_pattern)
            except re.error as e:
                problems.append(f"Schedule I: the ready log pattern isn't valid ({e}).")
        slot = self.slot()
        if isinstance(slot, str):
            problems.append(f"Schedule I: {slot}.")
            return problems
        self.refresh()
        if not problems and self.cfg.backup_before_start and not self.is_running():
            log.info("Backing up Schedule I save '%s'...", slot.name)
            try:
                backup.backup_folder(slot.path, f"schedule1-{slot.steam_id}-{slot.folder}", keep=self.cfg.backups_keep)
            except OSError as e:
                problems.append(f"Schedule I: couldn't back up save '{slot.name}' ({e}). Fix this or turn "
                                "off 'Back up before Start' in Settings.")
        return problems

    # ---- launch / load / ready -------------------------------------------------------

    def launch(self, abort: threading.Event) -> StepResult:
        self.refresh()
        self.player_log = PlayerLog(s1saves.default_player_log(), self.cfg.ready_log_pattern, self._clock)
        if self.is_running():
            self.player_log.read_from_start()
        else:
            self.player_log.forget_current_file()  # only this launch's log counts
        self.verified_save_at = 0.0
        result = super().launch(abort)
        if result.ok:
            w = self.game_window()
            if w:
                self.actions.bring_to_front(w.hwnd)
        return result

    def start_game(self, abort: threading.Event) -> StepResult:
        exe = steam.steam_exe(self.steam_dir) if self.steam_dir else None
        target = [str(exe), "-applaunch", self.cfg.steam_app_id] if exe else [f"steam://rungameid/{self.cfg.steam_app_id}"]
        try:
            winapi.open_target(target)
        except OSError as e:
            return StepResult(False, f"couldn't ask Steam to launch the game: {e}")
        self.status = "Steam is starting Schedule I..."
        return StepResult(True, "asked Steam to launch it")

    def load_save(self, abort):
        slot = self.slot()
        if isinstance(slot, str):
            return StepResult(False, slot)
        how = "press Ready (button or hotkey) once you're in the game" if self.manual_ready else \
            "the timer starts by itself once the game has loaded"
        self.status = f"In Schedule I: Continue > load '{slot.name}' ({slot.folder}), then {how}"
        return StepResult(True, f"waiting for you to load '{slot.name}'")

    def check_ready(self) -> ReadyCheck:
        if not self.is_running():
            return ReadyCheck(False, "Schedule I isn't running")
        w = self.game_window()
        if w is None or w.minimized:
            return ReadyCheck(False, "Schedule I's window is minimized or missing")
        if self.manual_ready:
            return ReadyCheck(False, "press Ready once you're in the game")
        self.player_log.poll()
        if not self.player_log.ready_at:
            return ReadyCheck(False, "loading (waiting for the ready line in Player.log)")
        if self._clock() - self.player_log.ready_at < self.cfg.ready_settle_seconds:
            return ReadyCheck(False, "loading")
        if self.actions.foreground() != w.hwnd and not self.actions.bring_to_front(w.hwnd):
            return ReadyCheck(False, "Schedule I isn't the active window. Click on it")
        return ReadyCheck(True, "Player.log ready line seen")

    def on_manual_ready(self) -> None:
        """You pressed Ready: write the newest Player.log lines to GameSwap's log,
        so an automatic ready signal can be found from them later."""
        self.player_log.poll()
        if self.player_log.recent:
            log.info("Player.log lines just before you pressed Ready:\n    %s", "\n    ".join(self.player_log.recent[-15:]))

    # ---- save / exit -------------------------------------------------------------------

    def save(self, abort):
        """Wait for YOU to save in-game, then verify the save on disk."""
        slot = self.slot()
        if isinstance(slot, str):
            return StepResult(False, slot)
        if not self.is_running():
            return StepResult(False, "Schedule I isn't running, so there is nothing to save")
        since = self._wall() - self.cfg.save_max_age_seconds
        while not abort.is_set():
            done, why = s1saves.check_save(slot.path, since, SAVE_QUIET_SECONDS, now=self._wall())
            if done:
                self.verified_save_at = self._wall()
                self.status = ""
                return StepResult(True, f"save '{slot.name}' verified on disk: {why}")
            self.status = f"SAVE NOW in Schedule I: {SAVE_HINT} ({why})"
            if not self.is_running():
                return StepResult(False, "Schedule I closed before a save was verified. Progress since its "
                                         "last save may be lost; check the save before continuing")
            abort.wait(1.0)
            self.refresh()
        return StepResult(False, "stopped waiting for the save. Schedule I was NOT closed")

    def exit(self, abort):
        self.refresh()
        if not self.is_running():
            return StepResult(True, "Schedule I was already closed")
        if not self.verified_save_at:
            return StepResult(False, "no verified save yet, so Schedule I wasn't closed")
        w = self.game_window()
        if w is None or not self.actions.close_window(w.hwnd):
            return StepResult(False, "couldn't ask Schedule I's window to close")
        self.status = "Closing Schedule I (if it asks you to confirm quitting, confirm it)..."
        while not abort.is_set():
            self.refresh()
            if not self.is_running():
                break
            abort.wait(self.POLL)
        if self.is_running():
            return StepResult(False, "Schedule I didn't close. Is it asking you to confirm? It was NOT force-closed")
        slot = self.slot()
        if not isinstance(slot, str):
            ok, why = s1saves.check_save(slot.path, self.verified_save_at - 600, 0, now=self._wall())
            if not ok and "isn't valid" in why:
                return StepResult(False, f"Schedule I closed, but its save looks damaged ({why}). "
                                         "Check it, and restore a backup from GameSwap's backups folder if needed")
        return StepResult(True, "Schedule I exited normally after a verified save")
