# Sound for "What if you could run at the speed of sound?": a fast original chase tune (snare, tuba, fife) scored to
# the cut, plus synthesized effects timed to story.ts, ducked under the voice, mixed to -14 LUFS.
import sys, os
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dsp import SR, ns, rng, lp, hp, bp, place, pan, st, dbg, integrated, read_wav, write_wav, make_ir, convolve_st
import instruments as I
import sfx_gen as G

FPS = 30; TOTAL = 1745; DUR = TOTAL / FPS; N = ns(DUR)
fr = lambda f: f / FPS
F = I.m2f
Q = 0.4  # 150 bpm
R0 = rng(343)
def R(): return rng(int(R0.integers(1 << 30)))
music = np.zeros((2, N)); sfx = np.zeros((2, N)); amb = np.zeros((2, N))
def M(x, t, p=0.0, g=1.0): place(music, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def S(x, t, p=0.0, g=1.0): place(sfx, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def A(x, t, p=0.0, g=1.0): place(amb, pan(x, p) if np.ndim(x) == 1 else x, t, g)

# original 4-bar riff in D minor-ish, looped
RIFF = [(0, 0.5, 62), (0.5, 0.5, 65), (1, 0.5, 69), (1.5, 0.5, 67), (2, 1, 65), (3, 1, 62),
        (4, 0.5, 60), (4.5, 0.5, 64), (5, 0.5, 67), (5.5, 0.5, 65), (6, 1, 64), (7, 1, 60),
        (8, 0.5, 62), (8.5, 0.5, 65), (9, 0.5, 69), (9.5, 0.5, 72), (10, 1, 74), (11, 1, 69),
        (12, 0.5, 67), (12.5, 0.5, 65), (13, 0.5, 64), (13.5, 0.5, 60), (14, 2, 62)]
BASS = [38, 38, 36, 36, 38, 38, 33, 33]
def chase(t0, until, lead=True, vel=0.5, snare=True):
    t = t0; k = 0
    while t < until:
        bar = k % 4
        for beat in range(4):
            tb = t + beat * Q
            if tb >= until: break
            M(I.brass(F(BASS[(bar * 2 + beat // 2) % 8]), 0.18, 0.55, R(), "tuba", scoop=-25), tb, -0.1)
            if snare:
                M(I.snare(0.45 if beat % 2 else 0.6, R()), tb, 0.15)
                M(I.snare(0.25, R()), tb + Q / 2, 0.15)
        if lead:
            for (b, d, m) in RIFF:
                if b // 4 != bar: continue
                tt = t + (b % 4) * Q
                if tt < until: M(I.fife(F(m + 12), d * Q * 0.9, vel, R()), tt, 0.05)
        t += 4 * Q; k += 1

M(I.timpani(F(38), 0.6, R()), 0.2)
for (tr, vr) in I.snare_roll(0.4, fr(200), 0.1, 0.6, R()): M(I.snare(vr, R(), buzz=True), tr, 0.1)
chase(fr(202), fr(845))
for k, m in enumerate([62, 66, 69, 74]): M(I.glock(F(m + 12), 0.55, R()), fr(848) + k * 0.12, 0.15)
for k, m in enumerate([65, 64, 63, 62]): M(I.brass(F(m - 12), 0.3 if k < 3 else 1.0, 0.5, R(), "horn", scoop=-8, fall=(-2.5 if k == 3 else 0.0)), fr(940) + k * 0.33, -0.1)
chase(fr(1029), fr(1388), lead=False, snare=True)
chase(fr(1388), fr(1463), lead=True, vel=0.45)
M(I.brass(F(38), 1.3, 0.7, R(), "tuba", scoop=-30, fall=-2.0), fr(1465), -0.1)
for j, m in enumerate([62, 65, 69]): M(I.pluck(F(m), 0.4, R(), dur=0.6), fr(1590) + j * 0.3, 0.0)
for j, m in enumerate([50, 57, 62, 65, 69]): M(I.brass(F(m), 0.7, 0.7, R(), "stab", scoop=-6), fr(1703) + 0.004 * j, 0.2 - 0.1 * j)
M(I.cymbal(0.7, R()), fr(1703), 0.2)

def thud(r, g=1.0):
    n = ns(0.4); t = np.arange(n) / SR
    return g * (np.sin(2 * np.pi * (50 + 50 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.1) + 0.4 * lp(r.standard_normal(n), 500) * np.exp(-t / 0.06))
def boom(r):
    n = ns(1.6); t = np.arange(n) / SR
    crack = bp(r.standard_normal(n), 300, 6000) * np.exp(-t / 0.02)
    low = np.sin(2 * np.pi * (35 + 40 * np.exp(-t / 0.05)) * t) * np.exp(-t / 0.5)
    rumble = lp(r.standard_normal(n), 120) * np.exp(-t / 0.7)
    return 0.9 * crack + 1.2 * low + 0.8 * rumble
def roar(dur, r, rise=True):
    n = ns(dur); t = np.arange(n) / SR; u = t / dur
    x = bp(r.standard_normal(n), 150, 3000) * (u if rise else 1.0)
    return 0.5 * x
def screech(r, dur=0.7):
    n = ns(dur); t = np.arange(n) / SR
    f = 2400 + 300 * np.sin(2 * np.pi * 13 * t)
    return 0.3 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(1, (dur - t) / 0.1) + 0.2 * bp(r.standard_normal(n), 1500, 5000)
def splat(r):
    n = ns(0.25); t = np.arange(n) / SR
    return 0.6 * lp(r.standard_normal(n), 900) * np.exp(-t / 0.04) + 0.4 * np.sin(2 * np.pi * (300 - 800 * t) * t) * np.exp(-t / 0.06)
def kaching(r):
    out = np.zeros(ns(1.2))
    for k, f in enumerate([2093, 2637, 3136]):
        x = G.clink(r, f0=f, dur=0.6); i = ns(0.05 + 0.08 * k); out[i:i + len(x)] += x[:len(out) - i]
    return out
def rustle(dur, r, g=0.5):
    n = ns(dur); env = np.clip(lp(np.abs(r.standard_normal(n)), 8) * 4, 0, 1)
    return g * bp(r.standard_normal(n), 2000, 8000) * env

A(G.breeze(DUR, R(), level=0.5), 0.0)
A(G.bird_chirps(fr(202), R(), density=0.4), 0.0, 0.3)
S(thud(R(), 1.0), fr(202)); S(G.whoosh(0.9, R(), peak=0.2), fr(202))
S(G.whoosh(1.0, R(), peak=0.5), fr(235) - 0.5)
S(roar(fr(572) - fr(303), R()), fr(303), 0.0, 0.8)
S(splat(R()), fr(527), 0.1)
S(G.whoosh(1.2, R(), peak=0.8), fr(606) - 0.9); S(boom(R()), fr(606))
for k in range(26): S(G.clink(R(), f0=2500 + 3000 * R0.random(), dur=0.12), fr(664) + 0.6 * R0.random(), (R0.random() - 0.5) * 1.6, 0.6)
S(G.whoosh(0.8, R(), peak=0.5), fr(744) - 0.4, 0.4)
S(G.whoosh(1.2, R(), peak=0.3, f_lo=150, f_hi=900), fr(850))
S(G.clink(R(), f0=700, dur=0.1), fr(960)); S(G.clink(R(), f0=500, dur=0.1), fr(990))  # chewing / cutlery
S(roar(fr(1207) - fr(1029), R()), fr(1029), 0.0, 0.9)
S(roar(fr(1315) - fr(1207), R(), rise=False), fr(1207), 0.0, 0.15); S(roar(fr(1388) - fr(1315), R()), fr(1315), 0.0, 1.0)
S(screech(R()), fr(1400), 0.0); S(thud(R(), 1.3), fr(1465)); S(G.oof(R()), fr(1467), 0.0, 0.7)
S(kaching(R()), fr(1690), 0.1); S(rustle(1.4, R()), fr(1688), 0.2)

voice, vsr = read_wav(sys.argv[1])
voice = st(voice[0] if voice.shape[0] == 1 else voice.mean(axis=0))
if vsr != SR:
    from scipy.signal import resample_poly
    voice = st(resample_poly(voice[0], SR, vsr))
vbuf = np.zeros((2, N)); place(vbuf, voice, 0.0)
ir = make_ir(1.0, 5)
music = 0.8 * music + 0.2 * convolve_st(music, ir)[:, :N]
sfx = 0.9 * sfx + 0.1 * convolve_st(sfx, ir)[:, :N]
env = lp(np.abs(vbuf[0]), 6); env = env / (np.percentile(env[env > 1e-4], 90) + 1e-9)
music *= 1 - 0.5 * np.clip(env, 0, 1)
def lufs(x): v = integrated(x); return v if np.isfinite(v) else -70
vbuf *= dbg(-16 - lufs(vbuf)); music *= dbg(-25 - lufs(music)); sfx *= dbg(-26 - lufs(sfx)); amb *= dbg(-36 - lufs(amb))
mix = vbuf + music + sfx + amb
mix *= dbg(-14 - lufs(mix))
if np.max(np.abs(mix)) > 0.89: mix = np.tanh(mix / 0.89) * 0.89
write_wav(sys.argv[2], mix[:, :N])
print("mix", round(N / SR, 2), "s  LUFS", round(lufs(mix), 1), " peak", round(float(np.max(np.abs(mix))), 3))
