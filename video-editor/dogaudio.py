"""Dog-sounds-only audio: find the moments when people are talking and silence them.

How it works (and its limits, which matter):
  1. A small speech detector (Silero VAD) scores every 32 ms of the audio: "how likely is this a human talking?"
  2. Moments above the threshold are treated as talking. Short gaps between words are bridged, one-off blips are
     ignored (a yip is not a word), and each talking span is padded a little so word edges don't leak.
  3. Talking spans are faded out. Everything else (breathing, whining, panting, claws on the floor) is untouched.

Limits:
  * If the dog makes a noise *while* someone is talking, that noise goes with the talking. This removes whole
    moments; it does not separate overlapping sounds.
  * A very voice-like whine can be mistaken for speech. Use talking_detection="gentle" if good dog sounds are being cut.
"""
from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np

from editor import EditError

SR = 16000
FRAME = 512  # samples per VAD frame at 16 kHz = 32 ms
FRAME_SECONDS = FRAME / SR
# level -> (speech score needed, shortest burst in frames that counts as talking). Lower = removes more.
LEVELS = {"gentle": (0.7, 8), "normal": (0.5, 5), "strict": (0.3, 3), "strongest": (0.12, 3)}
BRIDGE_GAP = 12  # frames (~0.4 s): pauses shorter than this between talking are still talking
PAD = 4          # frames (~0.13 s) added each side of talking
MAX_SECONDS = 600
OUT_SR = 44100


def _decode(src: Path, start: float, duration: float, sr: int, channels: int) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(duration), "-i", str(src),
           "-vn", "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"]
    try:
        raw = subprocess.run(cmd, capture_output=True, timeout=300, check=True).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise EditError("Couldn't read the audio from that video.") from None
    audio = np.frombuffer(raw, dtype="<f4")
    return audio.reshape(-1, channels) if channels > 1 else audio


def speech_probabilities(mono16k: np.ndarray) -> np.ndarray:
    """Probability (0-1) of human speech for each 32 ms frame."""
    from pysilero_vad import SileroVoiceActivityDetector
    vad = SileroVoiceActivityDetector()
    pcm = (np.clip(mono16k, -1, 1) * 32767).astype("<i2")
    pad = (-len(pcm)) % FRAME
    if pad:
        pcm = np.concatenate([pcm, np.zeros(pad, dtype="<i2")])
    chunk_bytes = FRAME * 2
    data = pcm.tobytes()
    return np.array([vad.process_chunk(data[i:i + chunk_bytes]) for i in range(0, len(data), chunk_bytes)])


def _runs(mask: np.ndarray, value: bool):
    """Yield (start, end) index pairs of consecutive entries equal to `value`."""
    edges = np.flatnonzero(np.diff(np.concatenate([[False], mask == value, [False]]).astype(np.int8)))
    return list(zip(edges[::2], edges[1::2]))


def talking_mask(probs: np.ndarray, threshold: float, min_talk: int = 5) -> np.ndarray:
    """Per-frame True where someone is (treated as) talking."""
    mask = probs >= threshold
    for start, end in _runs(mask, False):            # bridge short pauses inside a sentence
        if 0 < start and end < len(mask) and end - start <= BRIDGE_GAP:
            mask[start:end] = True
    for start, end in _runs(mask, True):             # drop blips too short to be words
        if end - start < min_talk:
            mask[start:end] = False
    padded = mask.copy()
    for start, end in _runs(mask, True):             # widen so word edges don't leak
        padded[max(0, start - PAD):min(len(mask), end + PAD)] = True
    return padded


def gain_curve(mask: np.ndarray, n_samples: int, sr: int) -> np.ndarray:
    """Smooth 1 -> 0 -> 1 gain, one value per audio sample (no clicks at the edges)."""
    gain = 1.0 - mask.astype(np.float64)
    kernel = np.array([0.25, 0.5, 0.25])
    for _ in range(2):
        gain = np.convolve(np.pad(gain, 2, mode="edge"), kernel, mode="same")[2:-2]
    centers = (np.arange(len(gain)) + 0.5) * FRAME_SECONDS
    return np.interp(np.arange(n_samples) / sr, centers, gain).astype(np.float32)


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(audio.shape[1] if audio.ndim > 1 else 1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def isolate(src: Path, dst_wav: Path, start: float, duration: float, level: str = "normal") -> dict:
    """Write dst_wav = the clip's audio with talking removed. Returns a report of what was removed."""
    if level not in LEVELS:
        raise EditError(f"talking_detection must be one of {tuple(LEVELS)}")
    if duration > MAX_SECONDS:
        raise EditError(f"Dog-sounds mode works on clips up to {MAX_SECONDS // 60} minutes. Trim it and try again.")

    mono = _decode(src, start, duration, SR, 1)
    mask = talking_mask(speech_probabilities(mono), *LEVELS[level])

    full = _decode(src, start, duration, OUT_SR, 2)
    gain = gain_curve(mask, len(full), OUT_SR)
    _write_wav(dst_wav, full * gain[:, None], OUT_SR)

    spans = [(round(s * FRAME_SECONDS, 2), round(min(e * FRAME_SECONDS, duration), 2)) for s, e in _runs(mask, True)]
    return {"clip_seconds": round(duration, 2), "spans": spans,
            "talking_seconds": round(sum(e - s for s, e in spans), 2)}


def analyze(src: Path, start: float, duration: float) -> dict:
    """Numbers about the audio, so detection can be tuned on real recordings without moving the video anywhere."""
    mono = _decode(src, start, duration, SR, 1)
    probs = speech_probabilities(mono)
    per_sec = int(round(1 / FRAME_SECONDS))  # frames per second (~31)
    rows = []
    for i in range(0, len(probs), per_sec):
        chunk = probs[i:i + per_sec]
        seg = mono[int(i * FRAME): int((i + per_sec) * FRAME)]
        rms = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
        rows.append({"t": round(i * FRAME_SECONDS), "p_max": round(float(chunk.max()), 2), "p_mean": round(float(chunk.mean()), 2),
                     "db": round(20 * np.log10(max(rms, 1e-6)), 1), "flat": _flatness(seg)})
    counts = {f">={t}": round(float((probs >= t).mean()) * 100) for t in (0.7, 0.5, 0.3, 0.12)}
    dbs = np.array([r["db"] for r in rows]) if rows else np.zeros(1)
    loud = {f"p{q}": round(float(np.percentile(dbs, q)), 1) for q in (10, 50, 90)}
    return {"clip_seconds": round(duration, 1), "percent_of_audio_flagged_at": counts, "loudness_db_percentiles": loud,
            "per_second": rows}


def _flatness(seg: np.ndarray) -> float:
    """0 = very pitched/tonal (voices, whines), 1 = noise-like (breathing, wind). A hint for telling them apart."""
    if len(seg) < 512:
        return 0.0
    power = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
    freqs = np.fft.rfftfreq(len(seg), 1 / SR)
    band = power[(freqs >= 100) & (freqs <= 4000)] + 1e-12
    return round(float(np.exp(np.mean(np.log(band))) / np.mean(band)), 3)


def format_analysis(a: dict) -> str:
    lines = [f"Patrick audio analysis ({a['clip_seconds']}s). p = chance of human speech (0-1), db = loudness (0 is the loudest possible).",
             "Share of the audio that counts as talking at each speech-score cutoff: "
             + ", ".join(f"{k}: {v}%" for k, v in a["percent_of_audio_flagged_at"].items()),
             "Loudness across the clip (dB, closer to 0 = louder): " + ", ".join(f"{k}: {v}" for k, v in a["loudness_db_percentiles"].items()),
             "flat: 0 = pitched/tonal like a voice or whine, 1 = noise-like like breathing", "",
             "second | p_max | p_mean | db | flat"]
    lines += [f"{r['t']:>5}s | {r['p_max']:.2f} | {r['p_mean']:.2f} | {r['db']:6.1f} | {r['flat']:.3f}" for r in a["per_second"]]
    return "\n".join(lines) + "\n"


def describe(report: dict) -> str:
    n, secs, total = len(report["spans"]), report["talking_seconds"], report["clip_seconds"]
    if n == 0:
        return "No talking found, so the audio is unchanged."
    if secs >= total * 0.95:
        return "Almost the whole clip sounded like talking, so it's nearly silent. Try 'gentle' if that's wrong."
    return f"Removed {secs:.1f}s of talking in {n} spot{'s' if n != 1 else ''} (out of {total:.0f}s). Everything else is untouched."
