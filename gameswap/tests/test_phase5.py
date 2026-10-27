"""Phase 5: automatic launch retry, stop after N turns, resume after a crash,
session log + YouTube chapters, and the self-test."""

import csv
import json
import os

import pytest
from conftest import Rig, make_cfg

from gameswap import selftest
from gameswap.machine import State
from gameswap.session import SessionRecorder, fmt_chapter, load_unfinished


def start(r):
    r.m.start()
    r.m.tick()


class FlakyLaunch:
    """Make the first `n` launches of a simulated game fail."""

    def __init__(self, driver, n):
        self.driver, self.n, self.calls = driver, n, 0
        self.real = driver.launch
        driver.launch = self

    def __call__(self, abort):
        self.calls += 1
        if self.calls <= self.n:
            from gameswap.drivers import StepResult
            return StepResult(False, "Steam was busy")
        return self.real(abort)


def test_failed_launch_is_retried_once_by_itself():
    r = Rig(make_cfg(launch_retries=1, launch_retry_delay=20))
    flaky = FlakyLaunch(r.drivers["minecraft"], 1)
    events = []
    r.m.on_event = lambda k, i: events.append(k)
    start(r)
    r.advance(1)
    assert r.m.state == State.LAUNCHING and "trying again" in r.m.message
    r.advance(18)
    assert flaky.calls == 1, "waits the retry delay first"
    r.run_until(State.PLAYING)
    assert flaky.calls == 2 and "retry" in events


def test_second_launch_failure_asks_you():
    r = Rig(make_cfg(launch_retries=1, launch_retry_delay=5))
    FlakyLaunch(r.drivers["minecraft"], 5)
    start(r)
    r.run_until(State.ERROR)
    assert "Steam was busy" in r.m.error


def test_retries_reset_for_every_turn():
    r = Rig(make_cfg(launch_retries=1, launch_retry_delay=5))
    start(r)
    r.run_until(State.PLAYING)
    FlakyLaunch(r.drivers["schedule1"], 1)
    r.m.switch_now()
    r.run_until(State.SAVING)
    r.run_until(State.PLAYING)
    assert r.m.driver.key == "schedule1"


def test_stop_after_turns_saves_closes_and_stops():
    r = Rig(make_cfg(stop_after_turns=3))
    start(r)
    r.run_until(State.STOPPED, limit=4000)
    assert r.m.turn == 3
    assert not any(d.is_running() for d in r.drivers.values()), "the last game was saved and closed"


def test_events_for_the_session_log():
    r = Rig(make_cfg())
    events = []
    r.m.on_event = lambda kind, info: events.append((kind, info.get("turn"), info.get("game")))
    start(r)
    r.run_until(State.PLAYING)
    r.m.switch_now()
    r.run_until(State.SAVING)
    r.run_until(State.PLAYING)
    r.m.stop()
    r.run_until(State.STOPPED)
    kinds = [e[0] for e in events]
    assert kinds == ["session_start", "turn_start", "turn_end", "game_closed", "turn_start",
                     "turn_end", "game_closed", "stopped"]
    assert events[1][1:] == (1, "Minecraft") and events[4][1:] == (2, "Schedule I")


def test_resume_point_continues_the_rotation():
    r = Rig(make_cfg())
    r.m.resume_point = (1, 7)  # 7 turns done, Schedule I is next
    start(r)
    r.run_until(State.PLAYING)
    assert r.m.driver.key == "schedule1" and r.m.turn == 8


# ---- session recorder ---------------------------------------------------------------

class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_chapters_and_csv_follow_the_recording(tmp_path):
    clock, rec_time = Clock(), {"v": None}
    rec = SessionRecorder(["minecraft", "schedule1"], recording_seconds=lambda: rec_time["v"],
                          log_dir=tmp_path, state_file=tmp_path / "session.json", clock=clock)
    rec.handle("session_start", {"turn": 0, "next": "Minecraft"})
    rec_time["v"] = 4.0  # OBS has been recording 4 s: too close to 00:00, so it replaces "Start"
    rec.handle("turn_start", {"turn": 1, "game": "Minecraft", "key": "minecraft"})
    rec_time["v"] = 652.0
    rec.handle("turn_start", {"turn": 2, "game": "Schedule I", "key": "schedule1"})
    rec_time["v"] = 3725.0
    rec.handle("turn_start", {"turn": 3, "game": "Minecraft", "key": "minecraft"})
    text = rec.chapters_path.read_text()
    assert text.splitlines() == ["00:00 Turn 1 - Minecraft", "10:52 Turn 2 - Schedule I", "1:02:05 Turn 3 - Minecraft"]
    rows = list(csv.reader(rec.csv_path.open()))
    assert rows[0][:3] == ["time", "video time", "event"] and rows[-1][1:5] == ["1:02:05", "turn_start", "3", "Minecraft"]


def test_unfinished_session_offers_resume_with_the_interrupted_game(tmp_path):
    state = tmp_path / "session.json"
    rec = SessionRecorder(["minecraft", "schedule1"], log_dir=tmp_path, state_file=state)
    rec.handle("session_start", {"turn": 0})
    rec.handle("turn_start", {"turn": 1, "game": "Minecraft", "key": "minecraft"})
    rec.handle("game_closed", {"turn": 1, "game": "Minecraft", "key": "minecraft"})
    rec.handle("turn_start", {"turn": 2, "game": "Schedule I", "key": "schedule1"})
    # ...GameSwap crashes here, mid Schedule I turn
    last = load_unfinished(state)
    assert last["turns"] == 1 and last["next_index"] == 1, "Schedule I's turn wasn't finished, so it goes again"
    rec.handle("stopped", {"turns": 2, "how": "stop"})
    assert load_unfinished(state) is None


def test_fmt_chapter():
    assert fmt_chapter(0) == "00:00" and fmt_chapter(61) == "01:01" and fmt_chapter(3600) == "1:00:00"


# ---- self-test + packaging ----------------------------------------------------------------

def test_selftest_passes(tmp_path, monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    monkeypatch.setattr(selftest, "APP_DIR", tmp_path)
    result = tmp_path / "selftest-result.txt"
    assert selftest.run(result) == 0, result.read_text(encoding="utf-8")
    assert "ALL PASSED" in result.read_text(encoding="utf-8")


def test_packaged_app_keeps_its_files_next_to_the_exe(tmp_path, monkeypatch):
    import importlib
    import sys

    from gameswap import config

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "GameSwap.exe"))
    try:
        reloaded = importlib.reload(config)
        assert reloaded.APP_DIR == tmp_path and reloaded.CONFIG_PATH == tmp_path / "config.json"
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_spec_bundles_the_overlay_pages():
    spec = (selftest.Path(__file__).resolve().parent.parent / "GameSwap.spec").read_text()
    assert '("gameswap/overlay_pages", "gameswap/overlay_pages")' in spec
    assert "gameswap_launcher.py" in spec and "console=False" in spec
    assert '("gameswap/assets", "gameswap/assets")' in spec and 'icon="gameswap/assets/gameswap.ico"' in spec


def test_config_validation_for_phase5_settings():
    from gameswap.config import Config

    cfg = Config()
    cfg.launch_retries = -1
    cfg.stop_after_turns = -2
    problems = " ".join(cfg.validate())
    assert "retries" in problems and "Stop after" in problems
    assert json.dumps(cfg.__dict__, default=str)
