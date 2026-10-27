"""Records each challenge session for you and your YouTube video.

  logs/session-<start>.csv        one row per turn and per problem (opens in Excel)
  logs/chapters-<start>.txt       YouTube chapters, timed to the OBS recording
  session.json                    where the challenge is, so it can be resumed
                                  if GameSwap or the PC stops unexpectedly

Chapter times come from OBS's own recording clock when OBS is recording;
otherwise from the time since Start.
"""

from __future__ import annotations

import csv
import json
import logging
import time
from pathlib import Path
from typing import Callable

from .config import APP_DIR, LOG_DIR

log = logging.getLogger("gameswap.session")

STATE_FILE = APP_DIR / "session.json"


def fmt_chapter(seconds: float) -> str:
    s = max(0, int(seconds))
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def load_unfinished(state_file: Path = STATE_FILE) -> dict | None:
    """The last session, if it didn't end with Stop / Emergency Stop."""
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("finished") or "next_index" not in data:
        return None
    return data


class SessionRecorder:
    def __init__(self, rotation: list[str], recording_seconds: Callable[[], float | None] = lambda: None,
                 log_dir: Path = LOG_DIR, state_file: Path = STATE_FILE, clock=time.monotonic):
        self.rotation = rotation
        self._recording_seconds = recording_seconds  # OBS's recording clock, or None
        self.log_dir = log_dir
        self.state_file = state_file
        self._clock = clock
        self._started = 0.0
        self.csv_path: Path | None = None
        self.chapters_path: Path | None = None
        self.chapters: list[tuple[float, str]] = []

    def handle(self, kind: str, info: dict) -> None:
        if kind == "session_start":
            self._start(info)
            return
        if self.csv_path is None:
            return
        t = self._now()
        if kind == "turn_start":
            self.chapters.append((t, f"Turn {info['turn']} - {info['game']}"))
            self._write_chapters()
            # If GameSwap stops during this turn, resume with this same game.
            self._save_state(turns=info["turn"] - 1, next_index=self.rotation.index(info["key"]), finished=False)
        elif kind == "game_closed":
            # Saved and closed: this turn is done, the next game is up.
            next_index = (self.rotation.index(info["key"]) + 1) % len(self.rotation)
            self._save_state(turns=info["turn"], next_index=next_index, finished=False)
        elif kind == "stopped":
            self._save_state(finished=True)
            if self.chapters_path and self.chapters:
                log.info("YouTube chapters: %s", self.chapters_path)
        self._row(kind, info, t)

    # ---- internals --------------------------------------------------------

    def _start(self, info: dict) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self.csv_path = self.log_dir / f"session-{stamp}.csv"
        self.chapters_path = self.log_dir / f"chapters-{stamp}.txt"
        self._started = self._clock()
        self.chapters = [(0.0, "Start")]
        with self.csv_path.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["time", "video time", "event", "turn", "game", "details"])
        self._row("session_start", info, self._now())
        self._save_state(turns=info.get("turn", 0), next_index=None, finished=False)

    def _now(self) -> float:
        rec = self._recording_seconds()
        return rec if rec is not None else self._clock() - self._started

    def _row(self, kind: str, info: dict, t: float) -> None:
        details = {k: v for k, v in info.items() if k not in ("turn", "game")}
        try:
            with self.csv_path.open("a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow([time.strftime("%H:%M:%S"), fmt_chapter(t), kind,
                                        info.get("turn", ""), info.get("game", ""),
                                        json.dumps(details) if details else ""])
        except OSError as e:
            log.warning("Couldn't write the session log: %s", e)

    def _write_chapters(self) -> None:
        # YouTube needs the first chapter at 00:00 and chapters at least 10 s long.
        # A chapter that comes too soon replaces the previous title instead of being lost.
        kept: list[tuple[float, str]] = []
        for t, title in self.chapters:
            if kept and t - kept[-1][0] < 10:
                kept[-1] = (kept[-1][0], title)
            else:
                kept.append((t, title))
        lines = [f"{fmt_chapter(t)} {title}" for t, title in kept]
        try:
            self.chapters_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError as e:
            log.warning("Couldn't write chapters: %s", e)

    def _save_state(self, turns=None, next_index=None, finished=False) -> None:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if turns is not None:
            data["turns"] = turns
        if next_index is not None:
            data["next_index"] = next_index
            data["next_game"] = self.rotation[next_index]
        data["finished"] = finished
        data["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(self.state_file)
        except OSError as e:
            log.warning("Couldn't save the session state: %s", e)
