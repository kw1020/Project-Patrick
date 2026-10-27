"""Test Load / Test Save buttons: run one game step by itself, outside the challenge.

Test Load: launch the game (if needed), open the configured save, and wait
           until gameplay is verified. The game is left running.
Test Save: run the save workflow on a game that is in verified gameplay,
           and report whether the save was confirmed. The game is not closed.
"""

from __future__ import annotations

import logging
import threading
import time

from .config import Config
from .drivers import GameDriver, StepResult

log = logging.getLogger("gameswap.test")


class TestRunner:
    __test__ = False  # not a pytest test class
    def __init__(self, cfg: Config, drivers: dict[str, GameDriver]):
        self.cfg = cfg
        self.drivers = drivers
        self._thread: threading.Thread | None = None
        self._abort = threading.Event()
        self.last_result: StepResult | None = None
        self.current = ""

    @property
    def busy(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def abort(self) -> None:
        self._abort.set()

    def test_load(self, key: str) -> bool:
        return self._start(key, "Test Load", self._load)

    def test_save(self, key: str) -> bool:
        return self._start(key, "Test Save", self._save)

    def _start(self, key, title, fn) -> bool:
        if self.busy:
            log.warning("A test is already running.")
            return False
        driver = self.drivers[key]
        others = [d.name for k, d in self.drivers.items() if k != key and d.is_running()]
        if others:
            log.error("%s refused: %s is running. Only one game may run at a time.", title, ", ".join(others))
            return False
        self._abort = threading.Event()
        self.current = f"{title}: {driver.name}"
        self.last_result = None
        self._thread = threading.Thread(target=self._wrap, args=(title, driver, fn), name="test", daemon=True)
        self._thread.start()
        return True

    def _wrap(self, title, driver, fn) -> None:
        log.info("%s started for %s.", title, driver.name)
        try:
            result = fn(driver)
        except Exception as e:
            log.exception("%s crashed", title)
            result = StepResult(False, f"crashed: {e}")
        self.last_result = result
        if result.ok:
            log.info("%s PASSED for %s: %s", title, driver.name, result.detail)
        else:
            log.error("%s FAILED for %s: %s", title, driver.name, result.detail)
        self.current = ""

    def _load(self, driver: GameDriver) -> StepResult:
        start = time.monotonic()
        if not driver.is_running():
            timer = threading.Timer(self.cfg.launch_timeout, self._abort.set)
            timer.start()
            try:
                r = driver.launch(self._abort)
            finally:
                timer.cancel()
            if not r.ok:
                if self._abort.is_set():
                    return StepResult(False, f"{driver.name} didn't start within the {self.cfg.launch_timeout} s "
                                             "launch timeout (or Emergency Stop was pressed)")
                return StepResult(False, f"launch: {r.detail}")
            log.info("Test Load: %s launched after %.1f s (%s).", driver.name, time.monotonic() - start, r.detail)
        else:
            driver.refresh()
        if not getattr(driver, "automates_load", True):
            return StepResult(True, f"launch and detection passed - {driver.describe()}. "
                                    f"Opening the save is automated in {driver.phase_for_load}.")
        loaded_at = time.monotonic()
        r = driver.load_save(self._abort)
        if not r.ok:
            return StepResult(False, f"load: {r.detail}")
        log.info("Test Load: save opened (%s). Waiting for verified gameplay...", r.detail)
        streak = 0
        while time.monotonic() - loaded_at < self.cfg.load_timeout:
            if self._abort.is_set():
                return StepResult(False, "aborted")
            check = driver.check_ready()
            streak = streak + 1 if check.ready else 0
            if streak >= self.cfg.ready_stable_checks:
                return StepResult(True, f"gameplay verified {time.monotonic() - start:.1f} s after start ({check.detail})")
            self._abort.wait(self.cfg.ready_poll_seconds)
        return StepResult(False, f"gameplay not verified within the {self.cfg.load_timeout} s load timeout")

    def _save(self, driver: GameDriver) -> StepResult:
        driver.refresh()
        if not driver.is_running():
            return StepResult(False, f"{driver.name} isn't running. Run Test Load first.")
        if getattr(driver, "save_needs_player", False):
            log.info("Test Save: save in %s now (%s). GameSwap will verify it on disk.",
                     driver.name, getattr(driver, "save_hint", "use the game's save"))
        else:
            check = driver.check_ready()
            if not check.ready:
                return StepResult(False, f"{driver.name} isn't in verified gameplay ({check.detail}).")
        limit = driver.cfg.save_wait_seconds or self.cfg.save_timeout
        timer = threading.Timer(limit, self._abort.set)
        timer.start()
        try:
            result = driver.save(self._abort)
        finally:
            timer.cancel()
        if not result.ok and self._abort.is_set():
            return StepResult(False, f"no save confirmed within {limit} s ({result.detail})")
        return result
