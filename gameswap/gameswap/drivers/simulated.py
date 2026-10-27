"""A pretend game, so the timer, OBS switching and error handling can be
tested on your PC before the real game drivers exist."""

from __future__ import annotations

import threading
import time
from typing import Callable

from ..config import GameConfig
from .base import GameDriver, ReadyCheck, StepResult


class SimulatedGame(GameDriver):
    mode_label = "Simulated (Phase 1)"

    def __init__(self, key: str, cfg: GameConfig, clock: Callable[[], float] = time.monotonic):
        super().__init__(key, cfg)
        self._clock = clock
        self._lock = threading.Lock()
        self._running = False
        self._in_world = False
        self._loaded_at = 0.0

    @property
    def sim(self):
        return self.cfg.simulation

    def _wait(self, seconds: float, abort: threading.Event) -> bool:
        """Sleep, but wake up early on abort. True if not aborted."""
        return not abort.wait(seconds) if seconds > 0 else not abort.is_set()

    def is_running(self) -> bool:
        with self._lock:
            return self._running

    def launch(self, abort):
        if self.is_running():
            return StepResult(True, "already running")
        if not self._wait(self.sim.launch_seconds, abort):
            return StepResult(False, "aborted")
        if self.sim.fail_step == "launch":
            return StepResult(False, "simulated launch failure: the game never started")
        with self._lock:
            self._running = True
        return StepResult(True, "process and window found (simulated)")

    def load_save(self, abort):
        if not self.is_running():
            return StepResult(False, "the game isn't running")
        if not self._wait(self.sim.load_seconds, abort):
            return StepResult(False, "aborted")
        if self.sim.fail_step == "load":
            return StepResult(False, "simulated failure: couldn't find the save in the menu")
        with self._lock:
            self._in_world = True
            self._loaded_at = self._clock()
        return StepResult(True, f"opened save '{self.cfg.save_name or 'default'}' (simulated)")

    def check_ready(self):
        with self._lock:
            if not (self._running and self._in_world):
                return ReadyCheck(False, "not in a world")
            if self.sim.fail_step == "ready":
                return ReadyCheck(False, "simulated: still looks like a loading screen")
            waited = self._clock() - self._loaded_at
            if waited < self.sim.ready_after_seconds:
                return ReadyCheck(False, "loading screen")
            return ReadyCheck(True, "in gameplay (simulated)")

    def save(self, abort):
        if not self.check_ready().ready:
            return StepResult(False, "not in gameplay, so there is nothing to save")
        if not self._wait(self.sim.save_seconds, abort):
            return StepResult(False, "aborted")
        if self.sim.fail_step == "save":
            return StepResult(False, "simulated failure: the save could not be confirmed")
        with self._lock:
            self._in_world = False  # like Minecraft's Save and Quit to Title
        return StepResult(True, "save confirmed (simulated)")

    def exit(self, abort):
        if not self.is_running():
            return StepResult(True, "already closed")
        if not self._wait(self.sim.exit_seconds, abort):
            return StepResult(False, "aborted")
        if self.sim.fail_step == "exit":
            return StepResult(False, "simulated failure: the game didn't close")
        with self._lock:
            self._running = False
            self._in_world = False
        return StepResult(True, "process exited (simulated)")
