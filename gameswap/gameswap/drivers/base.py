"""What every game driver must do. The state machine only talks to this.

Each method except is_running/check_ready may take a while, so the state
machine always runs them on a worker thread. They must watch the `abort`
event and give up quickly when it is set (Emergency Stop or a timeout).

Rules every real driver must follow:
  * Never force-close the game.
  * Never press keys unless the game's own window is in front AND the
    expected menu/screen has been verified.
  * Only report a save as ok when the save was actually confirmed.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

from ..config import GameConfig


@dataclass
class StepResult:
    ok: bool
    detail: str = ""


@dataclass
class ReadyCheck:
    ready: bool
    detail: str = ""


class GameDriver:
    mode_label = "Not implemented"

    def __init__(self, key: str, cfg: GameConfig):
        self.key = key
        self.cfg = cfg

    @property
    def name(self) -> str:
        return self.cfg.name

    @property
    def obs_scene(self) -> str:
        return self.cfg.obs_scene

    def preflight(self) -> list[str]:
        """Settings problems that should stop Start. Empty list means OK."""
        return []

    def is_running(self) -> bool:
        raise NotImplementedError

    def launch(self, abort: threading.Event) -> StepResult:
        """Start the game. Return once its process and main window exist."""
        raise NotImplementedError

    def load_save(self, abort: threading.Event) -> StepResult:
        """Get from the main menu into the configured world/save."""
        raise NotImplementedError

    def check_ready(self) -> ReadyCheck:
        """One quick look: is real gameplay happening right now (not a loading screen)?"""
        raise NotImplementedError

    def save(self, abort: threading.Event) -> StepResult:
        """Save progress using the game's own verified controls, and confirm it."""
        raise NotImplementedError

    def exit(self, abort: threading.Event) -> StepResult:
        """Quit the game normally. Return once its process has exited."""
        raise NotImplementedError
