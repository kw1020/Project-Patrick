"""A pretend PC with a pretend Minecraft, launcher and Steam.

The fake Minecraft behaves the way the real one does in the ways GameSwap
relies on: it writes the same log lines, locks the open world's
session.lock, saves when its pause menu opens, and saves + unloads the
world when its window is closed.
"""

from __future__ import annotations

import gzip
import struct
import threading
import time
from pathlib import Path

from fakes import MC_CMDLINE, FakeProc, FakeSystem, minecraft_launcher, window

from gameswap.actions import UiControl


def level_dat(name: str) -> bytes:
    def s(x):
        b = x.encode()
        return struct.pack(">H", len(b)) + b
    v = name.encode()
    return gzip.compress(b"\x0a" + s("") + b"\x0a" + s("Data") + b"\x08" + s("LevelName")
                         + struct.pack(">H", len(v)) + v + b"\x00\x00")


class FakeActions:
    def __init__(self, pc: "FakePC"):
        self.pc = pc
        self.fg = 0
        self.focus_allowed = True
        self.escapes = 0
        self.closes = 0
        self.invoked: list[str] = []
        self.keys_sent_to_wrong_window = 0

    def foreground(self):
        return self.fg

    def bring_to_front(self, hwnd):
        if self.focus_allowed:
            self.fg = hwnd
        return self.fg == hwnd

    def release_modifiers(self, wait=1.5):
        pass

    def press_escape(self, hwnd):
        if self.fg != hwnd:
            return False
        game = self.pc.game
        if game is None or game.hwnd != self.fg:
            self.keys_sent_to_wrong_window += 1
            return True
        self.escapes += 1
        game.escape()
        return True

    def close_window(self, hwnd):
        self.closes += 1
        if self.pc.game and self.pc.game.hwnd == hwnd:
            self.pc.game.close()
        return True

    def world_in_use(self, world_dir: Path):
        return self.pc.game is not None and self.pc.game.locked == world_dir

    def can_read_ui(self):
        return True

    def ui_controls(self, hwnd):
        return list(self.pc.launcher_controls)

    def invoke(self, control: UiControl):
        self.invoked.append(control.name)
        if control.name.lower() == "play":
            self.pc.start_game(quick_play=None)
        else:
            self.pc.start_game(quick_play=self.pc.world_folder)
        return True


class FakeGame:
    """One running copy of the pretend Minecraft."""

    def __init__(self, pc: "FakePC", quick_play):
        self.pc = pc
        self.proc = FakeProc("javaw.exe", MC_CMDLINE + (["--quickPlaySingleplayer", quick_play] if quick_play else []),
                             windows=[window(pc.window_title, pc.window_class)])
        self.hwnd = self.proc.windows[0].hwnd
        self.locked: Path | None = None
        self.paused = False
        self.inventory_open = False
        self.save_on_pause = True  # False = like a LAN world (no singleplayer pause)
        self.log_saves_on_exit = True
        self.ignore_close = False
        pc.log.write_text(f"[{time.strftime('%H:%M:%S')}] [main/INFO]: Loading Minecraft 1.21.4 run {id(self)}\n"
                          "[Render thread/INFO]: Setting user: Krew\n")

    def write(self, line):
        with self.pc.log.open("a") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {line}\n")

    def open_world(self, folder: str):
        self.write("[Server thread/INFO]: Starting integrated minecraft server version 1.21.4")
        self.locked = self.pc.saves / folder
        time.sleep(self.pc.join_delay)
        self.write("[Server thread/INFO]: Krew joined the game")

    def escape(self):
        if self.inventory_open:
            self.inventory_open = False
        elif self.paused:
            self.paused = False
        else:
            self.paused = True
            if self.save_on_pause and self.locked:
                self.write("[Server thread/INFO]: Saving and pausing game...")
                self.write("[Server thread/INFO]: Saving chunks for level 'ServerLevel[Challenge]'/minecraft:overworld")

    def close(self):
        if self.ignore_close:
            return

        def shutdown():
            time.sleep(0.1)
            self.write("[Render thread/INFO]: Stopping!")
            if self.locked:
                self.write("[Server thread/INFO]: Stopping server")
                if self.log_saves_on_exit:
                    self.write("[Server thread/INFO]: Saving players")
                    self.write("[Server thread/INFO]: Saving worlds")
                    self.write("[Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved")
            self.locked = None
            time.sleep(0.1)
            self.pc.system.remove(self.proc)
            self.pc.game = None
        threading.Thread(target=shutdown, daemon=True).start()


class FakePC:
    def __init__(self, tmp: Path, world_folder="Challenge World", shown="Krew's Challenge"):
        self.system = FakeSystem()
        self.game_dir = tmp / ".minecraft"
        self.saves = self.game_dir / "saves"
        self.world_folder = world_folder
        for folder, name in ((world_folder, shown), ("Other World", "Other")):
            (self.saves / folder).mkdir(parents=True)
            (self.saves / folder / "level.dat").write_bytes(level_dat(name))
            (self.saves / folder / "region").mkdir()
            (self.saves / folder / "region" / "r.0.0.mca").write_bytes(b"x" * 1000)
        (self.game_dir / "logs").mkdir(parents=True)
        self.log = self.game_dir / "logs" / "latest.log"
        self.log.write_text("[old session]\n" * 50)
        self.launcher_exe = tmp / "MinecraftLauncher.exe"
        self.launcher_exe.write_bytes(b"MZ")
        self.launcher_controls = [UiControl("ButtonControl", "PLAY"), UiControl("ListItemControl", shown),
                                  UiControl("ButtonControl", "Settings")]
        self.game: FakeGame | None = None
        self.launcher = None
        self.start_delay = 0.2
        self.window_title, self.window_class = "Minecraft* 1.21.4", "GLFW30"  # 26.3+: SDL_app
        self.join_delay = 0.2
        self.auto_open_world_after_play = None  # "You" opening a world from the title screen
        self.actions = FakeActions(self)

    def open_target(self, cmd):
        if cmd[0].endswith("MinecraftLauncher.exe") and self.launcher is None:
            self.launcher = self.system.add(minecraft_launcher())

    def start_game(self, quick_play):
        def go():
            time.sleep(self.start_delay)
            self.game = FakeGame(self, quick_play)
            self.system.add(self.game.proc)
            if quick_play:
                time.sleep(0.1)
                self.game.open_world(quick_play)
            elif self.auto_open_world_after_play:
                time.sleep(0.2)
                self.game.open_world(self.auto_open_world_after_play)
        threading.Thread(target=go, daemon=True).start()
