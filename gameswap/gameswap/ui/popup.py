"""The pop-up panel: a small always-on-top card at the top of your screen.

- While you play, a small timer (game + time left) sits in the corner.
  Clicks pass straight through it to the game.

- Show / hide it any time with its hotkey (Ctrl+Shift+G by default).
- It pops up by itself at 1 minute and 30 seconds left, then stays up for
  the final countdown (10, 9, 8 ...) and while the games switch, and
  tucks itself away a few seconds after the next game starts.
- It never takes keyboard focus, so popping up can't pause your game.
  (Minecraft pauses itself when it loses focus.) Its buttons work with
  a mouse click without stealing focus, and every button has a hotkey.

For it to appear over a game, play in borderless / windowed fullscreen.
"""

from __future__ import annotations

import time

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from .. import winapi
from ..config import Config
from ..machine import ACTIVE_STATES, Snapshot, State

MARGIN = 16
SWITCH_STATES = {State.SAVING, State.EXITING, State.SWITCHING, State.LAUNCHING, State.LOADING,
                 State.VERIFYING_GAMEPLAY}

STYLE = """
QFrame#panel { background: rgba(14, 16, 24, 235); border: 2px solid #343b4d; border-radius: 16px; }
QFrame#panel[level="warning"] { border-color: #ffb020; }
QFrame#panel[level="final"] { border-color: #ff3b3b; background: rgba(48, 6, 8, 240); }
QFrame#panel[level="go"] { border-color: #2fd27a; }
QFrame#mini { background: rgba(14, 16, 24, 175); border: 1px solid rgba(255, 255, 255, 30); border-radius: 10px; }
QFrame#mini[level="warning"] { border-color: #ffb020; }
QLabel#miniGame { color: #aeb5c4; font-size: 10px; font-weight: 700; letter-spacing: 1px; }
QLabel#miniClock { font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 22px; font-weight: 800; }
QLabel#miniClock[level="warning"] { color: #ffb020; }
QLabel#miniClock[level="paused"] { color: #7a8296; }
QLabel#miniNext { color: #8a93a6; font-size: 10px; }
QLabel#miniNext[level="warning"] { color: #ffb020; font-weight: 700; }
QLabel { color: #e6e9ef; background: transparent; font-family: "Segoe UI"; }
QLabel#brand { color: #8a93a6; font-size: 11px; font-weight: 700; letter-spacing: 2px; }
QLabel#headline { font-size: 15px; font-weight: 700; }
QLabel#clock { font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 46px; font-weight: 800; }
QLabel#clock[big="true"] { font-size: 84px; }
QLabel#detail { color: #aeb5c4; font-size: 12px; }
QLabel#hint { color: #6c7489; font-size: 10px; }
QPushButton { background: #252a38; color: #e6e9ef; border: 1px solid #343b4d; border-radius: 8px;
              padding: 6px 10px; font-family: "Segoe UI"; font-size: 12px; }
QPushButton:hover { background: #30364a; }
QPushButton:disabled { color: #4d5466; background: #1a1d27; border-color: #232735; }
QPushButton#primary { background: #1f7a4a; border-color: #2a9a5f; font-weight: 700; }
QPushButton#close { background: transparent; border: none; color: #6c7489; font-size: 14px; padding: 0 4px; }
"""


class PopupPanel(QWidget):
    start_clicked = Signal()
    pause_clicked = Signal()
    ready_clicked = Signal()
    switch_clicked = Signal()
    stop_clicked = Signal()

    def __init__(self, cfg: Config, clock=time.monotonic):
        super().__init__(None, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
                         | Qt.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setFocusPolicy(Qt.NoFocus)
        self.setWindowTitle("GameSwap")
        self.setStyleSheet(STYLE)
        self.cfg = cfg
        self._clock = clock
        self.pinned = False  # you opened it with the hotkey: stays until you close it
        self._auto_until = 0.0  # an alert keeps it up until then
        self._last_remaining: int | None = None
        self._last_state: State | None = None
        self._go_until = 0.0
        self._last_prompt = ""
        self._last_raise = 0.0

        self.panel = QFrame(objectName="panel")
        self.mini = QFrame(objectName="mini")
        mini_col = QVBoxLayout(self.mini)
        mini_col.setContentsMargins(10, 5, 10, 6)
        mini_col.setSpacing(0)
        self.mini_game = QLabel("", objectName="miniGame")
        self.mini_clock = QLabel("--:--", objectName="miniClock")
        self.mini_next = QLabel("", objectName="miniNext")
        self.mini_next.setWordWrap(True)
        mini_col.addWidget(self.mini_game)
        mini_col.addWidget(self.mini_clock)
        mini_col.addWidget(self.mini_next)
        self.compact = False
        self.mini.hide()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(self.panel)
        outer.addWidget(self.mini)
        col = QVBoxLayout(self.panel)
        col.setContentsMargins(16, 10, 16, 12)
        col.setSpacing(2)

        top = QHBoxLayout()
        top.addWidget(QLabel("GAMESWAP", objectName="brand"))
        top.addStretch(1)
        self.close_btn = QPushButton("✕", objectName="close")
        self.close_btn.setFocusPolicy(Qt.NoFocus)
        self.close_btn.clicked.connect(self.hide_now)
        top.addWidget(self.close_btn)
        col.addLayout(top)

        self.headline = QLabel("", objectName="headline")
        self.clock_label = QLabel("--:--", objectName="clock")
        self.clock_label.setAlignment(Qt.AlignCenter)
        self.detail = QLabel("", objectName="detail")
        self.detail.setWordWrap(True)
        col.addWidget(self.headline)
        col.addWidget(self.clock_label)
        col.addWidget(self.detail)

        row = QHBoxLayout()
        row.setSpacing(6)
        self.start_btn = self._button("Start", self.start_clicked, primary=True)
        self.pause_btn = self._button("Pause", self.pause_clicked)
        self.ready_btn = self._button("Start timer now", self.ready_clicked, primary=True)
        self.switch_btn = self._button("Switch now", self.switch_clicked)
        self.stop_btn = self._button("Stop", self.stop_clicked)
        for b in (self.start_btn, self.pause_btn, self.ready_btn, self.switch_btn, self.stop_btn):
            row.addWidget(b)
        col.addLayout(row)

        h = cfg.hotkeys
        self.hint = QLabel(f"{pretty(h.popup)} show/hide  ·  {pretty(h.start)} start  ·  {pretty(h.pause)} pause  ·  "
                           f"{pretty(h.ready)} start timer now", objectName="hint")
        self.hint.setWordWrap(True)
        col.addWidget(self.hint)
        self.setFixedWidth(400)

    def _button(self, text, signal, primary=False) -> QPushButton:
        b = QPushButton(text, objectName="primary" if primary else "")
        b.setFocusPolicy(Qt.NoFocus)  # clicking never takes focus from the game
        b.clicked.connect(signal.emit)
        return b

    # ---- showing / hiding ---------------------------------------------------

    def toggle(self) -> None:
        """The show/hide hotkey: opens the full panel, or closes it back to the small timer."""
        if self.isVisible() and self.pinned:
            self.hide_now()
        else:
            self.pinned = True
            self._set_compact(False)
            self._appear()

    def hide_now(self) -> None:
        self.pinned = False
        self._auto_until = 0.0
        self.hide()

    def _appear(self) -> None:
        if not self.cfg.popup.enabled:
            return
        if not self.isVisible():
            self.adjustSize()
            self._place()
            self.setWindowOpacity(self._target_opacity())
            self.show()

    def _target_opacity(self) -> float:
        return self.cfg.popup.timer_opacity if self.compact else 1.0

    def _place(self) -> None:
        screen = QGuiApplication.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        corner = self.cfg.popup.corner
        if corner == "top-left":
            x = area.left() + MARGIN
        elif corner == "top-center":
            x = area.center().x() - self.width() // 2
        else:
            x = area.right() - self.width() - MARGIN
        self.move(x, area.top() + MARGIN)

    # ---- every tick ---------------------------------------------------------------

    def update_from(self, s: Snapshot, testing: bool = False) -> None:
        now = self._clock()
        rem = s.remaining
        want_full = False

        if s.state == State.PLAYING and rem is not None and not s.paused:
            prev = self._last_remaining
            for a in self.cfg.popup.alert_seconds:
                if prev is not None and prev > a >= rem:
                    self._auto_until = now + self.cfg.popup.alert_show_seconds
            if rem <= self.cfg.countdown_seconds:
                want_full = True  # the big 10, 9, 8 ... countdown
        if s.state == State.ERROR:
            want_full = True  # something needs you
        if s.prompt and not self._last_prompt:
            self._auto_until = now + self.cfg.popup.alert_show_seconds  # SAVE NOW
        if s.state == State.PLAYING and self._last_state in SWITCH_STATES:
            self._go_until = now + 3.0  # "GO!" in the small timer for a moment
        if now < self._auto_until:
            want_full = True

        self._last_prompt = s.prompt
        self._last_remaining = rem if s.state == State.PLAYING else None
        self._last_state = s.state if s.state in ACTIVE_STATES or s.state == State.ERROR else None

        self._render(s, now)
        self._render_mini(s, now)
        if want_full or self.pinned:
            self._set_compact(False)
            self._appear()
        elif self.cfg.popup.always_show_timer:
            self._set_compact(True)  # the small, always-on corner timer
            self._appear()
        elif self.isVisible():
            self.hide()
        if self.isVisible() and now - self._last_raise > 2.0:
            self._last_raise = now
            winapi.keep_on_top(int(self.winId()))  # stay above games that grab the top spot

    def _set_compact(self, on: bool) -> None:
        """Switch between the small corner timer and the full panel."""
        if on == self.compact:
            return
        self.compact = on
        was_visible = self.isVisible()
        self.panel.setVisible(not on)
        self.mini.setVisible(on)
        self.setFixedWidth(228 if on else 400)
        # The small timer lets clicks pass through to the game; the full panel has buttons.
        self.setWindowFlag(Qt.WindowTransparentForInput, on)
        self.adjustSize()
        self._place()
        self.setWindowOpacity(self._target_opacity())
        if was_visible:
            self.show()  # changing window flags hides the window; show it again (without focus)

    def _render(self, s: Snapshot, now: float) -> None:
        rem = s.remaining
        level, big = "", False
        if s.state == State.PLAYING and rem is not None:
            if rem <= self.cfg.countdown_seconds:
                self.headline.setText(f"Switching to {s.next_name} in")
                self.clock_label.setText(str(rem))
                level, big = "final", True
            else:
                self.clock_label.setText(f"{rem // 60}:{rem % 60:02d}")
                alert = rem <= max(self.cfg.popup.alert_seconds, default=0)
                if now < self._go_until:
                    self.headline.setText(f"GO! {s.game_name}")
                    level = "go"
                elif alert:
                    self.headline.setText(_left(rem) + f" left in {s.game_name}")
                    level = "warning"
                else:
                    self.headline.setText(s.game_name)
            final = rem <= self.cfg.countdown_seconds
            self.detail.setText("PAUSED" if s.paused else (s.prompt or ("Get somewhere safe!" if final
                                                                          else f"Next: {s.next_name}")))
        elif s.state in (State.SAVING, State.EXITING, State.SWITCHING):
            target = s.game_name if s.state != State.SWITCHING else s.next_name
            self.headline.setText(f"Switching to {target}" if s.state == State.SWITCHING else f"Wrapping up {s.game_name}")
            self.clock_label.setText("⇄")
            self.detail.setText(s.prompt or s.message)
        elif s.state in (State.LAUNCHING, State.LOADING, State.VERIFYING_GAMEPLAY):
            self.headline.setText(f"Loading {s.game_name}")
            self.clock_label.setText("…")
            self.detail.setText(s.message)
        elif s.state == State.ERROR:
            self.headline.setText("Needs your attention")
            self.clock_label.setText("!")
            self.detail.setText(s.error)
            level = "final"
        else:
            self.headline.setText("Ready" if s.state == State.IDLE else "Stopped")
            self.clock_label.setText(f"{s.play_seconds // 60}:{s.play_seconds % 60:02d}")
            self.detail.setText(f"First up: {s.game_name}" if not s.busy else "Checking OBS and the games...")

        active = s.state in ACTIVE_STATES
        idle = s.state in (State.IDLE, State.STOPPED) and not s.busy
        self.start_btn.setVisible(idle or (active and s.paused))
        self.start_btn.setText("Resume" if active and s.paused else "Start")
        self.pause_btn.setVisible(active and not s.paused)
        self.ready_btn.setVisible(s.can_confirm_ready)
        self.switch_btn.setVisible(s.state == State.PLAYING and not s.paused)
        self.stop_btn.setVisible(active or s.state == State.ERROR)

        self._set_prop(self.panel, "level", level)
        self._set_prop(self.clock_label, "big", "true" if big else "false")


    def _render_mini(self, s: Snapshot, now: float) -> None:
        """The small corner timer: always shows where things are."""
        h = self.cfg.hotkeys
        rem = s.remaining
        test = "  ·  TEST" if s.test_run else ""
        level = ""
        if s.state == State.PLAYING and rem is not None:
            alert = rem <= max(self.cfg.popup.alert_seconds, default=0)
            game = s.game_name.upper() + (f"  ·  TURN {s.turn}" if s.turn else "") + test
            clock = f"{rem // 60}:{rem % 60:02d}"
            if s.paused:
                game += "  ·  PAUSED"
                nxt, level = f"Paused  ·  {pretty(h.pause)} to resume", "paused"
            elif s.prompt:
                nxt, level = "SAVE NOW!", "warning"
            elif now < self._go_until:
                nxt = f"GO!  ·  next: {s.next_name}"
            elif alert:
                nxt, level = f"{_left(rem)} left  ·  then {s.next_name}", "warning"
            else:
                nxt = f"Next: {s.next_name}"
        elif s.state in (State.LAUNCHING, State.LOADING, State.VERIFYING_GAMEPLAY):
            game, clock = f"{s.game_name.upper()}  ·  LOADING{test}", "…"
            nxt = (f"Playing? {pretty(h.ready)} starts the timer" if s.can_confirm_ready
                   else _short(s.message))
        elif s.state in (State.SAVING, State.EXITING, State.SWITCHING):
            game, clock = f"SWITCHING{test}", "⇄"
            nxt = "SAVE NOW!" if s.prompt else f"Up next: {s.next_name}"
            level = "warning" if s.prompt else ""
        elif s.state == State.ERROR:
            game, clock, nxt, level = "NEEDS YOU", "!", _short(s.error), "warning"
        else:
            game = "GAMESWAP  ·  " + ("STOPPED" if s.state == State.STOPPED else "READY")
            clock = f"{s.play_seconds // 60}:{s.play_seconds % 60:02d}"
            nxt = "Checking..." if s.busy else f"First: {s.game_name}  ·  {pretty(h.start)} to start"
        self.mini_game.setText(game)
        self.mini_clock.setText(clock)
        self.mini_next.setText(nxt)
        self._set_prop(self.mini_clock, "level", level)
        self._set_prop(self.mini_next, "level", "warning" if level == "warning" else "")
        self._set_prop(self.mini, "level", "warning" if level == "warning" else "")

    @staticmethod
    def _set_prop(widget, name, value) -> None:
        if widget.property(name) != value:
            widget.setProperty(name, value)
            widget.style().unpolish(widget)
            widget.style().polish(widget)


def _short(text: str, limit: int = 60) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def pretty(hotkey: str) -> str:
    """'ctrl+shift+F6' -> 'Ctrl+Shift+F6'."""
    return "+".join(p[:1].upper() + p[1:] for p in hotkey.split("+"))


def _left(seconds: int) -> str:
    if seconds >= 60 and seconds % 60 == 0:
        m = seconds // 60
        return f"{m} minute" + ("s" if m != 1 else "")
    if seconds > 60:
        return f"{seconds // 60}:{seconds % 60:02d}"
    return f"{seconds} seconds"
