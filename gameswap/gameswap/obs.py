"""OBS Studio control through OBS WebSocket (built into OBS 28 and newer).

Scene changes are queued and sent from a background thread, so the app
never freezes waiting for OBS. GameSwap never stops a recording; it only
starts one (if you allow it) and warns you if recording stops.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass

from .config import ObsConfig

log = logging.getLogger("gameswap.obs")

# obsws-python logs the OBS password when it connects. Keep it out of our logs.
logging.getLogger("obsws_python").setLevel(logging.CRITICAL)

try:
    import obsws_python
except ImportError:  # the UI explains how to install it
    obsws_python = None


@dataclass
class ObsStatus:
    connected: bool = False
    recording: bool = False
    scene: str = ""
    error: str = ""


class ObsController:
    POLL_SECONDS = 2.0
    RECONNECT_SECONDS = 5.0

    def __init__(self, cfg: ObsConfig, client_factory=None):
        self.cfg = cfg
        self._factory = client_factory or self._default_factory
        self._client = None
        self._lock = threading.RLock()
        self._queue: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_attempt = 0.0
        self._expect_recording = False
        self.status = ObsStatus()

    # ---- lifecycle -------------------------------------------------------

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="obs", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._queue.put(None)
        if self._thread:
            self._thread.join(timeout=3)
        with self._lock:
            self._disconnect()

    # ---- SceneSwitcher interface ----------------------------------------

    def set_scene(self, name: str) -> None:
        self._queue.put(("scene", name))

    def preflight(self, scenes: list[str]) -> list[str]:
        """Blocking. Connect, check the scenes exist, and make sure we're recording."""
        with self._lock:
            client = self._connect(force=True)
            if client is None:
                return [f"Can't connect to OBS: {self.status.error}"]
            try:
                existing = [s["sceneName"] for s in client.get_scene_list().scenes]
            except Exception as e:
                self._lost(e)
                return [f"OBS didn't return its scene list: {e}"]
            problems = [
                f"OBS has no scene called '{s}'. Create it (README, OBS setup) or fix the name in Settings."
                for s in scenes if s not in existing
            ]
            if problems:
                return problems
            try:
                recording = client.get_record_status().output_active
                if not recording and self.cfg.start_recording_on_start:
                    client.start_record()
                    log.info("Asked OBS to start recording.")
                    for _ in range(20):
                        time.sleep(0.25)
                        if client.get_record_status().output_active:
                            recording = True
                            break
                if not recording:
                    if self.cfg.start_recording_on_start:
                        return ["OBS didn't start recording. Check OBS for an error (disk space, encoder)."]
                    return ["OBS isn't recording. Press Start Recording in OBS, or turn on "
                            "'Start recording when I press Start' in Settings."]
            except Exception as e:
                self._lost(e)
                return [f"Couldn't check OBS recording: {e}"]
            self._expect_recording = True
            self.status.recording = True
            return []

    # ---- background thread -------------------------------------------------

    def _run(self) -> None:
        next_poll = 0.0
        while not self._stop.is_set():
            timeout = max(0.0, next_poll - time.monotonic())
            try:
                item = self._queue.get(timeout=timeout)
            except queue.Empty:
                item = "poll"
            if item is None:
                return
            if item == "poll":
                self._poll()
                next_poll = time.monotonic() + self.POLL_SECONDS
            else:
                _, name = item
                # Only the newest scene request matters if several piled up.
                while True:
                    try:
                        newer = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if newer is None:
                        return
                    name = newer[1]
                self._switch(name)

    def _switch(self, name: str) -> None:
        with self._lock:
            for attempt in (1, 2):
                client = self._connect(force=attempt == 2)
                if client is None:
                    continue
                try:
                    client.set_current_program_scene(name)
                    self.status.scene = name
                    log.info("OBS scene -> %s", name)
                    return
                except Exception as e:
                    self._lost(e)
            log.error("Couldn't switch OBS to scene '%s': %s", name, self.status.error)

    def _poll(self) -> None:
        with self._lock:
            client = self._connect()
            if client is None:
                return
            try:
                recording = client.get_record_status().output_active
                resp = client.get_current_program_scene()
                scene = getattr(resp, "scene_name", None) or getattr(resp, "current_program_scene_name", "")
            except Exception as e:
                self._lost(e)
                return
            if self._expect_recording and self.status.recording and not recording:
                log.error("OBS RECORDING STOPPED! GameSwap didn't stop it. Restart recording in OBS.")
            if self._expect_recording and recording and not self.status.recording:
                log.info("OBS is recording again.")
            self.status.recording = recording
            self.status.scene = scene

    # ---- connection --------------------------------------------------------

    def _default_factory(self):
        if obsws_python is None:
            raise RuntimeError("the obsws-python package isn't installed - run install.bat again")
        return obsws_python.ReqClient(
            host=self.cfg.host, port=int(self.cfg.port), password=self.cfg.password, timeout=3
        )

    def _connect(self, force: bool = False):
        if self._client is not None:
            return self._client
        now = time.monotonic()
        if not force and now - self._last_attempt < self.RECONNECT_SECONDS:
            return None
        self._last_attempt = now
        try:
            self._client = self._factory()
        except Exception as e:
            self.status.connected = False
            self.status.error = _explain(e)
            return None
        was = self.status.connected
        self.status.connected = True
        self.status.error = ""
        if not was:
            log.info("Connected to OBS at %s:%s.", self.cfg.host, self.cfg.port)
        return self._client

    def _lost(self, error: Exception) -> None:
        if self.status.connected:
            log.warning("Lost connection to OBS: %s", _explain(error))
        self.status.connected = False
        self.status.error = _explain(error)
        self._disconnect()

    def _disconnect(self) -> None:
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
        self._client = None


def _explain(e: Exception) -> str:
    text = str(e) or type(e).__name__
    lower = text.lower()
    if isinstance(e, ConnectionRefusedError) or "refused" in lower or "10061" in lower:
        return ("OBS isn't answering. Is OBS open, and is Tools > WebSocket Server Settings > "
                "Enable WebSocket server ticked?")
    if "auth" in lower or "4009" in lower or "identify" in lower:
        return "OBS rejected the password. Copy it from OBS (Show Connect Info) into Settings."
    return text
