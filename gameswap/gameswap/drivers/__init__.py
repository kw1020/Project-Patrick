from __future__ import annotations

from ..config import Config
from ..procmon import ProcessMonitor
from .base import GameDriver, ReadyCheck, StepResult
from .simulated import SimulatedGame

__all__ = ["GameDriver", "ReadyCheck", "StepResult", "SimulatedGame", "make_drivers"]


def make_drivers(cfg: Config, monitor: ProcessMonitor, actions=None) -> dict[str, GameDriver]:
    """actions: what the drivers use to press keys/buttons (tests pass a fake)."""
    from .minecraft import MinecraftDriver
    from .schedule1 import Schedule1Driver

    real = {"minecraft": MinecraftDriver, "schedule1": Schedule1Driver}
    drivers: dict[str, GameDriver] = {}
    for key, game_cfg in cfg.games.items():
        if game_cfg.driver == "simulated":
            drivers[key] = SimulatedGame(key, game_cfg)
        elif game_cfg.driver in real:
            drivers[key] = real[game_cfg.driver](key, game_cfg, monitor, actions=actions)
        else:
            raise ValueError(f"{game_cfg.name}: unknown game driver '{game_cfg.driver}'")
    return drivers
