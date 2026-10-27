"""Everything GameSwap physically does to a game, in one place.

The game drivers call these through an `Actions` object, so the tests can
swap in a fake one. Rules every action follows:
  * Keys are only sent after the caller has checked the game's window is
    the one in front (and press_escape checks again right before sending).
  * Windows are only asked to close (the same as clicking their X).
    Nothing here can kill or force-close a process.
  * Launcher buttons are pressed through Windows' accessibility system
    (like a screen reader would), never by clicking screen positions.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

from . import winapi

log = logging.getLogger("gameswap.actions")

VK_ESCAPE, SCAN_ESCAPE = 0x1B, 0x01
KEYEVENTF_KEYUP = 0x0002
# Left/right Shift, Ctrl, Alt, Windows keys.
MODIFIERS = (0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C)
INVOKABLE_TYPES = {"ButtonControl", "HyperlinkControl", "ListItemControl", "MenuItemControl", "TabItemControl"}


@dataclass
class UiControl:
    """One clickable thing in an app's accessibility tree."""

    kind: str  # e.g. "ButtonControl"
    name: str
    automation_id: str = ""
    handle: object = None  # the real uiautomation control (None in tests)


def world_in_use(world_dir: Path) -> bool:
    """True while Minecraft has this world open. Minecraft locks the world's
    session.lock file while the world is loaded; on Windows a locked file
    can't be read."""
    lock = world_dir / "session.lock"
    if not lock.exists():
        return False
    try:
        with lock.open("rb") as f:
            f.read(1)
        return False
    except OSError:
        return True


class Actions:
    """The real actions, on Windows."""

    def foreground(self) -> int:
        return winapi.foreground_hwnd()

    def bring_to_front(self, hwnd: int) -> bool:
        return winapi.bring_to_front(hwnd)

    def release_modifiers(self, wait: float = 1.5) -> None:
        """Make sure Ctrl/Shift/Alt/Win aren't held before a key is sent.
        (Esc while you hold Ctrl to sprint would be Ctrl+Esc = Start menu.)"""
        import win32api

        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if not any(win32api.GetAsyncKeyState(vk) & 0x8000 for vk in MODIFIERS):
                return
            time.sleep(0.03)
        for vk in MODIFIERS:
            if win32api.GetAsyncKeyState(vk) & 0x8000:
                win32api.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)

    def press_escape(self, hwnd: int) -> bool:
        """Press Esc once, only if `hwnd` is the window in front right now."""
        import win32api

        if self.foreground() != hwnd:
            return False
        win32api.keybd_event(VK_ESCAPE, SCAN_ESCAPE, 0, 0)
        time.sleep(0.05)
        win32api.keybd_event(VK_ESCAPE, SCAN_ESCAPE, KEYEVENTF_KEYUP, 0)
        return True

    def close_window(self, hwnd: int) -> bool:
        """Ask a window to close, exactly like clicking its X button."""
        import win32con
        import win32gui

        try:
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            return True
        except Exception as e:
            log.error("Couldn't ask the window to close: %s", e)
            return False

    def world_in_use(self, world_dir: Path) -> bool:
        return world_in_use(world_dir)

    def can_read_ui(self) -> bool:
        try:
            import uiautomation  # noqa: F401
            return True
        except ImportError:
            return False

    def ui_controls(self, hwnd: int) -> list[UiControl]:
        """The invokable controls (buttons, list items...) inside a window."""
        try:
            import uiautomation as auto
        except ImportError:
            log.warning("uiautomation isn't installed; run install.bat again.")
            return []
        found = []
        with auto.UIAutomationInitializerInThread():
            root = auto.ControlFromHandle(hwnd)
            # Chromium-style apps only build their accessibility tree once asked.
            list(auto.WalkControl(root, maxDepth=3))
            time.sleep(1.0)
            for ctrl, _depth in auto.WalkControl(root, includeTop=False, maxDepth=40):
                if ctrl.ControlTypeName in INVOKABLE_TYPES and ctrl.Name:
                    found.append(UiControl(ctrl.ControlTypeName, ctrl.Name, ctrl.AutomationId, ctrl))
        return found

    def invoke(self, control: UiControl) -> bool:
        """Press a control the way a screen reader does (no mouse, no keys)."""
        try:
            import uiautomation as auto
        except ImportError:
            return False
        with auto.UIAutomationInitializerInThread():
            ctrl = control.handle
            try:
                ctrl.GetInvokePattern().Invoke()
                return True
            except Exception:
                pass
            try:
                ctrl.GetLegacyIAccessiblePattern().DoDefaultAction()
                return True
            except Exception as e:
                log.warning("Couldn't press '%s': %s", control.name, e)
                return False


def choose_launcher_target(controls: list[UiControl], world_name: str) -> tuple[UiControl | None, str]:
    """Pick what to press in the Minecraft Launcher.

    1. The Quick Play entry for your world: opens Minecraft straight into it.
    2. Otherwise the PLAY button: opens Minecraft at its title screen.
    Only presses something that matches exactly once; if anything is
    ambiguous it returns None and you click yourself.
    """
    def norm(s):
        return " ".join(s.split()).casefold()

    if world_name:
        w = norm(world_name)
        quick = [c for c in controls if norm(c.name) == w or norm(c.name).startswith(w + ",")]
        if len(quick) == 1:
            return quick[0], "quick play"
        if len(quick) > 1:
            return None, f"{len(quick)} launcher entries are called '{world_name}'"
    play = [c for c in controls if norm(c.name) == "play"]
    if len(play) == 1:
        return play[0], "play button"
    if len(play) > 1:
        return None, f"{len(play)} PLAY buttons found"
    return None, "no PLAY button found in the launcher"
