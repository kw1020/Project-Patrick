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
from ..actions import Actions, choose_launcher_target, find_java_tab
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
LAUNCHER_UI_WAIT = 15.0  # seconds to wait for the launcher's buttons to appear
PRESS_START_WAIT = 30.0
LAUNCHER_OPEN_WAIT = 25.0  # stop waiting for the launcher's window after this; you can still click PLAY  # after pressing, how long Minecraft gets to start before you're asked
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
    app_id = store_launcher_app_id()
    if app_id:
        return [f"shell:AppsFolder\\{app_id}"], "found in the Start menu (Microsoft Store / Xbox app version)"
    return None, ("the Minecraft Launcher wasn't found. Open it once from the Start menu, or set its path in "
                  "Settings > Games > Minecraft Launcher")


_store_app_id_cache: list[str] = []


def store_launcher_app_id() -> str:
    """The Minecraft Launcher's app ID from Windows' own Start menu list. That's
    how Microsoft Store / Xbox app installs (which have no normal .exe path)
    are found and started."""
    if _store_app_id_cache:
        return _store_app_id_cache[0]
    if not winapi.IS_WINDOWS:
        return ""
    import subprocess

    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-StartApps | Where-Object { $_.Name -like '*Minecraft*' } | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    app_id = pick_launcher_app_id(out)
    if app_id:
        _store_app_id_cache.append(app_id)
    return app_id


def pick_launcher_app_id(get_start_apps_json: str) -> str:
    """From Get-StartApps output, the entry that is the Minecraft Launcher (not
    Bedrock 'Minecraft', not Minecraft Education)."""
    import json

    try:
        data = json.loads(get_start_apps_json or "[]")
    except ValueError:
        return ""
    apps = data if isinstance(data, list) else [data]
    for app in apps:
        name = str(app.get("Name", "")).lower()
        if "launcher" in name and "minecraft" in name:
            return str(app.get("AppID", ""))
    for app in apps:  # older Store installs list the launcher's package by its ID
        if "4297127d64ec6" in str(app.get("AppID", "")).lower():
            return str(app.get("AppID", ""))
    return ""


class MinecraftGameMatcher:
    def wants_name(self, name: str) -> bool:
        return name in JAVA_NAMES

    def inspect(self, proc) -> dict | None:
        try:
            return minecraft_args(proc.cmdline())
        except Exception:
            # Windows wouldn't show this java's command line. Accept it only if it
            # runs from a Minecraft folder (the launcher's own Java lives there).
            exe = proc.exe().lower()
            return {"version": "", "game_dir": ""} if "minecraft" in exe else None

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
    """Minecraft's window, titled 'Minecraft ...'. Up to 1.21 / 26.2 it's made by
    GLFW (class GLFW30); from 26.3 by SDL3 (class SDL_app). Only the game's own
    java process is searched, so its biggest window is the game as a last resort."""
    windows = [w for w in windows if "launcher" not in w.title.lower()
               and not w.class_name.startswith("Chrome_WidgetWin")]  # never the launcher
    game = [w for w in windows if w.class_name.upper().startswith(("GLFW", "SDL"))]
    titled = [w for w in windows if w.title.lower().startswith("minecraft")]
    titled_game = [w for w in titled if w in game]
    if titled_game or titled or game:
        return (titled_game or titled or game)[0]
    sized = [w for w in windows if _area(w) >= 200 * 150]
    return max(sized, key=_area, default=None)


def _area(w: WindowInfo) -> int:
    l, t, r, b = w.rect
    return max(0, r - l) * max(0, b - t)


def most_recent_world(game_dir: Path) -> str:
    """The world folder you played last (its level.dat was saved most recently)."""
    worlds = list_worlds(game_dir)
    try:
        return max(worlds, key=lambda f: (game_dir / "saves" / f / "level.dat").stat().st_mtime) if worlds else ""
    except OSError:
        return ""


def resolve_world(game_dir: Path, wanted: str) -> tuple[str, str] | str:
    """Turn the 'World to open' setting into (folder name, shown name).
    Accepts the folder name or the name shown in Minecraft's world list;
    blank means the world you played most recently.
    Returns an error message instead if it doesn't match exactly one world."""
    wanted = wanted.strip() or most_recent_world(game_dir)
    if not wanted:
        return (f"no Minecraft worlds were found in {game_dir / 'saves'}. Play a world once, or set the "
                ".minecraft folder in Settings > Games")
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

    @property
    def manual_ready(self) -> bool:
        """Ctrl+Shift+F10 also works for Minecraft, as a backup if the automatic
        'you're in the world' check doesn't fire on your PC."""
        return True

    def world(self) -> tuple[Path, str, str] | str:
        """(world folder path, folder name, shown name), or an error message."""
        wanted = self.cfg.save_name
        if not wanted.strip() and self.is_running():
            # Nothing picked and you're already playing: use the world that's open.
            wanted = next((f for f in list_worlds(self.game_dir)
                           if self.actions.world_in_use(self.game_dir / "saves" / f)), "")
        found = resolve_world(self.game_dir, wanted)
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

    def _world_open(self, world_dir: Path) -> bool:
        """The world is loaded: Minecraft holds its lock, or its log says you joined
        (and it hasn't started closing). The log is the backup check."""
        ev = self.game_log.events
        return self.actions.world_in_use(world_dir) or bool(ev.joined and not ev.stopping)

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
            # Not a reason to refuse: you can open Minecraft yourself and GameSwap picks it up.
            log.warning("Minecraft: %s. When it's Minecraft's turn, open it yourself.", how)
        world = self.world()
        if isinstance(world, str):
            problems.append(f"Minecraft: {world}.")
            return problems
        world_dir, folder, shown = world
        if not self.cfg.save_name.strip():
            log.info("No world picked in Settings, so GameSwap will open the one you played last: '%s'.", shown)
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
            opened = False
            if cmd is not None:
                try:
                    winapi.open_target(cmd)
                    opened = True
                except OSError as e:
                    how = f"couldn't open it ({e})"
            if not opened:
                # Keep going: open Minecraft yourself and GameSwap picks it up.
                log.warning("Minecraft Launcher: %s. Waiting for you to open Minecraft.", how)
                self.status = "Open Minecraft yourself and load your world - GameSwap will pick it up"
                return StepResult(True, "waiting for you to open Minecraft")
            self.status = "Opening the Minecraft Launcher..."
            log.info("Opening the Minecraft Launcher (%s).", how)
            deadline = time.monotonic() + LAUNCHER_OPEN_WAIT
            while not abort.is_set() and time.monotonic() < deadline:
                self.refresh()
                if self.launcher_window() is not None or self.is_running():
                    break
                abort.wait(self.POLL)
            if self.launcher_window() is None and not self.is_running():
                log.warning("The Minecraft Launcher's window wasn't recognised; waiting for you to press PLAY.")
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
        java_clicked = False
        controls = []
        while not abort.is_set() and time.monotonic() < deadline:
            try:
                controls = self.actions.ui_controls(w.hwnd)
            except Exception as e:
                why = f"couldn't read the launcher's buttons: {e}"
                controls = []
            # The launcher can open on HOME (other games live there too): go to
            # MINECRAFT: JAVA EDITION first, and press nothing until it's showing.
            tab = find_java_tab(controls)
            if tab is not None and tab.selected is not True:
                if java_clicked and tab.selected is False:
                    why = "the launcher didn't switch to MINECRAFT: JAVA EDITION"
                    abort.wait(1.0)
                    continue
                if not java_clicked:
                    self.status = "Opening MINECRAFT: JAVA EDITION in the launcher..."
                    log.info("Launcher: switching to MINECRAFT: JAVA EDITION.")
                    if not self.actions.select(tab):
                        why = "couldn't open MINECRAFT: JAVA EDITION in the launcher"
                        break
                    java_clicked = True
                    abort.wait(1.5)
                    deadline = time.monotonic() + LAUNCHER_UI_WAIT  # the Java page gets the full wait
                    continue
            target, why = choose_launcher_target(controls, shown) if controls else (None, why or "no buttons yet")
            if target is not None:
                if self.actions.invoke(target):
                    pressed = f"Quick Play '{shown}'" if why == "quick play" else "PLAY"
                    log.info("Launcher: pressed %s.", pressed)
                    return pressed
                why = f"pressing '{target.name or shown}' didn't work"
                break
            abort.wait(1.0)
        named = [f"{c.kind[:-7]} '{c.name}'" for c in controls if c.name][:60]
        log.warning("Launcher: couldn't press PLAY (%s). It showed: %s", why, ", ".join(named) or "nothing readable")
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
            wrong = [f for f in others if self.actions.world_in_use(self.game_dir / "saves" / f)]
            if not wrong and self._world_open(world_dir):
                return StepResult(True, f"world '{shown}' is open" + (" (Quick Play)" if quick else ""))
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
        if not self._world_open(world_dir):
            return ReadyCheck(False, f"world '{shown}' isn't open")
        if not ev.joined:
            return ReadyCheck(False, "loading the world")
        if self._clock() - ev.joined < self.cfg.ready_settle_seconds:
            return ReadyCheck(False, "loading terrain")
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
        self.game_log.poll()
        if not self._world_open(world_dir):
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
        self.game_log.poll()
        world_was_open = bool(world_dir) and self._world_open(world_dir)
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
