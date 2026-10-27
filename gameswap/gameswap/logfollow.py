"""Follow a game's log file as it is written (like `tail -f`).

Notices when the game starts a brand-new log file (each time it launches)
by checking the first bytes of the file, and starts again from the top.
"""

from __future__ import annotations

from pathlib import Path

HEAD_BYTES = 256


class LogFollower:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._offset = 0
        self._head = b""
        self._partial = ""
        self.reset_events()

    def reset_events(self) -> None:
        """Forget what was seen. Subclasses keep their own event state."""

    def handle(self, line: str) -> None:
        """Called for every new complete line."""

    def forget_current_file(self) -> None:
        """Ignore what's in the file now; only a NEW log (a new game start) will be read."""
        self._head = self._read_head()
        self._offset = self._size()
        self._partial = ""
        self.reset_events()

    def read_from_start(self) -> None:
        """Read the current file from the top (the game is already running)."""
        self._head = b""
        self._offset = 0
        self._partial = ""
        self.reset_events()

    def poll(self) -> list[str]:
        """Read new complete lines and handle them. Returns the new lines."""
        head = self._read_head()
        n = min(len(head), len(self._head))
        replaced = (n > 0 and head[:n] != self._head[:n]) or self._size() < self._offset
        if replaced:
            # A different file: the game started again and began a new log.
            self._offset = 0
            self._partial = ""
            self.reset_events()
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
            self.handle(line)
        return lines

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
