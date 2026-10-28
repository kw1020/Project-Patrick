"""Opens the real window (off-screen) and runs a short real-time cycle."""

import os
import time

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")

from conftest import make_cfg  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from gameswap.machine import State  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


def pump(app, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        app.processEvents()
        time.sleep(0.01)


def test_window_runs_a_short_cycle(app, tmp_path, monkeypatch):
    from gameswap.ui import main_window

    monkeypatch.setattr(main_window.sound, "play", lambda kind: None)
    cfg = make_cfg(play_seconds=20, warning_seconds=[8, 3], switch_delay_seconds=0.5,
                   ready_poll_seconds=0.2, ready_stable_checks=2)
    cfg.obs.enabled = False
    cfg.overlay.port = 0
    cfg.overlay.write_text_file = False
    for g in cfg.games.values():
        s = g.simulation
        s.launch_seconds = s.load_seconds = s.save_seconds = s.exit_seconds = 0.3
        s.ready_after_seconds = 0.5

    win = main_window.MainWindow(cfg, config_path=tmp_path / "config.json", session_file=tmp_path / "session.json",
                                 log_dir=tmp_path / "logs", ask_resume=False)
    win.show()
    pump(app, 0.3)
    assert win.start_btn.isEnabled()
    win.start_btn.click()

    end = time.monotonic() + 10
    while win.machine.state != State.PLAYING and time.monotonic() < end:
        pump(app, 0.1)
    assert win.machine.state == State.PLAYING
    pump(app, 0.3)
    assert win.game_label.text() == "Minecraft"
    assert win.clock_label.text().startswith("00:")
    assert win.pause_btn.isEnabled() and win.switch_btn.isEnabled()
    win.grab().save(str(tmp_path / "playing.png"))

    win.switch_btn.click()
    end = time.monotonic() + 10
    while not (win.machine.state == State.PLAYING and win.machine.driver.name == "Schedule I") and time.monotonic() < end:
        pump(app, 0.1)
    assert win.machine.driver.name == "Schedule I"

    win.emergency_btn.click()
    pump(app, 0.3)
    assert win.machine.state == State.STOPPED
    assert "EMERGENCY" in win.message_label.text()
    assert "EMERGENCY STOP" in win.log_view.toPlainText()
    win.machine.state = State.IDLE  # let the window close without the "quit?" question
    win.close()


def test_settings_world_picker_lists_worlds_and_saves_the_folder(app, tmp_path):
    from fake_minecraft import level_dat

    from gameswap.config import Config
    from gameswap.ui.settings_dialog import SettingsDialog

    mc_dir = tmp_path / ".minecraft"
    for folder, shown in (("New World (2)", "Krew's Challenge"), ("Old", "Old")):
        (mc_dir / "saves" / folder).mkdir(parents=True)
        (mc_dir / "saves" / folder / "level.dat").write_bytes(level_dat(shown))
    cfg = Config()
    cfg.games["minecraft"].game_folder = str(mc_dir)
    dlg = SettingsDialog(cfg)
    picker = dlg._game_widgets["minecraft"]["save"]
    assert [picker.itemText(i) for i in range(picker.count())] == ["Krew's Challenge   [New World (2)]", "Old"]
    picker.setCurrentIndex(0)
    dlg._game_widgets["minecraft"]["settle"].setValue(4.5)
    assert dlg._collect() == []
    assert dlg.cfg.games["minecraft"].save_name == "New World (2)"
    assert dlg.cfg.games["minecraft"].ready_settle_seconds == 4.5
    assert cfg.games["minecraft"].save_name == "", "the original settings change only when you press Save"


def test_settings_save_slot_picker(app, tmp_path):
    import json

    from gameswap.config import Config
    from gameswap.s1saves import resolve_slot
    from gameswap.ui.settings_dialog import SettingsDialog

    saves = tmp_path / "Saves"
    for sid in ("111", "222"):
        slot = saves / sid / "SaveGame_1"
        slot.mkdir(parents=True)
        (slot / "Game.json").write_text(json.dumps({"OrganisationName": "Krew Co"}))
    cfg = Config()
    cfg.games["schedule1"].save_folder = str(saves)
    dlg = SettingsDialog(cfg)
    picker = dlg._game_widgets["schedule1"]["save"]
    assert picker.count() == 2 and all("Krew Co (SaveGame_1)" in picker.itemText(i) for i in range(2))
    picker.setCurrentIndex(1)
    assert dlg._collect() == []
    chosen = dlg.cfg.games["schedule1"].save_name
    assert resolve_slot(saves, chosen).steam_id == "222", "two accounts with the same name stay apart"


def test_refused_start_explains_why_in_a_popup(app, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    from gameswap.ui import main_window

    monkeypatch.setattr(main_window.sound, "play", lambda kind: None)
    cfg = make_cfg(play_seconds=5)  # too short: Start must refuse and say why
    cfg.obs.enabled = False
    cfg.overlay.port = 0
    win = main_window.MainWindow(cfg, config_path=tmp_path / "config.json", session_file=tmp_path / "session.json",
                                 log_dir=tmp_path / "logs", ask_resume=False)
    win.show()
    win.start_btn.click()
    pump(app, 0.4)
    boxes = [b for b in win.findChildren(QMessageBox) if b.isVisible()]
    assert boxes and "Play time must be at least 20 seconds" in boxes[0].informativeText()
    for b in boxes:
        b.close()
    win.close()


def test_start_hotkey_repeats_the_last_start_button(app, tmp_path, monkeypatch):
    from gameswap import config as config_mod
    from gameswap.ui import main_window

    monkeypatch.setattr(main_window.sound, "play", lambda kind: None)
    cfg = make_cfg()
    cfg.overlay.port = 0
    cfg.overlay.write_text_file = False
    path = tmp_path / "config.json"
    win = main_window.MainWindow(cfg, config_path=path, session_file=tmp_path / "session.json",
                                 log_dir=tmp_path / "logs", ask_resume=False)
    calls = []
    monkeypatch.setattr(win.machine, "start", lambda test_run=False: calls.append(test_run))
    win._on_hotkey("start")
    win.test_btn.click()
    win._on_hotkey("start")
    win.popup.start_clicked.emit()
    assert calls == [False, True, True, True]
    assert config_mod.load(path).hotkey_start_is_test, "remembered after a restart"
    win.start_btn.click()
    win._on_hotkey("start")
    assert calls[-2:] == [False, False]
    win.close()


def test_update_button_downloads_installs_and_closes(app, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    from gameswap import updater
    from gameswap.ui import main_window

    monkeypatch.setattr(main_window.sound, "play", lambda kind: None)
    cfg = make_cfg()
    cfg.overlay.port = 0
    cfg.overlay.write_text_file = False
    win = main_window.MainWindow(cfg, config_path=tmp_path / "config.json", session_file=tmp_path / "session.json",
                                 log_dir=tmp_path / "logs", ask_resume=False, check_updates=False)
    win.show()
    installed = []
    monkeypatch.setattr(updater, "download", lambda u: tmp_path / u.name)
    monkeypatch.setattr(updater, "start_install", installed.append)
    monkeypatch.setattr(main_window.QApplication, "quit", lambda self=None: None)
    u = updater.Update("9.9.9", "https://dl/x.exe", "GameSwap-Setup-9.9.9.exe", 1, "0" * 64)
    win.bridge.update_found.emit(u)
    pump(app, 0.2)
    assert win.update_btn.isVisible() and win.update_btn.text() == "Update to 9.9.9"
    for b in win.findChildren(QMessageBox):
        b.close()
    win.update_btn.click()
    end = time.monotonic() + 5
    while not installed and time.monotonic() < end:
        pump(app, 0.05)
    assert installed == [tmp_path / "GameSwap-Setup-9.9.9.exe"]
    assert not win.isVisible(), "GameSwap closes so the installer can replace it"
