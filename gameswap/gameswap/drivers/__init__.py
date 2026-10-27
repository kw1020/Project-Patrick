from __future__ import annotations

from ..config import Config
from .base import GameDriver, ReadyCheck, StepResult
from .simulated import SimulatedGame

__all__ = ["GameDriver", "ReadyCheck", "StepResult", "SimulatedGame", "make_drivers"]


def make_drivers(cfg: Config) -> dict[str, GameDriver]:
    drivers: dict[str, GameDriver] = {}
    for key, game_cfg in cfg.games.items():
        if game_cfg.driver == "simulated":
            drivers[key] = SimulatedGame(key, game_cfg)
        else:
            raise ValueError(
                f"{game_cfg.name}: driver '{game_cfg.driver}' isn't built yet. "
                "Phase 1 only has 'simulated'."
            )
    return drivers
