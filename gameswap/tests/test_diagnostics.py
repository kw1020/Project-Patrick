import gzip
import json
import struct

from fakes import FakeSystem, minecraft_game

from gameswap import diagnostics
from gameswap.config import Config
from gameswap.drivers import make_drivers


def nbt_level_dat(level_name: str) -> bytes:
    """A tiny but real NBT level.dat: {"": {"Data": {"LevelName": ...}}}."""
    def name(s):
        b = s.encode()
        return struct.pack(">H", len(b)) + b
    value = level_name.encode()
    data = (b"\x0a" + name("") + b"\x0a" + name("Data")
            + b"\x03" + name("version") + struct.pack(">i", 19133)
            + b"\x08" + name("LevelName") + struct.pack(">H", len(value)) + value
            + b"\x00" + b"\x00")
    return gzip.compress(data)


def test_level_name_reads_the_shown_world_name(tmp_path):
    p = tmp_path / "level.dat"
    p.write_bytes(nbt_level_dat("Krew's Challenge ⛏"))
    assert diagnostics.level_name(p) == "Krew's Challenge ⛏"
    p.write_bytes(b"not gzip")
    assert diagnostics.level_name(p) == ""


def test_report_lists_worlds_installations_and_never_the_token(tmp_path):
    mc_dir = tmp_path / ".minecraft"
    world = mc_dir / "saves" / "New World (1)"
    world.mkdir(parents=True)
    (world / "level.dat").write_bytes(nbt_level_dat("Challenge"))
    (mc_dir / "options.txt").write_text("guiScale:3\nfullscreen:false\nlang:en_us\nsecretThing:x\n")
    (mc_dir / "launcher_profiles.json").write_text(json.dumps({"profiles": {
        "a": {"name": "", "type": "latest-release", "lastVersionId": "latest-release"}}}))

    cfg = Config()
    cfg.games["minecraft"].game_folder = str(mc_dir)
    system = FakeSystem()
    system.add(minecraft_game())
    drivers = make_drivers(cfg, system.monitor())
    drivers["minecraft"].processes  # noqa: B018
    report = diagnostics.build_report(cfg, drivers)

    assert "Challenge  <-  New World (1)" in report
    assert "guiScale" in report and "secretThing" not in report
    assert "Latest release" in report
    assert "v1.21.4" in report or "version 1.21.4" in report
    assert "SECRET-TOKEN" not in report
    assert "== Schedule I ==" in report
