"""`GameSwap.exe --selftest` (or `python -m gameswap --selftest`).

Checks that everything GameSwap needs is present and works on this PC,
without touching any game or OBS: libraries, overlay pages, the folder it
saves to, and a short run of the real window with two pretend games.
Writes the result to selftest-result.txt next to GameSwap and returns 0
when everything passed.
"""

from __future__ import annotations

import importlib
import logging
import sys
import tempfile
import time
import traceback
from pathlib import Path

from . import __version__
from .config import APP_DIR


def run(result_file: Path | None = None) -> int:
    result_file = result_file or APP_DIR / "selftest-result.txt"
    lines = [f"GameSwap {__version__} self-test - {time.strftime('%Y-%m-%d %H:%M:%S')}",
             f"Python {sys.version.split()[0]}, packaged: {bool(getattr(sys, 'frozen', False))}"]
    ok = True

    def check(name, fn):
        nonlocal ok
        try:
            detail = fn() or ""
            lines.append(f"PASS  {name}{' - ' + detail if detail else ''}")
        except Exception as e:
            ok = False
            lines.append(f"FAIL  {name} - {e.__class__.__name__}: {e}")
            lines.append("      " + traceback.format_exc().strip().replace("\n", "\n      "))

    libs = ["PySide6.QtWidgets", "obsws_python", "psutil"]
    if sys.platform == "win32":
        libs += ["win32gui", "win32api", "win32process", "win32com.client", "uiautomation"]
    for lib in libs:
        check(f"library {lib}", lambda lib=lib: importlib.import_module(lib) and None)

    def pages():
        from .overlay import PAGES_DIR

        for name in ("timer.html", "switching.html"):
            if not (PAGES_DIR / name).is_file():
                raise FileNotFoundError(PAGES_DIR / name)
        return str(PAGES_DIR)

    check("overlay pages", pages)

    def icon():
        from .ui import ICON_PATH

        if not ICON_PATH.is_file():
            raise FileNotFoundError(ICON_PATH)

    check("app icon", icon)

    def writable():
        probe = APP_DIR / ".gameswap-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return str(APP_DIR)

    check("GameSwap's folder is writable", writable)
    check("window + timer + state machine (pretend games)", _window_run)

    lines.append("RESULT: " + ("ALL PASSED" if ok else "SOMETHING FAILED - send this file to Claude"))
    text = "\n".join(lines) + "\n"
    try:
        result_file.write_text(text, encoding="utf-8")
    except OSError:
        pass
    print(text)
    return 0 if ok else 1


def _window_run() -> str:
    from PySide6.QtWidgets import QApplication

    from .config import Config
    from .machine import State
    from .ui import main_window

    app = QApplication.instance() or QApplication(sys.argv[:1])
    tmp = Path(tempfile.mkdtemp(prefix="gameswap-selftest-"))
    cfg = Config()
    cfg.obs.enabled = False
    cfg.overlay.port = 0
    cfg.overlay.write_text_file = False
    cfg.sounds = False
    cfg.play_seconds = 20
    cfg.warning_seconds = [10, 5]
    cfg.switch_delay_seconds = 0.2
    cfg.ready_poll_seconds = 0.1
    cfg.ready_stable_checks = 2
    for g in cfg.games.values():
        g.driver = "simulated"
        g.save_prompt_seconds = 0
        s = g.simulation
        s.launch_seconds = s.load_seconds = s.save_seconds = s.exit_seconds = 0.2
        s.ready_after_seconds = 0.3
    logging.getLogger().setLevel(logging.INFO)
    win = main_window.MainWindow(cfg, config_path=tmp / "config.json", session_file=tmp / "session.json",
                                 log_dir=tmp / "logs", ask_resume=False)
    seen = []

    def pump_until(cond, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            app.processEvents()
            if win.machine.state not in seen[-1:]:
                seen.append(win.machine.state)
            if cond():
                return True
            time.sleep(0.01)
        return False

    try:
        win.machine.start()
        if not pump_until(lambda: win.machine.state == State.PLAYING, 15):
            raise RuntimeError(f"never reached PLAYING (stuck in {win.machine.state.value})")
        win.machine.switch_now()
        if not pump_until(lambda: win.machine.state == State.PLAYING and win.machine.turn == 2, 15):
            raise RuntimeError(f"the switch didn't finish (stuck in {win.machine.state.value})")
        win.machine.emergency_stop()
        pump_until(lambda: False, 0.2)
        csvs = list((tmp / "logs").glob("session-*.csv"))
        if not csvs or "turn_start,2," not in csvs[0].read_text(encoding="utf-8"):
            raise RuntimeError("the session log wasn't written")
        if not list((tmp / "logs").glob("chapters-*.txt")):
            raise RuntimeError("the YouTube chapters file wasn't written")
    finally:
        win.machine.state = State.IDLE
        win.close()
    return " -> ".join(s.value for s in seen)
