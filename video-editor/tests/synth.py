"""Test fixtures: espeak speech plus crude synthetic dog-like sounds. These are stand-ins, NOT real dog recordings."""
import ctypes, math, os
import numpy as np
import espeakng_loader

def speech(text, voice=b"en-us", speed=150):
    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    rate = lib.espeak_Initialize(2, 0, os.path.dirname(espeakng_loader.get_data_path()).encode(), 0)
    lib.espeak_SetVoiceByName(voice)
    lib.espeak_SetParameter(1, speed, 0)
    chunks = []
    CB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
    def cb(wav, n, ev):
        if wav and n > 0:
            chunks.append(np.ctypeslib.as_array(wav, shape=(n,)).copy())
        return 0
    cbf = CB(cb); lib.espeak_SetSynthCallback(cbf)
    t = text.encode()
    lib.espeak_Synth(t, len(t) + 1, 0, 0, 0, 1, None, None)
    lib.espeak_Synchronize()
    x = np.concatenate(chunks).astype(np.float32) / 32768
    return x, rate

def resample(x, sr_from, sr_to):
    n = int(len(x) * sr_to / sr_from)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)

def breathing(sr, secs, seed=0):
    rng = np.random.default_rng(seed)
    n = int(sr * secs); noise = rng.standard_normal(n)
    k = np.ones(8) / 8; noise = np.convolve(noise, k, "same")      # soft low-passed noise
    env = 0.5 * (1 - np.cos(2 * np.pi * np.arange(n) / sr / 1.2 * 1.0))  # ~0.8 breaths/sec swell
    return (noise * env * 0.25).astype(np.float32)

def whine(sr, secs):
    n = int(sr * secs); t = np.arange(n) / sr
    f0 = 700 + 500 * np.sin(2 * np.pi * 0.9 * t) + 250 * t / secs      # rising wobbling whine
    ph = 2 * np.pi * np.cumsum(f0) / sr
    sig = np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph)
    env = np.minimum(1, np.minimum(t / 0.1, (secs - t) / 0.15))
    return (sig * env * 0.25).astype(np.float32)
