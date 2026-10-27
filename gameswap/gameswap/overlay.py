"""Overlay for OBS: a tiny local web server plus an optional text file.

Add these as Browser Sources in OBS:
  http://127.0.0.1:8765/            corner countdown (put it in each game scene)
  http://127.0.0.1:8765/switching   full-screen loading transition (Switching scene)

Or point a Text source at overlay/timer.txt ("Read from file").
Only your own PC can reach the server (127.0.0.1).
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import APP_DIR

log = logging.getLogger("gameswap.overlay")

PAGES_DIR = Path(__file__).resolve().parent / "overlay_pages"
TEXT_FILE = APP_DIR / "overlay" / "timer.txt"

STATE_LABELS = {
    "IDLE": "Ready",
    "LAUNCHING": "Launching",
    "LOADING": "Loading",
    "VERIFYING_GAMEPLAY": "Loading",
    "PLAYING": "Playing",
    "SAVING": "Saving",
    "EXITING": "Closing",
    "SWITCHING": "Switching",
    "ERROR": "Paused",
    "STOPPED": "Stopped",
}


def overlay_state(snap) -> dict:
    """What the overlay pages need, as plain JSON-able values."""
    remaining = snap.remaining
    return {
        "state": snap.state.value,
        "label": "Paused" if snap.paused else STATE_LABELS[snap.state.value],
        "game": snap.game_name,
        "next": snap.next_name,
        "remaining": remaining,
        "clock": f"{remaining // 60}:{remaining % 60:02d}" if remaining is not None else "",
        "level": snap.warning_level,
        "paused": snap.paused,
        "unverified": snap.unverified,
        "message": snap.message,
        "turn": snap.turn,
    }


def overlay_text(state: dict) -> str:
    if state["state"] == "PLAYING":
        extra = " (PAUSED)" if state["paused"] else ""
        return f"{state['game']}  {state['clock']}{extra}"
    if state["state"] in ("IDLE", "STOPPED"):
        return ""
    return f"{state['label']}: {state['next'] if state['state'] == 'SWITCHING' else state['game']}"


class OverlayServer:
    def __init__(self, port: int, write_text_file: bool = True, text_file: Path = TEXT_FILE):
        self.port = port
        self.write_text_file = write_text_file
        self.text_file = text_file
        self._state: dict = {}
        self._json = b"{}"
        self._last_text: str | None = None
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def start(self) -> bool:
        handler = _make_handler(self)
        try:
            self._server = ThreadingHTTPServer(("127.0.0.1", self.port), handler)
        except OSError as e:
            log.error("Overlay server couldn't use port %d (%s). Pick another port in Settings.", self.port, e)
            return False
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, name="overlay", daemon=True).start()
        log.info("Overlay ready at %s and %sswitching", self.url, self.url)
        return True

    def close(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    def update(self, state: dict) -> None:
        with self._lock:
            self._state = state
            self._json = json.dumps(state).encode()
        if self.write_text_file:
            text = overlay_text(state)
            if text != self._last_text:
                self._last_text = text
                try:
                    self.text_file.parent.mkdir(parents=True, exist_ok=True)
                    self.text_file.write_text(text, encoding="utf-8")
                except OSError as e:
                    log.warning("Couldn't write %s: %s", self.text_file, e)

    def state_json(self) -> bytes:
        with self._lock:
            return self._json


def _make_handler(server: OverlayServer):
    pages = {"/": "timer.html", "/timer": "timer.html", "/switching": "switching.html"}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/state":
                self._send(200, "application/json", server.state_json())
            elif path in pages:
                self._send(200, "text/html; charset=utf-8", (PAGES_DIR / pages[path]).read_bytes())
            else:
                self._send(404, "text/plain", b"not found")

        def _send(self, code, ctype, body):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep OBS's polling out of the log
            pass

    return Handler
