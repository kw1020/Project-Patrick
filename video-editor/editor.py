"""Core video editing: turns a clip plus options into an Instagram-ready MP4 with ffmpeg.

Both the web app and the email worker call `process()`. Nothing here touches the network.
"""
from __future__ import annotations

import json
import re
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path

WIDTH, HEIGHT = 1080, 1920  # Instagram Reels, 9:16
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}
AUDIO_MODES = ("keep", "denoise", "mute")
REFRAME_MODES = ("fit", "crop", "none")
FFMPEG_TIMEOUT = 900  # seconds
_ENCODE_LOCK = threading.Lock()


class EditError(Exception):
    """A problem the user can understand (bad options, unreadable video, ffmpeg failure)."""


@dataclass
class EditOptions:
    trim_start: float = 0.0
    trim_end: float | None = None  # None = until the end
    reframe: str = "fit"  # fit = whole frame on blurred background, crop = fill 9:16, none = leave as is
    audio_mode: str = "keep"  # keep | denoise | mute
    music: Path | None = None
    music_volume: float = 0.35  # 0..1, relative to the original audio when both are present
    speed: float = 1.0
    normalize: bool = True

    def validate(self) -> None:
        if self.audio_mode not in AUDIO_MODES:
            raise EditError(f"audio_mode must be one of {AUDIO_MODES}")
        if self.reframe not in REFRAME_MODES:
            raise EditError(f"reframe must be one of {REFRAME_MODES}")
        if not 0.5 <= self.speed <= 2.0:
            raise EditError("speed must be between 0.5 and 2.0")
        if not 0.0 <= self.music_volume <= 1.0:
            raise EditError("music_volume must be between 0 and 1")
        if self.trim_start < 0 or (self.trim_end is not None and self.trim_end <= self.trim_start):
            raise EditError("trim end must be after trim start")


@dataclass
class MediaInfo:
    duration: float
    has_audio: bool


def probe(path: Path) -> MediaInfo:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True).stdout
        data = json.loads(out)
        streams = data.get("streams", [])
        if not any(s.get("codec_type") == "video" for s in streams):
            raise EditError("That file has no video in it.")
        duration = float(data["format"]["duration"])
    except (subprocess.CalledProcessError, KeyError, ValueError, json.JSONDecodeError):
        raise EditError("Couldn't read that video. Is it a normal MP4/MOV file?") from None
    return MediaInfo(duration, any(s.get("codec_type") == "audio" for s in streams))


def _num(x: float) -> str:
    return f"{x:.3f}".rstrip("0").rstrip(".")


def _video_chain(opts: EditOptions) -> str:
    if opts.reframe == "fit":
        # whole frame centred over a blurred, zoomed copy of itself, so nothing is cut off
        parts = [
            "[0:v]split=2[bg][fg]",
            f"[bg]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},boxblur=20:2[b]",
            f"[fg]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease[f]",
            "[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1",
        ]
        chain = ";".join(parts)
    elif opts.reframe == "crop":
        chain = (f"[0:v]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
                 f"crop={WIDTH}:{HEIGHT},setsar=1")
    else:
        chain = "[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1"  # h264 needs even dimensions
    chain += ",fps=30"
    if opts.speed != 1.0:
        chain += f",setpts=PTS/{_num(opts.speed)}"
    return chain + "[v]"


def _audio_chain(opts: EditOptions, has_audio: bool, out_len: float) -> tuple[str, bool]:
    """Returns (filtergraph fragment ending in [a], whether there is any audio)."""
    use_orig = has_audio and opts.audio_mode != "mute"
    use_music = opts.music is not None
    if not use_orig and not use_music:
        return "", False

    parts: list[str] = []
    if use_orig:
        f = ["[0:a]"]
        steps = []
        if opts.audio_mode == "denoise":
            steps += ["highpass=f=80", "afftdn=nr=18:nf=-30"]
        if opts.speed != 1.0:
            steps.append(f"atempo={_num(opts.speed)}")
        parts.append(f[0] + (",".join(steps) if steps else "anull") + "[orig]")
    if use_music:
        # music input is looped forever (-stream_loop); the output -t cuts it to the video length
        fade_at = max(out_len - 1.0, 0.0)
        parts.append(f"[1:a]volume={_num(opts.music_volume)},afade=t=out:st={_num(fade_at)}:d=1[mus]")

    if use_orig and use_music:
        parts.append("[orig]asplit=2[o1][o2]")
        # duck the music while someone is talking, so speech and the dog's noises stay clear
        parts.append("[mus][o1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck]")
        parts.append("[o2][duck]amix=inputs=2:duration=first:normalize=0[mix]")
        last = "mix"
    else:
        last = "orig" if use_orig else "mus"

    tail = "loudnorm=I=-14:TP=-1.5:LRA=11" if opts.normalize else "anull"
    parts.append(f"[{last}]{tail}[a]")
    return ";".join(parts), True


def build_command(src: Path, dst: Path, opts: EditOptions, info: MediaInfo) -> tuple[list[str], float]:
    """Pure function: returns (ffmpeg argv, output length in seconds)."""
    opts.validate()
    end = min(opts.trim_end, info.duration) if opts.trim_end is not None else info.duration
    if end <= opts.trim_start:
        raise EditError(f"Trim start is past the end of the video ({info.duration:.1f}s long).")
    clip_len = end - opts.trim_start
    out_len = clip_len / opts.speed

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-ss", _num(opts.trim_start), "-t", _num(clip_len), "-i", str(src)]
    if opts.music is not None:
        cmd += ["-stream_loop", "-1", "-i", str(opts.music)]

    audio_graph, has_out_audio = _audio_chain(opts, info.has_audio, out_len)
    graph = _video_chain(opts) + (";" + audio_graph if audio_graph else "")
    cmd += ["-filter_complex", graph, "-map", "[v]"]
    cmd += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ar", "44100"] if has_out_audio else ["-an"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-t", _num(out_len), "-movflags", "+faststart", str(dst)]
    return cmd, out_len


def process(src: Path, dst: Path, opts: EditOptions) -> dict:
    info = probe(src)
    cmd, out_len = build_command(src, dst, opts, info)
    try:
        with _ENCODE_LOCK:  # web jobs and email jobs share one small server: one encode at a time
            run = subprocess.run(cmd, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise EditError("Editing took too long and was stopped. Try a shorter clip.") from None
    if run.returncode != 0 or not dst.exists():
        detail = run.stderr.strip().splitlines()[-1] if run.stderr.strip() else "unknown error"
        raise EditError(f"ffmpeg failed: {detail}")
    return {"duration": round(out_len, 2), "size_bytes": dst.stat().st_size,
            "had_audio": info.has_audio}


# ---------------------------------------------------------------- music library + text commands

def list_music(music_dir: Path) -> list[str]:
    if not music_dir.is_dir():
        return []
    return sorted(p.stem for p in music_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS)


def find_music(name: str, music_dir: Path) -> Path | None:
    """Look a track up by name. Never joins user text into a path, so it can't escape music_dir."""
    name = name.strip().lower()
    if not name or not music_dir.is_dir():
        return None
    tracks = [p for p in music_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS]
    exact = [p for p in tracks if p.stem.lower() == name]
    loose = [p for p in tracks if name in p.stem.lower()]
    return (exact or loose or [None])[0]


def _seconds(text: str) -> float:
    parts = [float(p) for p in text.strip().split(":")]
    if not 1 <= len(parts) <= 3:
        raise ValueError(text)
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def parse_commands(text: str, music_dir: Path) -> tuple[EditOptions, list[str]]:
    """Understand plain-English edit requests, e.g. from an email.

    Recognised (any order, any line):  mute | denoise | trim 0:03-0:15 | music: name |
    speed 1.5 | crop | no reframe
    Returns the options and a list of human-readable notes about what was understood.
    """
    opts, notes = EditOptions(), []
    low = text.lower()

    if re.search(r"\b(mute|no audio|remove (the )?audio|silent)\b", low):
        opts.audio_mode = "mute"
        notes.append("Removed the original audio")
    elif re.search(r"\b(denoise|clean (up )?(the )?audio|remove (the )?noise|reduce noise)\b", low):
        opts.audio_mode = "denoise"
        notes.append("Cleaned up background noise")

    m = re.search(r"\btrim\s+([\d:.]+)\s*(?:-|to)\s*([\d:.]+)", low)
    if m:
        try:
            opts.trim_start, opts.trim_end = _seconds(m.group(1)), _seconds(m.group(2))
            notes.append(f"Trimmed to {m.group(1)} – {m.group(2)}")
        except ValueError:
            notes.append(f"Couldn't understand the trim times '{m.group(0)}', so I left the length alone")

    m = re.search(r"\bspeed\s+(?:x\s*)?([\d.]+)", low)
    if m:
        try:
            opts.speed = float(m.group(1))
            notes.append(f"Speed {opts.speed}x")
        except ValueError:
            notes.append("Couldn't understand the speed request")

    if re.search(r"\bno reframe\b", low):
        opts.reframe = "none"
        notes.append("Kept the original frame shape")
    elif re.search(r"\bcrop\b", low):
        opts.reframe = "crop"
        notes.append("Cropped to fill the vertical screen")

    m = re.search(r"\bmusic\s*[:=]\s*([^\n,;]+)", text, re.IGNORECASE)
    if m:
        track = find_music(m.group(1), music_dir)
        if track:
            opts.music = track
            notes.append(f"Added music: {track.stem}")
        else:
            avail = ", ".join(list_music(music_dir)) or "none yet"
            notes.append(f"Couldn't find music '{m.group(1).strip()}' (available: {avail})")
    return opts, notes
