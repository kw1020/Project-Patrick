"""Reading Minecraft world folders."""

from __future__ import annotations

import gzip
import struct
from pathlib import Path


def level_name(level_dat: Path) -> str:
    """The world name shown in Minecraft's world list (stored inside level.dat)."""
    try:
        data = gzip.decompress(level_dat.read_bytes())
    except (OSError, EOFError, gzip.BadGzipFile):
        return ""
    marker = b"\x08\x00\x09LevelName"  # NBT: string tag named "LevelName"
    i = data.find(marker)
    if i < 0:
        return ""
    i += len(marker)
    (length,) = struct.unpack(">H", data[i:i + 2])
    return data[i + 2:i + 2 + length].decode("utf-8", errors="replace")
