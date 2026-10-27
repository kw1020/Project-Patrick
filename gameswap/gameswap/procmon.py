"""Finds the games' processes and windows.

One background thread scans about once a second and keeps the results, so
the window and the state machine can ask "is Minecraft running?" ten times
a second without slowing anything down. Steps that need an up-to-date
answer (launch, exit) call scan_now().

Command lines are only looked at for java processes, and only the Minecraft
version and folder are kept. Minecraft's command line contains your login
token, so it is never stored or logged.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from . import winapi

log = logging.getLogger("gameswap.proc")

try:
    import psutil
except ImportError:  # install.bat installs it
    psutil = None


@dataclass(frozen=True)
class WindowInfo:
    hwnd: int
    title: str
    class_name: str
    rect: tuple[int, int, int, int]  # left, top, right, bottom (physical pixels)
    minimized: bool = False

    @property
    def size(self) -> str:
        left, top, right, bottom = self.rect
        return f"{right - left}x{bottom - top}"


@dataclass
class ProcInfo:
    pid: int
    name: str
    create_time: float
    exe: str = ""
    extra: dict = field(default_factory=dict)  # e.g. {"version": "1.21.4", "game_dir": "..."}
    windows: list[WindowInfo] = field(default_factory=list)


class Matcher(Protocol):
    """Decides which processes belong to one game."""

    def wants_name(self, name: str) -> bool:
        """Cheap first filter on the process name (lower case)."""

    def inspect(self, proc) -> dict | None:
        """Look closer at a psutil.Process. Return extra info if it's ours, else None."""

    def pick_window(self, windows: list[WindowInfo]) -> WindowInfo | None:
        """Which of the process's windows is the game window."""


class ProcessMonitor:
    INTERVAL = 1.0

    def __init__(self, lister: Callable[[], list] | None = None, window_lister=None):
        self._matchers: dict[str, Matcher] = {}
        self._results: dict[str, list[ProcInfo]] = {}
        self._known: dict[tuple[int, float], tuple[str, dict]] = {}  # (pid, start) -> (key, extra)
        self._lock = threading.Lock()
        self._scan_lock = threading.Lock()
        self._stop = threading.Event()
        self._lister = lister or _list_processes
        self._window_lister = window_lister or winapi.windows_for_pids
        self._thread: threading.Thread | None = None

    def register(self, key: str, matcher: Matcher) -> None:
        with self._lock:
            self._matchers[key] = matcher
            self._known.clear()

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="procmon", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def get(self, key: str) -> list[ProcInfo]:
        with self._lock:
            return list(self._results.get(key, []))

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.scan_now()
            except Exception:
                log.exception("Process scan failed")
            self._stop.wait(self.INTERVAL)

    def scan_now(self) -> None:
        with self._scan_lock:
            with self._lock:
                matchers = dict(self._matchers)
            found: dict[str, list[ProcInfo]] = {k: [] for k in matchers}
            seen = set()
            for proc in self._lister():
                try:
                    pid, name, start = proc.pid, (proc.info.get("name") or ""), proc.info.get("create_time") or 0.0
                except Exception:
                    continue
                ident = (pid, start)
                seen.add(ident)
                cached = self._known.get(ident)
                if cached is not None:
                    key, extra = cached
                    if key in found:
                        found[key].append(ProcInfo(pid, name, start, extra.get("exe", ""), extra))
                    continue
                low = name.lower()
                for key, m in matchers.items():
                    if not m.wants_name(low):
                        continue
                    try:
                        extra = m.inspect(proc)
                    except Exception:  # process vanished or access denied
                        extra = None
                    if extra is not None:
                        self._known[ident] = (key, extra)
                        found[key].append(ProcInfo(pid, name, start, extra.get("exe", ""), extra))
                        break
                else:
                    # Remember "not a game" too, so each process is inspected once.
                    self._known[ident] = ("", {})
            for ident in list(self._known):
                if ident not in seen:
                    del self._known[ident]

            pids = {p.pid for procs in found.values() for p in procs}
            windows = self._window_lister(pids) if pids else {}
            for key, procs in found.items():
                for p in procs:
                    p.windows = windows.get(p.pid, [])
            with self._lock:
                self._results = found


def _list_processes():
    if psutil is None:
        return []
    return psutil.process_iter(["name", "create_time"])
