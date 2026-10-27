"""Zip backups of a save folder before GameSwap starts touching it."""

from __future__ import annotations

import logging
import time
import zipfile
from pathlib import Path

from .config import APP_DIR

log = logging.getLogger("gameswap.backup")

BACKUP_DIR = APP_DIR / "backups"
SKIP = {"session.lock"}  # Minecraft's "world is open" marker


def backup_folder(source: Path, label: str, keep: int = 5, dest_root: Path | None = None) -> Path:
    """Copy `source` into backups/<label>/<label>-YYYYmmdd-HHMMSS.zip and keep
    only the newest `keep` backups for that label."""
    dest_dir = (dest_root or BACKUP_DIR) / _safe(label)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / f"{_safe(label)}-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    tmp = target.with_suffix(".partial")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for path in sorted(source.rglob("*")):
            if path.is_file() and path.name not in SKIP:
                z.write(path, Path(source.name) / path.relative_to(source))
    tmp.replace(target)
    old = sorted(dest_dir.glob("*.zip"))[:-keep] if keep > 0 else []
    for p in old:
        p.unlink()
    log.info("Backed up %s to %s", source, target)
    return target


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in " -_." else "_" for c in name).strip() or "save"
