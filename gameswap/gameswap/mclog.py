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

SERVER = re.compile(r"\[Server thread/INFO\][^:]*: (.*)$")
JOINED = re.compile(r"^(\S+) joined the game$")
LOGGED_IN = re.compile(r"^(\S+?)\[.*\] logged in with entity id")
CRASH_MARKERS = ("---- Minecraft Crash Report ----", "Game crashed!", "This crash report has been saved to")
HEAD_BYTES = 256


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


class MinecraftLog:
    def __init__(self, path: Path, clock=time.monotonic):
        self.path = Path(path)
        self._clock = clock
        self._offset = 0
        self._head = b""
        self._partial = ""
        self.events = LogEvents()

    def forget_current_file(self) -> None:
        """Ignore what's in the file now; only a NEW log (a new Minecraft start) will be read."""
        head = self._read_head()
        self._head = head
        self._offset = self._size()
        self._partial = ""
        self.events = LogEvents()

    def read_from_start(self) -> None:
        """Read the current file from the top (Minecraft is already running)."""
        self._head = b""
        self._offset = 0
        self._partial = ""
        self.events = LogEvents()

    def poll(self) -> list[str]:
        """Read new complete lines and update events. Returns the new lines."""
        head = self._read_head()
        n = min(len(head), len(self._head))
        replaced = (n > 0 and head[:n] != self._head[:n]) or self._size() < self._offset
        if replaced:
            # A different file: Minecraft started again and began a new log.
            self._offset = 0
            self._partial = ""
            self.events = LogEvents()
        if replaced or len(head) > len(self._head):
            self._head = head
        try:
            with self.path.open("rb") as f:
                f.seek(self._offset)
                data = f.read()
        except OSError:
            return []
        self._offset += len(data)
        text = self._partial + data.decode("utf-8", errors="replace")
        *complete, self._partial = text.split("\n")
        lines = [line.rstrip("\r") for line in complete]
        for line in lines:
            self._handle(line)
        return lines

    def _handle(self, line: str) -> None:
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

    def _size(self) -> int:
        try:
            return self.path.stat().st_size
        except OSError:
            return 0

    def _read_head(self) -> bytes:
        try:
            with self.path.open("rb") as f:
                return f.read(HEAD_BYTES)
        except OSError:
            return b""
