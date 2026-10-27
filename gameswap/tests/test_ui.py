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

    win = main_window.MainWindow(cfg, config_path=tmp_path / "config.json")
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
