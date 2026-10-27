"""Thin wrappers around Windows (pywin32). Safe to import on any OS; the
functions just return empty results when not on Windows."""

from __future__ import annotations

import logging
import os
import sys

log = logging.getLogger("gameswap.win")

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    try:
        import win32api
        import win32con
        import win32gui
        import win32process
    except ImportError:  # pywin32 missing; install.bat installs it
        win32gui = None
else:
    win32gui = None


def available() -> bool:
    return win32gui is not None


def windows_for_pids(pids: set[int]) -> dict:
    """{pid: [WindowInfo]} for visible, top-level, un-owned windows of those processes."""
    from .procmon import WindowInfo

    out: dict[int, list] = {}
    if not available() or not pids:
        return out

    def callback(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd) or win32gui.GetWindow(hwnd, win32con.GW_OWNER):
                return True
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if pid in pids:
                out.setdefault(pid, []).append(WindowInfo(
                    hwnd=hwnd,
                    title=win32gui.GetWindowText(hwnd),
                    class_name=win32gui.GetClassName(hwnd),
                    rect=tuple(win32gui.GetWindowRect(hwnd)),
                    minimized=bool(win32gui.IsIconic(hwnd)),
                ))
        except Exception:  # the window closed while we looked at it
            pass
        return True

    win32gui.EnumWindows(callback, None)
    return out


def foreground_hwnd() -> int:
    return win32gui.GetForegroundWindow() if available() else 0


def bring_to_front(hwnd: int) -> bool:
    """Restore and try to focus a window. No keys are sent. If Windows refuses
    the focus change, the taskbar button flashes instead."""
    if not available():
        return False
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        if win32gui.GetForegroundWindow() == hwnd:
            return True
        win32gui.FlashWindowEx(hwnd, win32con.FLASHW_ALL | win32con.FLASHW_TIMERNOFG, 0, 0)
        return False
    except Exception as e:
        log.debug("bring_to_front failed: %s", e)
        return False


def keep_on_top(hwnd: int) -> None:
    """Re-assert 'always on top' without taking focus (some games push themselves up)."""
    if not available() or not hwnd:
        return
    try:
        win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE)
    except Exception:
        pass


def monitors() -> list[dict]:
    if not available():
        return []
    result = []
    for handle, _, _ in win32api.EnumDisplayMonitors():
        info = win32api.GetMonitorInfo(handle)
        result.append({"device": info.get("Device", ""), "rect": info["Monitor"], "primary": bool(info["Flags"] & 1)})
    return result


def shortcut_target(lnk_path: str) -> str:
    """Where a Windows .lnk shortcut points, or '' if it can't be read."""
    if not IS_WINDOWS:
        return ""
    try:
        import win32com.client

        return win32com.client.Dispatch("WScript.Shell").CreateShortcut(lnk_path).TargetPath or ""
    except Exception:
        return ""


def read_registry(root: str, path: str, value: str) -> str:
    """Read a string from the registry. root is 'HKCU' or 'HKLM'."""
    if not IS_WINDOWS:
        return ""
    import winreg

    hive = {"HKCU": winreg.HKEY_CURRENT_USER, "HKLM": winreg.HKEY_LOCAL_MACHINE}[root]
    try:
        with winreg.OpenKey(hive, path) as key:
            return str(winreg.QueryValueEx(key, value)[0])
    except OSError:
        return ""


def open_target(target: list[str]) -> None:
    """Start a program (['C:\\...exe', 'arg']) or a shell target (['shell:...'] / ['steam://...'])."""
    import subprocess

    if len(target) == 1 and (target[0].startswith("shell:") or "://" in target[0]):
        if IS_WINDOWS:
            os.startfile(target[0])
        else:
            raise OSError(f"can't open {target[0]} on this OS")
        return
    flags = 0
    if IS_WINDOWS:
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(target, close_fds=True, creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
