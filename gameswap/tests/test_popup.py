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


def test_corner_timer_is_on_from_the_start_and_hotkey_opens_the_panel(setup):
    rig, popup = setup
    popup.update_from(rig.m.snapshot())
    assert popup.isVisible() and popup.compact, "always on, no button needed"
    assert popup.mini_game.text() == "GAMESWAP  ·  READY" and popup.mini_clock.text() == "2:00"
    assert "Ctrl+Shift+F6 to start" in popup.mini_next.text()
    popup.toggle()
    assert popup.isVisible() and not popup.compact
    assert popup.start_btn.isVisible() and popup.start_btn.text() == "Start"
    started = []
    popup.start_clicked.connect(lambda: started.append(True))
    popup.start_btn.click()
    assert started
    popup.toggle()
    popup.update_from(rig.m.snapshot())
    assert popup.isVisible() and popup.compact, "closing the panel goes back to the small timer"


def test_alerts_at_one_minute_and_30_seconds_then_big_countdown(setup):
    rig, popup = setup
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    step(rig, popup, 3.5)  # the "GO!" moment passes
    assert popup.compact, "only the small corner timer during normal play"
    step(rig, popup, 120 - 3.5 - 60)
    assert popup.isVisible() and "1 minute left" in popup.headline.text()
    step(rig, popup, 6)
    assert popup.compact, "an alert shrinks back to the small timer"
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
    assert popup.compact


def test_ready_button_shows_for_games_you_confirm(setup, monkeypatch):
    rig, popup = setup
    driver = rig.drivers["minecraft"]
    monkeypatch.setattr(type(driver), "manual_ready", True, raising=False)
    rig.cfg.games["minecraft"].simulation.ready_after_seconds = 9999
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.VERIFYING_GAMEPLAY)
    popup.update_from(rig.m.snapshot())
    assert popup.compact and popup.mini_next.text() == "Playing? Ctrl+Shift+F10 starts the timer"
    popup.toggle()
    popup.update_from(rig.m.snapshot())
    assert popup.ready_btn.isVisible()


def test_disabled_popup_never_shows(setup):
    rig, popup = setup
    rig.cfg.popup.enabled = False
    popup.toggle()
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    step(rig, popup, 1)
    assert not popup.isVisible()


def test_small_timer_stays_in_the_top_left_while_playing(setup, app):
    rig, popup = setup
    assert rig.cfg.popup.corner == "top-left" and rig.cfg.popup.always_show_timer
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    step(rig, popup, 4)  # past the GO! moment
    assert popup.isVisible() and popup.compact, "the small timer is always there while playing"
    assert popup.mini.isVisible() and not popup.panel.isVisible()
    assert popup.mini_clock.text() == "1:56" and popup.mini_game.text() == "MINECRAFT  ·  TURN 1"
    assert popup.mini_next.text() == "Next: Schedule I"
    assert popup.windowFlags() & Qt.WindowTransparentForInput, "clicks pass through to the game"
    area = app.primaryScreen().availableGeometry()
    assert popup.x() == area.left() + 16 and popup.y() == area.top() + 16
    step(rig, popup, 120 - 4 - 59.5)  # 1 minute left: grows into the full panel
    assert not popup.compact and popup.panel.isVisible() and "1 minute left" in popup.headline.text()
    assert not popup.windowFlags() & Qt.WindowTransparentForInput
    step(rig, popup, 6)
    assert popup.isVisible() and popup.compact, "back to the small timer after the alert"
    assert popup.mini_next.text().endswith("left  ·  then Schedule I") and popup.mini.property("level") == "warning"


def test_small_timer_can_be_turned_off(setup):
    rig, popup = setup
    rig.cfg.popup.always_show_timer = False
    rig.m.start()
    rig.m.tick()
    rig.run_until(State.PLAYING)
    step(rig, popup, 4)
    assert not popup.isVisible()


def test_loading_and_switching_stay_small(setup):
    rig, popup = setup
    rig.m.start()
    rig.m.tick()
    for _ in range(50):
        rig.advance(0.1)
        popup.update_from(rig.m.snapshot())
        if rig.m.state in (State.LAUNCHING, State.LOADING, State.VERIFYING_GAMEPLAY):
            assert popup.compact and "LOADING" in popup.mini_game.text()
    rig.run_until(State.PLAYING)
    rig.m.switch_now()
    while rig.m.state != State.SWITCHING:
        rig.advance(0.1)
        popup.update_from(rig.m.snapshot())
    assert popup.compact and popup.mini_game.text() == "SWITCHING"
    assert popup.mini_next.text() == "Up next: Schedule I"


def test_test_run_is_marked_and_skips_obs(setup):
    rig, popup = setup
    rig.obs.problems = ["OBS isn't answering."]  # OBS closed: a normal Start would refuse
    rig.m.start(test_run=True)
    rig.m.tick()
    rig.run_until(State.PLAYING)
    assert rig.obs.scenes == [], "a test run never touches OBS"
    popup.update_from(rig.m.snapshot())
    step(rig, popup, 4)
    assert popup.mini_game.text() == "MINECRAFT  ·  TURN 1  ·  TEST"
