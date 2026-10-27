"""Warning beeps. They play on a background thread so the timer never waits."""

from __future__ import annotations

import sys
import threading

# (frequency Hz, milliseconds) pairs; 0 Hz is a pause.
PATTERNS = {
    "warning": [(880, 180), (0, 120), (880, 180)],  # 30 s left
    "final": [(1175, 150), (0, 80), (1175, 150), (0, 80), (1175, 150)],  # 10 s left
    "tick": [(1000, 90)],  # 3, 2, 1
    "go": [(660, 120), (990, 220)],  # timer started
    "error": [(330, 500)],
}


def play(kind: str) -> None:
    pattern = PATTERNS.get(kind)
    if pattern:
        threading.Thread(target=_play, args=(pattern,), name="sound", daemon=True).start()


def _play(pattern) -> None:
    if sys.platform == "win32":
        import time
        import winsound

        for freq, ms in pattern:
            if freq:
                winsound.Beep(freq, ms)
            else:
                time.sleep(ms / 1000)
    else:
        print("\a", end="", flush=True)
