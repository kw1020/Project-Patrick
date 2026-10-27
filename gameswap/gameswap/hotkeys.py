"""System-wide hotkeys (they work while a game has focus). Windows only."""

from __future__ import annotations

import ctypes
import sys
import threading
from typing import Callable

IS_WINDOWS = sys.platform == "win32"

MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, MOD_NOREPEAT = 0x1, 0x2, 0x4, 0x8, 0x4000
WM_HOTKEY, WM_QUIT = 0x0312, 0x0012
_MODS = {"ctrl": MOD_CONTROL, "control": MOD_CONTROL, "shift": MOD_SHIFT, "alt": MOD_ALT, "win": MOD_WIN}
_NAMED = {
    "pause": 0x13, "end": 0x23, "home": 0x24, "insert": 0x2D, "delete": 0x2E,
    "pageup": 0x21, "pagedown": 0x22, "scrolllock": 0x91,
}


def parse_hotkey(text: str) -> tuple[int, int]:
    """'ctrl+shift+F9' -> (modifier flags, virtual-key code)."""
    parts = [p.strip().lower() for p in text.split("+") if p.strip()]
    if not parts:
        raise ValueError("empty hotkey")
    mods = 0
    for p in parts[:-1]:
        if p not in _MODS:
            raise ValueError(f"unknown modifier '{p}'")
        mods |= _MODS[p]
    key = parts[-1]
    if key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        vk = 0x70 + int(key[1:]) - 1
    elif key in _NAMED:
        vk = _NAMED[key]
    elif len(key) == 1 and key.isalnum():
        vk = ord(key.upper())
    else:
        raise ValueError(f"unknown key '{key}'")
    if vk == 0x7B:
        raise ValueError("F12 is reserved by Windows")
    if mods == 0:
        raise ValueError("use at least one of ctrl/shift/alt so games don't trigger it by accident")
    return mods, vk


class HotkeyListener:
    def __init__(self, bindings: dict[str, Callable[[], None]], on_error: Callable[[str], None]):
        self._bindings = bindings  # "ctrl+shift+F9" -> callback (runs on the hotkey thread)
        self._on_error = on_error
        self._thread_id = 0

    def start(self) -> None:
        if IS_WINDOWS:
            threading.Thread(target=self._run, name="hotkeys", daemon=True).start()

    def stop(self) -> None:
        if self._thread_id:
            ctypes.windll.user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)

    def _run(self) -> None:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        self._thread_id = ctypes.windll.kernel32.GetCurrentThreadId()
        callbacks = {}
        for i, (combo, callback) in enumerate(self._bindings.items(), start=1):
            try:
                mods, vk = parse_hotkey(combo)
            except ValueError as e:
                self._on_error(f"Hotkey '{combo}' is invalid: {e}")
                continue
            if user32.RegisterHotKey(None, i, mods | MOD_NOREPEAT, vk):
                callbacks[i] = callback
            else:
                self._on_error(f"Hotkey {combo} is already used by another app. Change it in Settings.")
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_HOTKEY and msg.wParam in callbacks:
                callbacks[msg.wParam]()
        for i in callbacks:
            user32.UnregisterHotKey(None, i)
