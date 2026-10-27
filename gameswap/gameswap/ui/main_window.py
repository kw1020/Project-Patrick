"""GameSwap main window."""

from __future__ import annotations

import html
import logging
import os
import subprocess
import sys
import threading

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import (
    QDialog, QFrame, QGridLayout, QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
    QPlainTextEdit, QPushButton, QSizePolicy, QVBoxLayout, QWidget,
)

from .. import config as config_mod
from .. import diagnostics, sound
from ..config import LOG_DIR, Config
from ..drivers import make_drivers
from ..hotkeys import HotkeyListener
from ..machine import ACTIVE_STATES, Machine, State
from ..obs import ObsController
from ..overlay import OverlayServer, overlay_state
from ..procmon import ProcessMonitor
from ..testrun import TestRunner
from .settings_dialog import SettingsDialog

log = logging.getLogger("gameswap")

STATE_TEXT = {
    State.IDLE: "Ready",
    State.LAUNCHING: "Launching",
    State.LOADING: "Loading save",
    State.VERIFYING_GAMEPLAY: "Verifying gameplay",
    State.PLAYING: "Playing",
    State.SAVING: "Saving",
    State.EXITING: "Closing game",
    State.SWITCHING: "Switching",
    State.ERROR: "Needs attention",
    State.STOPPED: "Stopped",
}
LEVEL_COLORS = {logging.ERROR: "#ff6b6b", logging.WARNING: "#ffb020", logging.INFO: "#d8dee9", logging.DEBUG: "#7a8296"}

STYLE = """
QWidget { background: #12141c; color: #e6e9ef; font-family: "Segoe UI"; font-size: 13px; }
QLabel { background: transparent; }
QLabel#game { font-size: 30px; font-weight: 700; }
QLabel#clock { font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 78px; font-weight: 700; }
QGroupBox { border: 1px solid #2a2f3d; border-radius: 8px; margin-top: 14px; padding: 10px; }
QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #9aa3b2; }
QPushButton { background: #252a38; border: 1px solid #343b4d; border-radius: 6px; padding: 8px 14px; }
QPushButton:hover { background: #2f3547; }
QPushButton:disabled { color: #5b6273; background: #1a1d27; border-color: #232735; }
QPushButton#start { background: #1f7a4a; border-color: #2a9a5f; font-weight: 600; }
QPushButton#emergency { background: #b3261e; border-color: #e0443a; font-weight: 700; font-size: 15px; }
QPushButton#emergency:hover { background: #d1302a; }
QPlainTextEdit { background: #0b0d13; border: 1px solid #2a2f3d; border-radius: 6px; font-family: Consolas, monospace; font-size: 12px; }
QFrame#card { background: #191c27; border: 1px solid #2a2f3d; border-radius: 12px; }
QFrame#error { background: #3a1416; border: 1px solid #e0443a; border-radius: 10px; }
QCheckBox::indicator { width: 15px; height: 15px; border: 1px solid #6c7489; border-radius: 3px; background: #0b0d13; }
QCheckBox::indicator:checked { background: #3d7bff; border-color: #3d7bff; }
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox { background: #0b0d13; border: 1px solid #343b4d; border-radius: 4px; padding: 4px; }
"""


def _set_style(widget, css: str) -> None:
    """Restyle only when it changes; restyling every tick wastes CPU."""
    if widget.styleSheet() != css:
        widget.setStyleSheet(css)


class _Bridge(QObject):
    """Carries log lines and hotkeys from background threads to the UI thread."""

    log_line = Signal(int, str)
    hotkey = Signal(str)
    diag_done = Signal(str)


class _QtLogHandler(logging.Handler):
    def __init__(self, bridge: _Bridge):
        super().__init__(logging.INFO)
        self.bridge = bridge
        self.setFormatter(logging.Formatter("%(asctime)s  %(message)s", "%H:%M:%S"))

    def emit(self, record):
        try:
            self.bridge.log_line.emit(record.levelno, self.format(record))
        except RuntimeError:  # window already closed
            pass


class MainWindow(QMainWindow):
    def __init__(self, cfg: Config, config_path=config_mod.CONFIG_PATH):
        super().__init__()
        self.cfg = cfg
        self.config_path = config_path
        self.setWindowTitle("GameSwap")
        self.resize(900, 820)
        self.setStyleSheet(STYLE)

        self.bridge = _Bridge()
        self.bridge.log_line.connect(self._append_log)
        self.bridge.hotkey.connect(self._on_hotkey)
        self.bridge.diag_done.connect(self._diagnostics_done)
        self._log_handler = _QtLogHandler(self.bridge)
        logging.getLogger().addHandler(self._log_handler)

        self.obs: ObsController | None = None
        self.overlay: OverlayServer | None = None
        self.hotkeys: HotkeyListener | None = None
        self.machine: Machine | None = None
        self.tests: TestRunner | None = None
        self.monitor: ProcessMonitor | None = None

        self._build_ui()
        self._build_services()

        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.PreciseTimer)
        self.timer.timeout.connect(self._tick)
        self.timer.start(100)

    # ---- layout ------------------------------------------------------------

    def _build_ui(self) -> None:
        root = QWidget()
        col = QVBoxLayout(root)
        col.setSpacing(10)

        card = QFrame(objectName="card")
        cl = QGridLayout(card)
        self.game_label = QLabel("-", objectName="game")
        self.state_label = QLabel("Ready")
        self.state_label.setStyleSheet("color: #9aa3b2; font-size: 15px;")
        self.clock_label = QLabel("--:--", objectName="clock")
        self.clock_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.next_label = QLabel("Next: -")
        self.next_label.setStyleSheet("font-size: 15px;")
        self.message_label = QLabel("")
        self.message_label.setWordWrap(True)
        self.message_label.setStyleSheet("color: #9aa3b2;")
        cl.addWidget(QLabel("CURRENT GAME", styleSheet="color:#6c7489; font-size:11px; letter-spacing:2px;"), 0, 0)
        cl.addWidget(self.game_label, 1, 0)
        cl.addWidget(self.state_label, 2, 0)
        cl.addWidget(self.next_label, 3, 0)
        cl.addWidget(self.clock_label, 0, 1, 4, 1)
        cl.addWidget(self.message_label, 4, 0, 1, 2)
        cl.setColumnStretch(0, 1)
        col.addWidget(card)

        self.error_frame = QFrame(objectName="error")
        el = QVBoxLayout(self.error_frame)
        self.error_label = QLabel("")
        self.error_label.setWordWrap(True)
        self.error_label.setStyleSheet("font-size: 14px; background: transparent;")
        er = QHBoxLayout()
        self.retry_btn = QPushButton("Retry")
        self.continue_btn = QPushButton("Continue")
        self.retry_btn.clicked.connect(lambda: self.machine.retry())
        self.continue_btn.clicked.connect(lambda: self.machine.continue_manual())
        er.addWidget(self.retry_btn)
        er.addWidget(self.continue_btn)
        er.addStretch(1)
        el.addWidget(self.error_label)
        el.addLayout(er)
        self.error_frame.hide()
        col.addWidget(self.error_frame)

        buttons = QHBoxLayout()
        self.start_btn = QPushButton("Start", objectName="start")
        self.pause_btn = QPushButton("Pause")
        self.resume_btn = QPushButton("Resume")
        self.stop_btn = QPushButton("Stop")
        self.switch_btn = QPushButton("Switch Now")
        self.ready_btn = QPushButton("I'm in the game (Ready)")
        self.ready_btn.setToolTip("For Schedule I: press once your save has loaded and you can play")
        self.emergency_btn = QPushButton("EMERGENCY STOP", objectName="emergency")
        self.start_btn.clicked.connect(lambda: self.machine.start())
        self.pause_btn.clicked.connect(lambda: self.machine.pause())
        self.resume_btn.clicked.connect(lambda: self.machine.resume())
        self.stop_btn.clicked.connect(lambda: self.machine.stop())
        self.switch_btn.clicked.connect(lambda: self.machine.switch_now())
        self.ready_btn.clicked.connect(lambda: self.machine.confirm_ready())
        self.emergency_btn.clicked.connect(self._emergency)
        for b in (self.start_btn, self.pause_btn, self.resume_btn, self.stop_btn, self.switch_btn, self.ready_btn):
            buttons.addWidget(b)
        buttons.addStretch(1)
        self.emergency_btn.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Expanding)
        buttons.addWidget(self.emergency_btn)
        col.addLayout(buttons)

        status = QHBoxLayout()
        self.obs_label = QLabel("OBS: -")
        self.overlay_label = QLabel("")
        self.overlay_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        copy_btn = QPushButton("Copy overlay URL")
        copy_btn.clicked.connect(lambda: QGuiApplication.clipboard().setText(self.overlay.url if self.overlay else ""))
        self.diag_btn = QPushButton("Diagnostics")
        self.diag_btn.setToolTip("Write a report of what GameSwap can find on this PC")
        self.diag_btn.clicked.connect(self._run_diagnostics)
        self.settings_btn = QPushButton("Settings")
        self.settings_btn.clicked.connect(self._open_settings)
        status.addWidget(self.obs_label)
        status.addSpacing(20)
        status.addWidget(self.overlay_label, 1)
        status.addWidget(copy_btn)
        status.addWidget(self.diag_btn)
        status.addWidget(self.settings_btn)
        col.addLayout(status)

        self.games_box = QGroupBox("Games")
        self.games_grid = QGridLayout(self.games_box)
        col.addWidget(self.games_box)

        log_box = QGroupBox("Log")
        ll = QVBoxLayout(log_box)
        self.log_view = QPlainTextEdit(readOnly=True)
        self.log_view.setMaximumBlockCount(3000)
        open_logs = QPushButton("Open log folder")
        open_logs.clicked.connect(self._open_logs)
        ll.addWidget(self.log_view)
        ll.addWidget(open_logs, alignment=Qt.AlignRight)
        col.addWidget(log_box, 1)

        self.hotkey_label = QLabel("")
        self.hotkey_label.setStyleSheet("color: #6c7489; font-size: 11px;")
        col.addWidget(self.hotkey_label)
        self.setCentralWidget(root)

    def _build_games_rows(self) -> None:
        while self.games_grid.count():
            item = self.games_grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.game_rows = {}
        for r, key in enumerate(self.cfg.rotation):
            d = self.machine.drivers[key]
            name = QLabel(f"<b>{html.escape(d.name)}</b>")
            mode = QLabel(d.mode_label)
            mode.setStyleSheet("color: #9aa3b2;")
            running = QLabel("-")
            running.setWordWrap(True)
            test_load = QPushButton("Test Load")
            test_save = QPushButton("Test Save")
            test_load.clicked.connect(lambda _=False, k=key: self._test("load", k))
            test_save.clicked.connect(lambda _=False, k=key: self._test("save", k))
            for c, w in enumerate((name, mode, running, test_load, test_save)):
                self.games_grid.addWidget(w, r, c)
            self.game_rows[key] = (running, test_load, test_save)
        self.games_grid.setColumnStretch(2, 1)

    # ---- services (rebuilt after Settings) -----------------------------------

    def _build_services(self) -> None:
        self._stop_services()
        self.monitor = ProcessMonitor()
        try:
            drivers = make_drivers(self.cfg, self.monitor)
        except Exception as e:  # a broken setting must not stop the app opening
            log.error("Couldn't set up the games (%s). Using simulated games until Settings are fixed.", e)
            for g in self.cfg.games.values():
                g.driver = "simulated"
            drivers = make_drivers(self.cfg, self.monitor)
        self.monitor.start()
        if self.cfg.obs.enabled:
            self.obs = ObsController(self.cfg.obs)
            self.obs.start()
        self.machine = Machine(self.cfg, drivers, self.obs)
        self.machine.on_sound = sound.play
        self.tests = TestRunner(self.cfg, drivers)

        self.overlay = OverlayServer(self.cfg.overlay.port, self.cfg.overlay.write_text_file)
        if self.overlay.start():
            self.overlay_label.setText(f"Overlay: {self.overlay.url}  ·  {self.overlay.url}switching")
        else:
            self.overlay_label.setText("Overlay: port in use - change it in Settings")

        h = self.cfg.hotkeys
        bindings = {
            h.start: lambda: self.bridge.hotkey.emit("start"),
            h.pause: lambda: self.bridge.hotkey.emit("pause"),
            h.stop: lambda: self.bridge.hotkey.emit("stop"),
            h.emergency: lambda: self.bridge.hotkey.emit("emergency"),
            h.ready: lambda: self.bridge.hotkey.emit("ready"),
        }
        self.hotkeys = HotkeyListener(bindings, lambda msg: log.warning(msg))
        self.hotkeys.start()
        self.hotkey_label.setText(
            f"Hotkeys (work in-game):  Start/Resume {h.start}   ·   Pause/Resume {h.pause}   ·   "
            f"Stop {h.stop}   ·   Emergency Stop {h.emergency}   ·   Ready {h.ready}"
        )
        self._build_games_rows()

    def _stop_services(self) -> None:
        if self.hotkeys:
            self.hotkeys.stop()
        if self.machine:
            self.machine.shutdown()
        if self.tests:
            self.tests.abort()
        if self.obs:
            self.obs.close()
            self.obs = None
        if self.overlay:
            self.overlay.close()
        if self.monitor:
            self.monitor.stop()

    # ---- every 100 ms ------------------------------------------------------------

    def _tick(self) -> None:
        m = self.machine
        m.tick()
        s = m.snapshot()
        if self.overlay:
            self.overlay.update(overlay_state(s))

        self.game_label.setText(s.game_name)
        state_text = STATE_TEXT[s.state] + ("  (PAUSED)" if s.paused else "")
        if s.unverified:
            state_text += "  - FALLBACK, gameplay not verified"
        if self.tests.busy:
            state_text = self.tests.current + "..."
        self.state_label.setText(state_text)
        self.next_label.setText(f"Next: {s.next_name}")
        self.message_label.setText(f"⚠ {s.prompt}" if s.prompt and s.state == State.PLAYING else s.message)
        if s.remaining is not None:
            self.clock_label.setText(f"{s.remaining // 60:02d}:{s.remaining % 60:02d}")
            color = {"final": "#ff5252", "warning": "#ffb020"}.get(s.warning_level, "#ffffff")
            if s.paused:
                color = "#7a8296"
            _set_style(self.clock_label, f"color: {color};")
        else:
            self.clock_label.setText("--:--")
            _set_style(self.clock_label, "color: #4a5163;")

        in_error = s.state == State.ERROR
        self.error_frame.setVisible(in_error)
        if in_error:
            self.error_label.setText("⚠  " + s.error)
            self.continue_btn.setText(s.continue_label or "Continue")

        active = s.state in ACTIVE_STATES
        idle = s.state in (State.IDLE, State.STOPPED) and not s.busy
        testing = self.tests.busy
        self.start_btn.setEnabled(idle and not testing)
        self.pause_btn.setEnabled(active and not s.paused)
        self.resume_btn.setEnabled(active and s.paused)
        self.stop_btn.setEnabled(active or in_error)
        self.switch_btn.setEnabled(s.state == State.PLAYING and not s.paused)
        self.ready_btn.setEnabled(s.can_confirm_ready)
        self.settings_btn.setEnabled(idle and not testing)
        for key, (running, load_btn, save_btn) in self.game_rows.items():
            d = m.drivers[key]
            is_running = d.is_running()
            running.setText(("● " if is_running else "○ ") + d.describe())
            _set_style(running, f"color: {'#4cd27a' if is_running else '#6c7489'};")
            load_btn.setEnabled(idle and not testing)
            save_btn.setEnabled(idle and not testing and is_running)

        if self.obs is None:
            self.obs_label.setText("OBS: off (Settings)")
            _set_style(self.obs_label, "color: #6c7489;")
        else:
            st = self.obs.status
            if not st.connected:
                self.obs_label.setText("OBS: not connected")
                self.obs_label.setToolTip(st.error)
                _set_style(self.obs_label, "color: #ffb020;")
            else:
                rec = "● REC" if st.recording else "○ not recording"
                self.obs_label.setText(f"OBS: connected  {rec}  ·  {st.scene}")
                self.obs_label.setToolTip("")
                _set_style(self.obs_label, f"color: {'#4cd27a' if st.recording else '#ffb020'};")

    # ---- actions -------------------------------------------------------------------

    def _emergency(self) -> None:
        self.machine.emergency_stop()
        if self.tests.busy:
            self.tests.abort()
            log.warning("EMERGENCY STOP: test aborted.")

    def _on_hotkey(self, action: str) -> None:
        if action == "start":
            self.machine.start()
        elif action == "pause":
            self.machine.toggle_pause()
        elif action == "stop":
            self.machine.stop()
        elif action == "emergency":
            self._emergency()
        elif action == "ready":
            self.machine.confirm_ready()

    def _test(self, kind: str, key: str) -> None:
        if kind == "load":
            self.tests.test_load(key)
        else:
            self.tests.test_save(key)

    def _open_settings(self) -> None:
        dlg = SettingsDialog(self.cfg, self)
        if dlg.exec() != QDialog.Accepted:
            return
        self.cfg = dlg.cfg
        config_mod.save(self.cfg, self.config_path)
        log.info("Settings saved.")
        self._build_services()

    def _run_diagnostics(self) -> None:
        self.diag_btn.setEnabled(False)
        self.diag_btn.setText("Diagnostics...")
        log.info("Running diagnostics (takes a few seconds)...")
        cfg, drivers = self.cfg, self.machine.drivers

        def work():
            try:
                path = str(diagnostics.write_report(cfg, drivers))
            except Exception as e:
                log.exception("Diagnostics failed")
                path = f"ERROR: {e}"
            self.bridge.diag_done.emit(path)

        threading.Thread(target=work, name="diagnostics", daemon=True).start()

    def _diagnostics_done(self, path: str) -> None:
        self.diag_btn.setEnabled(True)
        self.diag_btn.setText("Diagnostics")
        if path.startswith("ERROR"):
            return
        log.info("Diagnostics saved: %s", path)
        if sys.platform == "win32":
            os.startfile(path)

    def _open_logs(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(LOG_DIR)
        else:
            subprocess.Popen(["xdg-open", str(LOG_DIR)])

    def _append_log(self, level: int, text: str) -> None:
        color = LEVEL_COLORS.get(level, "#d8dee9")
        self.log_view.appendHtml(f'<span style="color:{color}">{html.escape(text)}</span>')

    def closeEvent(self, event) -> None:
        s = self.machine.snapshot()
        if s.state in ACTIVE_STATES or s.state == State.ERROR:
            answer = QMessageBox.question(
                self, "Quit GameSwap?",
                "A run is in progress. Quitting stops the automation. Games and OBS are left exactly as they are.",
            )
            if answer != QMessageBox.Yes:
                event.ignore()
                return
        self.timer.stop()
        self._stop_services()
        logging.getLogger().removeHandler(self._log_handler)
        event.accept()
