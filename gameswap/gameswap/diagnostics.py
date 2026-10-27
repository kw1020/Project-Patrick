"""Diagnostics: one text report about the games on this PC.

It shows what GameSwap can find (launcher, Steam, game folders, worlds,
windows) so problems are easy to spot, and it gives Claude the facts that
Phases 3-4 are built on (for example how the Minecraft Launcher's buttons
look to Windows' accessibility system).

It never reads Minecraft's account files or login token. The report
contains folder paths, which include your Windows user name.
"""

from __future__ import annotations

import json
import logging
import platform
import sys
import time
from pathlib import Path

from . import __version__, s1saves, steam, winapi
from .config import LOG_DIR, Config
from .drivers.minecraft import MinecraftDriver, default_game_dir, find_launcher, list_worlds, start_menu_shortcuts
from .mcworld import level_name
from .drivers.schedule1 import Schedule1Driver

log = logging.getLogger("gameswap.diag")

MINECRAFT_OPTIONS = ("guiScale", "fullscreen", "lang", "pauseOnLostFocus", "overrideWidth", "overrideHeight")
UIA_MAX_LINES = 1500


def read_options(path: Path) -> dict[str, str]:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            k, sep, v = line.partition(":")
            if sep and k in MINECRAFT_OPTIONS:
                out[k] = v
    except OSError:
        pass
    return out


def launcher_installations(game_dir: Path) -> list[str]:
    """Installation names from launcher_profiles.json (no account data is in this file)."""
    try:
        data = json.loads((game_dir / "launcher_profiles.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = []
    for p in (data.get("profiles") or {}).values():
        name = p.get("name") or {"latest-release": "Latest release", "latest-snapshot": "Latest snapshot"}.get(p.get("type"), "?")
        rows.append(f"{name}  (type={p.get('type', '?')}, version={p.get('lastVersionId', '?')}"
                    f"{', own game folder' if p.get('gameDir') else ''}, last used={p.get('lastUsed', '?')})")
    return rows


def _windows(procs) -> list[str]:
    lines = []
    for p in procs:
        lines.append(f"  pid {p.pid} {p.name}" + (f" version {p.extra['version']}" if p.extra.get("version") else ""))
        for w in p.windows:
            lines.append(f'    window "{w.title}" class={w.class_name} size={w.size} rect={w.rect}'
                         + (" MINIMIZED" if w.minimized else ""))
    return lines or ["  not running"]


def uia_tree(hwnd: int) -> list[str]:
    """The window's accessibility tree: what UI automation could click in Phase 3."""
    try:
        import uiautomation as auto
    except ImportError:
        return ["  (uiautomation isn't installed - run install.bat again)"]
    lines = []
    try:
        with auto.UIAutomationInitializerInThread():
            root = auto.ControlFromHandle(hwnd)
            # Chromium-style apps only build their tree once something asks; ask, wait, ask again.
            list(auto.WalkControl(root, maxDepth=3))
            time.sleep(1.5)
            for ctrl, depth in auto.WalkControl(root, includeTop=True, maxDepth=40):
                r = ctrl.BoundingRectangle
                lines.append(f"  {'  ' * depth}{ctrl.ControlTypeName} name={ctrl.Name!r} id={ctrl.AutomationId!r} "
                             f"class={ctrl.ClassName!r} rect=({r.left},{r.top},{r.right},{r.bottom})")
                if len(lines) >= UIA_MAX_LINES:
                    lines.append("  ... (cut off)")
                    break
    except Exception as e:
        lines.append(f"  (couldn't read the accessibility tree: {e})")
    return lines


def build_report(cfg: Config, drivers: dict) -> str:
    out = [f"GameSwap {__version__} diagnostics - {time.strftime('%Y-%m-%d %H:%M:%S')}",
           f"Windows: {platform.platform()}   Python: {sys.version.split()[0]}", ""]

    out.append("== Monitors ==")
    for m in winapi.monitors():
        l, t, r, b = m["rect"]
        out.append(f"  {m['device']} {r - l}x{b - t} at ({l},{t}){' PRIMARY' if m['primary'] else ''}")
    out.append("")

    mc = drivers.get("minecraft")
    out.append("== Minecraft ==")
    cmd, how = find_launcher(cfg.games["minecraft"].launch_path)
    out.append(f"  Launcher: {cmd[0] if cmd else 'NOT FOUND'} ({how})")
    for lnk in start_menu_shortcuts():
        out.append(f"  Start menu shortcut: {lnk} -> {winapi.shortcut_target(str(lnk)) or '?'}")
    if isinstance(mc, MinecraftDriver):
        mc.refresh()
        out.append("  Launcher processes:")
        out += ["  " + x for x in _windows(mc.monitor.get(MinecraftDriver.LAUNCHER_KEY))]
        out.append("  Game processes:")
        out += ["  " + x for x in _windows(mc.processes())]
        game_dir = mc.game_dir
    else:
        out.append("  (driver is set to Simulated - switch it to Real in Settings to see processes)")
        game_dir = Path(cfg.games["minecraft"].game_folder) if cfg.games["minecraft"].game_folder else default_game_dir()
    out.append(f"  Game folder: {game_dir} {'(exists)' if game_dir.is_dir() else '(MISSING)'}")
    out.append(f"  Options: {read_options(game_dir / 'options.txt') or 'options.txt not found'}")
    out.append("  Launcher installations:")
    out += [f"    {row}" for row in launcher_installations(game_dir)] or ["    (none found)"]
    worlds = list_worlds(game_dir)
    out.append(f"  Worlds ({len(worlds)}): shown name  <-  folder name")
    for folder in worlds:
        out.append(f"    {level_name(game_dir / 'saves' / folder / 'level.dat') or '?'}  <-  {folder}")
    if isinstance(mc, MinecraftDriver):
        w = mc.launcher_window()
        out.append("  Launcher accessibility tree (for Phase 3):")
        out += uia_tree(w.hwnd) if w else ["  (open the Minecraft Launcher, then run Diagnostics again)"]
    out.append("")

    s1 = drivers.get("schedule1")
    out.append("== Schedule I ==")
    g = cfg.games["schedule1"]
    steam_dir = steam.find_steam_dir(g.launch_path)
    out.append(f"  Steam: {steam_dir or 'NOT FOUND'}")
    if steam_dir:
        out.append(f"  steam.exe: {steam.steam_exe(steam_dir) or 'NOT FOUND'}")
        for lib in steam.library_folders(steam_dir):
            out.append(f"  Library: {lib}")
        install = Path(g.game_folder) if g.game_folder else steam.find_install_dir(steam_dir, g.steam_app_id)
        out.append(f"  App {g.steam_app_id} installed in: {install or 'NOT FOUND'}")
        if install:
            for exe in steam.unity_game_exes(install):
                out.append(f"  Game program: {exe.name}")
    if isinstance(s1, Schedule1Driver):
        s1.refresh()
        out.append("  Game processes:")
        out += ["  " + x for x in _windows(s1.processes())]
    saves_root = Path(g.save_folder) if g.save_folder else s1saves.default_saves_root()
    slots = s1saves.list_slots(saves_root)
    out.append(f"  Saves folder: {saves_root} {'(exists)' if saves_root.is_dir() else '(MISSING)'}")
    for slot in slots:
        out.append(f"    Steam {slot.steam_id}: {slot.label}")
    chosen = s1saves.resolve_slot(saves_root, g.save_name)
    out.append(f"  Save to load: {chosen.label if not isinstance(chosen, str) else chosen}")
    player_log = s1saves.default_player_log()
    out.append(f"  Player.log: {player_log} {'(exists)' if player_log.exists() else '(not found)'}")
    try:
        tail = player_log.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]
    except OSError:
        tail = []
    out += [f"    | {line}" for line in tail]
    out.append("")
    return "\n".join(out)


def write_report(cfg: Config, drivers: dict, folder: Path = LOG_DIR) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"diagnostics-{time.strftime('%Y%m%d-%H%M%S')}.txt"
    path.write_text(build_report(cfg, drivers), encoding="utf-8")
    return path
