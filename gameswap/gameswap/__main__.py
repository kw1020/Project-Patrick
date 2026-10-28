"""Start GameSwap:  python -m gameswap"""

from __future__ import annotations

import logging
import sys


def lower_priority() -> None:
    """Run GameSwap at 'below normal' priority, so your games and OBS always get
    the CPU first. Its work is tiny, so its timer stays accurate."""
    try:
        import psutil

        p = psutil.Process()
        p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if sys.platform == "win32" else 10)
    except Exception as e:  # not allowed / not supported: run at normal priority
        logging.getLogger("gameswap").debug("Couldn't lower GameSwap's priority: %s", e)


def main() -> int:
    if "--selftest" in sys.argv:
        from .selftest import run

        return run()
    if sys.version_info < (3, 12):
        print("GameSwap needs Python 3.12 or newer. See README, step 1.")
        return 1
    try:
        from PySide6.QtWidgets import QApplication, QMessageBox
    except ImportError:
        print("PySide6 isn't installed. Double-click install.bat first.")
        return 1

    from . import __version__, config, logsetup

    log_path = logsetup.setup()
    log = logging.getLogger("gameswap")
    if sys.platform == "win32":
        # Its own taskbar identity, so Windows shows GameSwap's icon instead of Python's.
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("GameSwap.App")
    lower_priority()
    app = QApplication(sys.argv)
    app.setApplicationName("GameSwap")
    from PySide6.QtGui import QIcon

    from .ui import ICON_PATH

    app.setWindowIcon(QIcon(str(ICON_PATH)))

    try:
        cfg = config.load()
    except Exception as e:
        QMessageBox.critical(None, "GameSwap", f"config.json couldn't be read:\n{e}\n\n"
                             "Fix it, or delete it to go back to the default settings.")
        return 1

    from .ui.main_window import MainWindow

    log.info("GameSwap %s started. Log file: %s", __version__, log_path)
    for problem in cfg.validate():
        log.warning("Settings: %s", problem)
    window = MainWindow(cfg)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
