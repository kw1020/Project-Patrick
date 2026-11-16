# Sound for "What if you were the last person alive?": an original music-box theme (happy -> lonely -> cozy) scored
# to the cut, plus synthesized effects timed to the picture (story.ts), ducked under the voice, mixed to -14 LUFS.
# Uses the bridge template's numpy instruments / dsp / sfx_gen modules (copied next to this file).
import sys, os
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dsp import SR, ns, rng, lp, hp, bp, place, pan, st, dbg, integrated, read_wav, write_wav, make_ir, convolve_st
import instruments as I
import sfx_gen as G

FPS = 30; TOTAL = 1830; DUR = TOTAL / FPS; N = ns(DUR)
fr = lambda f: f / FPS
F = I.m2f
Q = 0.6  # 100 bpm
R0 = rng(2026)
def R(): return rng(int(R0.integers(1 << 30)))
music = np.zeros((2, N)); sfx = np.zeros((2, N)); amb = np.zeros((2, N))
def M(x, t, p=0.0, g=1.0): place(music, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def S(x, t, p=0.0, g=1.0): place(sfx, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def A(x, t, p=0.0, g=1.0): place(amb, pan(x, p) if np.ndim(x) == 1 else x, t, g)

THEME = [(1, 0, 1, 76), (1, 1, 1, 79), (1, 2, 2, 84), (2, 0, 1, 83), (2, 1, 1, 81), (2, 2, 2, 79), (3, 0, 1, 77), (3, 1, 1, 76), (3, 2, 2, 74),
         (4, 0, 1, 79), (4, 1, 1, 77), (4, 2, 2, 76), (5, 0, 1, 76), (5, 1, 1, 79), (5, 2, 1, 84), (5, 3, 1, 88), (6, 0, 2, 86), (6, 2, 2, 84),
         (7, 0, 1, 81), (7, 1, 1, 83), (7, 2, 1, 84), (7, 3, 1, 86), (8, 0, 4, 84)]
ROOT = {1: 48, 2: 43, 3: 41, 4: 43, 5: 48, 6: 43, 7: 41, 8: 48}
CHORD = {1: [60, 64, 67], 2: [59, 62, 67], 3: [57, 60, 65], 4: [59, 62, 67], 5: [60, 64, 67], 6: [59, 62, 67], 7: [57, 60, 65], 8: [60, 64, 67]}

def theme(t0, bars, until, lead="musicbox", vel=0.5, bass=True, padv=0.0, oct=0):
    for k, bar in enumerate(bars):
        tb = t0 + k * 4 * Q
        if tb >= until: break
        if bass:
            for beat in (0, 2):
                if tb + beat * Q < until: M(I.pluck(F(ROOT[bar] + (7 if beat == 2 else 0)), 0.45, R(), dur=0.8), tb + beat * Q, -0.15)
        if padv > 0: M(I.pad([F(m) for m in CHORD[bar]], min(4 * Q, until - tb), padv, R()), tb, 0.0)
        for (b, beat, d, m) in THEME:
            if b != bar: continue
            t = tb + beat * Q
            if t >= until: continue
            if lead == "musicbox": M(I.musicbox(F(m + oct), vel, R()), t, 0.1)
            elif lead == "vibes": M(I.vibes(F(m + oct), vel, R()), t, 0.1)
            elif lead == "glock": M(I.glock(F(m + oct), vel, R()), t, 0.1)

# happy start
theme(0.3, [1, 2, 3, 4, 5], fr(294))
M(I.triangle(0.35, R()), fr(189), 0.3)
# power plants: pad only; night: soft pad + shimmer on "Milky Way"
M(I.pad([F(48), F(55), F(60)], fr(401) - fr(294), 0.35, R(), att=1.0), fr(294))
M(I.pad([F(48), F(55), F(59), F(64)], fr(571) - fr(401), 0.45, R(), att=1.5, rel=1.5), fr(401))
for k, m in enumerate([72, 76, 79, 83, 84, 88]): M(I.glock(F(m), 0.4, R()), fr(530) + k * 0.13, 0.2)
# subway: low tension
M(I.pad([F(45), F(52), F(57), F(60)], fr(712) - fr(571), 0.4, R(), att=0.8, warm=600), fr(571))
# beans: a sad little pluck figure
for k, m in enumerate([67, 65, 64, 62, 60]): M(I.pluck(F(m), 0.5, R(), dur=0.5), fr(779) + k * 0.22, 0.0)
# the sports cars: walking bass + theme, stopped dead on "start"
theme(fr(823), [5, 6, 7], fr(985), vel=0.5)
M(I.brass(F(41), 1.2, 0.6, R(), "tuba", scoop=-30, fall=-1.5), fr(990), -0.1)
# Luckily / Unluckily
for k, m in enumerate([72, 76, 79, 84]): M(I.glock(F(m + 12), 0.55, R()), fr(1006) + k * 0.12, 0.15)
for k, m in enumerate([67, 66, 65, 64]): M(I.brass(F(m - 12), 0.34 if k < 3 else 1.0, 0.45, R(), "soft", scoop=-8, fall=(-2.5 if k == 3 else 0.0)), fr(1090) + k * 0.36, -0.1)
# the flashback city + the beach: warm full theme
theme(fr(1150), [1, 2, 3, 4, 5, 6, 7, 8], fr(1534), lead="vibes", vel=0.45, padv=0.3)
# the highway and the paper: theme thins out
M(I.pad([F(48), F(55), F(64)], fr(1634) - fr(1534), 0.3, R(), att=0.8), fr(1534))
theme(fr(1634), [1, 2], fr(1760), vel=0.45, bass=False)
# "All of them."
for j, m in enumerate([48, 55, 60, 64, 67]): M(I.brass(F(m), 0.7, 0.55, R(), "soft", scoop=-6), fr(1773) + 0.004 * j, 0.2 - 0.1 * j)
M(I.cymbal(0.45, R(), dur=2.4), fr(1773), 0.2); M(I.triangle(0.4, R()), fr(1789))

# ---------------- effects ----------------
def tone(f0, dur, r, rough=0.0):
    n = ns(dur); t = np.arange(n) / SR
    return np.sin(2 * np.pi * f0 * t) + rough * bp(r.standard_normal(n), f0 * 0.5, f0 * 4)
def thud(r, g=1.0):
    n = ns(0.35); t = np.arange(n) / SR
    return g * (np.sin(2 * np.pi * (55 + 40 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.08) + 0.3 * lp(r.standard_normal(n), 400) * np.exp(-t / 0.05))
def buzz(dur, r):
    n = ns(dur); t = np.arange(n) / SR
    f = 210 + 25 * np.sin(2 * np.pi * 7 * t) + 15 * np.sin(2 * np.pi * 0.7 * t)
    x = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.5 * t) ** 2)
    return 0.12 * lp(x, 2500)
def crank(r, dur=1.4):
    n = ns(dur); t = np.arange(n) / SR
    rr = 8 + 3 * np.sin(2 * np.pi * 1.1 * t)
    x = np.sin(2 * np.pi * np.cumsum(55 + 25 * np.abs(np.sin(np.pi * np.cumsum(rr) / SR))) / SR) * (0.6 + 0.4 * np.abs(np.sin(np.pi * np.cumsum(rr) / SR)))
    return 0.5 * lp(x + 0.3 * bp(r.standard_normal(n), 100, 900), 1200)
def hum(dur, r, f0=60.0):
    n = ns(dur); t = np.arange(n) / SR
    return 0.2 * (np.sin(2 * np.pi * f0 * t) + 0.5 * np.sin(2 * np.pi * 2 * f0 * t) + 0.2 * bp(r.standard_normal(n), 80, 400))
def power_down(r):
    n = ns(1.2); t = np.arange(n) / SR
    f = 120 * np.exp(-t / 0.4) + 25
    return 0.3 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.5)
def rustle(dur, r, g=0.4):
    n = ns(dur); env = np.clip(lp(np.abs(r.standard_normal(n)), 6) * 4, 0, 1)
    return g * bp(r.standard_normal(n), 2000, 8000) * env
def beep(r, f=1800):
    n = ns(0.09); t = np.arange(n) / SR
    return 0.25 * np.sin(2 * np.pi * f * t) * np.minimum(1, (0.09 - t) / 0.01)

A(G.breeze(fr(401), R(), level=0.6), 0.0)
A(G.bird_chirps(fr(294), R(), density=0.5), 0.0, 0.3)
S(G.clink(R(), f0=2400, dur=0.4), fr(189), 0.3, 0.6)                     # shop door bell
for k in range(2): S(beep(R()), fr(224) + 0.14 * k, 0.2)                  # car unlock beep-beep
S(G.crickets(1.4, R(), voices=1), fr(258), 0.1, 1.0)                       # "no line": a single cricket
S(hum(fr(381) + 0.2 - fr(294), R()), fr(294), 0.0, 0.8)
for tp in [353, 365, 381]: S(thud(R(), 0.9), fr(tp)); S(power_down(R()), fr(tp))
A(G.crickets(fr(571) - fr(401), R(), voices=3), fr(401), 0.0)
A(G.water_bed(fr(712) - fr(575), R(), close=1.2), fr(575), 0.0)
S(G.bubbles(fr(712) - fr(600), R(), rate=14.0), fr(600), 0.1)
S(buzz(fr(823) - fr(730), R()), fr(730), -0.2, 1.0)                       # flies on the rotten food
S(G.clink(R(), f0=900, dur=0.15), fr(782), 0.1)                           # can
for k in range(int((fr(985) - fr(823)) / 0.36)): S(G.stroll_step(R(), 0.3), fr(823) + 0.36 * k, 0.1, 0.5)
S(crank(R()), fr(987), 0.2); S(thud(R(), 0.6), fr(987) + 1.4, 0.2)
A(G.crickets(fr(1148) - fr(1068), R(), voices=2), fr(1068), 0.0, 0.7)
A(G.breeze(fr(1352) - fr(1148), R(), level=0.5), fr(1148))
for k in range(4): A(G.babble(fr(1352) - fr(1148), R(), base=110 + 40 * k, scale=1.0 + 0.1 * k), fr(1148), (k - 1.5) * 0.4, 0.5)
for t in [fr(1250), fr(1290), fr(1320)]: S(G.hammer_hit(R(), 0.5), t, 0.3)
A(G.water_bed(fr(1534) - fr(1352), R(), close=0.8, slosh_rate=1.1), fr(1352))
for k in range(5): S(G.whoosh(0.9, R(), peak=0.5, f_lo=200, f_hi=1500), fr(1440) + 0.9 * k - 0.3, -0.2, 0.7)
A(G.bird_chirps(fr(1634) - fr(1534), R(), density=0.7), fr(1534), 0.2)
A(G.breeze(DUR - fr(1534), R(), level=0.5), fr(1534))
S(rustle(fr(1757) - fr(1640), R()), fr(1640), 0.1)
S(G.whoosh(1.2, R(), peak=0.4), fr(1757) - 0.2)

# ---------------- mix ----------------
voice, vsr = read_wav(sys.argv[1])
voice = st(voice[0] if voice.shape[0] == 1 else voice.mean(axis=0))
if vsr != SR:
    from scipy.signal import resample_poly
    voice = st(resample_poly(voice[0], SR, vsr))
vbuf = np.zeros((2, N)); place(vbuf, voice, 0.0)
ir = make_ir(1.4, 9)
music = 0.75 * music + 0.25 * convolve_st(music, ir)[:, :N]
sfx = 0.88 * sfx + 0.12 * convolve_st(sfx, ir)[:, :N]
env = lp(np.abs(vbuf[0]), 6); env = env / (np.percentile(env[env > 1e-4], 90) + 1e-9)
music *= 1 - 0.45 * np.clip(env, 0, 1)
def lufs(x): v = integrated(x); return v if np.isfinite(v) else -70
vbuf *= dbg(-16 - lufs(vbuf)); music *= dbg(-25 - lufs(music)); sfx *= dbg(-28 - lufs(sfx)); amb *= dbg(-35 - lufs(amb))
mix = vbuf + music + sfx + amb
mix *= dbg(-14 - lufs(mix))
if np.max(np.abs(mix)) > 0.89: mix = np.tanh(mix / 0.89) * 0.89
write_wav(sys.argv[2], mix[:, :N])
print("mix", round(N / SR, 2), "s  LUFS", round(lufs(mix), 1), " peak", round(float(np.max(np.abs(mix))), 3))
