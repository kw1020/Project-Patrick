"""The GameSwap state machine.

    IDLE -> LAUNCHING -> LOADING -> VERIFYING_GAMEPLAY -> PLAYING
         -> SAVING -> EXITING -> SWITCHING -> LAUNCHING (next game) -> ...

Anything that goes wrong lands in ERROR, which waits for you (Retry or
Continue). STOPPED is the end of a run.

tick() is called ~10 times a second from the UI thread and never blocks:
slow game steps run on worker threads and tick() just checks if they are
done. Every timer is driven by time.monotonic(), and time spent paused is
never counted.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Protocol

from .config import Config
from .drivers import GameDriver, ReadyCheck, StepResult

log = logging.getLogger("gameswap")


class State(str, Enum):
    IDLE = "IDLE"
    LAUNCHING = "LAUNCHING"
    LOADING = "LOADING"
    VERIFYING_GAMEPLAY = "VERIFYING_GAMEPLAY"
    PLAYING = "PLAYING"
    SAVING = "SAVING"
    EXITING = "EXITING"
    SWITCHING = "SWITCHING"
    ERROR = "ERROR"
    STOPPED = "STOPPED"


ACTIVE_STATES = {
    State.LAUNCHING, State.LOADING, State.VERIFYING_GAMEPLAY, State.PLAYING,
    State.SAVING, State.EXITING, State.SWITCHING,
}
# States where the game has started but isn't in verified gameplay yet.
LOADING_STATES = {State.LAUNCHING, State.LOADING, State.VERIFYING_GAMEPLAY}


class SceneSwitcher(Protocol):
    def set_scene(self, name: str) -> None:
        """Ask OBS to show a scene. Must return immediately."""

    def preflight(self, scenes: list[str]) -> list[str]:
        """Blocking check before Start: connected, scenes exist, recording. Returns problems."""


class NoObs:
    def set_scene(self, name: str) -> None:
        pass

    def preflight(self, scenes: list[str]) -> list[str]:
        return []


@dataclass
class Snapshot:
    state: State
    paused: bool
    game_key: str
    game_name: str
    next_name: str
    remaining: int | None  # whole seconds of play left; None outside PLAYING
    play_seconds: int
    warning_level: str  # "" | "warning" | "final"
    message: str
    error: str
    unverified: bool  # PLAYING on the fallback cycle without verified gameplay
    turn: int
    continue_label: str  # text for the Continue button in ERROR, "" if not allowed
    busy: bool  # a Start check is running
    prompt: str = ""  # e.g. "SAVE NOW: sleep in your bed..." for games you save yourself
    test_run: bool = False  # a Test Start run (OBS left alone)
    can_confirm_ready: bool = False  # the Ready button applies right now


class Machine:
    def __init__(
        self,
        cfg: Config,
        drivers: dict[str, GameDriver],
        obs: SceneSwitcher | None = None,
        clock: Callable[[], float] = time.monotonic,
        executor: Executor | None = None,
    ):
        self.cfg = cfg
        self.drivers = drivers
        self.obs = obs or NoObs()
        self.test_run = False  # a Test Start: OBS is left alone for the whole run
        self.start_problems: list[str] = []  # why the last Start was refused (shown in a pop-up)
        self._clock = clock
        self._executor = executor or ThreadPoolExecutor(max_workers=2, thread_name_prefix="game-step")
        self.on_sound: Callable[[str], None] = lambda kind: None
        # Notified about turns, errors and stops (the session log and YouTube chapters listen).
        self.on_event: Callable[[str, dict], None] = lambda kind, info: None
        self.resume_point: tuple[int, int] | None = None  # (next game index, turns played) to continue from

        self.state = State.IDLE
        self.paused = False
        self.index = 0
        self.turn = 0
        self.message = "Press Start when OBS is open."
        self.error = ""
        self.unverified = False
        self.prompt = ""
        self._prompted = False

        self._job: Future | None = None
        self._preflight: Future | None = None
        self._step_abort = threading.Event()
        self._last_tick = clock()
        self._state_time = 0.0  # time in the current state, pauses excluded
        self._load_time = 0.0  # LOADING + VERIFYING time, pauses excluded
        self._cycle_time = 0.0  # since this game's LAUNCHING began, pauses excluded
        self._remaining = 0.0
        self._warned: set[int] = set()
        self._ready_streak = 0
        self._next_poll = 0.0
        self._last_health = 0.0
        self._stop_requested = False
        self._launch_retries_left = cfg.launch_retries
        self._retry_at = 0.0
        self._played = 0.0  # seconds actually played this turn
        self._error_from: State | None = None
        self._last_tick_sound = None

    # ---- who's playing -----------------------------------------------------

    @property
    def game_key(self) -> str:
        return self.cfg.rotation[self.index % len(self.cfg.rotation)]

    @property
    def driver(self) -> GameDriver:
        return self.drivers[self.game_key]

    @property
    def next_driver(self) -> GameDriver:
        return self.drivers[self.cfg.rotation[(self.index + 1) % len(self.cfg.rotation)]]

    # ---- buttons -------------------------------------------------------------

    def start(self, test_run: bool = False) -> None:
        """Start the challenge. test_run=True: a practice run that ignores OBS
        completely (no connection, no scene changes, no recording)."""
        if self.paused and self.state in ACTIVE_STATES:
            self.resume()
            return
        if self.state not in (State.IDLE, State.STOPPED) or self._preflight:
            return
        self.test_run = test_run
        problems = self.cfg.validate()
        if problems:
            for p in problems:
                log.error("Can't start: %s", p)
            self.message = "Fix the settings shown in the log, then press Start."
            self.start_problems = list(problems)
            return
        self.message = "Checking the games..." if test_run else "Checking OBS and the games..."
        if test_run:
            log.info("TEST START pressed - a practice run without OBS. Running checks.")
        else:
            log.info("Start pressed - running checks.")
        self._preflight = self._executor.submit(self._run_preflight)

    def pause(self) -> None:
        if self.state in ACTIVE_STATES and not self.paused:
            self.paused = True
            log.info("Paused during %s. The timer is frozen.", self.state.value)

    def resume(self) -> None:
        if self.paused:
            self.paused = False
            self._last_tick = self._clock()
            log.info("Resumed.")

    def toggle_pause(self) -> None:
        self.resume() if self.paused else self.pause()

    def confirm_ready(self) -> None:
        """You say you're in the game (for games whose gameplay can't be detected)."""
        d = self.driver
        if self.state != State.VERIFYING_GAMEPLAY or self.paused or not getattr(d, "manual_ready", False):
            return
        d.refresh()
        if not d.is_running():
            log.error("Ready ignored: %s isn't running.", d.name)
            return
        hook = getattr(d, "on_manual_ready", None)
        if hook:
            hook()
        log.info("You confirmed %s is in gameplay.", d.name)
        self._start_playing(self.cfg.play_seconds, verified_by="you")

    def switch_now(self) -> None:
        if self.state == State.PLAYING and not self.paused:
            log.info("Switch Now pressed - ending %s's turn early.", self.driver.name)
            self._remaining = 0.0

    def stop(self) -> None:
        """Stop safely: save and quit a game that's in gameplay, then stop."""
        if self.state in (State.IDLE, State.STOPPED):
            return
        self.paused = False
        if self.state == State.PLAYING:
            log.info("Stop pressed - saving and closing %s first.", self.driver.name)
            self._stop_requested = True
            self._end_turn()
            self._enter(State.SAVING)
        elif self.state in (State.SAVING, State.EXITING):
            log.info("Stop pressed - finishing the save/exit first.")
            self._stop_requested = True
        elif self.state in LOADING_STATES:
            self._cancel_step()
            self._finish(f"Stopped while {self.driver.name} was loading. It was left open "
                         "because it never reached gameplay, so there was nothing to save.")
        else:
            self._cancel_step()
            self._finish("Stopped.")

    def emergency_stop(self) -> None:
        """Stop everything at once. No more inputs; games and OBS are left as they are."""
        self._cancel_step()
        if self._preflight:
            self._preflight = None
        self.paused = False
        self._enter(State.STOPPED)
        self.message = "EMERGENCY STOP - nothing else will be sent to the games."
        log.warning("EMERGENCY STOP. Automation halted; games and OBS left exactly as they are.")
        self._event("stopped", {"turns": self.turn, "how": "emergency"})

    def retry(self) -> None:
        if self.state != State.ERROR or self._error_from is None:
            return
        target = self._error_from
        if target == State.PLAYING:  # the game closed by itself mid-turn
            target = State.LAUNCHING
        log.info("Retry: going back to %s.", target.value)
        self.error = ""
        self._load_time = 0.0  # a retried load gets a fresh timeout
        self._enter(target, advance=False)

    def continue_manual(self) -> None:
        """You fixed the problem yourself; check that's true, then move on."""
        if self.state != State.ERROR or self._error_from is None:
            return
        self.driver.refresh()  # check what's really running, not a second-old answer
        frm = self._error_from
        if frm in LOADING_STATES:
            if not self.driver.is_running():
                log.error("Can't continue: %s isn't running.", self.driver.name)
                return
            log.info("Continue: you confirmed %s is in gameplay. Starting its timer.", self.driver.name)
            self.error = ""
            self._start_playing(self.cfg.play_seconds, verified_by="you")
        elif frm in (State.SAVING, State.EXITING, State.PLAYING):
            if self.driver.is_running():
                log.error("Can't continue: %s is still running. Save and quit it yourself first.",
                          self.driver.name)
                return
            log.info("Continue: %s is closed. Moving on.", self.driver.name)
            self.error = ""
            self._after_exit()
        elif frm == State.SWITCHING:
            self.error = ""
            self._enter(State.SWITCHING, advance=False)

    def continue_label(self) -> str:
        if self.state != State.ERROR or self._error_from is None:
            return ""
        if self._error_from in LOADING_STATES:
            return f"{self.driver.name} is in gameplay - start timer"
        if self._error_from in (State.SAVING, State.EXITING, State.PLAYING):
            return f"I saved and closed {self.driver.name} - continue"
        return "Other game is closed - continue"

    # ---- the tick ------------------------------------------------------------

    def tick(self) -> None:
        now = self._clock()
        dt, self._last_tick = max(0.0, now - self._last_tick), now

        if self._preflight and self._preflight.done():
            self._finish_preflight()

        if self.state not in ACTIVE_STATES or self.paused:
            return

        self._state_time += dt
        self._cycle_time += dt
        if self.state in (State.LOADING, State.VERIFYING_GAMEPLAY):
            self._load_time += dt

        if self.driver.status and self.state in (State.LAUNCHING, State.LOADING, State.SAVING, State.EXITING):
            self.message = self.driver.status

        handler = {
            State.LAUNCHING: self._tick_launching,
            State.LOADING: self._tick_loading,
            State.VERIFYING_GAMEPLAY: self._tick_verifying,
            State.PLAYING: self._tick_playing,
            State.SAVING: self._tick_saving,
            State.EXITING: self._tick_exiting,
            State.SWITCHING: self._tick_switching,
        }[self.state]
        handler(dt)

    def _tick_launching(self, dt):
        if self._retry_at:
            if self._state_time >= self._retry_at:
                self._retry_at = 0.0
                log.info("Retrying the launch of %s.", self.driver.name)
                self._enter(State.LAUNCHING, advance=False)
            return
        result = self._job_result()
        if result is None:
            if self._state_time > self.cfg.launch_timeout:
                self._launch_failed(f"{self.driver.name} didn't start within {self.cfg.launch_timeout} s.")
            return
        if result.ok:
            log.info("%s launched: %s", self.driver.name, result.detail)
            self._enter(State.LOADING)
        else:
            self._launch_failed(f"Launching {self.driver.name} failed: {result.detail}")

    def _launch_failed(self, text: str) -> None:
        """One automatic retry (by default), then ask you."""
        if self._launch_retries_left > 0:
            self._launch_retries_left -= 1
            delay = self.cfg.launch_retry_delay
            self._cancel_step()
            self._retry_at = self._state_time + delay
            self.message = f"Launch problem - trying again in {delay} s"
            log.warning("%s Trying again by itself in %d s.", text, delay)
            self._event("retry", {"step": "launch", "reason": text})
            return
        self._fail(text)

    def _tick_loading(self, dt):
        result = self._job_result()
        if result is None:
            self._check_load_timeout()
            return
        if result.ok:
            log.info("%s: %s", self.driver.name, result.detail)
            self._enter(State.VERIFYING_GAMEPLAY)
        else:
            self._fail(f"Loading the save in {self.driver.name} failed: {result.detail}")

    def _tick_verifying(self, dt):
        if self._job is not None:
            check = self._job_result()
            if check is not None:
                if check.ready:
                    self._ready_streak += 1
                    if self._ready_streak >= self.cfg.ready_stable_checks:
                        log.info("%s gameplay verified (%s, %d checks in a row).",
                                 self.driver.name, check.detail, self._ready_streak)
                        self._start_playing(self.cfg.play_seconds, verified_by="the game")
                        return
                else:
                    if self._ready_streak:
                        log.info("%s readiness dropped (%s); starting the count again.",
                                 self.driver.name, check.detail)
                    self._ready_streak = 0
                    self.message = f"Waiting for {self.driver.name} gameplay ({check.detail})"
        if self._check_load_timeout():
            return
        if self._job is None and self._state_time >= self._next_poll:
            self._next_poll = self._state_time + self.cfg.ready_poll_seconds
            self._job = self._executor.submit(self._safe_ready_check, self.driver)

    def _check_load_timeout(self) -> bool:
        if self._load_time <= self.cfg.load_timeout:
            return False
        if self.cfg.fallback_cycle_enabled:
            left = self.cfg.fallback_cycle_seconds - self._cycle_time
            log.warning(
                "%s gameplay couldn't be verified within %d s. Fallback cycle is on: playing "
                "until %d min after launch (%d s left). Saving will still be verified.",
                self.driver.name, self.cfg.load_timeout, self.cfg.fallback_cycle_seconds // 60, max(0, left),
            )
            self._cancel_step()
            self._start_playing(max(0.0, left), verified_by=None)
        else:
            self._fail(
                f"Couldn't verify that {self.driver.name} reached gameplay within "
                f"{self.cfg.load_timeout} s. Check the game. If it's really in gameplay, press Continue."
            )
        return True

    def _tick_playing(self, dt):
        self._played += dt
        self._remaining = max(0.0, self._remaining - dt)
        secs = _whole_seconds(self._remaining)

        for w in sorted(self.cfg.warning_seconds, reverse=True):
            if w not in self._warned and self._remaining <= w and self._remaining > 0:
                self._warned.add(w)
                final = w == min(self.cfg.warning_seconds)
                log.info("%d-second warning for %s.", w, self.driver.name)
                self._sound("final" if final else "warning")
        prompt_at = self.driver.cfg.save_prompt_seconds
        if prompt_at and not self._prompted and 0 < self._remaining <= prompt_at:
            self._prompted = True
            hint = getattr(self.driver, "save_hint", "save your game")
            self.prompt = f"SAVE NOW: {hint}"
            log.info("Save prompt for %s (%d s left): %s.", self.driver.name, secs, hint)
            self._sound("save")
        if 0 < secs <= self.cfg.countdown_seconds and secs != self._last_tick_sound:
            self._last_tick_sound = secs
            if secs not in self.cfg.warning_seconds:  # that second already has its warning sound
                self._sound("tick")

        if self._state_time - self._last_health >= 1.0:
            self._last_health = self._state_time
            if not self.driver.is_running():
                self._fail(f"{self.driver.name} closed or crashed during its turn. Progress since its "
                           "last save may be lost. Retry relaunches it; Continue moves to the next game.")
                return

        if self._remaining <= 0:
            log.info("%s's time is up.", self.driver.name)
            if self.cfg.stop_after_turns and self.turn >= self.cfg.stop_after_turns and not self._stop_requested:
                log.info("That was turn %d of %d: GameSwap will stop after saving.", self.turn, self.cfg.stop_after_turns)
                self._stop_requested = True
            self._end_turn()
            self._enter(State.SAVING)

    def _tick_saving(self, dt):
        result = self._job_result()
        if result is None:
            limit = self.driver.cfg.save_wait_seconds or self.cfg.save_timeout
            if self._state_time > limit:
                self._fail(f"Saving {self.driver.name} wasn't confirmed within {limit} s. "
                           "Check the game - it was NOT closed. Save it, then press Retry.")
            return
        if result.ok:
            log.info("%s saved: %s", self.driver.name, result.detail)
            self._enter(State.EXITING)
        else:
            self._fail(f"Couldn't confirm {self.driver.name} saved: {result.detail}. "
                       "The game was NOT closed. Save and quit it yourself, then press Continue, or press Retry.")

    def _tick_exiting(self, dt):
        result = self._job_result()
        if result is None:
            if self._state_time > self.cfg.exit_timeout:
                self._fail(f"{self.driver.name} didn't close within {self.cfg.exit_timeout} s. "
                           "GameSwap never force-closes games. Close it yourself, then press Continue.")
            return
        if not result.ok:
            self._fail(f"{self.driver.name} didn't exit normally: {result.detail}")
            return
        if self.driver.is_running():
            self._fail(f"{self.driver.name} reported it closed, but its process is still running.")
            return
        log.info("%s closed: %s", self.driver.name, result.detail)
        self._after_exit()

    def _tick_switching(self, dt):
        if self._state_time < self.cfg.switch_delay_seconds:
            return
        others = [d.name for d in self.drivers.values() if d.is_running()]
        if others:
            self._fail(f"{', '.join(others)} is still running. Only one game may run at a time. "
                       "Close it, then press Continue.")
            return
        self._enter(State.LAUNCHING)

    # ---- transitions ---------------------------------------------------------

    def _enter(self, state: State, advance: bool = True) -> None:
        prev = self.state
        self._cancel_step()
        self._retry_at = 0.0
        self.driver.status = ""
        self.state = state
        self._state_time = 0.0
        self._last_health = 0.0
        driver = self.driver

        if state == State.LAUNCHING:
            self._cycle_time = 0.0
            self._load_time = 0.0
            self.unverified = False
            self.message = f"Launching {driver.name}..."
            self._scene(self.cfg.obs.switching_scene)
            self._job = self._executor.submit(self._safe_step, driver.launch, self._step_abort)
        elif state == State.LOADING:
            self._load_time = 0.0
            self.message = f"Loading {driver.name} save..."
            self._job = self._executor.submit(self._safe_step, driver.load_save, self._step_abort)
        elif state == State.VERIFYING_GAMEPLAY:
            self._ready_streak = 0
            self._next_poll = 0.0
            self.message = f"Waiting for {driver.name} gameplay..."
        elif state == State.SAVING:
            self.message = f"Saving {driver.name}..."
            if getattr(driver, "save_needs_player", False):
                self._sound("save")  # you save in-game, so the game stays on screen
            else:
                self._scene(self.cfg.obs.switching_scene)
            self._job = self._executor.submit(self._safe_step, driver.save, self._step_abort)
        elif state == State.EXITING:
            self.message = f"Closing {driver.name}..."
            self._scene(self.cfg.obs.switching_scene)
            self._job = self._executor.submit(self._safe_step, driver.exit, self._step_abort)
        elif state == State.SWITCHING:
            self._launch_retries_left = self.cfg.launch_retries
            if advance:
                self.index = (self.index + 1) % len(self.cfg.rotation)
            self.message = f"Up next: {self.driver.name}"
            log.info("Switching to %s.", self.driver.name)
        elif state == State.STOPPED:
            self._stop_requested = False
        if prev != state:
            log.debug("State %s -> %s", prev.value, state.value)

    def _start_playing(self, seconds: float, verified_by: str | None) -> None:
        self._enter(State.PLAYING)
        self._remaining = float(seconds)
        self._warned = {w for w in self.cfg.warning_seconds if w >= seconds}
        self._prompted = False
        self.prompt = ""
        self._last_tick_sound = None
        self.unverified = verified_by is None
        self.turn += 1
        self._played = 0.0
        self.message = f"Playing {self.driver.name}"
        self._scene(self.driver.obs_scene)
        self._sound("go")
        log.info("Turn %d: %s - %s on the clock%s.", self.turn, self.driver.name,
                 _mmss(seconds), "" if verified_by else " (FALLBACK, gameplay not verified)")
        self._event("turn_start", {"turn": self.turn, "game": self.driver.name, "key": self.game_key,
                                   "seconds": seconds, "verified_by": verified_by or "fallback"})

    def _end_turn(self) -> None:
        self._event("turn_end", {"turn": self.turn, "game": self.driver.name, "key": self.game_key,
                                 "played": round(self._played, 1)})

    def _after_exit(self) -> None:
        self._event("game_closed", {"turn": self.turn, "game": self.driver.name, "key": self.game_key})
        if self._stop_requested:
            self._finish(f"Stopped. {self.driver.name} was saved and closed normally.")
        else:
            self._enter(State.SWITCHING)

    def _finish(self, text: str) -> None:
        self._enter(State.STOPPED)
        self.message = text
        log.info(text)
        self._event("stopped", {"turns": self.turn, "how": "stop"})

    def _fail(self, text: str) -> None:
        self._error_from = self.state
        self._cancel_step()
        self.state = State.ERROR
        self.error = text
        self.message = "Needs your attention"
        self.paused = False
        log.error("[%s] %s", self._error_from.value, text)
        self._sound("error")
        self._event("error", {"step": self._error_from.value, "game": self.driver.name, "text": text})

    # ---- Start checks --------------------------------------------------------

    def _run_preflight(self) -> list[str]:
        problems = []
        for key in self.cfg.rotation:
            d = self.drivers[key]
            problems += d.preflight()
            d.refresh()
            if d.is_running():
                problems.append(f"{d.name} is already running. Save and close it, then press Start.")
        scenes = [self.cfg.obs.switching_scene] + [self.drivers[k].obs_scene for k in self.cfg.rotation]
        if not self.test_run:
            problems += self.obs.preflight(list(dict.fromkeys(scenes)))
        return problems

    def _finish_preflight(self) -> None:
        future, self._preflight = self._preflight, None
        try:
            problems = future.result()
        except Exception as e:  # a bug in a check shouldn't crash the app
            log.exception("Start checks crashed")
            problems = [f"Start checks crashed: {e}"]
        if problems:
            for p in problems:
                log.error("Can't start: %s", p)
            self.message = "Can't start yet - see the log."
            self.start_problems = list(problems)
            self._sound("error")
            return
        self.start_problems = []
        self.index, self.turn = self.resume_point or (0, 0)
        self.index %= len(self.cfg.rotation)
        self.resume_point = None
        self.error = ""
        self._stop_requested = False
        self._launch_retries_left = self.cfg.launch_retries
        self._retry_at = 0.0
        log.info("Checks passed. Rotation: %s.", " -> ".join(self.drivers[k].name for k in self.cfg.rotation))
        if self.turn:
            log.info("Continuing the previous session: %d turns played, next up %s.", self.turn, self.driver.name)
        self._event("session_start", {"turn": self.turn, "next": self.driver.name})
        self._enter(State.LAUNCHING)

    # ---- worker helpers ------------------------------------------------------

    def _cancel_step(self) -> None:
        self._step_abort.set()
        self._step_abort = threading.Event()
        self._job = None

    def _job_result(self):
        if self._job is None or not self._job.done():
            return None
        job, self._job = self._job, None
        return job.result()

    @staticmethod
    def _safe_step(fn, abort) -> StepResult:
        try:
            result = fn(abort)
            return result if isinstance(result, StepResult) else StepResult(False, "driver returned nothing")
        except Exception as e:
            log.exception("Game step crashed")
            return StepResult(False, f"crashed: {e}")

    @staticmethod
    def _safe_ready_check(driver) -> ReadyCheck:
        try:
            return driver.check_ready()
        except Exception as e:
            log.exception("Ready check crashed")
            return ReadyCheck(False, f"check crashed: {e}")

    def _scene(self, name: str) -> None:
        if not self.test_run:
            self.obs.set_scene(name)

    def _event(self, kind: str, info: dict) -> None:
        try:
            self.on_event(kind, info)
        except Exception:
            log.exception("Session event handler failed")

    def _sound(self, kind: str) -> None:
        if self.cfg.sounds:
            try:
                self.on_sound(kind)
            except Exception:
                log.exception("Sound failed")

    # ---- for the UI and overlay ----------------------------------------------

    def snapshot(self) -> Snapshot:
        remaining = _whole_seconds(self._remaining) if self.state == State.PLAYING else None
        level = ""
        if remaining is not None and self.cfg.warning_seconds:
            if remaining <= min(self.cfg.warning_seconds):
                level = "final"
            elif remaining <= max(self.cfg.warning_seconds):
                level = "warning"
        nxt = self.next_driver.name if self.state != State.SWITCHING else self.driver.name
        return Snapshot(
            state=self.state,
            paused=self.paused,
            game_key=self.game_key,
            game_name=self.driver.name,
            next_name=nxt,
            remaining=remaining,
            play_seconds=self.cfg.play_seconds,
            warning_level=level,
            message=self.message,
            error=self.error,
            unverified=self.unverified,
            turn=self.turn,
            continue_label=self.continue_label(),
            busy=self._preflight is not None,
            prompt=self.prompt if self.state in (State.PLAYING, State.SAVING) else "",
            test_run=self.test_run and self.state != State.IDLE,
            can_confirm_ready=(self.state == State.VERIFYING_GAMEPLAY and not self.paused
                               and bool(getattr(self.driver, "manual_ready", False))),
        )

    def shutdown(self) -> None:
        self._cancel_step()
        self._executor.shutdown(wait=False, cancel_futures=True)


def _whole_seconds(seconds: float) -> int:
    """Seconds left, rounded up like a countdown (tiny float drift ignored)."""
    return max(0, math.ceil(seconds - 1e-6))


def _mmss(seconds: float) -> str:
    s = _whole_seconds(seconds)
    return f"{s // 60}:{s % 60:02d}"
