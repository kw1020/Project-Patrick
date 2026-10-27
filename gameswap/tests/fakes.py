"""Fake processes and windows so the real game drivers can be tested anywhere."""

from __future__ import annotations

import itertools
import threading

from gameswap.procmon import ProcessMonitor, WindowInfo

_pids = itertools.count(5000)


class FakeProc:
    def __init__(self, name, cmdline=(), exe="", windows=()):
        self.pid = next(_pids)
        self.info = {"name": name, "create_time": 1000.0 + self.pid}
        self._cmdline = list(cmdline)
        self._exe = exe
        self.windows = list(windows)
        self.inspected = 0

    def cmdline(self):
        self.inspected += 1
        return self._cmdline

    def exe(self):
        self.inspected += 1
        return self._exe


class FakeSystem:
    """A pretend Windows: a list of running processes and their windows."""

    def __init__(self):
        self.procs: list[FakeProc] = []
        self.lock = threading.Lock()

    def add(self, proc: FakeProc) -> FakeProc:
        with self.lock:
            self.procs.append(proc)
        return proc

    def remove(self, proc: FakeProc) -> None:
        with self.lock:
            self.procs.remove(proc)

    def lister(self):
        with self.lock:
            return list(self.procs)

    def window_lister(self, pids):
        with self.lock:
            return {p.pid: p.windows for p in self.procs if p.pid in pids and p.windows}

    def monitor(self) -> ProcessMonitor:
        return ProcessMonitor(lister=self.lister, window_lister=self.window_lister)


def window(title, cls, w=1920, h=1080, hwnd=None):
    return WindowInfo(hwnd or next(_pids), title, cls, (0, 0, w, h))


MC_CMDLINE = [
    r"C:\Users\krew\AppData\Local\Packages\runtime\javaw.exe", "-Xmx4G", "net.minecraft.client.main.Main",
    "--username", "Krew", "--version", "1.21.4", "--gameDir", r"C:\Users\krew\AppData\Roaming\.minecraft",
    "--assetsDir", r"C:\Users\krew\AppData\Roaming\.minecraft\assets", "--accessToken", "SECRET-TOKEN-123",
]


def minecraft_game(title="Minecraft* 1.21.4"):
    return FakeProc("javaw.exe", MC_CMDLINE, windows=[window(title, "GLFW30")])


def minecraft_launcher():
    return FakeProc("MinecraftLauncher.exe",
                    exe=r"C:\Program Files (x86)\Minecraft Launcher\MinecraftLauncher.exe",
                    windows=[window("Minecraft Launcher", "Chrome_WidgetWin_1", 1280, 720)])
