"""Phase 3: Minecraft opens the world, verifies gameplay, saves and exits by itself."""

import threading
import time
import zipfile
from pathlib import Path

import pytest
from fake_minecraft import FakePC

from gameswap import backup, winapi
from gameswap.actions import UiControl, choose_launcher_target
from gameswap.config import Config
from gameswap.drivers import make_drivers
from gameswap.drivers import minecraft as mc
from gameswap.drivers.minecraft import resolve_world
from gameswap.drivers.real_base import RealGameDriver
from gameswap.machine import Machine, State
from gameswap.mclog import MinecraftLog


@pytest.fixture
def pc(tmp_path, monkeypatch):
    p = FakePC(tmp_path)
    monkeypatch.setattr(winapi, "open_target", p.open_target)
    monkeypatch.setattr(RealGameDriver, "POLL", 0.02)
    monkeypatch.setattr(mc, "SAVE_CONFIRM_WAIT", 0.6)
    monkeypatch.setattr(mc, "PRESS_START_WAIT", 2.0)
    monkeypatch.setattr(mc, "LAUNCHER_UI_WAIT", 1.0)
    monkeypatch.setattr(backup, "BACKUP_DIR", tmp_path / "backups")
    return p


def make(pc, **game):
    cfg = Config()
    g = cfg.games["minecraft"]
    g.launch_path = str(pc.launcher_exe)
    g.game_folder = str(pc.game_dir)
    g.save_name = "Krew's Challenge"
    g.ready_settle_seconds = 0.2
    for k, v in game.items():
        setattr(g, k, v)
    cfg.games["schedule1"].driver = "simulated"
    cfg.games["schedule1"].save_prompt_seconds = 0
    for s in (cfg.games["schedule1"].simulation,):
        s.launch_seconds = s.load_seconds = s.save_seconds = s.exit_seconds = 0.05
        s.ready_after_seconds = 0.1
    mon = pc.system.monitor()
    drivers = make_drivers(cfg, mon, actions=pc.actions)
    return cfg, drivers["minecraft"], drivers


def run(fn, *args):
    box = {}
    t = threading.Thread(target=lambda: box.setdefault("r", fn(*args)))
    t.start()
    t.join(15)
    assert not t.is_alive(), "step hung"
    return box["r"]


def wait_ready(d, timeout=5.0):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = d.check_ready()
        if last.ready:
            return last
        time.sleep(0.05)
    raise AssertionError(f"never ready: {last.detail}")


# ---- small pieces -------------------------------------------------------------

def test_log_reader_follows_a_new_log_and_ignores_chat(tmp_path):
    path = tmp_path / "latest.log"
    path.write_text("[10:00:00] old session line\n" * 20)
    log = MinecraftLog(path)
    log.forget_current_file()
    log.poll()
    assert log.events.joined == 0
    path.write_text("[10:05:00] [main/INFO]: new session\n"
                    "[10:05:01] [Render thread/INFO]: [CHAT] Krew joined the game\n")
    log.poll()
    assert log.events.joined == 0, "a chat message must not count"
    with path.open("a") as f:
        f.write("[10:05:02] [Server thread/INFO]: Krew joined the game\n")
        f.write("[10:05:03] [Server thread/INFO]: Saving and pausing game...\n")
        f.write("[10:05:04] [Server thread/INFO]: Stopping ser")  # line still being written
    log.poll()
    assert log.events.player == "Krew" and log.events.pauses == 1
    assert log.events.stopping == 0
    with path.open("a") as f:
        f.write("ver\n[10:05:05] [Server thread/INFO]: Saving worlds\n")
    log.poll()
    assert log.events.stopping and log.events.saving_worlds


def test_resolve_world_by_folder_or_shown_name(pc):
    assert resolve_world(pc.game_dir, "Challenge World") == ("Challenge World", "Krew's Challenge")
    assert resolve_world(pc.game_dir, "Krew's Challenge") == ("Challenge World", "Krew's Challenge")
    assert "no world called" in resolve_world(pc.game_dir, "Nope")
    import os
    os.utime(pc.saves / "Other World" / "level.dat", (9e9, 9e9))  # played most recently
    assert resolve_world(pc.game_dir, "") == ("Other World", "Other"), "blank = the world you played last"


def test_launcher_target_choice_is_strict():
    c = [UiControl("ButtonControl", "PLAY"), UiControl("ListItemControl", "Krew's Challenge, Singleplayer")]
    assert choose_launcher_target(c, "Krew's Challenge")[1] == "quick play"
    assert choose_launcher_target(c, "")[1] == "play button"
    two = c + [UiControl("ButtonControl", "Play")]
    assert choose_launcher_target(two, "")[0] is None, "two PLAY buttons is ambiguous: press nothing"
    assert choose_launcher_target([UiControl("ButtonControl", "Settings")], "x")[0] is None


def test_backup_before_start_zips_world_without_session_lock(pc, tmp_path):
    (pc.saves / "Challenge World" / "session.lock").write_text("x")
    cfg, d, _ = make(pc, backups_keep=2)
    for _ in range(3):
        assert d.preflight() == []
        time.sleep(1.05)
    zips = sorted((tmp_path / "backups" / "minecraft-Challenge World").glob("*.zip"))
    assert len(zips) == 2, "only the newest backups are kept"
    names = zipfile.ZipFile(zips[-1]).namelist()
    assert "Challenge World/level.dat" in names and not any("session.lock" in n for n in names)


# ---- the full Minecraft flow ----------------------------------------------------

def test_quick_play_opens_the_world_and_gameplay_is_verified(pc):
    cfg, d, _ = make(pc)
    r = run(d.launch, threading.Event())
    assert r.ok, r.detail
    assert pc.actions.invoked == ["Krew's Challenge"], "should press the Quick Play entry, not PLAY"
    r = run(d.load_save, threading.Event())
    assert r.ok and "Quick Play" in r.detail
    check = wait_ready(d)
    assert "Krew is in" in check.detail


def test_not_ready_during_terrain_loading(pc):
    cfg, d, _ = make(pc, ready_settle_seconds=1.0)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    time.sleep(0.3)
    assert not d.check_ready().ready
    wait_ready(d, 3)


def test_play_button_then_you_open_the_world(pc):
    pc.launcher_controls = [UiControl("ButtonControl", "PLAY")]  # no Quick Play entry
    pc.auto_open_world_after_play = "Challenge World"
    cfg, d, _ = make(pc)
    assert run(d.launch, threading.Event()).ok
    assert pc.actions.invoked == ["PLAY"]
    r = run(d.load_save, threading.Event())
    assert r.ok and "Quick Play" not in r.detail


def test_wrong_world_is_caught(pc):
    pc.launcher_controls = [UiControl("ButtonControl", "PLAY")]
    pc.auto_open_world_after_play = "Other World"
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    r = run(d.load_save, threading.Event())
    assert not r.ok and "Other World" in r.detail


def test_save_is_confirmed_by_minecraft_log(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    r = run(d.save, threading.Event())
    assert r.ok and "Saving and pausing game" in r.detail
    assert pc.actions.escapes == 1


def test_save_with_inventory_open_needs_and_gets_a_second_esc(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    pc.game.inventory_open = True
    r = run(d.save, threading.Event())
    assert r.ok and "press 2" in r.detail
    assert pc.actions.escapes == 2


def test_save_never_sends_keys_when_minecraft_is_not_in_front(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    pc.actions.fg = 999  # you clicked into OBS
    pc.actions.focus_allowed = False  # and Windows refuses to switch
    r = run(d.save, threading.Event())
    assert not r.ok and "no keys were sent" in r.detail
    assert pc.actions.escapes == 0 and pc.actions.keys_sent_to_wrong_window == 0


def test_unconfirmed_save_stops_after_two_presses_and_never_closes(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    pc.game.save_on_pause = False  # e.g. a world opened to LAN
    r = run(d.save, threading.Event())
    assert not r.ok and "NOT closed" in r.detail
    assert pc.actions.escapes == 2 and pc.actions.closes == 0
    assert d.is_running()


def test_exit_waits_for_world_save_unload_and_process_exit(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    run(d.save, threading.Event())
    r = run(d.exit, threading.Event())
    assert r.ok and "Saving worlds" in r.detail
    assert not d.is_running()
    assert not pc.actions.world_in_use(pc.saves / "Challenge World")


def test_exit_without_save_lines_is_an_error(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    pc.game.log_saves_on_exit = False
    r = run(d.exit, threading.Event())
    assert not r.ok and "didn't show the world being saved" in r.detail


def test_exit_that_never_happens_is_not_forced(pc):
    cfg, d, _ = make(pc)
    run(d.launch, threading.Event())
    run(d.load_save, threading.Event())
    wait_ready(d)
    pc.game.ignore_close = True
    abort = threading.Event()
    threading.Timer(0.5, abort.set).start()
    r = run(d.exit, abort)
    assert not r.ok and "NOT force-closed" in r.detail
    assert d.is_running()


def test_no_code_path_can_kill_a_game():
    src = "\n".join(p.read_text(encoding="utf-8") for p in Path(mc.__file__).parent.parent.rglob("*.py"))
    for forbidden in ("TerminateProcess", ".kill(", "taskkill", "os.kill", ".terminate("):
        assert forbidden not in src, f"found {forbidden!r} in GameSwap's code"


def test_full_machine_cycle_minecraft_then_next_game_and_back(pc):
    cfg, d, drivers = make(pc)
    cfg.play_seconds = 20
    cfg.warning_seconds = [10, 5]
    cfg.switch_delay_seconds = 0.1
    cfg.ready_poll_seconds = 0.05
    cfg.ready_stable_checks = 2
    cfg.backup_before_start = False
    m = Machine(cfg, drivers)
    m.on_sound = lambda k: None
    states = []

    def tick_until(cond, timeout=15):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            m.tick()
            if not states or states[-1] != m.state:
                states.append(m.state)
            if cond():
                return
            time.sleep(0.01)
        raise AssertionError(f"stuck in {m.state}: {m.error or m.message}")

    m.start()
    tick_until(lambda: m.state == State.PLAYING)
    assert m.driver.key == "minecraft"
    m.switch_now()
    tick_until(lambda: m.state == State.PLAYING and m.driver.key == "schedule1")
    assert states[:7] == [State.IDLE, State.LAUNCHING, State.LOADING, State.VERIFYING_GAMEPLAY,
                          State.PLAYING, State.SAVING, State.EXITING]
    assert not d.is_running(), "Minecraft must be closed before the next game"
    m.switch_now()
    tick_until(lambda: m.state == State.PLAYING and m.driver.key == "minecraft")
    assert m.turn == 3
    m.shutdown()


def _already_playing(pc):
    """You opened Minecraft yourself and are standing in your world."""
    pc.start_game(quick_play=None)
    end = time.monotonic() + 5
    while pc.game is None and time.monotonic() < end:
        time.sleep(0.02)
    pc.game.open_world("Challenge World")
    pc.actions.fg = pc.game.hwnd


def _run_machine_until(m, cond, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        m.tick()
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError(f"stuck in {m.state}: {m.error or m.message}")


@pytest.mark.parametrize("lock_check_works,window_class", [(True, "GLFW30"), (False, "GLFW30"), (True, "SDL_app")])
def test_start_while_already_in_minecraft_then_switch(pc, lock_check_works, window_class):
    if window_class == "SDL_app":  # Minecraft 26.3 and later
        pc.window_title, pc.window_class = "Minecraft* 26.3 - Singleplayer", "SDL_app"
    cfg, d, drivers = make(pc, save_name="")  # nothing picked in Settings
    cfg.play_seconds = 20
    cfg.warning_seconds = [10, 5]
    cfg.switch_delay_seconds = 0.1
    cfg.ready_poll_seconds = 0.05
    cfg.ready_stable_checks = 2
    cfg.backup_before_start = False
    if not lock_check_works:
        pc.actions.world_in_use = lambda path: False  # only Minecraft's log can tell
    _already_playing(pc)
    m = Machine(cfg, drivers)
    m.on_sound = lambda k: None
    m.start(test_run=True)
    _run_machine_until(m, lambda: m.state == State.PLAYING)
    assert pc.launcher is None and pc.actions.invoked == [], "nothing was launched: it used your Minecraft"
    m.switch_now()
    _run_machine_until(m, lambda: m.state == State.PLAYING and m.driver.key == "schedule1")
    assert pc.actions.escapes >= 1 and pc.actions.closes == 1
    assert not d.is_running()
    m.shutdown()


def test_ready_hotkey_works_for_minecraft_as_a_backup(pc):
    cfg, d, drivers = make(pc)
    cfg.backup_before_start = False
    _already_playing(pc)
    pc.log.write_text("[12:00:00] fresh log with no join line\n")  # the automatic check can't fire
    m = Machine(cfg, drivers)
    m.on_sound = lambda k: None
    m.start(test_run=True)
    _run_machine_until(m, lambda: m.state == State.VERIFYING_GAMEPLAY or m.state == State.PLAYING)
    if m.state == State.VERIFYING_GAMEPLAY:
        assert m.snapshot().can_confirm_ready
        m.confirm_ready()  # Ctrl+Shift+F10
    assert m.state == State.PLAYING
    m.shutdown()


def test_minecraft_pausing_itself_when_you_click_gameswap_doesnt_stop_the_timer(pc):
    """Clicking Test Start in GameSwap makes Minecraft lose focus and pause
    itself. The timer must still start, and the switch must still work."""
    cfg, d, drivers = make(pc, save_name="")
    cfg.play_seconds = 20
    cfg.warning_seconds = [10, 5]
    cfg.switch_delay_seconds = 0.1
    cfg.ready_poll_seconds = 0.05
    cfg.ready_stable_checks = 2
    cfg.backup_before_start = False
    _already_playing(pc)
    m = Machine(cfg, drivers)
    m.on_sound = lambda k: None
    m.start(test_run=True)
    _run_machine_until(m, lambda: m.state in (State.LOADING, State.VERIFYING_GAMEPLAY))
    pc.game.escape()  # Minecraft pauses itself: "Saving and pausing game..."
    assert pc.game.paused
    _run_machine_until(m, lambda: m.state == State.PLAYING)
    m.switch_now()  # the pause menu is still open: Esc closes it, the next Esc saves
    _run_machine_until(m, lambda: m.state == State.PLAYING and m.driver.key == "schedule1")
    assert not d.is_running()
    m.shutdown()


def test_start_timer_now_works_even_when_gameswap_cant_see_the_world(pc):
    cfg, d, drivers = make(pc)
    cfg.backup_before_start = False
    _already_playing(pc)
    pc.actions.world_in_use = lambda path: False  # no lock check...
    pc.log.write_text("[12:00:00] fresh log with no join line\n")  # ...and nothing in the log
    m = Machine(cfg, drivers)
    m.on_sound = lambda k: None
    m.start(test_run=True)
    _run_machine_until(m, lambda: m.state == State.LOADING)
    for _ in range(20):
        m.tick()
        time.sleep(0.01)
    assert m.state == State.LOADING, "GameSwap can't tell you're in the world"
    assert m.snapshot().can_confirm_ready
    m.confirm_ready()  # Ctrl+Shift+F10 / "Start timer now"
    assert m.state == State.PLAYING and m.snapshot().remaining == cfg.play_seconds
    m.shutdown()
