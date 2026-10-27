"""Settings window. Changes are saved to config.json when you press Save."""

from __future__ import annotations

import copy
import threading

from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFileDialog, QFormLayout,
    QGroupBox, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton, QScrollArea, QSpinBox,
    QTabWidget, QVBoxLayout, QWidget,
)

from ..config import DRIVERS, POPUP_CORNERS, SIM_FAIL_STEPS, Config
from ..hotkeys import parse_hotkey
from ..obs import ObsController


def _spin(value: int, lo: int, hi: int, suffix: str = " s") -> QSpinBox:
    s = QSpinBox()
    s.setRange(lo, hi)
    s.setValue(int(value))
    s.setSuffix(suffix)
    return s


def _dspin(value: float, lo: float, hi: float, step: float = 0.5, suffix: str = " s") -> QDoubleSpinBox:
    s = QDoubleSpinBox()
    s.setRange(lo, hi)
    s.setDecimals(1)
    s.setSingleStep(step)
    s.setValue(float(value))
    s.setSuffix(suffix)
    return s


def _hint(text: str) -> QLabel:
    label = QLabel(text)
    label.setWordWrap(True)
    label.setStyleSheet("color: #8a93a6; font-size: 11px;")
    return label


class _ObsTestSignal(QObject):
    done = Signal(str)


class SettingsDialog(QDialog):
    def __init__(self, cfg: Config, parent=None):
        super().__init__(parent)
        self.setWindowTitle("GameSwap Settings")
        self.resize(620, 640)
        self.cfg = copy.deepcopy(cfg)
        self._game_widgets: dict[str, dict] = {}

        tabs = QTabWidget()
        tabs.addTab(self._timer_tab(), "Timer")
        tabs.addTab(self._games_tab(), "Games")
        tabs.addTab(self._obs_tab(), "OBS")
        tabs.addTab(self._overlay_tab(), "Overlay && Hotkeys")

        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(tabs)
        layout.addWidget(buttons)

    # ---- tabs ------------------------------------------------------------

    def _timer_tab(self) -> QWidget:
        c = self.cfg
        w = QWidget()
        form = QFormLayout(w)
        self.play_min = _spin(c.play_seconds // 60, 0, 180, " min")
        self.play_sec = _spin(c.play_seconds % 60, 0, 59, " s")
        row = QHBoxLayout()
        row.addWidget(self.play_min)
        row.addWidget(self.play_sec)
        form.addRow("Play time per game", row)
        form.addRow("", _hint("Counts only verified gameplay. Loading screens are never counted."))
        self.warnings = QLineEdit(", ".join(str(x) for x in c.warning_seconds))
        form.addRow("Warnings (seconds left)", self.warnings)
        self.launch_timeout = _spin(c.launch_timeout, 5, 1800)
        self.load_timeout = _spin(c.load_timeout, 5, 1800)
        self.save_timeout = _spin(c.save_timeout, 5, 1800)
        self.exit_timeout = _spin(c.exit_timeout, 5, 1800)
        form.addRow("Launch timeout", self.launch_timeout)
        form.addRow("Loading timeout", self.load_timeout)
        form.addRow("", _hint("How long a game may take from launch to verified gameplay before GameSwap stops and asks you."))
        form.addRow("Save timeout", self.save_timeout)
        form.addRow("Exit timeout", self.exit_timeout)
        self.ready_checks = _spin(c.ready_stable_checks, 1, 30, "")
        self.ready_poll = _dspin(c.ready_poll_seconds, 0.2, 10)
        form.addRow("Ready checks in a row", self.ready_checks)
        form.addRow("Time between ready checks", self.ready_poll)
        self.switch_delay = _dspin(c.switch_delay_seconds, 0, 60)
        form.addRow("Pause between games", self.switch_delay)
        self.fallback = QCheckBox("Use a 12-minute fallback cycle if gameplay can't be verified")
        self.fallback.setChecked(c.fallback_cycle_enabled)
        self.fallback_min = _dspin(c.fallback_cycle_seconds / 60, 1, 120, 0.5, " min")
        form.addRow(self.fallback)
        form.addRow("Fallback cycle length", self.fallback_min)
        form.addRow("", _hint("Off = stop and ask you (safest). On = the turn ends this long after launch. "
                              "Saving and closing are verified either way."))
        self.retries = _spin(c.launch_retries, 0, 5, "")
        self.retry_delay = _spin(c.launch_retry_delay, 1, 600)
        form.addRow("Automatic launch retries", self.retries)
        form.addRow("Wait before retrying", self.retry_delay)
        self.stop_after = _spin(c.stop_after_turns, 0, 1000, " turns")
        form.addRow("Stop by itself after", self.stop_after)
        form.addRow("", _hint("0 = keep going until you press Stop. It always saves and closes the game first."))
        self.sounds = QCheckBox("Play warning sounds")
        self.sounds.setChecked(c.sounds)
        form.addRow(self.sounds)
        return w

    def _games_tab(self) -> QWidget:
        inner = QWidget()
        col = QVBoxLayout(inner)
        for key in self.cfg.rotation:
            g = self.cfg.games[key]
            box = QGroupBox(g.name)
            form = QFormLayout(box)
            wd = {}
            wd["name"] = QLineEdit(g.name)
            wd["scene"] = QLineEdit(g.obs_scene)
            wd["path"] = QLineEdit(g.launch_path)
            browse = QPushButton("Browse...")
            browse.clicked.connect(lambda _=False, e=wd["path"]: self._browse(e))
            path_row = QHBoxLayout()
            path_row.addWidget(wd["path"])
            path_row.addWidget(browse)
            wd["folder"] = QLineEdit(g.game_folder)
            folder_btn = QPushButton("Browse...")
            folder_btn.clicked.connect(lambda _=False, e=wd["folder"]: self._browse_folder(e))
            folder_row = QHBoxLayout()
            folder_row.addWidget(wd["folder"])
            folder_row.addWidget(folder_btn)
            wd["steam"] = QLineEdit(g.steam_app_id)
            if key == "minecraft":
                wd["save"] = self._world_picker(g)
            elif key == "schedule1":
                wd["save"] = self._slot_picker(g)
            else:
                wd["save"] = QLineEdit(g.save_name)
            wd["saves_folder"] = QLineEdit(g.save_folder)
            wd["saves_folder"].setPlaceholderText("blank = AppData\\LocalLow\\TVGS\\Schedule I\\Saves")
            wd["prompt"] = _spin(g.save_prompt_seconds, 0, 3600)
            wd["max_age"] = _spin(g.save_max_age_seconds, 10, 3600)
            wd["save_wait"] = _spin(g.save_wait_seconds, 0, 3600)
            wd["ready_re"] = QLineEdit(g.ready_log_pattern)
            wd["ready_re"].setPlaceholderText("blank = I press Ready myself")
            wd["auto_play"] = QCheckBox("Press Quick Play / PLAY in the launcher for me")
            wd["auto_play"].setChecked(g.auto_click_play)
            wd["settle"] = _dspin(g.ready_settle_seconds, 0, 60)
            wd["backup"] = QCheckBox("Back up the world/save before every Start")
            wd["backup"].setChecked(g.backup_before_start)
            wd["keep"] = _spin(g.backups_keep, 1, 100, " backups")
            wd["driver"] = QComboBox()
            if key in DRIVERS:
                wd["driver"].addItem("Real game", DRIVERS[key][0])
            wd["driver"].addItem("Simulated (pretend game, for testing)", "simulated")
            wd["driver"].setCurrentIndex(max(0, wd["driver"].findData(g.driver)))
            is_steam = key == "schedule1"
            form.addRow("Name", wd["name"])
            form.addRow("Game driver", wd["driver"])
            form.addRow("OBS scene", wd["scene"])
            form.addRow("steam.exe" if is_steam else "Minecraft Launcher", path_row)
            form.addRow("Install folder" if is_steam else ".minecraft folder", folder_row)
            form.addRow("", _hint("Leave both blank to find them automatically. Diagnostics shows what was found."))
            if is_steam:
                form.addRow("Steam App ID", wd["steam"])
            form.addRow("Save to load" if is_steam else "World to open", wd["save"])
            if is_steam:
                form.addRow("Saves folder", wd["saves_folder"])
                form.addRow("Show SAVE NOW at", wd["prompt"])
                form.addRow("A save this recent counts", wd["max_age"])
                form.addRow("Wait for your save up to", wd["save_wait"])
                form.addRow("Ready log line (advanced)", wd["ready_re"])
                form.addRow("", _hint("Schedule I (Phase 4): GameSwap launches it through Steam. You load your "
                                      "save and press Ready. At SAVE NOW you sleep or use the save device; GameSwap "
                                      "checks the save files on disk, then closes the game normally. It never "
                                      "closes Schedule I without a verified save."))
            else:
                form.addRow(wd["auto_play"])
                form.addRow("Wait for terrain after joining", wd["settle"])
                form.addRow("", _hint("Minecraft (Phase 3): opens your world, starts the timer once you're in "
                                      "the world, saves with the pause menu (confirmed in Minecraft's log) and "
                                      "closes normally."))
            form.addRow(wd["backup"])
            form.addRow("Keep", wd["keep"])
            sim = g.simulation
            wd["sim_launch"] = _dspin(sim.launch_seconds, 0, 120)
            wd["sim_load"] = _dspin(sim.load_seconds, 0, 120)
            wd["sim_ready"] = _dspin(sim.ready_after_seconds, 0, 120)
            wd["sim_save"] = _dspin(sim.save_seconds, 0, 120)
            wd["sim_exit"] = _dspin(sim.exit_seconds, 0, 120)
            wd["sim_fail"] = QComboBox()
            for step in SIM_FAIL_STEPS:
                wd["sim_fail"].addItem("Nothing (normal)" if not step else f"Fail at: {step}", step)
            wd["sim_fail"].setCurrentIndex(SIM_FAIL_STEPS.index(sim.fail_step))
            sim_box = QGroupBox("Simulation (testing only)")
            sim_form = QFormLayout(sim_box)
            sim_form.addRow("Launch takes", wd["sim_launch"])
            sim_form.addRow("Loading the save takes", wd["sim_load"])
            sim_form.addRow("Loading screen after that", wd["sim_ready"])
            sim_form.addRow("Saving takes", wd["sim_save"])
            sim_form.addRow("Closing takes", wd["sim_exit"])
            sim_form.addRow("Make a step fail", wd["sim_fail"])
            form.addRow(sim_box)
            self._game_widgets[key] = wd
            col.addWidget(box)
        col.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(inner)
        return scroll

    def _obs_tab(self) -> QWidget:
        o = self.cfg.obs
        w = QWidget()
        form = QFormLayout(w)
        self.obs_enabled = QCheckBox("Control OBS (switch scenes, check recording)")
        self.obs_enabled.setChecked(o.enabled)
        self.obs_host = QLineEdit(o.host)
        self.obs_port = _spin(o.port, 1, 65535, "")
        self.obs_password = QLineEdit(o.password)
        self.obs_password.setEchoMode(QLineEdit.Password)
        show = QCheckBox("Show")
        show.toggled.connect(lambda on: self.obs_password.setEchoMode(QLineEdit.Normal if on else QLineEdit.Password))
        pw_row = QHBoxLayout()
        pw_row.addWidget(self.obs_password)
        pw_row.addWidget(show)
        self.obs_switching = QLineEdit(o.switching_scene)
        self.obs_record = QCheckBox("Start recording when I press Start (it is never stopped)")
        self.obs_record.setChecked(o.start_recording_on_start)
        self.obs_test_run = QCheckBox("Test run: switch scenes but DON'T record")
        self.obs_test_run.setChecked(o.test_run_no_recording)
        self.obs_test_run.toggled.connect(lambda on: self.obs_record.setEnabled(not on))
        self.obs_record.setEnabled(not o.test_run_no_recording)
        self.obs_test = QPushButton("Test OBS connection")
        self.obs_result = _hint("")
        self.obs_signal = _ObsTestSignal()
        self.obs_signal.done.connect(self._obs_test_done)
        self.obs_test.clicked.connect(self._test_obs)
        form.addRow(self.obs_enabled)
        form.addRow("Host", self.obs_host)
        form.addRow("Port", self.obs_port)
        form.addRow("Password", pw_row)
        form.addRow("", _hint("In OBS: Tools > WebSocket Server Settings > Show Connect Info."))
        form.addRow("Switching scene", self.obs_switching)
        form.addRow(self.obs_record)
        form.addRow(self.obs_test_run)
        form.addRow("", _hint("Tick for practice runs. Untick before recording for real."))
        form.addRow(self.obs_test)
        form.addRow(self.obs_result)
        return w

    def _overlay_tab(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self.overlay_port = _spin(self.cfg.overlay.port, 1024, 65535, "")
        self.overlay_text = QCheckBox("Also write overlay/timer.txt (for an OBS Text source)")
        self.overlay_text.setChecked(self.cfg.overlay.write_text_file)
        form.addRow("Overlay port", self.overlay_port)
        form.addRow(self.overlay_text)
        p = self.cfg.popup
        self.popup_on = QCheckBox("Pop-up panel at the top of the screen")
        self.popup_on.setChecked(p.enabled)
        self.popup_corner = QComboBox()
        for corner in POPUP_CORNERS:
            self.popup_corner.addItem(corner.replace("-", " ").capitalize(), corner)
        self.popup_corner.setCurrentIndex(max(0, self.popup_corner.findData(p.corner)))
        self.popup_alerts = QLineEdit(", ".join(str(x) for x in p.alert_seconds))
        self.countdown = _spin(self.cfg.countdown_seconds, 0, 60)
        form.addRow(self.popup_on)
        form.addRow("Pop-up position", self.popup_corner)
        form.addRow("Pop up by itself at (seconds left)", self.popup_alerts)
        form.addRow("Big final countdown from", self.countdown)
        form.addRow("", _hint("The pop-up never takes focus, so it can't pause your game. For it to show over "
                              "a game, play in borderless or windowed fullscreen."))
        h = self.cfg.hotkeys
        self.hk = {
            "start": QLineEdit(h.start), "pause": QLineEdit(h.pause),
            "stop": QLineEdit(h.stop), "emergency": QLineEdit(h.emergency),
            "ready": QLineEdit(h.ready),
            "popup": QLineEdit(h.popup),
        }
        form.addRow(_hint("Hotkeys work while a game is in front. Example: ctrl+shift+F9"))
        form.addRow("Start / Resume", self.hk["start"])
        form.addRow("Pause / Resume", self.hk["pause"])
        form.addRow("Stop", self.hk["stop"])
        form.addRow("Emergency Stop", self.hk["emergency"])
        form.addRow("I'm in the game (Ready)", self.hk["ready"])
        form.addRow("Show / hide the pop-up", self.hk["popup"])
        return w

    # ---- actions ---------------------------------------------------------

    def _browse(self, edit: QLineEdit) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Choose the program", edit.text(), "Programs (*.exe);;All files (*)")
        if path:
            edit.setText(path.replace("/", "\\"))

    def _world_picker(self, g) -> QComboBox:
        """Dropdown of the worlds in the .minecraft folder (you can also type a name)."""
        from pathlib import Path

        from ..drivers.minecraft import default_game_dir, list_worlds
        from ..mcworld import level_name

        box = QComboBox()
        box.setEditable(True)
        game_dir = Path(g.game_folder) if g.game_folder else default_game_dir()
        current = -1
        for folder in list_worlds(game_dir):
            shown = level_name(game_dir / "saves" / folder / "level.dat") or folder
            box.addItem(shown if shown == folder else f"{shown}   [{folder}]", folder)
            if g.save_name in (folder, shown):
                current = box.count() - 1
        if current >= 0:
            box.setCurrentIndex(current)
        else:
            box.setEditText(g.save_name)
        return box

    def _slot_picker(self, g) -> QComboBox:
        """Dropdown of Schedule I save slots (you can also type a name)."""
        from pathlib import Path

        from ..s1saves import default_saves_root, list_slots

        box = QComboBox()
        box.setEditable(True)
        root = Path(g.save_folder) if g.save_folder else default_saves_root()
        current = -1
        slots = list_slots(root)
        several_accounts = len({s.steam_id for s in slots}) > 1
        for slot in slots:
            label = f"{slot.label}  [Steam {slot.steam_id}]" if several_accounts else slot.label
            box.addItem(label, str(slot.path))  # the full path can't be mixed up between accounts
            if g.save_name and g.save_name.lower() in (slot.folder.lower(), slot.name.lower(), str(slot.path).lower()):
                current = box.count() - 1
        if current >= 0:
            box.setCurrentIndex(current)
        else:
            box.setEditText(g.save_name)
        return box

    def _browse_folder(self, edit: QLineEdit) -> None:
        path = QFileDialog.getExistingDirectory(self, "Choose the folder", edit.text())
        if path:
            edit.setText(path.replace("/", "\\"))

    def _test_obs(self) -> None:
        self._collect()
        self.obs_test.setEnabled(False)
        self.obs_result.setText("Connecting...")
        cfg = copy.deepcopy(self.cfg.obs)
        cfg.start_recording_on_start = False  # a test must not start recording
        scenes = [cfg.switching_scene] + [self.cfg.games[k].obs_scene for k in self.cfg.rotation]

        def run():
            ctl = ObsController(cfg)
            problems = ctl.preflight(scenes)
            ctl.close()
            not_recording = [p for p in problems if "isn't recording" in p]
            real = [p for p in problems if p not in not_recording]
            if real:
                text = "Problem: " + " | ".join(real)
            else:
                text = "Connected. All scenes found." + (" (OBS isn't recording right now.)" if not_recording else "")
            self.obs_signal.done.emit(text)

        threading.Thread(target=run, daemon=True).start()

    def _obs_test_done(self, text: str) -> None:
        self.obs_test.setEnabled(True)
        self.obs_result.setText(text)

    def _collect(self) -> list[str]:
        """Copy every widget into self.cfg. Returns problems found while reading."""
        c, problems = self.cfg, []
        c.play_seconds = self.play_min.value() * 60 + self.play_sec.value()
        try:
            c.warning_seconds = sorted({int(x) for x in self.warnings.text().replace(" ", "").split(",") if x}, reverse=True)
        except ValueError:
            problems.append("Warnings must be whole numbers separated by commas, like: 30, 10")
        c.launch_timeout = self.launch_timeout.value()
        c.load_timeout = self.load_timeout.value()
        c.save_timeout = self.save_timeout.value()
        c.exit_timeout = self.exit_timeout.value()
        c.ready_stable_checks = self.ready_checks.value()
        c.ready_poll_seconds = self.ready_poll.value()
        c.switch_delay_seconds = self.switch_delay.value()
        c.fallback_cycle_enabled = self.fallback.isChecked()
        c.fallback_cycle_seconds = round(self.fallback_min.value() * 60)
        c.sounds = self.sounds.isChecked()
        c.launch_retries = self.retries.value()
        c.launch_retry_delay = self.retry_delay.value()
        c.stop_after_turns = self.stop_after.value()
        for key, wd in self._game_widgets.items():
            g = c.games[key]
            g.name = wd["name"].text().strip() or g.name
            g.obs_scene = wd["scene"].text().strip()
            g.launch_path = wd["path"].text().strip()
            g.game_folder = wd["folder"].text().strip()
            g.steam_app_id = wd["steam"].text().strip()
            if isinstance(wd["save"], QComboBox):
                box = wd["save"]
                i = box.currentIndex()
                if i < 0 or box.currentText() != box.itemText(i):  # you typed something instead
                    i = box.findText(box.currentText())
                g.save_name = (box.itemData(i) if i >= 0 else box.currentText()).strip()
            else:
                g.save_name = wd["save"].text().strip()
            g.auto_click_play = wd["auto_play"].isChecked()
            g.save_folder = wd["saves_folder"].text().strip()
            g.save_prompt_seconds = wd["prompt"].value()
            g.save_max_age_seconds = wd["max_age"].value()
            g.save_wait_seconds = wd["save_wait"].value()
            g.ready_log_pattern = wd["ready_re"].text().strip()
            g.ready_settle_seconds = wd["settle"].value()
            g.backup_before_start = wd["backup"].isChecked()
            g.backups_keep = wd["keep"].value()
            g.driver = wd["driver"].currentData()
            s = g.simulation
            s.launch_seconds = wd["sim_launch"].value()
            s.load_seconds = wd["sim_load"].value()
            s.ready_after_seconds = wd["sim_ready"].value()
            s.save_seconds = wd["sim_save"].value()
            s.exit_seconds = wd["sim_exit"].value()
            s.fail_step = wd["sim_fail"].currentData()
        o = c.obs
        o.enabled = self.obs_enabled.isChecked()
        o.host = self.obs_host.text().strip() or "localhost"
        o.port = self.obs_port.value()
        o.password = self.obs_password.text()
        o.switching_scene = self.obs_switching.text().strip()
        o.start_recording_on_start = self.obs_record.isChecked()
        o.test_run_no_recording = self.obs_test_run.isChecked()
        c.overlay.port = self.overlay_port.value()
        c.overlay.write_text_file = self.overlay_text.isChecked()
        c.popup.enabled = self.popup_on.isChecked()
        c.popup.corner = self.popup_corner.currentData()
        try:
            c.popup.alert_seconds = sorted({int(x) for x in self.popup_alerts.text().replace(" ", "").split(",") if x},
                                           reverse=True)
        except ValueError:
            problems.append("Pop-up alerts must be whole numbers separated by commas, like: 60, 30")
        c.countdown_seconds = self.countdown.value()
        for name, edit in self.hk.items():
            text = edit.text().strip()
            try:
                parse_hotkey(text)
            except ValueError as e:
                problems.append(f"Hotkey '{text}': {e}")
            setattr(c.hotkeys, name, text)
        return problems

    def _save(self) -> None:
        problems = self._collect() + self.cfg.validate()
        if problems:
            QMessageBox.warning(self, "Please fix these settings", "\n\n".join(problems))
            return
        self.accept()
