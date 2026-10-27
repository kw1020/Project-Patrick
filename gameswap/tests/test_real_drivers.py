"""The real Minecraft / Schedule I drivers, against a pretend Windows."""

import threading
import time

import pytest
from fakes import FakeProc, FakeSystem, minecraft_game, minecraft_launcher, window
from test_detection import make_steam

from gameswap import steam, winapi
from gameswap.config import Config
from gameswap.drivers import make_drivers
from gameswap.drivers import minecraft as mc_mod
from gameswap.drivers.real_base import RealGameDriver
from gameswap.machine import Machine, State
from gameswap.testrun import TestRunner


class StubActions:
    """Stand-in for keyboard/window actions; Phase 2 tests never press anything."""

    def foreground(self):
        return 0

    def bring_to_front(self, hwnd):
        return True

    def can_read_ui(self):
        return False


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A pretend PC with the Minecraft Launcher installed and Schedule I in Steam."""
    system = FakeSystem()
    steam_dir, game_dir = make_steam(tmp_path)
    launcher_exe = tmp_path / "MinecraftLauncher.exe"
    launcher_exe.write_bytes(b"MZ")
    opened = []

    def open_target(cmd):
        opened.append(cmd)
        if cmd[0].endswith("MinecraftLauncher.exe"):
            system.add(minecraft_launcher())
        elif cmd[0].endswith("steam.exe"):
            # Steam takes a moment, then the game's process and window appear.
            def start():
                time.sleep(0.3)
                system.add(FakeProc("Schedule I.exe", exe=str(game_dir / "Schedule I.exe"),
                                    windows=[window("Schedule I", "UnityWndClass")]))
            threading.Thread(target=start, daemon=True).start()

    monkeypatch.setattr(winapi, "open_target", open_target)
    monkeypatch.setattr(winapi, "bring_to_front", lambda hwnd: True)
    monkeypatch.setattr(steam, "find_steam_dir", lambda configured="": steam_dir)
    monkeypatch.setattr(RealGameDriver, "POLL", 0.02)

    cfg = Config()
    cfg.games["minecraft"].launch_path = str(launcher_exe)
    cfg.games["minecraft"].auto_click_play = False  # you click PLAY in these tests
    mon = system.monitor()
    drivers = make_drivers(cfg, mon, actions=StubActions())

    class World:
        pass

    w = World()
    w.system, w.cfg, w.drivers, w.opened, w.monitor = system, cfg, drivers, opened, mon
    w.steam_dir, w.game_dir = steam_dir, game_dir
    return w


def click_play_later(system, delay=0.3):
    """You clicking PLAY in the launcher: the game appears a bit later."""
    def go():
        time.sleep(delay)
        system.add(minecraft_game())
    threading.Thread(target=go, daemon=True).start()


def test_minecraft_launch_opens_launcher_and_waits_for_play(world):
    d = world.drivers["minecraft"]
    click_play_later(world.system)
    statuses = []
    abort = threading.Event()
    result_box = {}
    t = threading.Thread(target=lambda: result_box.setdefault("r", d.launch(abort)))
    t.start()
    while t.is_alive():
        statuses.append(d.status)
        time.sleep(0.02)
    r = result_box["r"]
    assert r.ok, r.detail
    assert "Minecraft* 1.21.4" in r.detail
    assert world.opened[0][0].endswith("MinecraftLauncher.exe")
    assert any("Click PLAY" in s for s in statuses)
    assert d.is_running() and "v1.21.4" in d.describe()


def test_minecraft_launch_gives_up_when_aborted(world):
    d = world.drivers["minecraft"]
    abort = threading.Event()
    threading.Timer(0.3, abort.set).start()
    r = d.launch(abort)
    assert not r.ok
    assert not d.is_running()


def test_minecraft_already_running_is_not_launched_twice(world):
    world.system.add(minecraft_game())
    r = world.drivers["minecraft"].launch(threading.Event())
    assert r.ok and "already running" in r.detail
    assert world.opened == []


def test_missing_launcher_path_is_reported(world):
    world.cfg.games["minecraft"].launch_path = r"C:\nope\MinecraftLauncher.exe"
    problems = world.drivers["minecraft"].preflight()
    assert problems and "doesn't exist" in problems[0]


def test_schedule1_launches_through_steam_applaunch(world):
    d = world.drivers["schedule1"]
    assert d.preflight() == []
    r = d.launch(threading.Event())
    assert r.ok, r.detail
    assert world.opened == [[str(world.steam_dir / "steam.exe"), "-applaunch", "3164500"]]
    assert d.game_window().class_name == "UnityWndClass"


def test_schedule1_not_installed_is_reported(world, monkeypatch):
    monkeypatch.setattr(steam, "find_install_dir", lambda steam_dir, app_id: None)
    problems = world.drivers["schedule1"].preflight()
    assert problems and "isn't installed" in problems[0]


def test_unautomated_schedule1_steps_stop_and_explain(world):
    d = world.drivers["schedule1"]
    r = d.load_save(threading.Event())
    assert not r.ok and "Phase 4" in r.detail and "Continue" in r.detail
    assert not d.check_ready().ready
    assert not d.save(threading.Event()).ok


def test_test_load_reports_launch_and_detection(world):
    runner = TestRunner(world.cfg, world.drivers)
    assert runner.test_load("schedule1")
    while runner.busy:
        time.sleep(0.02)
    assert runner.last_result.ok
    assert "launch and detection passed" in runner.last_result.detail


def run_until(m: Machine, cond, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        m.tick()
        if cond():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out in {m.state} ({m.error})")


def test_schedule1_manual_steps_round_trip(world):
    """Schedule I (Phase 4 not built yet): launched by Steam, you load + Continue,
    then you save/quit + Continue, and GameSwap checks it really closed."""
    cfg = world.cfg
    cfg.rotation = ["schedule1", "minecraft"]
    cfg.play_seconds = 20
    cfg.warning_seconds = [10, 5]
    m = Machine(cfg, world.drivers)
    m.on_sound = lambda k: None
    m._enter(State.LAUNCHING)
    run_until(m, lambda: m.state == State.ERROR)
    assert m._error_from == State.LOADING and "by hand" in m.error
    m.continue_manual()
    assert m.state == State.PLAYING
    m.switch_now()
    run_until(m, lambda: m.state == State.ERROR)
    assert m._error_from == State.SAVING
    m.continue_manual()
    assert m.state == State.ERROR, "must not switch while Schedule I is still running"
    world.system.remove(next(p for p in world.system.procs if p.info["name"] == "Schedule I.exe"))
    m.continue_manual()
    assert m.state == State.SWITCHING
    m.shutdown()


def test_switching_refuses_while_previous_game_still_running(world):
    cfg = world.cfg
    cfg.switch_delay_seconds = 0.1
    m = Machine(cfg, world.drivers)
    m.on_sound = lambda k: None
    world.system.add(minecraft_game())
    world.monitor.scan_now()
    m.index = 0
    m._enter(State.SWITCHING)  # pretend Minecraft's turn just ended
    run_until(m, lambda: m.state == State.ERROR)
    assert "still running" in m.error
    assert not world.drivers["schedule1"].is_running()
    m.shutdown()
