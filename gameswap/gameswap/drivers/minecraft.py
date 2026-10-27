"""Minecraft Java Edition, started through the official Minecraft Launcher.

Phase 2: opens the launcher, waits for you to click PLAY, then detects the
game (a java process) and its window. Phase 3 will press PLAY for you, open
your world, verify gameplay, and use Save and Quit.

Why you click PLAY for now: the official launcher has no supported way to
start the game or a world from the command line. Phase 3 will automate the
click only after Diagnostics confirms how the launcher's buttons look on
your PC.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from .. import winapi
from ..procmon import ProcessMonitor, WindowInfo
from .base import StepResult
from .real_base import RealGameDriver

JAVA_NAMES = {"javaw.exe", "java.exe", "javaw", "java"}
LAUNCHER_NAMES = {"minecraftlauncher.exe", "minecraft.exe"}

# The official launcher's usual install locations (newest first).
LAUNCHER_PATHS = [
    r"C:\XboxGames\Minecraft Launcher\Content\Minecraft.exe",
    r"C:\Program Files (x86)\Minecraft Launcher\MinecraftLauncher.exe",
    r"C:\Program Files\Minecraft Launcher\MinecraftLauncher.exe",
    r"C:\Program Files (x86)\Minecraft\MinecraftLauncher.exe",
]
# Microsoft Store / Xbox app copy of the launcher, started by its app ID.
STORE_LAUNCHER = r"shell:AppsFolder\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft"


def minecraft_args(cmdline: list[str]) -> dict | None:
    """If this java command line is the Minecraft game, return its version and
    folder. Nothing else is kept: the command line also holds your login token."""
    if "--gameDir" not in cmdline or "--assetsDir" not in cmdline:
        return None

    def value(flag):
        try:
            return cmdline[cmdline.index(flag) + 1]
        except (ValueError, IndexError):
            return ""

    return {"version": value("--version"), "game_dir": value("--gameDir")}


def default_game_dir() -> Path:
    return Path(os.environ.get("APPDATA", "")) / ".minecraft"


def list_worlds(game_dir: Path) -> list[str]:
    """Folder names in .minecraft/saves (the world list Phase 3 opens from)."""
    saves = game_dir / "saves"
    try:
        return sorted((p.name for p in saves.iterdir() if (p / "level.dat").exists()), key=str.lower)
    except OSError:
        return []


def start_menu_shortcuts() -> list[Path]:
    roots = [
        Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
        Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs",
    ]
    found = []
    for root in roots:
        try:
            found += [p for p in root.rglob("Minecraft Launcher*.lnk")]
        except OSError:
            pass
    return found


def find_launcher(configured: str = "") -> tuple[list[str] | None, str]:
    """(command to open the launcher, how it was found)."""
    if configured.strip():
        path = configured.strip().strip('"')
        if os.path.exists(path):
            return [path], "from Settings"
        return None, f"the launcher path in Settings doesn't exist: {path}"
    for path in LAUNCHER_PATHS:
        if os.path.exists(path):
            return [path], "found in its usual folder"
    for lnk in start_menu_shortcuts():
        target = winapi.shortcut_target(str(lnk))
        if target and os.path.exists(target):
            return [target], f"found via Start menu shortcut {lnk.name}"
    if winapi.IS_WINDOWS:
        return [STORE_LAUNCHER], "using the Microsoft Store / Xbox app launcher (not confirmed)"
    return None, "the Minecraft Launcher wasn't found. Set its path in Settings > Games"


class MinecraftGameMatcher:
    def wants_name(self, name: str) -> bool:
        return name in JAVA_NAMES

    def inspect(self, proc) -> dict | None:
        return minecraft_args(proc.cmdline())

    def pick_window(self, windows):
        return pick_minecraft_window(windows)


class LauncherMatcher:
    def wants_name(self, name: str) -> bool:
        return name in LAUNCHER_NAMES

    def inspect(self, proc) -> dict | None:
        exe = proc.exe()
        # "Minecraft.exe" could be another app; the launcher is MinecraftLauncher.exe,
        # lives in a "Minecraft Launcher" folder, or in its Microsoft Store package.
        low = exe.lower()
        if ("minecraft launcher" in low or "microsoft.4297127d64ec6" in low
                or os.path.basename(low) == "minecraftlauncher.exe"):
            return {"exe": exe}
        return None

    def pick_window(self, windows):
        titled = [w for w in windows if w.title]
        return max(titled, key=lambda w: _area(w), default=None)


def pick_minecraft_window(windows: list[WindowInfo]) -> WindowInfo | None:
    """Minecraft's window is made by GLFW (class GLFW30) and titled 'Minecraft ...'."""
    glfw = [w for w in windows if w.class_name.startswith("GLFW")]
    titled = [w for w in glfw if w.title.lower().startswith("minecraft")]
    return (titled or glfw or [None])[0]


def _area(w: WindowInfo) -> int:
    l, t, r, b = w.rect
    return max(0, r - l) * max(0, b - t)


class MinecraftDriver(RealGameDriver):
    mode_label = "Real - Phase 2 (launch + detect)"
    phase_for_load = "Phase 3"
    phase_for_save = "Phase 3"
    LAUNCHER_KEY = "minecraft_launcher"

    def __init__(self, key, cfg, monitor: ProcessMonitor):
        super().__init__(key, cfg, monitor)
        monitor.register(key, MinecraftGameMatcher())
        monitor.register(self.LAUNCHER_KEY, LauncherMatcher())

    @property
    def game_dir(self) -> Path:
        """The folder from Settings, else the running game's folder, else the default .minecraft."""
        if self.cfg.game_folder:
            return Path(self.cfg.game_folder)
        for p in self.processes():
            if p.extra.get("game_dir"):
                return Path(p.extra["game_dir"])
        return default_game_dir()

    def pick_window(self, windows):
        return pick_minecraft_window(windows)

    def preflight(self) -> list[str]:
        problems = []
        cmd, how = find_launcher(self.cfg.launch_path)
        if cmd is None:
            problems.append(f"Minecraft: {how}.")
        return problems

    def launcher_window(self) -> WindowInfo | None:
        for p in self.monitor.get(self.LAUNCHER_KEY):
            w = LauncherMatcher().pick_window(p.windows)
            if w:
                return w
        return None

    def start_game(self, abort: threading.Event) -> StepResult:
        if not self.monitor.get(self.LAUNCHER_KEY):
            cmd, how = find_launcher(self.cfg.launch_path)
            if cmd is None:
                return StepResult(False, how)
            try:
                winapi.open_target(cmd)
            except OSError as e:
                return StepResult(False, f"couldn't open the Minecraft Launcher ({how}): {e}")
            self.status = "Opening the Minecraft Launcher..."
            # Wait for the launcher's window before asking you to click.
            while not abort.is_set():
                self.refresh()
                if self.launcher_window() is not None or self.is_running():
                    break
                abort.wait(self.POLL)
        w = self.launcher_window()
        if w is not None:
            winapi.bring_to_front(w.hwnd)
        self.status = "Click PLAY in the Minecraft Launcher (Phase 3 will do this for you)"
        return StepResult(True, "launcher open")
