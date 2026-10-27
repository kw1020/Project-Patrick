"""Shared logic for the real game drivers (Minecraft, Schedule I).

Phase 2 automates launching and detecting the game. The steps that come
in later phases (opening the save, verifying gameplay, saving, quitting)
report "not automated yet" with instructions, so GameSwap stops and waits
for you instead of guessing. You do the step by hand and press Continue,
and GameSwap checks your claim where it can (for example, it confirms the
game process really exited).
"""

from __future__ import annotations

import logging
import threading
import time

from ..config import GameConfig
from ..procmon import ProcessMonitor, ProcInfo, WindowInfo
from .base import GameDriver, ReadyCheck, StepResult

log = logging.getLogger("gameswap.driver")


class RealGameDriver(GameDriver):
    POLL = 0.5
    automates_load = False  # becomes True in Phases 3-4
    # Filled in by each game:
    phase_for_load = "a later phase"
    phase_for_save = "a later phase"

    def __init__(self, key: str, cfg: GameConfig, monitor: ProcessMonitor):
        super().__init__(key, cfg)
        self.monitor = monitor
        self.status = ""
        self._launch_started = 0.0

    # ---- detection ---------------------------------------------------------

    def processes(self) -> list[ProcInfo]:
        return self.monitor.get(self.key)

    def is_running(self) -> bool:
        return bool(self.processes())

    def refresh(self) -> None:
        self.monitor.scan_now()

    def game_window(self) -> WindowInfo | None:
        for p in self.processes():
            w = self.pick_window(p.windows)
            if w is not None:
                return w
        return None

    def pick_window(self, windows: list[WindowInfo]) -> WindowInfo | None:
        raise NotImplementedError

    def describe(self) -> str:
        procs = self.processes()
        if not procs:
            return "not running"
        p = procs[0]
        w = self.pick_window(p.windows)
        win = f'window "{w.title}" {w.size}' + (" (minimized)" if w.minimized else "") if w else "no window yet"
        extra = f" v{p.extra['version']}" if p.extra.get("version") else ""
        return f"running{extra} (pid {p.pid}) - {win}"

    # ---- launching -----------------------------------------------------------

    def start_game(self, abort: threading.Event) -> StepResult:
        """Kick off the launch (open the launcher / ask Steam). Each game implements this."""
        raise NotImplementedError

    def launch(self, abort: threading.Event) -> StepResult:
        self.refresh()
        if self.game_window() is not None:
            return StepResult(True, "it was already running")
        if not self.is_running():
            started = self.start_game(abort)
            if not started.ok:
                return started
        self._launch_started = time.monotonic()
        # Wait for the process AND its game window. The state machine's launch
        # timeout sets `abort` if this takes too long.
        while not abort.is_set():
            self.refresh()
            w = self.game_window()
            if w is not None:
                p = self.processes()[0]
                took = time.monotonic() - self._launch_started
                self.status = ""
                return StepResult(True, f'pid {p.pid}, window "{w.title}" {w.size}, {took:.0f} s after launch')
            if self.is_running():
                self.status = f"{self.name} is starting (process found, waiting for its window)..."
            abort.wait(self.POLL)
        return StepResult(False, "stopped waiting for the game to start")

    def wait_for_exit(self, abort: threading.Event) -> bool:
        while not abort.is_set():
            self.refresh()
            if not self.is_running():
                return True
            abort.wait(self.POLL)
        return False

    # ---- steps that later phases automate --------------------------------------

    def load_save(self, abort):
        target = f" '{self.cfg.save_name}'" if self.cfg.save_name else ""
        return StepResult(False, f"opening the save automatically comes in {self.phase_for_load}. "
                                 f"Load your save{target} by hand, then press Continue")

    def check_ready(self):
        return ReadyCheck(False, f"gameplay detection comes in {self.phase_for_load}")

    def save(self, abort):
        return StepResult(False, f"saving automatically comes in {self.phase_for_save}. "
                                 f"Save and quit {self.name} by hand, then press Continue")

    def exit(self, abort):
        return StepResult(False, f"quitting automatically comes in {self.phase_for_save}. "
                                 f"Quit {self.name} normally, then press Continue")
