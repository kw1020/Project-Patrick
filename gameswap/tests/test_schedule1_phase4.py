"""Phase 4: Schedule I. You save in-game; GameSwap verifies the save on disk,
then closes the game normally. Plus the full Minecraft <-> Schedule I loop."""

import json
import os
import threading
import time

import pytest
from fake_minecraft import FakePC
from fakes import FakeProc, window
from test_detection import make_steam

from gameswap import backup, s1saves, steam, winapi
from gameswap.config import Config
from gameswap.drivers import make_drivers
from gameswap.drivers import minecraft as mc
from gameswap.drivers import schedule1 as s1
from gameswap.drivers.real_base import RealGameDriver
from gameswap.machine import Machine, State

STEAM_ID = "76561198000000000"


class FakeSchedule1:
    """The pretend Schedule I: a process + window, and a save slot on disk."""

    def __init__(self, pc: FakePC, tmp):
        self.pc = pc
        self.steam_dir, self.install = make_steam(tmp)
        self.saves = tmp / "Saves"
        self.slot = self.saves / STEAM_ID / "SaveGame_2"
        (self.slot / "Players").mkdir(parents=True)
        self.files = [self.slot / "Game.json", self.slot / "Time.json", self.slot / "Players" / "Player_0.json"]
        for f in self.files:
            f.write_text(json.dumps({"OrganisationName": "Krew Co"} if f.name == "Game.json" else {"v": 0}))
        old = time.time() - 3600
        for f in self.files:
            os.utime(f, (old, old))
        (self.saves / STEAM_ID / "SaveGame_1").mkdir()
        self.proc = None
        self.ignore_close = False
        self.close_requests = 0

    def start(self):
        def go():
            time.sleep(0.2)
            self.proc = FakeProc("Schedule I.exe", exe=str(self.install / "Schedule I.exe"),
                                 windows=[window("Schedule I", "UnityWndClass")])
            self.pc.system.add(self.proc)
        threading.Thread(target=go, daemon=True).start()

    def you_save(self, broken=False, slow=False):
        """You sleep in your bed / use the save device: the game writes the slot."""
        for i, f in enumerate(self.files):
            f.write_text('{"v": 1, "half' if broken and i == 0 else json.dumps({"v": 1, "OrganisationName": "Krew Co"}))
            if slow:
                time.sleep(0.4)

    def close(self):
        self.close_requests += 1
        if self.ignore_close or self.proc is None:
            return

        def go():
            time.sleep(0.2)
            self.pc.system.remove(self.proc)
            self.proc = None
        threading.Thread(target=go, daemon=True).start()


@pytest.fixture
def rig(tmp_path, monkeypatch):
    pc = FakePC(tmp_path)
    game = FakeSchedule1(pc, tmp_path)

    def open_target(cmd):
        if cmd[0].endswith("steam.exe"):
            game.start()
        else:
            pc.open_target(cmd)

    real_close = pc.actions.close_window

    def close_window(hwnd):
        if game.proc and game.proc.windows[0].hwnd == hwnd:
            game.close()
            return True
        return real_close(hwnd)

    monkeypatch.setattr(pc.actions, "close_window", close_window)
    monkeypatch.setattr(winapi, "open_target", open_target)
    monkeypatch.setattr(steam, "find_steam_dir", lambda configured="": game.steam_dir)
    monkeypatch.setattr(RealGameDriver, "POLL", 0.02)
    monkeypatch.setattr(s1, "SAVE_QUIET_SECONDS", 0.3)
    monkeypatch.setattr(s1saves, "MTIME_SLACK", 0.0)
    monkeypatch.setattr(mc, "SAVE_CONFIRM_WAIT", 0.6)
    monkeypatch.setattr(mc, "PRESS_START_WAIT", 2.0)
    monkeypatch.setattr(backup, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(s1saves, "default_player_log", lambda: tmp_path / "Player.log")

    cfg = Config()
    m_cfg, s_cfg = cfg.games["minecraft"], cfg.games["schedule1"]
    m_cfg.launch_path, m_cfg.game_folder, m_cfg.save_name = str(pc.launcher_exe), str(pc.game_dir), "Krew's Challenge"
    m_cfg.ready_settle_seconds = 0.2
    s_cfg.save_folder, s_cfg.save_name = str(game.saves), "Krew Co"
    drivers = make_drivers(cfg, pc.system.monitor(), actions=pc.actions)

    class Rig:
        pass

    r = Rig()
    r.pc, r.game, r.cfg, r.drivers, r.d = pc, game, cfg, drivers, drivers["schedule1"]
    r.tmp = tmp_path
    return r


def run(fn, *args, timeout=15):
    box = {}
    t = threading.Thread(target=lambda: box.setdefault("r", fn(*args)))
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "step hung"
    return box["r"]


# ---- save slots ------------------------------------------------------------

def test_slots_are_listed_with_names_and_resolved(rig):
    slots = s1saves.list_slots(rig.game.saves)
    assert [(s.folder, s.name) for s in slots] == [("SaveGame_1", "SaveGame_1"), ("SaveGame_2", "Krew Co")]
    assert s1saves.resolve_slot(rig.game.saves, "Krew Co").folder == "SaveGame_2"
    assert s1saves.resolve_slot(rig.game.saves, "savegame_2").folder == "SaveGame_2"
    assert "no save called" in s1saves.resolve_slot(rig.game.saves, "SaveGame_9")
    assert "no save is chosen" in s1saves.resolve_slot(rig.game.saves, "")


def test_check_save_needs_new_complete_quiet_valid_files(rig):
    slot, since = rig.game.slot, time.time() - 5
    assert s1saves.check_save(slot, since, 0.3) == (False, "no save yet")
    rig.game.you_save(broken=True)
    time.sleep(0.4)
    done, why = s1saves.check_save(slot, since, 0.3)
    assert not done and "isn't valid" in why
    rig.game.you_save()
    done, why = s1saves.check_save(slot, since, 5.0)
    assert not done and "still writing" in why
    time.sleep(0.4)
    assert s1saves.check_save(slot, since, 0.3)[0]


def test_backup_of_the_save_slot_before_start(rig):
    assert rig.d.preflight() == []
    zips = list((rig.tmp / "backups").rglob("*.zip"))
    assert len(zips) == 1 and "SaveGame_2" in zips[0].name


# ---- the driver ------------------------------------------------------------------

def test_launch_through_steam_then_you_load_and_press_ready(rig):
    r = run(rig.d.launch, threading.Event())
    assert r.ok, r.detail
    r = run(rig.d.load_save, threading.Event())
    assert r.ok and "Krew Co" in rig.d.status and "SaveGame_2" in rig.d.status
    assert rig.d.manual_ready
    assert not rig.d.check_ready().ready, "no guessing: you confirm gameplay"


def test_ready_line_in_player_log_makes_ready_automatic(rig):
    rig.cfg.games["schedule1"].ready_log_pattern = r"Loaded save .*Krew"
    rig.cfg.games["schedule1"].ready_settle_seconds = 0.1
    log = rig.tmp / "Player.log"
    log.write_text("old run\n")
    run(rig.d.launch, threading.Event())
    assert not rig.d.manual_ready
    log.write_text("Mono path ...\nInitialize engine\n")
    assert not rig.d.check_ready().ready
    with log.open("a") as f:
        f.write("Loaded save SaveGame_2 (Krew Co)\n")
    rig.d.check_ready()
    time.sleep(0.15)
    assert rig.d.check_ready().ready


def test_save_waits_for_you_then_verifies_on_disk(rig):
    run(rig.d.launch, threading.Event())
    statuses = []
    box = {}
    t = threading.Thread(target=lambda: box.setdefault("r", rig.d.save(threading.Event())))
    t.start()
    time.sleep(0.5)
    statuses.append(rig.d.status)
    rig.game.you_save(slow=True)
    t.join(10)
    assert "SAVE NOW" in statuses[0]
    assert box["r"].ok and "verified on disk" in box["r"].detail
    assert rig.pc.actions.escapes == 0, "Schedule I never gets keys pressed"


def test_old_save_does_not_count(rig):
    run(rig.d.launch, threading.Event())
    abort = threading.Event()
    threading.Timer(0.8, abort.set).start()
    r = run(rig.d.save, abort)
    assert not r.ok and "NOT closed" in r.detail


def test_exit_only_after_a_verified_save(rig):
    run(rig.d.launch, threading.Event())
    r = run(rig.d.exit, threading.Event())
    assert not r.ok and "no verified save" in r.detail
    assert rig.game.close_requests == 0
    rig.game.you_save()
    time.sleep(0.4)
    assert run(rig.d.save, threading.Event()).ok
    r = run(rig.d.exit, threading.Event())
    assert r.ok and "exited normally" in r.detail
    assert not rig.d.is_running()


def test_exit_that_is_blocked_is_never_forced(rig):
    run(rig.d.launch, threading.Event())
    rig.game.you_save()
    time.sleep(0.4)
    run(rig.d.save, threading.Event())
    rig.game.ignore_close = True  # e.g. a "Quit?" box is waiting for you
    abort = threading.Event()
    threading.Timer(0.5, abort.set).start()
    r = run(rig.d.exit, abort)
    assert not r.ok and "NOT force-closed" in r.detail
    assert rig.d.is_running()


# ---- the whole challenge: Minecraft <-> Schedule I ---------------------------------

def test_full_rotation_minecraft_and_schedule1(rig):
    cfg = rig.cfg
    cfg.play_seconds = 25
    cfg.warning_seconds = [10, 5]
    cfg.switch_delay_seconds = 0.1
    cfg.ready_poll_seconds = 0.05
    cfg.ready_stable_checks = 2
    cfg.games["schedule1"].save_prompt_seconds = 20
    m = Machine(cfg, rig.drivers)
    sounds, scenes = [], []
    m.on_sound = sounds.append

    class Obs:
        def set_scene(self, name):
            scenes.append(name)

        def preflight(self, names):
            return []

    m.obs = Obs()

    def tick_until(cond, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            m.tick()
            if cond():
                return
            time.sleep(0.01)
        raise AssertionError(f"stuck in {m.state}: {m.error or m.message}")

    m.start()
    tick_until(lambda: m.state == State.PLAYING)  # Minecraft, fully automatic
    m.switch_now()
    tick_until(lambda: m.state == State.VERIFYING_GAMEPLAY and m.driver.key == "schedule1")
    assert not rig.drivers["minecraft"].is_running(), "only one game at a time"
    assert m.snapshot().can_confirm_ready
    m.confirm_ready()  # you: "I'm in the game"
    assert m.state == State.PLAYING and m.snapshot().remaining == 25
    tick_until(lambda: m.prompt.startswith("SAVE NOW"))
    assert "save" in sounds
    rig.game.you_save()  # you sleep in your bed
    m.switch_now()
    tick_until(lambda: m.state == State.SAVING)
    assert scenes[-1] == "Schedule I", "the game stays on screen while you save"
    tick_until(lambda: m.state == State.PLAYING and m.driver.key == "minecraft", timeout=30)
    assert not rig.drivers["schedule1"].is_running()
    assert "Switching" in scenes
    assert m.turn == 3
    m.shutdown()


def test_schedule1_turn_end_without_a_save_waits_then_asks_you(rig):
    cfg = rig.cfg
    cfg.rotation = ["schedule1", "minecraft"]
    cfg.play_seconds = 20
    cfg.warning_seconds = [10, 5]
    cfg.games["schedule1"].save_prompt_seconds = 10
    cfg.games["schedule1"].save_wait_seconds = 1
    m = Machine(cfg, rig.drivers)
    m.on_sound = lambda k: None
    m._enter(State.LAUNCHING)
    end = time.monotonic() + 10
    while m.state != State.VERIFYING_GAMEPLAY and time.monotonic() < end:
        m.tick()
        time.sleep(0.01)
    m.confirm_ready()
    m.switch_now()
    end = time.monotonic() + 10
    while m.state != State.ERROR and time.monotonic() < end:
        m.tick()
        time.sleep(0.01)
    assert m.state == State.ERROR and "NOT closed" in m.error
    assert rig.drivers["schedule1"].is_running()
    rig.game.you_save()
    time.sleep(0.4)
    m.retry()
    end = time.monotonic() + 10
    while m.state != State.SWITCHING and time.monotonic() < end:
        m.tick()
        time.sleep(0.01)
    assert m.state == State.SWITCHING and not rig.drivers["schedule1"].is_running()
    m.shutdown()


# ---- save key (a save-key mod, e.g. F2) ------------------------------------------

def _with_save_key(rig, monkeypatch, works=True):
    """A pretend save-key mod: F2 saves, but only reaches Schedule I if it's in front."""
    monkeypatch.setattr(s1, "KEY_SAVE_WAIT", 1.0)
    rig.cfg.games["schedule1"].save_key = "F2"
    pressed = []

    def press_key(hwnd, key):
        if rig.pc.actions.fg != hwnd:
            return False
        pressed.append(key)
        if works and rig.game.proc and rig.game.proc.windows[0].hwnd == hwnd and key == "F2":
            threading.Thread(target=rig.game.you_save, daemon=True).start()
        return True

    monkeypatch.setattr(rig.pc.actions, "press_key", press_key, raising=False)
    return pressed


def _machine(rig):
    cfg = rig.cfg
    cfg.play_seconds = 25
    cfg.warning_seconds = [10, 5]
    cfg.switch_delay_seconds = 0.1
    cfg.ready_poll_seconds = 0.05
    cfg.ready_stable_checks = 2
    cfg.games["schedule1"].save_prompt_seconds = 20
    m = Machine(cfg, rig.drivers)
    m.sounds, m.scenes = [], []
    m.on_sound = m.sounds.append

    class Obs:
        def set_scene(self, name):
            m.scenes.append(name)

        def preflight(self, names):
            return []

    m.obs = Obs()
    return m


def _tick_until(m, cond, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        m.tick()
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError(f"stuck in {m.state}: {m.error or m.message}")


def test_save_key_saves_and_quits_schedule1_by_itself(rig, monkeypatch):
    pressed = _with_save_key(rig, monkeypatch)
    m = _machine(rig)
    m.start()
    _tick_until(m, lambda: m.state == State.PLAYING)  # Minecraft
    m.switch_now()
    _tick_until(m, lambda: m.state == State.VERIFYING_GAMEPLAY and m.driver.key == "schedule1")
    s = m.snapshot()
    assert s.waiting_for_you and "Ctrl+Shift+F10" in m.message, "you're told exactly what to press"
    m.confirm_ready()
    m._remaining = 15.0  # well inside the 20-second SAVE NOW window
    for _ in range(5):
        m.tick()
    assert m.prompt == "", "no SAVE NOW: GameSwap saves with the key"
    m.switch_now()
    _tick_until(m, lambda: m.state == State.PLAYING and m.driver.key == "minecraft", timeout=30)
    assert pressed == ["F2"]
    assert rig.game.close_requests == 1 and not rig.drivers["schedule1"].is_running()
    m.shutdown()


def test_save_key_that_does_nothing_falls_back_to_save_now(rig, monkeypatch):
    pressed = _with_save_key(rig, monkeypatch, works=False)
    m = _machine(rig)
    m.cfg.rotation = ["schedule1", "minecraft"]
    m._enter(State.LAUNCHING)
    _tick_until(m, lambda: m.state == State.VERIFYING_GAMEPLAY)
    m.confirm_ready()
    m.switch_now()
    _tick_until(m, lambda: m.prompt.startswith("SAVE NOW"), timeout=10)
    assert pressed == ["F2", "F2"], "pressed twice, then asks you"
    assert m.scenes[-1] == "Schedule I" and "save" in m.sounds
    assert rig.drivers["schedule1"].is_running() and rig.game.close_requests == 0, "never closed unsaved"
    rig.game.you_save()
    _tick_until(m, lambda: m.state == State.SWITCHING)
    assert rig.game.close_requests == 1
    m.shutdown()


def test_save_key_is_never_pressed_when_schedule1_is_not_in_front(rig, monkeypatch):
    pressed = _with_save_key(rig, monkeypatch)
    d = rig.d
    assert run(d.launch, threading.Event()).ok
    rig.pc.actions.focus_allowed = False
    rig.pc.actions.fg = 12345  # some other window, and Windows refuses to switch
    abort = threading.Event()
    threading.Timer(2.0, abort.set).start()
    r = run(d.save, abort)
    assert not r.ok and pressed == []
    assert "SAVE NOW" in d.status


def test_save_key_must_be_a_simple_key():
    cfg = Config()
    cfg.games["schedule1"].save_key = "ctrl+s"
    assert any("save key" in p for p in cfg.validate())
    cfg.games["schedule1"].save_key = "f2"
    assert not any("save key" in p for p in cfg.validate())


# ---- the helper mod (MelonLoader) loads your save ------------------------------------

def _with_melonloader(rig, monkeypatch, tmp_path):
    (rig.game.install / "MelonLoader").mkdir()
    (rig.game.install / "version.dll").write_bytes(b"MZ")
    dll = tmp_path / "GameSwapHelper.dll"
    dll.write_bytes(b"MZ helper mod")
    monkeypatch.setattr(s1, "HELPER_DLL", dll)
    return rig.game.install / "UserData" / "GameSwap"


def _mod_says(folder, text):
    """What the helper mod writes inside the game."""
    (folder / "status.txt").write_text(f"{text}\n2026-10-28T00:00:00Z\n")


def test_helper_mod_is_installed_loads_the_save_and_starts_the_timer(rig, monkeypatch, tmp_path):
    folder = _with_melonloader(rig, monkeypatch, tmp_path)
    (rig.game.install / "Mods").mkdir()
    (rig.game.install / "Mods" / "LoadToSave.dll").write_bytes(b"MZ")  # the broken Fast Load
    m = _machine(rig)
    m.cfg.rotation = ["schedule1", "minecraft"]
    m._enter(State.LAUNCHING)
    _tick_until(m, lambda: m.state == State.VERIFYING_GAMEPLAY)
    assert (rig.game.install / "Mods" / "GameSwapHelper.dll").read_bytes() == b"MZ helper mod"
    assert (folder / "load-request.txt").read_text() == "SaveGame_2", "asks for your save by its folder"
    assert not m.snapshot().waiting_for_you and "warning" not in m.sounds, "nothing for you to do yet"
    for _ in range(10):
        m.tick()
        time.sleep(0.01)
    assert m.state == State.VERIFYING_GAMEPLAY, "no timer until the mod says you're in"
    _mod_says(folder, "in-game SaveGame_2")
    _tick_until(m, lambda: m.state == State.PLAYING, timeout=5)
    assert m.unverified is False
    m.shutdown()


def test_helper_mod_failure_falls_back_to_you(rig, monkeypatch, tmp_path):
    folder = _with_melonloader(rig, monkeypatch, tmp_path)
    d = rig.d
    assert run(d.launch, threading.Event()).ok
    assert d.helper_active and not d.asks_ready
    _mod_says(folder, "failed no StartGame(SaveInfo, ...) method found")
    assert not d.check_ready().ready
    assert not d.helper_active and d.asks_ready, "you load it yourself and press Start timer now"


def test_no_melonloader_means_no_helper_and_no_files_in_the_game(rig, monkeypatch, tmp_path):
    dll = tmp_path / "GameSwapHelper.dll"
    dll.write_bytes(b"MZ")
    monkeypatch.setattr(s1, "HELPER_DLL", dll)
    d = rig.d
    assert run(d.launch, threading.Event()).ok
    assert not d.helper_active and d.asks_ready
    assert not (rig.game.install / "Mods").exists() and not (rig.game.install / "UserData").exists()
