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
import re
import time
from dataclasses import dataclass
from pathlib import Path

from . import winapi

log = logging.getLogger("gameswap.actions")

VK_ESCAPE, SCAN_ESCAPE = 0x1B, 0x01


def key_code(key: str) -> int | None:
    """Windows key code for 'F1'..'F12', 'A'..'Z' or '0'..'9'; None for anything else."""
    k = key.strip().upper()
    if re.fullmatch(r"F([1-9]|1[0-2])", k):
        return 0x70 + int(k[1:]) - 1
    if re.fullmatch(r"[A-Z0-9]", k):
        return ord(k)
    return None
KEYEVENTF_KEYUP = 0x0002
# Left/right Shift, Ctrl, Alt, Windows keys.
MODIFIERS = (0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C)
INVOKABLE_TYPES = {"ButtonControl", "HyperlinkControl", "ListItemControl", "MenuItemControl", "TabItemControl"}
# Named text/groups are read too: the launcher's Quick Play entry can be a
# clickable box whose only name is the world's name in a text inside it.
LABEL_TYPES = {"TextControl", "GroupControl"}


@dataclass
class UiControl:
    """One clickable thing in an app's accessibility tree."""

    kind: str  # e.g. "ButtonControl"
    name: str
    automation_id: str = ""
    handle: object = None  # the real uiautomation control (None in tests)
    parents: tuple = ()  # enclosing controls, nearest first
    selected: bool | None = None  # tabs: is this the page that's showing? (None = unknown)


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

    def press_key(self, hwnd: int, key: str) -> bool:
        """Press one key (e.g. 'F2'), only if `hwnd` is the window in front right now."""
        import win32api

        vk = key_code(key)
        if vk is None or self.foreground() != hwnd:
            return False
        scan = win32api.MapVirtualKey(vk, 0)
        win32api.keybd_event(vk, scan, 0, 0)
        time.sleep(0.05)
        win32api.keybd_event(vk, scan, KEYEVENTF_KEYUP, 0)
        return True

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
            stack: list[tuple[int, UiControl]] = []  # the controls enclosing the current one
            for ctrl, depth in auto.WalkControl(root, includeTop=False, maxDepth=40):
                while stack and stack[-1][0] >= depth:
                    stack.pop()
                kind = ctrl.ControlTypeName
                c = UiControl(kind, ctrl.Name or "", ctrl.AutomationId or "", ctrl,
                              parents=tuple(p for _, p in reversed(stack[-6:])))
                if kind == "TabItemControl":
                    try:
                        c.selected = bool(ctrl.GetSelectionItemPattern().IsSelected)
                    except Exception:
                        c.selected = None
                stack.append((depth, c))
                if c.name and (kind in INVOKABLE_TYPES or kind in LABEL_TYPES):
                    found.append(c)
        return found

    def select(self, control: UiControl) -> bool:
        """Switch to a tab/page (no mouse, no keys); falls back to pressing it."""
        try:
            import uiautomation as auto
        except ImportError:
            return False
        with auto.UIAutomationInitializerInThread():
            try:
                control.handle.GetSelectionItemPattern().Select()
                return True
            except Exception:
                pass
        return self.invoke(control)

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


def _norm(s: str) -> str:
    return " ".join(s.split()).casefold()


def find_java_tab(controls: list[UiControl]) -> UiControl | None:
    """The launcher's 'MINECRAFT: JAVA EDITION' page link, if there's exactly one."""
    tabs = [c for c in controls if c.kind in INVOKABLE_TYPES
            and (c.automation_id == "Java Edition-menulink" or "java edition" in _norm(c.name))]
    return tabs[0] if len(tabs) == 1 else None


def choose_launcher_target(controls: list[UiControl], world_name: str) -> tuple[UiControl | None, str]:
    """Pick what to press in the Minecraft Launcher.

    1. The Quick Play entry for your world: opens Minecraft straight into it.
    2. Otherwise the PLAY button: opens Minecraft at its title screen.
    Only presses something that matches exactly once; if anything is
    ambiguous it returns None and you click yourself.
    """
    if world_name:
        w = _norm(world_name)
        targets: list[UiControl] = []
        for c in controls:
            n = _norm(c.name)
            if not (n == w or (n.startswith(w) and not n[len(w)].isalnum())):
                continue
            # A text inside the entry: press the entry around it.
            t = c if c.kind in INVOKABLE_TYPES else next(
                (p for p in c.parents[:4] if p.kind in INVOKABLE_TYPES), c)
            if not any(t is x for x in targets):
                targets.append(t)
        if len(targets) == 1:
            return targets[0], "quick play"
        if len(targets) > 1:
            return None, f"{len(targets)} launcher entries are called '{world_name}'"
    play = [c for c in controls if c.kind in INVOKABLE_TYPES and _norm(c.name) == "play"]
    if len(play) == 1:
        return play[0], "play button"
    if len(play) > 1:
        return None, f"{len(play)} PLAY buttons found"
    return None, "no PLAY button found in the launcher"
