import sys
from concurrent.futures import Future
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gameswap.config import Config  # noqa: E402
from gameswap.drivers import SimulatedGame  # noqa: E402
from gameswap.machine import Machine  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ImmediateExecutor:
    """Runs each job straight away, so tests are fast and repeatable."""

    def submit(self, fn, *args):
        f = Future()
        try:
            f.set_result(fn(*args))
        except Exception as e:
            f.set_exception(e)
        return f

    def shutdown(self, **kwargs):
        pass


class FakeObs:
    def __init__(self, problems=None):
        self.scenes = []
        self.problems = problems or []

    def set_scene(self, name):
        if not self.scenes or self.scenes[-1] != name:
            self.scenes.append(name)

    def preflight(self, scenes):
        self.checked = scenes
        return list(self.problems)


class Rig:
    """A machine wired to simulated games, a fake clock, and a fake OBS."""

    def __init__(self, cfg: Config, obs=None):
        self.cfg = cfg
        self.clock = FakeClock()
        self.obs = obs or FakeObs()
        self.drivers = {k: SimulatedGame(k, g, clock=self.clock) for k, g in cfg.games.items()}
        self.sounds = []
        self.m = Machine(cfg, self.drivers, self.obs, clock=self.clock, executor=ImmediateExecutor())
        self.m.on_sound = self.sounds.append

    def advance(self, seconds: float, step: float = 0.1):
        """Move time forward in 0.1 s ticks, like the real UI timer."""
        n = round(seconds / step)
        for _ in range(n):
            self.clock.now += step
            self.m.tick()

    def run_until(self, state, limit: float = 3600):
        t = 0.0
        while self.m.state != state:
            self.advance(0.1)
            t += 0.1
            if t > limit:
                raise AssertionError(f"never reached {state}; stuck in {self.m.state} ({self.m.error})")
        return t


def make_cfg(**overrides) -> Config:
    """Real defaults, but with zero-second simulated steps and no sounds/OBS waits."""
    cfg = Config()
    cfg.switch_delay_seconds = 2.0
    for g in cfg.games.values():
        g.driver = "simulated"
        s = g.simulation
        s.launch_seconds = s.load_seconds = s.save_seconds = s.exit_seconds = 0
        s.ready_after_seconds = 20  # a 20 s loading screen after the world opens
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


@pytest.fixture
def rig():
    return Rig(make_cfg())
