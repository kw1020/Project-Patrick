# Sound for "What if you jumped into a hole through the Earth?": an original "space wonder" theme (pads, glock, pluck)
# scored to the cut, plus synthesized effects timed to story.ts, ducked under the voice, mixed to -14 LUFS.
import sys, os
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dsp import SR, ns, rng, lp, hp, bp, place, pan, st, dbg, integrated, read_wav, write_wav, make_ir, convolve_st
import instruments as I
import sfx_gen as G

FPS = 30; TOTAL = 1960; DUR = TOTAL / FPS; N = ns(DUR)
fr = lambda f: f / FPS
F = I.m2f
Q = 0.55
R0 = rng(4242)
def R(): return rng(int(R0.integers(1 << 30)))
music = np.zeros((2, N)); sfx = np.zeros((2, N)); amb = np.zeros((2, N))
def M(x, t, p=0.0, g=1.0): place(music, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def S(x, t, p=0.0, g=1.0): place(sfx, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def A(x, t, p=0.0, g=1.0): place(amb, pan(x, p) if np.ndim(x) == 1 else x, t, g)

# original arpeggio theme in A minor -> F -> C -> G
CH = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]]
def arps(t0, until, inst="glock", vel=0.45, pad=0.3, oct=12):
    t = t0; k = 0
    while t < until:
        c = CH[k % 4]
        if pad > 0: M(I.pad([F(m) for m in c[:3]], min(8 * Q, until - t), pad, R(), att=0.6, rel=0.8), t, 0.0)
        M(I.pluck(F(c[0] - 12), 0.45, R(), dur=1.2), t, -0.15)
        for i in range(8):
            tt = t + i * Q
            if tt >= until: break
            m = c[[0, 1, 2, 3, 2, 1, 2, 3][i]] + oct
            if inst == "glock": M(I.glock(F(m), vel, R()), tt, 0.15)
            else: M(I.musicbox(F(m), vel, R()), tt, 0.15)
        t += 8 * Q; k += 1

arps(0.2, fr(660))
M(I.pad([F(45), F(52), F(57)], fr(761) - fr(660), 0.35, R(), att=0.5), fr(660))
for k, m in enumerate([69, 72, 76, 81]): M(I.glock(F(m + 12), 0.5, R()), fr(700) + k * 0.15, 0.2)  # "magic"
arps(fr(761), fr(1088), inst="glock", vel=0.5, pad=0.35)
for k, m in enumerate([69, 73, 76, 81]): M(I.glock(F(m + 12), 0.55, R()), fr(1090) + k * 0.12, 0.15)  # Luckily
for k, m in enumerate([64, 63, 62, 61]): M(I.brass(F(m - 12), 0.32 if k < 3 else 1.0, 0.45, R(), "soft", scoop=-8, fall=(-2.5 if k == 3 else 0.0)), fr(1170) + k * 0.36, -0.1)
arps(fr(1278), fr(1866), inst="musicbox", vel=0.45, pad=0.3)
M(I.pad([F(45), F(52), F(57), F(64)], DUR - fr(1866), 0.4, R(), att=1.0, rel=1.5), fr(1866))
for j, m in enumerate([57, 64, 69, 72]): M(I.glock(F(m + 12), 0.5, R()), fr(1909) + j * 0.15, 0.1)

def rumble(dur, r, g=1.0):
    n = ns(dur); return g * 0.5 * lp(r.standard_normal(n), 90)
def fall_whoosh(dur, r):
    n = ns(dur); t = np.arange(n) / SR; u = t / dur
    sp = np.sin(np.pi * u)  # speed: zero at the ends, max at the centre
    x = bp(r.standard_normal(n), 200, 3000) * sp ** 1.5
    return 0.6 * x
def drill(dur, r):
    n = ns(dur); t = np.arange(n) / SR
    x = np.sign(np.sin(2 * np.pi * 42 * t)) * 0.3 + 0.4 * bp(r.standard_normal(n), 300, 2500) * (0.6 + 0.4 * np.sin(2 * np.pi * 6 * t))
    return 0.4 * lp(x, 3000)
def squish(r):
    n = ns(0.6); t = np.arange(n) / SR
    return 0.5 * np.sin(2 * np.pi * (500 * np.exp(-t / 0.15) + 80) * t) * np.exp(-t / 0.25) + 0.3 * lp(r.standard_normal(n), 1200) * np.exp(-t / 0.1)
def roll(dur, r):
    n = ns(dur); t = np.arange(n) / SR
    am = 0.5 + 0.5 * np.abs(np.sin(2 * np.pi * t / 1.7))
    return 0.25 * bp(r.standard_normal(n), 800, 4000) * am * (0.6 + 0.4 * np.sin(2 * np.pi * 31 * t))
def bubbles_lava(dur, r):
    out = np.zeros(ns(dur))
    for k in range(int(dur * 4)):
        i = ns(r.random() * dur); m = ns(0.25); tt = np.arange(m) / SR
        x = 0.3 * np.sin(2 * np.pi * (90 + 60 * r.random() + 200 * tt) * tt) * np.exp(-tt / 0.08)
        out[i:i + m] += x[:len(out) - i]
    return out

A(G.bird_chirps(fr(80), R(), density=0.5), 0.0, 0.3)
S(G.whoosh(1.0, R(), peak=0.4), fr(80) - 0.4)
A(G.breeze(fr(348) - fr(167), R(), level=1.0, bright=1500), fr(167))
S(drill(fr(348) - fr(167), R()), fr(167), 0.1, 0.8)
S(rumble(fr(660) - fr(413), R()), fr(413), 0.0, 1.0)
S(squish(R()), fr(600), 0.0)
A(G.bird_chirps(fr(761) - fr(660), R(), density=0.5), fr(660), 0.3)
S(G.whoosh(0.8, R(), peak=0.3), fr(744) - 0.2)
S(fall_whoosh(fr(1009) - fr(744), R()), fr(744), 0.0, 1.0)
A(G.water_bed(fr(1278) - fr(1009), R(), close=0.7, slosh_rate=0.9), fr(1009))
S(G.splash_big(R()), fr(1009), 0.0, 0.4)
S(G.whoosh(1.4, R(), peak=0.6), fr(1150))
for k in range(int((fr(1513) - fr(1278)) / 1.6)): S(fall_whoosh(1.6, R()), fr(1278) + 1.6 * k, 0.0, 0.5)
S(roll(fr(1618) - fr(1513), R()), fr(1513), 0.0)
A(G.bird_chirps(fr(1737) - fr(1618), R(), density=0.5), fr(1618), 0.3)
for t in np.arange(fr(1667) - 1.2, fr(1737), 2.4): S(G.whoosh(0.8, R(), peak=0.4), t, 0.0, 0.6)
for k in range(6): S(fall_whoosh(1.2 * 0.75 ** k, R()), fr(1737) + sum(1.2 * 0.75 ** j for j in range(k)), 0.0, 0.6 * 0.8 ** k)
S(rumble(DUR - fr(1866), R(), 0.6), fr(1866)); S(bubbles_lava(DUR - fr(1866), R()), fr(1866), 0.1)

voice, vsr = read_wav(sys.argv[1])
voice = st(voice[0] if voice.shape[0] == 1 else voice.mean(axis=0))
if vsr != SR:
    from scipy.signal import resample_poly
    voice = st(resample_poly(voice[0], SR, vsr))
vbuf = np.zeros((2, N)); place(vbuf, voice, 0.0)
ir = make_ir(1.8, 3)
music = 0.7 * music + 0.3 * convolve_st(music, ir)[:, :N]
sfx = 0.88 * sfx + 0.12 * convolve_st(sfx, ir)[:, :N]
env = lp(np.abs(vbuf[0]), 6); env = env / (np.percentile(env[env > 1e-4], 90) + 1e-9)
music *= 1 - 0.45 * np.clip(env, 0, 1)
def lufs(x): v = integrated(x); return v if np.isfinite(v) else -70
vbuf *= dbg(-16 - lufs(vbuf)); music *= dbg(-25 - lufs(music)); sfx *= dbg(-28 - lufs(sfx)); amb *= dbg(-36 - lufs(amb))
mix = vbuf + music + sfx + amb
mix *= dbg(-14 - lufs(mix))
if np.max(np.abs(mix)) > 0.89: mix = np.tanh(mix / 0.89) * 0.89
write_wav(sys.argv[2], mix[:, :N])
print("mix", round(N / SR, 2), "s  LUFS", round(lufs(mix), 1), " peak", round(float(np.max(np.abs(mix))), 3))
