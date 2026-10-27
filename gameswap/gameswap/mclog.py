"""Reads Minecraft's own log (.minecraft/logs/latest.log) as it is written.

Minecraft writes clear lines at the moments GameSwap cares about:
  [Server thread/INFO]: Krew joined the game     you are in the world
  [Server thread/INFO]: Saving and pausing game... the pause menu opened and the world was saved
  [Server thread/INFO]: Stopping server            the world is being closed
  [Server thread/INFO]: Saving worlds              ... and saved on the way out

Only lines from the game's server thread count, so chat messages can't
fake them.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from .logfollow import LogFollower

SERVER = re.compile(r"\[Server thread/INFO\][^:]*: (.*)$")
JOINED = re.compile(r"^(\S+) joined the game$")
LOGGED_IN = re.compile(r"^(\S+?)\[.*\] logged in with entity id")
CRASH_MARKERS = ("---- Minecraft Crash Report ----", "Game crashed!", "This crash report has been saved to")


@dataclass
class LogEvents:
    world_starting: float = 0.0  # "Starting integrated minecraft server"
    joined: float = 0.0  # when "<name> joined the game" was read
    player: str = ""
    pauses: int = 0  # "Saving and pausing game..." lines
    last_pause: float = 0.0
    stopping: float = 0.0  # "Stopping server"
    saving_worlds: float = 0.0  # "Saving worlds" / "All dimensions are saved"
    crashed: str = ""
    lines: list[str] = field(default_factory=list)  # the newest lines, for error messages


class MinecraftLog(LogFollower):
    def __init__(self, path: Path, clock=time.monotonic):
        self._clock = clock
        super().__init__(path)

    def reset_events(self) -> None:
        self.events = LogEvents()

    def handle(self, line: str) -> None:
        ev = self.events
        ev.lines = (ev.lines + [line])[-12:]
        now = self._clock()
        for marker in CRASH_MARKERS:
            if marker in line:
                ev.crashed = line.strip()
        if "Starting integrated minecraft server" in line:
            ev.world_starting = now
            ev.joined = 0.0
            ev.stopping = ev.saving_worlds = 0.0
        m = SERVER.search(line)
        if not m:
            return
        msg = m.group(1).strip()
        j = JOINED.match(msg) or LOGGED_IN.match(msg)
        if j and not ev.joined:
            ev.joined, ev.player = now, j.group(1)
        elif msg.startswith("Saving and pausing game"):
            ev.pauses += 1
            ev.last_pause = now
        elif msg == "Stopping server":
            ev.stopping = now
        elif msg == "Saving worlds" or "All dimensions are saved" in msg:
            ev.saving_worlds = ev.saving_worlds or now
