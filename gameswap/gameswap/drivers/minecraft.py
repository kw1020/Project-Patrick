"""Minecraft Java Edition, through the official Minecraft Launcher.

How each step works, and how GameSwap knows it worked:

Launch   Opens the launcher and presses your world's Quick Play entry (or
         PLAY) through Windows' accessibility system: no mouse, no keys.
         If neither is found exactly once, it asks you to click.
         Verified: Minecraft's process and window appear.
Load     Quick Play opens your world directly. Otherwise it asks you to
         open the world yourself and notices when you do.
         Verified: Minecraft locks that world's session.lock file, and
         the world is the one you chose (not another one).
Ready    Verified: the world is locked, Minecraft's log says "<you> joined
         the game", a few seconds have passed for terrain, and Minecraft's
         window is the active one.
Save     Presses Esc, only after confirming Minecraft's window is in front.
         Verified: Minecraft logs "Saving and pausing game..." (it saves the
         world whenever the pause menu opens). At most two presses.
Exit     Asks the window to close, exactly like clicking its X. Minecraft
         then saves and unloads the world itself.
         Verified: the log shows "Stopping server" and "Saving worlds", the
         world unlocks, and the process exits. Never force-closed.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from .. import backup, winapi
from ..actions import Actions, choose_launcher_target
from ..mclog import MinecraftLog
from ..mcworld import level_name
from ..procmon import ProcessMonitor, WindowInfo
from .base import ReadyCheck, StepResult
from .real_base import RealGameDriver

log = logging.getLogger("gameswap.minecraft")

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
LAUNCHER_UI_WAIT = 15.0  # seconds to wait for the launcher's buttons to appear
PRESS_START_WAIT = 30.0  # after pressing, how long Minecraft gets to start before you're asked
SAVE_CONFIRM_WAIT = 2.5  # Minecraft logs the pause-save within a fraction of a second


def minecraft_args(cmdline: list[str]) -> dict | None:
    """If this java command line is the Minecraft game, return its version, its
    folder, and the world it was told to open (Quick Play). Nothing else is
    kept: the command line also holds your login token."""
    if "--gameDir" not in cmdline or "--assetsDir" not in cmdline:
        return None

    def value(flag):
        try:
            return cmdline[cmdline.index(flag) + 1]
        except (ValueError, IndexError):
            return ""

    info = {"version": value("--version"), "game_dir": value("--gameDir")}
    if "--quickPlaySingleplayer" in cmdline:
        info["quick_play"] = value("--quickPlaySingleplayer")
    return info


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


def resolve_world(game_dir: Path, wanted: str) -> tuple[str, str] | str:
    """Turn the 'World to open' setting into (folder name, shown name).
    Accepts the folder name or the name shown in Minecraft's world list.
    Returns an error message instead if it doesn't match exactly one world."""
    wanted = wanted.strip()
    if not wanted:
        return "no world is chosen. Pick one in Settings > Games > World to open"
    folders = list_worlds(game_dir)
    if wanted in folders:
        return wanted, level_name(game_dir / "saves" / wanted / "level.dat") or wanted
    by_shown = [f for f in folders if level_name(game_dir / "saves" / f / "level.dat") == wanted]
    if len(by_shown) == 1:
        return by_shown[0], wanted
    if len(by_shown) > 1:
        return f"{len(by_shown)} worlds are called '{wanted}'. Use the folder name from Diagnostics instead"
    return f"there is no world called '{wanted}' in {game_dir / 'saves'}"


class MinecraftDriver(RealGameDriver):
    mode_label = "Real - Phase 3 (automatic)"
    automates_load = True
    LAUNCHER_KEY = "minecraft_launcher"

    def __init__(self, key, cfg, monitor: ProcessMonitor, actions: Actions | None = None, clock=time.monotonic):
        super().__init__(key, cfg, monitor)
        self.actions = actions or Actions()
        self._clock = clock
        self.game_log = MinecraftLog(self.game_dir / "logs" / "latest.log", clock)
        monitor.register(key, MinecraftGameMatcher())
        monitor.register(self.LAUNCHER_KEY, LauncherMatcher())

    # ---- where things are --------------------------------------------------

    @property
    def game_dir(self) -> Path:
        """The folder from Settings, else the running game's folder, else the default .minecraft."""
        if self.cfg.game_folder:
            return Path(self.cfg.game_folder)
        for p in self.processes():
            if p.extra.get("game_dir"):
                return Path(p.extra["game_dir"])
        return default_game_dir()

    def world(self) -> tuple[Path, str, str] | str:
        """(world folder path, folder name, shown name), or an error message."""
        found = resolve_world(self.game_dir, self.cfg.save_name)
        if isinstance(found, str):
            return found
        folder, shown = found
        return self.game_dir / "saves" / folder, folder, shown

    def pick_window(self, windows):
        return pick_minecraft_window(windows)

    def launcher_window(self) -> WindowInfo | None:
        for p in self.monitor.get(self.LAUNCHER_KEY):
            w = LauncherMatcher().pick_window(p.windows)
            if w:
                return w
        return None

    def _point_log_at_running_game(self) -> None:
        path = self.game_dir / "logs" / "latest.log"
        if path != self.game_log.path:
            self.game_log = MinecraftLog(path, self._clock)
            self.game_log.read_from_start()

    # ---- Start checks + backup -------------------------------------------------

    def preflight(self) -> list[str]:
        problems = []
        cmd, how = find_launcher(self.cfg.launch_path)
        if cmd is None:
            problems.append(f"Minecraft: {how}.")
        world = self.world()
        if isinstance(world, str):
            problems.append(f"Minecraft: {world}.")
            return problems
        world_dir, folder, shown = world
        self.refresh()
        if not problems and self.cfg.backup_before_start and not self.is_running():
            log.info("Backing up Minecraft world '%s'...", shown)
            try:
                backup.backup_folder(world_dir, f"minecraft-{folder}", keep=self.cfg.backups_keep)
            except OSError as e:
                problems.append(f"Minecraft: couldn't back up world '{shown}' ({e}). Fix this or turn "
                                "off 'Back up before Start' in Settings.")
        return problems

    # ---- launch ----------------------------------------------------------------

    def launch(self, abort: threading.Event) -> StepResult:
        self.refresh()
        if self.is_running():
            self._point_log_at_running_game()
            self.game_log.read_from_start()
        else:
            self.game_log = MinecraftLog(self.game_dir / "logs" / "latest.log", self._clock)
            self.game_log.forget_current_file()  # only the new game's log counts
        result = super().launch(abort)
        if result.ok:
            self._point_log_at_running_game()
            w = self.game_window()
            if w:
                self.actions.bring_to_front(w.hwnd)
        return result

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
            while not abort.is_set():
                self.refresh()
                if self.launcher_window() is not None or self.is_running():
                    break
                abort.wait(self.POLL)
        if self.is_running():
            return StepResult(True, "the game is starting")
        w = self.launcher_window()
        if w is not None:
            self.actions.bring_to_front(w.hwnd)
        if self.cfg.auto_click_play and w is not None and not self.actions.can_read_ui():
            self.status = "Couldn't press PLAY automatically (uiautomation isn't installed: run install.bat). Click PLAY"
        elif self.cfg.auto_click_play and w is not None:
            pressed = self._press_in_launcher(w, abort)
            if pressed:
                self.status = f"Pressed {pressed} in the launcher. Minecraft is starting..."
                deadline = time.monotonic() + PRESS_START_WAIT
                while not abort.is_set() and time.monotonic() < deadline:
                    self.refresh()
                    if self.is_running():
                        return StepResult(True, f"pressed {pressed}")
                    abort.wait(self.POLL)
                self.status = f"Pressing {pressed} didn't start Minecraft. Click PLAY in the launcher yourself"
                return StepResult(True, f"pressed {pressed}, but Minecraft didn't start")
        if not self.status.startswith("Couldn't press"):
            self.status = "Click PLAY in the Minecraft Launcher"
        return StepResult(True, "waiting for you to click PLAY")

    def _press_in_launcher(self, w: WindowInfo, abort: threading.Event) -> str:
        world = self.world()
        shown = world[2] if not isinstance(world, str) else ""
        self.status = "Looking for PLAY in the launcher..."
        deadline = time.monotonic() + LAUNCHER_UI_WAIT
        why = ""
        while not abort.is_set() and time.monotonic() < deadline:
            try:
                controls = self.actions.ui_controls(w.hwnd)
            except Exception as e:
                why = f"couldn't read the launcher's buttons: {e}"
                controls = []
            target, why = choose_launcher_target(controls, shown) if controls else (None, why or "no buttons yet")
            if target is not None:
                if self.actions.invoke(target):
                    return f"Quick Play '{target.name}'" if why == "quick play" else "PLAY"
                why = f"pressing '{target.name}' didn't work"
                break
            abort.wait(1.0)
        self.status = f"Couldn't press PLAY automatically ({why}). Click PLAY in the launcher"
        return ""

    # ---- load ------------------------------------------------------------------

    def load_save(self, abort):
        world = self.world()
        if isinstance(world, str):
            return StepResult(False, world)
        world_dir, folder, shown = world
        proc = (self.processes() or [None])[0]
        quick = proc.extra.get("quick_play") if proc else None
        if quick and quick not in (folder, shown):
            return StepResult(False, f"the launcher opened world '{quick}', not '{shown}'")
        if quick:
            self.status = f"Opening '{shown}' (Quick Play)..."
        else:
            self.status = f"In Minecraft, open your world: Singleplayer > {shown} > Play Selected World"
        others = [f for f in list_worlds(self.game_dir) if f != folder]
        while not abort.is_set():
            self.refresh()
            if not self.is_running():
                return StepResult(False, "Minecraft closed while loading")
            self.game_log.poll()
            if self.game_log.events.crashed:
                return StepResult(False, f"Minecraft crashed: {self.game_log.events.crashed}")
            if self.actions.world_in_use(world_dir):
                return StepResult(True, f"world '{shown}' is open" + (" (Quick Play)" if quick else ""))
            wrong = [f for f in others if self.actions.world_in_use(self.game_dir / "saves" / f)]
            if wrong:
                return StepResult(False, f"world '{wrong[0]}' was opened instead of '{shown}'. Save and quit "
                                         "it, then open the right world and press Retry")
            abort.wait(self.POLL)
        return StepResult(False, "stopped waiting for the world to open")

    # ---- ready -----------------------------------------------------------------

    def check_ready(self) -> ReadyCheck:
        if not self.is_running():
            return ReadyCheck(False, "Minecraft isn't running")
        world = self.world()
        if isinstance(world, str):
            return ReadyCheck(False, world)
        world_dir, _folder, shown = world
        self.game_log.poll()
        ev = self.game_log.events
        if ev.crashed:
            return ReadyCheck(False, f"Minecraft crashed: {ev.crashed}")
        if not self.actions.world_in_use(world_dir):
            return ReadyCheck(False, f"world '{shown}' isn't open")
        if not ev.joined:
            return ReadyCheck(False, "loading the world")
        if self._clock() - ev.joined < self.cfg.ready_settle_seconds:
            return ReadyCheck(False, "loading terrain")
        if ev.last_pause > ev.joined:
            return ReadyCheck(False, "Minecraft paused itself while loading. Click into it and press Esc, "
                                     "then press Continue")
        w = self.game_window()
        if w is None or w.minimized:
            return ReadyCheck(False, "Minecraft's window is minimized or missing")
        if self.actions.foreground() != w.hwnd and not self.actions.bring_to_front(w.hwnd):
            return ReadyCheck(False, "Minecraft isn't the active window. Click on it")
        return ReadyCheck(True, f"{ev.player} is in '{shown}'")

    # ---- save --------------------------------------------------------------------

    def save(self, abort):
        world = self.world()
        if isinstance(world, str):
            return StepResult(False, world)
        world_dir, _folder, shown = world
        w = self.game_window()
        if w is None:
            return StepResult(False, "Minecraft's window wasn't found")
        if not self.actions.world_in_use(world_dir):
            return StepResult(False, f"world '{shown}' isn't open, so there is nothing to save")
        if self.actions.foreground() != w.hwnd and not self.actions.bring_to_front(w.hwnd):
            return StepResult(False, "couldn't bring Minecraft to the front, so no keys were sent")
        self.actions.release_modifiers()
        # Esc opens the pause menu (which saves), or first closes an open
        # inventory/chat, or closes an already-open pause menu. A second press
        # covers the last two cases. Each press must be confirmed by the log.
        for attempt in (1, 2):
            if abort.is_set():
                return StepResult(False, "stopped")
            self.game_log.poll()
            before = self.game_log.events.pauses
            if self.actions.foreground() != w.hwnd:
                return StepResult(False, "Minecraft stopped being the active window, so no keys were sent")
            if not self.actions.press_escape(w.hwnd):
                return StepResult(False, "Minecraft wasn't the active window, so Esc wasn't sent")
            deadline = time.monotonic() + SAVE_CONFIRM_WAIT
            while time.monotonic() < deadline and not abort.is_set():
                self.game_log.poll()
                if self.game_log.events.pauses > before:
                    abort.wait(1.0)  # let the save finish writing
                    self.game_log.poll()
                    return StepResult(True, f"Minecraft confirmed 'Saving and pausing game' (Esc press {attempt})")
                abort.wait(0.1)
        return StepResult(False, "pressed Esc twice but Minecraft didn't report saving. Is this a LAN or "
                                 "multiplayer world? The game was NOT closed")

    # ---- exit --------------------------------------------------------------------

    def exit(self, abort):
        self.refresh()
        if not self.is_running():
            return StepResult(True, "Minecraft was already closed")
        world = self.world()
        world_dir = world[0] if not isinstance(world, str) else None
        world_was_open = bool(world_dir) and self.actions.world_in_use(world_dir)
        w = self.game_window()
        if w is None or not self.actions.close_window(w.hwnd):
            return StepResult(False, "couldn't ask Minecraft's window to close")
        self.status = "Closing Minecraft (it saves and unloads the world first)..."
        while not abort.is_set():
            self.refresh()
            self.game_log.poll()
            if not self.is_running():
                break
            abort.wait(self.POLL)
        if self.is_running():
            return StepResult(False, "Minecraft didn't close in time. It was NOT force-closed")
        self.game_log.poll()
        ev = self.game_log.events
        if world_dir and self.actions.world_in_use(world_dir):
            return StepResult(False, "Minecraft exited but the world still looks open")
        if world_was_open and not (ev.stopping and ev.saving_worlds):
            return StepResult(False, "Minecraft closed, but its log didn't show the world being saved "
                                     "('Stopping server' / 'Saving worlds'). Check the world before continuing")
        if world_was_open:
            return StepResult(True, "world saved and unloaded ('Saving worlds'), then Minecraft exited")
        return StepResult(True, "Minecraft exited (no world was open)")
