"""GameSwap settings, stored in config.json next to the app."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import get_type_hints

# Where config.json, logs and backups live: next to GameSwap.exe when packaged,
# otherwise the project folder.
APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent
CONFIG_PATH = APP_DIR / "config.json"
LOG_DIR = APP_DIR / "logs"

SIM_FAIL_STEPS = ("", "launch", "load", "ready", "save", "exit")
POPUP_CORNERS = ("top-right", "top-left", "top-center")
DRIVERS = {"minecraft": ("minecraft", "simulated"), "schedule1": ("schedule1", "simulated")}


@dataclass
class SimulationConfig:
    """Fake-game timings, used until the real game drivers exist (Phases 2-3)."""

    launch_seconds: float = 3.0
    load_seconds: float = 4.0
    ready_after_seconds: float = 3.0
    save_seconds: float = 2.0
    exit_seconds: float = 2.0
    # Make one step fail on purpose to test the error handling.
    fail_step: str = ""


@dataclass
class GameConfig:
    name: str = "Game"
    obs_scene: str = "Game"
    # "simulated" (pretend game, for testing) or the real driver: "minecraft" / "schedule1".
    driver: str = "simulated"
    # Minecraft Launcher .exe, or steam.exe for Schedule I. Blank = find it automatically.
    launch_path: str = ""
    # .minecraft folder, or Schedule I's install folder. Blank = find it automatically.
    game_folder: str = ""
    steam_app_id: str = ""
    # Minecraft world (folder or shown name) / Schedule I save to load.
    save_name: str = ""
    # Minecraft: press Quick Play / PLAY in the launcher for you.
    auto_click_play: bool = True
    # After the game says you've joined, wait this long for terrain before the timer starts.
    ready_settle_seconds: float = 3.0
    # Zip the world/save before every Start, keeping this many backups.
    backup_before_start: bool = True
    backups_keep: int = 5
    # Schedule I: where its save slots are. Blank = AppData\LocalLow\TVGS\Schedule I\Saves.
    save_folder: str = ""
    # Show "SAVE NOW" this many seconds before the turn ends (0 = never; for games you save yourself).
    save_prompt_seconds: int = 0
    # A save this recent (or newer) counts as the end-of-turn save.
    save_max_age_seconds: int = 90
    # How long the save step may wait (0 = the general Save timeout).
    save_wait_seconds: int = 0
    # Schedule I: a Player.log line (regular expression) that means "in the game".
    # Blank = you press Ready.
    ready_log_pattern: str = ""
    simulation: SimulationConfig = field(default_factory=SimulationConfig)


@dataclass
class ObsConfig:
    enabled: bool = True
    host: str = "localhost"
    port: int = 4455
    password: str = ""
    switching_scene: str = "Switching"
    start_recording_on_start: bool = True
    # Test run: switch scenes but don't require (or start) a recording.
    test_run_no_recording: bool = False


@dataclass
class OverlayConfig:
    port: int = 8765
    write_text_file: bool = True


@dataclass
class HotkeyConfig:
    start: str = "ctrl+shift+F6"
    pause: str = "ctrl+shift+F7"
    stop: str = "ctrl+shift+F8"
    emergency: str = "ctrl+shift+F9"
    ready: str = "ctrl+shift+F10"  # "I'm in the game" (Schedule I)
    popup: str = "ctrl+shift+G"  # show / hide the pop-up panel


@dataclass
class PopupConfig:
    """The small always-on-top panel at the top of your screen."""

    enabled: bool = True
    corner: str = "top-right"  # or "top-left", "top-center"
    # Pop up by itself with this many seconds left.
    alert_seconds: list[int] = field(default_factory=lambda: [60, 30])
    # How long an alert stays up before tucking itself away again.
    alert_show_seconds: float = 5.0


@dataclass
class Config:
    rotation: list[str] = field(default_factory=lambda: ["minecraft", "schedule1"])
    games: dict[str, GameConfig] = field(
        default_factory=lambda: {
            "minecraft": GameConfig("Minecraft", "Minecraft", driver="minecraft"),
            # 3164500 is Schedule I's Steam app ID.
            "schedule1": GameConfig("Schedule I", "Schedule I", driver="schedule1", steam_app_id="3164500",
                                    save_prompt_seconds=60, save_wait_seconds=300),
        }
    )

    play_seconds: int = 600
    warning_seconds: list[int] = field(default_factory=lambda: [30, 10])

    launch_timeout: int = 120  # start pressed -> game process running
    load_timeout: int = 240  # game launched -> gameplay verified
    save_timeout: int = 90
    exit_timeout: int = 120
    switch_delay_seconds: float = 3.0
    ready_poll_seconds: float = 1.0
    ready_stable_checks: int = 3  # this many "ready" checks in a row before the timer starts

    # Off by default. When on and gameplay can't be verified before the load
    # timeout, the turn ends 12 minutes after launch instead of stopping.
    # Saving and exiting are still verified either way.
    fallback_cycle_enabled: bool = False
    fallback_cycle_seconds: int = 720

    # If a game fails to start, try once more by itself after this delay.
    # A retry never starts a second copy: it first checks the game isn't already starting.
    launch_retries: int = 1
    launch_retry_delay: int = 20
    # Stop by itself (saving and closing the game) after this many turns. 0 = never.
    stop_after_turns: int = 0

    sounds: bool = True
    obs: ObsConfig = field(default_factory=ObsConfig)
    overlay: OverlayConfig = field(default_factory=OverlayConfig)
    hotkeys: HotkeyConfig = field(default_factory=HotkeyConfig)
    popup: PopupConfig = field(default_factory=PopupConfig)
    # The last this-many seconds count down out loud (a tick each second) and big on screen.
    countdown_seconds: int = 10

    def game(self, key: str) -> GameConfig:
        return self.games[key]

    def validate(self) -> list[str]:
        """Problems in plain English; empty list means the settings are usable."""
        problems = []
        if self.play_seconds < 20:
            problems.append("Play time must be at least 20 seconds.")
        if any(w <= 0 or w >= self.play_seconds for w in self.warning_seconds):
            problems.append("Each warning must be above 0 and shorter than the play time.")
        if len(self.rotation) < 2:
            problems.append("The rotation needs at least two games.")
        for key in self.rotation:
            if key not in self.games:
                problems.append(f"Rotation lists '{key}', but there are no settings for it.")
        for name, value in (
            ("Launch timeout", self.launch_timeout),
            ("Load timeout", self.load_timeout),
            ("Save timeout", self.save_timeout),
            ("Exit timeout", self.exit_timeout),
        ):
            if value < 5:
                problems.append(f"{name} must be at least 5 seconds.")
        if self.launch_retries < 0 or self.launch_retry_delay < 1:
            problems.append("Launch retries can't be negative, and the retry delay must be at least 1 second.")
        if not 0 <= self.countdown_seconds < self.play_seconds:
            problems.append("The final countdown must be shorter than the play time.")
        if self.popup.corner not in POPUP_CORNERS:
            problems.append(f"Pop-up position must be one of: {', '.join(POPUP_CORNERS)}.")
        if any(a <= 0 for a in self.popup.alert_seconds):
            problems.append("Each pop-up alert must be above 0 seconds.")  # longer than a turn = just skipped
        if self.stop_after_turns < 0:
            problems.append("'Stop after turns' can't be negative.")
        if self.ready_stable_checks < 1:
            problems.append("Ready checks in a row must be at least 1.")
        if self.fallback_cycle_enabled and self.fallback_cycle_seconds <= self.play_seconds:
            problems.append("The fallback cycle must be longer than the play time.")
        for key, g in self.games.items():
            if g.driver not in DRIVERS.get(key, ("simulated",)):
                problems.append(f"{g.name}: unknown game driver '{g.driver}'.")
            if g.save_prompt_seconds and not 0 < g.save_prompt_seconds < self.play_seconds:
                problems.append(f"{g.name}: the save prompt must be shorter than the play time.")
            if g.save_max_age_seconds < 10:
                problems.append(f"{g.name}: 'a save this recent counts' must be at least 10 seconds.")
            if g.simulation.fail_step not in SIM_FAIL_STEPS:
                problems.append(f"{g.name}: unknown simulated failure '{g.simulation.fail_step}'.")
        if self.obs.enabled:
            scenes = [self.obs.switching_scene] + [self.games[k].obs_scene for k in self.rotation if k in self.games]
            if any(not s.strip() for s in scenes):
                problems.append("Every OBS scene name must be filled in.")
        return problems


def _build(cls, data):
    """Turn parsed JSON into dataclasses, ignoring unknown keys."""
    hints = get_type_hints(cls)
    kwargs = {}
    for f in fields(cls):
        if f.name not in data:
            continue
        value, hint = data[f.name], hints[f.name]
        if is_dataclass(hint) and isinstance(value, dict):
            value = _build(hint, value)
        elif f.name == "games" and isinstance(value, dict):
            value = {k: _build(GameConfig, v) for k, v in value.items()}
        kwargs[f.name] = value
    return cls(**kwargs)


def load(path: Path = CONFIG_PATH) -> Config:
    if not path.exists():
        cfg = Config()
        save(cfg, path)
        return cfg
    with path.open(encoding="utf-8") as f:
        return _build(Config, json.load(f))


def save(cfg: Config, path: Path = CONFIG_PATH) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(asdict(cfg), f, indent=2)
    tmp.replace(path)
