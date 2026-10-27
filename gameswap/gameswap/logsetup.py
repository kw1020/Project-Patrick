"""Logging to the screen and to logs/gameswap-YYYY-MM-DD.log."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

from .config import LOG_DIR

FORMAT = "%(asctime)s %(levelname)-7s %(message)s"


def setup(log_dir: Path = LOG_DIR) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"gameswap-{time.strftime('%Y-%m-%d')}.log"
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    file_handler = logging.FileHandler(path, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter(FORMAT, "%H:%M:%S"))
    root.addHandler(file_handler)
    if sys.stderr is not None:  # the packaged GameSwap.exe has no console
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter(FORMAT, "%H:%M:%S"))
        root.addHandler(console)
    return path
