import json
import time
import urllib.request

from conftest import Rig, make_cfg

from gameswap import config as config_mod
from gameswap.drivers import SimulatedGame
from gameswap.hotkeys import parse_hotkey
from gameswap.machine import State
from gameswap.overlay import OverlayServer, overlay_state, overlay_text
from gameswap.testrun import TestRunner


def test_overlay_serves_pages_and_live_state(tmp_path):
    srv = OverlayServer(port=0, text_file=tmp_path / "timer.txt")
    assert srv.start()
    r = Rig(make_cfg())
    r.m.start()
    r.m.tick()
    r.run_until(State.PLAYING)
    r.advance(575)
    srv.update(overlay_state(r.m.snapshot()))
    base = f"http://127.0.0.1:{srv.port}"
    state = json.loads(urllib.request.urlopen(base + "/state").read())
    assert state["state"] == "PLAYING" and state["clock"] == "0:25" and state["level"] == "warning"
    assert b"GameSwap Timer" in urllib.request.urlopen(base + "/").read()
    assert b"GameSwap Switching" in urllib.request.urlopen(base + "/switching").read()
    assert (tmp_path / "timer.txt").read_text() == "Minecraft  0:25"
    srv.close()


def test_overlay_text_while_switching():
    r = Rig(make_cfg())
    r.m.start()
    r.m.tick()
    r.run_until(State.PLAYING)
    r.run_until(State.SWITCHING)
    assert overlay_text(overlay_state(r.m.snapshot())) == "Switching: Schedule I"


def test_config_round_trip(tmp_path):
    path = tmp_path / "config.json"
    cfg = config_mod.load(path)  # creates the default file
    assert path.exists()
    cfg.play_seconds = 540
    cfg.games["schedule1"].save_name = "Slot 2"
    cfg.obs.password = "pw"
    config_mod.save(cfg, path)
    again = config_mod.load(path)
    assert again.play_seconds == 540
    assert again.games["schedule1"].save_name == "Slot 2"
    assert again.games["schedule1"].steam_app_id == "3164500"
    assert again.obs.password == "pw"


def test_config_validation_catches_mistakes():
    cfg = config_mod.Config()
    assert cfg.validate() == []
    cfg.warning_seconds = [700]
    cfg.fallback_cycle_enabled = True
    cfg.fallback_cycle_seconds = 300
    problems = cfg.validate()
    assert any("warning" in p.lower() for p in problems)
    assert any("fallback" in p.lower() for p in problems)


def test_hotkey_parsing():
    assert parse_hotkey("ctrl+shift+F9") == (0x2 | 0x4, 0x78)
    for bad in ("F9", "ctrl+F12", "ctrl+banana", ""):
        try:
            parse_hotkey(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} should be rejected")


def _wait(runner):
    end = time.monotonic() + 10
    while runner.busy and time.monotonic() < end:
        time.sleep(0.02)


def test_test_load_and_test_save_buttons():
    cfg = make_cfg(ready_poll_seconds=0.05, ready_stable_checks=2)
    for g in cfg.games.values():
        g.simulation.ready_after_seconds = 0.2
    drivers = {k: SimulatedGame(k, g) for k, g in cfg.games.items()}
    runner = TestRunner(cfg, drivers)

    assert runner.test_save("minecraft")
    _wait(runner)
    assert not runner.last_result.ok  # can't test a save before loading

    assert runner.test_load("minecraft")
    _wait(runner)
    assert runner.last_result.ok, runner.last_result.detail
    assert drivers["minecraft"].is_running()

    assert not runner.test_load("schedule1"), "two games at once must be refused"

    assert runner.test_save("minecraft")
    _wait(runner)
    assert runner.last_result.ok, runner.last_result.detail
    assert drivers["minecraft"].is_running(), "Test Save must not close the game"
