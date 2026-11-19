#!/usr/bin/env python3
"""Beat finder for v2.0.0 Edits (numpy only, no librosa).

Usage: beats.py <pcm file> [sample_rate]
  The file is raw 16-bit little-endian mono PCM (src/lib/beats.ts makes it with ffmpeg at 22050 Hz).
Prints one JSON line: {"tempo", "beats": [s...], "downbeats": [s...], "drops": [{"t", "ratio"}], "duration", "confidence", "ms"}

How:
  1. Onset strength: log-magnitude spectrogram (1024-pt Hann, hop 256 = 11.6 ms), positive spectral flux summed over
     bins, minus its local mean (0.5 s), half-wave rectified.
  2. Tempo: autocorrelation of the onset curve over lags for 70-180 BPM, mildly weighted toward 120 BPM, refined by
     parabolic interpolation (sub-frame).
  3. Beats: dynamic programming (Ellis 2007): each frame's score = its onset + the best earlier beat about one period back,
     penalised by how far the gap is from the period (log-squared). Backtracked from the best frame near the end.
  4. Each beat is then refined on the waveform itself (1 ms energy envelope, first rise past 30% of the local peak) and the
     tempo re-measured from a straight-line fit through the beat times.
  5. Downbeats: of the 4 phases, the one whose beats carry the most low-frequency (kick) energy; every 4th beat from there.
  6. Drops: bars whose energy jumps >= 1.4x over the two bars before (biggest first).
"""
import json
import sys
import time

import numpy as np

N_FFT = 1024
HOP = 256


def onset_envelope(y, sr):
    n = 1 + max(0, (len(y) - N_FFT) // HOP)
    if n < 8:
        return np.zeros(max(n, 1)), np.zeros(max(n, 1))
    win = np.hanning(N_FFT).astype(np.float32)
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    frames = y[idx] * win
    mag = np.abs(np.fft.rfft(frames, axis=1))
    logm = np.log1p(100.0 * mag)
    flux = np.maximum(0.0, np.diff(logm, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    # low band (kick drum area, < ~150 Hz) energy per frame for downbeats
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    low = (mag[:, freqs < 150] ** 2).sum(axis=1)
    k = max(1, int(round(0.5 * sr / HOP)))
    local = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0.0, flux - local)
    if env.max() > 0:
        env = env / env.max()
    return env, low


def frame_time(i, sr):
    # flux at frame i = change from frame i-1 to i; the new sound is in the second half of frame i's window
    return (i * HOP + N_FFT * 0.5) / sr


def estimate_period(env, sr, lo_bpm=70.0, hi_bpm=180.0):
    fps = sr / HOP
    x = env - env.mean()
    n = len(x)
    if n < 16:
        return 60.0 / 120.0 * fps
    spec = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    lo = int(np.floor(60.0 * fps / hi_bpm))
    hi = min(n - 2, int(np.ceil(60.0 * fps / lo_bpm)))
    if hi <= lo + 2:
        return 60.0 / 120.0 * fps
    lags = np.arange(lo, hi + 1)
    bpm = 60.0 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpm / 120.0) / 1.0) ** 2)
    # also reward lags whose double has energy (a real beat period repeats)
    dbl = np.array([ac[min(n - 1, 2 * L)] for L in lags])
    score = (ac[lags] + 0.5 * np.maximum(0, dbl)) * prior
    j = int(np.argmax(score))
    L = float(lags[j])
    if 0 < j < len(lags) - 1:
        a, b, c = score[j - 1], score[j], score[j + 1]
        den = a - 2 * b + c
        if den != 0:
            L += 0.5 * (a - c) / den
    return L


def track_beats(env, period, tightness=100.0):
    n = len(env)
    score = env.astype(np.float64).copy()
    back = -np.ones(n, dtype=np.int64)
    P = period
    lo_off = int(round(P / 2)); hi_off = int(round(2 * P))
    offs = np.arange(lo_off, hi_off + 1)
    pen = -tightness * (np.log(offs / P)) ** 2
    for t in range(n):
        prev = t - offs
        ok = prev >= 0
        if not ok.any():
            continue
        cand = score[prev[ok]] + pen[ok]
        k = int(np.argmax(cand))
        if cand[k] > 0:
            score[t] = env[t] + cand[k]
            back[t] = prev[ok][k]
    # best end within the last period
    tail = max(0, n - int(round(P)) - 1)
    t = tail + int(np.argmax(score[tail:]))
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    return np.array(beats[::-1], dtype=np.int64)


def refine_on_wave(y, sr, times, reach=0.05):
    """Snap each beat to the attack in the waveform: 1 ms energy envelope of the first difference (bass and hum count little),
    then from the loudest point within +-50 ms walk BACK to where it first rose past half way above the local background
    (a click / kick / snare attack). Keeps the frame estimate when nothing stands out there."""
    if not len(times):
        return times
    hop = max(1, sr // 1000)
    d = np.diff(y.astype(np.float64), prepend=0.0)
    e = d ** 2
    m = len(e) // hop
    env = e[: m * hop].reshape(m, hop).mean(axis=1)
    env = np.convolve(env, np.ones(3) / 3, mode="same")
    out = []
    step = hop / sr  # seconds per envelope point (~1 ms)
    r = int(round(reach / step))
    for t in times:
        c = int(round(t / step))
        a, b = max(0, c - r), min(m, c + r)
        if b - a < 5:
            out.append(t); continue
        w = env[a:b]
        pk = int(np.argmax(w))
        bg = float(np.median(w))
        if w[pk] <= 0 or w[pk] < 2.5 * (bg + 1e-12):
            out.append(t); continue
        thr = bg + 0.5 * (w[pk] - bg)
        k = pk
        while k > 0 and w[k - 1] >= thr:
            k -= 1
        out.append((a + k) * step)
    return np.array(out)


def main():
    t0 = time.time()
    path = sys.argv[1]
    sr = int(sys.argv[2]) if len(sys.argv) > 2 else 22050
    y = np.fromfile(path, dtype="<i2").astype(np.float32) / 32768.0
    duration = len(y) / sr
    if duration < 4:
        print(json.dumps({"error": "song is shorter than 4 seconds", "duration": duration}))
        return
    env, low = onset_envelope(y, sr)
    fps = sr / HOP
    period = estimate_period(env, sr)
    bf = track_beats(env, period)
    times = np.array([frame_time(i, sr) for i in bf])
    times = times[(times >= 0) & (times <= duration)]
    times = refine_on_wave(y, sr, times)
    # tempo from a straight-line fit through the beats (robust to small jitter)
    if len(times) >= 4:
        k = np.arange(len(times))
        slope, icpt = np.polyfit(k, times, 1)
        resid = times - (slope * k + icpt)
        good = np.abs(resid) < 0.25 * slope
        if good.sum() >= 4:
            slope, icpt = np.polyfit(k[good], times[good], 1)
        tempo = 60.0 / slope
    else:
        tempo = 60.0 * fps / period
    # downbeats: the phase with the most kick energy (plus onset strength) on its beats
    fr = np.clip(np.round((times * sr - N_FFT * 0.5) / HOP).astype(int), 0, len(env) - 1)
    lowv = low[fr] / (low.max() + 1e-12)
    onv = env[fr]
    best, best_s = 0, -1.0
    for ph in range(4):
        s = float(lowv[ph::4].mean() + 0.5 * onv[ph::4].mean()) if len(lowv[ph::4]) else 0.0
        if s > best_s + 1e-9:
            best, best_s = ph, s
    downs = times[best::4]
    # drops: energy per bar vs the two bars before
    rms = []
    for i in range(len(downs)):
        a = int(downs[i] * sr)
        b = int(downs[i + 1] * sr) if i + 1 < len(downs) else min(len(y), a + int(4 * 60.0 / tempo * sr))
        seg = y[a:b]
        rms.append(float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0)
    drops = []
    for i in range(2, len(rms)):
        before = (rms[i - 1] + rms[i - 2]) / 2
        if before > 0 and rms[i] / before >= 1.4:
            drops.append({"t": round(float(downs[i]), 3), "ratio": round(rms[i] / before, 2)})
    drops.sort(key=lambda d: -d["ratio"])
    conf = float(np.mean(onv)) if len(onv) else 0.0
    print(json.dumps({
        "tempo": round(float(tempo), 3), "beats": [round(float(x), 4) for x in times],
        "downbeats": [round(float(x), 4) for x in downs], "drops": drops[:3], "duration": round(duration, 3),
        "confidence": round(conf, 3), "ms": int((time.time() - t0) * 1000),
    }))


if __name__ == "__main__":
    main()
