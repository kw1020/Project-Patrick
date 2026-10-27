"""The pop-up panel: hotkey toggle, alerts at 1 min / 30 s, big 10..1 countdown,
stays up while switching, never takes focus."""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")

from conftest import Rig, make_cfg  # noqa: E402
from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from gameswap.machine import State  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture
def setup(app):
    from gameswap.ui.popup import PopupPanel

    rig = Rig(make_cfg(play_seconds=120))
    popup = PopupPanel(rig.cfg, clock=rig.clock)
    yield rig, popup
    popup.close()


def step(rig, popup, seconds):
    for _ in range(round(seconds / 0.1)):
        rig.advance(0.1)
        popup.update_from(rig.m.snapshot())


def test_never_takes_focus(setup):
    _, popup = setup
    assert popup.windowFlags() & Qt.WindowDoesNotAcceptFocus
    assert popup.windowFlags() & Qt.WindowStaysOnTopHint
    assert popup.testAttribute(Qt.WA_ShowWithoutActivating)
    for b in (popup.start_btn, popup.pause_btn, popup.ready_btn, popup.switch_btn, popup.stop_btn):
        assert b.focusPolicy() == Qt.NoFocus


def test_hotkey_toggle_and_start_button(setup):
    rig, popup = setup
    popup.update_from(rig.m.snapshot())
    assert not popup.isVisible()
    popup.toggle()
    assert popup.isVisible() and popup.start_btn.isVisible() and popup.start_btn.text() == "Start timer"
    started = []
    popup.start_clicked.connect(lambda: started.append(True))
    popup.start_btn.click()
    assert started
    popup.toggle()
    assert not popup.isVisible()


def test_alerts_at_one_minute_and_30_seconds_then_big_countdown(setup):
    rig, popup = setup
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    step(rig, popup, 3.5)  # the "GO!" moment passes
    assert not popup.isVisible(), "tucked away during normal play"
    step(rig, popup, 120 - 3.5 - 60)
    assert popup.isVisible() and "1 minute left" in popup.headline.text()
    step(rig, popup, 6)
    assert not popup.isVisible(), "an alert tucks itself away again"
    step(rig, popup, 60 - 6 - 30)
    assert popup.isVisible() and "30 seconds left" in popup.headline.text()
    step(rig, popup, 30 - 9.95)
    assert popup.isVisible()
    assert popup.clock_label.text() == "10" and popup.clock_label.property("big") == "true"
    assert "Switching to Schedule I in" in popup.headline.text()
    step(rig, popup, 5)
    assert popup.clock_label.text() == "5"


def test_stays_up_while_switching_then_says_go(setup):
    rig, popup = setup
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    rig.m.switch_now()
    seen = set()
    for _ in range(400):
        rig.advance(0.1)
        popup.update_from(rig.m.snapshot())
        if rig.m.state != State.PLAYING:
            assert popup.isVisible(), f"hidden during {rig.m.state}"
            seen.add(rig.m.state)
        elif State.SWITCHING in seen:
            break
    assert {State.SAVING, State.SWITCHING, State.LAUNCHING} <= seen
    popup.update_from(rig.m.snapshot())
    assert popup.isVisible() and popup.headline.text().startswith("GO!")
    step(rig, popup, 3.5)
    assert not popup.isVisible()


def test_ready_button_shows_for_games_you_confirm(setup, monkeypatch):
    rig, popup = setup
    driver = rig.drivers["minecraft"]
    monkeypatch.setattr(type(driver), "manual_ready", True, raising=False)
    rig.cfg.games["minecraft"].simulation.ready_after_seconds = 9999
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.VERIFYING_GAMEPLAY)
    popup.update_from(rig.m.snapshot())
    assert popup.isVisible() and popup.ready_btn.isVisible()


def test_disabled_popup_never_shows(setup):
    rig, popup = setup
    rig.cfg.popup.enabled = False
    popup.toggle()
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    step(rig, popup, 1)
    assert not popup.isVisible()
