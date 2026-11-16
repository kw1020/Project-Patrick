# Sound for "The Great Emu War": an original oompah march (tuba, horns, fife, snare) scored to the cut, plus
# synthesized effects timed to the picture (story.ts), ducked under the voice. Uses the bridge template's own
# numpy instruments / dsp / sfx_gen modules (copied next to this file). Output: mix.wav (48 kHz stereo, exact length).
import sys, os
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dsp import SR, ns, tt, rng, lp, hp, bp, place, pan, st, dbg, integrated, read_wav, write_wav, make_ir, convolve_st, true_peak
import instruments as I
import sfx_gen as G

FPS = 30
TOTAL = 1990
DUR = TOTAL / FPS
N = ns(DUR)
fr = lambda f: f / FPS
F = I.m2f
Q = 0.5  # 120 bpm quarter

R0 = rng(1932)
def R():
    return rng(int(R0.integers(1 << 30)))

music = np.zeros((2, N)); sfx = np.zeros((2, N)); amb = np.zeros((2, N))
def M(x, t, p=0.0, g=1.0): place(music, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def S(x, t, p=0.0, g=1.0): place(sfx, pan(x, p) if np.ndim(x) == 1 else x, t, g)
def A(x, t, p=0.0, g=1.0): place(amb, pan(x, p) if np.ndim(x) == 1 else x, t, g)

# ---------------- music: original march in F ----------------
# (bar, beat, length in beats, midi)
THEME = [
    (1, 0, 1, 72), (1, 1, .5, 69), (1, 1.5, .5, 69), (1, 2, 1, 72), (1, 3, 1, 77),
    (2, 0, 1, 76), (2, 1, .5, 74), (2, 1.5, .5, 72), (2, 2, 2, 74),
    (3, 0, 1, 70), (3, 1, .5, 67), (3, 1.5, .5, 67), (3, 2, 1, 70), (3, 3, 1, 74),
    (4, 0, 1, 72), (4, 1, .5, 70), (4, 1.5, .5, 69), (4, 2, 2, 67),
    (5, 0, 1, 72), (5, 1, .5, 69), (5, 1.5, .5, 69), (5, 2, 1, 72), (5, 3, 1, 77),
    (6, 0, 1, 79), (6, 1, .5, 77), (6, 1.5, .5, 76), (6, 2, 1, 74), (6, 3, 1, 72),
    (7, 0, 1, 70), (7, 1, 1, 74), (7, 2, 1, 72), (7, 3, 1, 64),
    (8, 0, 2, 65),
]
CHORDS = {1: "F", 2: "C", 3: "Bb", 4: "C", 5: "F", 6: "C", 7: "Bb", 8: "F"}
CH = {"F": {"oom": [41, 36], "pah": [57, 60, 65]}, "C": {"oom": [36, 43], "pah": [55, 60, 64]}, "Bb": {"oom": [46, 41], "pah": [58, 62, 65]}}
SN = {"light": [1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 1], "march": [3, 0, 1, 1, 2, 0, 1, 0, 3, 0, 1, 1, 2, 0, 1, 0],
      "drive": [2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1]}

def band(t0, bars, until, lead="fife", lead_vel=0.55, oct=0, snare="march", sn_vel=0.5, tuba_vel=0.6, pah_vel=0.35, lead_inst=None):
    """play theme bars (list of bar numbers) back to back from t0, cutting everything at `until`"""
    for k, bar in enumerate(bars):
        tb = t0 + k * 4 * Q
        if tb >= until:
            break
        c = CH[CHORDS[bar]]
        for beat in range(4):
            t = tb + beat * Q
            if t >= until: break
            if tuba_vel > 0:
                M(I.brass(F(c["oom"][beat % 2]), 0.3, tuba_vel * (1 if beat % 2 == 0 else 0.88), R(), "tuba"), t, -0.1)
            if pah_vel > 0 and t + Q / 2 < until:
                for j, m in enumerate(c["pah"]):
                    M(I.brass(F(m), 0.15, pah_vel, R(), "horn", scoop=-12), t + Q / 2 + 0.004 * j, 0.3 - 0.12 * j)
        if snare:
            for s, v in enumerate(SN[snare]):
                t = tb + s * Q / 4
                if v and t < until:
                    M(I.snare(sn_vel * (0.45 + 0.2 * v), R()), t, 0.15)
        for (b, beat, d, m) in THEME:
            if b != bar: continue
            t = tb + beat * Q
            if t >= until: continue
            dur = min(d * Q * 0.92, until - t)
            if lead == "fife": M(I.fife(F(m + oct), dur, lead_vel, R()), t, 0.05)
            elif lead == "glock": M(I.glock(F(m + oct), lead_vel, R()), t, 0.1)
            elif lead == "pluck": M(I.pluck(F(m + oct), lead_vel, R()), t, -0.05)

# hook: snare roll building, a slide down on "And lost"
for (tr, vr) in I.snare_roll(0.25, 3.85, 0.15, 0.7, R()):
    M(I.snare(vr, R(), buzz=True), tr, 0.1)
M(I.timpani(F(41), 0.8, R()), 3.55)
for k, m in enumerate([65, 64, 63, 62]):
    M(I.brass(F(m - 12), 0.32 if k < 3 else 0.9, 0.7, R(), "horn", scoop=-10, fall=(-2.0 if k == 3 else 0.0)), fr(118) + 0.0 + k * 0.17, 0.0)
# march: shots 2-8 (the chase pushes the snare to "drive")
band(4.72, [1, 2, 3, 4, 5, 6, 7, 8], 20.72)
band(20.72, [1, 2, 3], 27.2, sn_vel=0.55)
band(26.72, [4, 5, 6, 7, 8], fr(1026), oct=12, snare="drive", sn_vel=0.62, tuba_vel=0.7, pah_vel=0.4, lead_vel=0.6)
M(I.cymbal(0.7, R()), fr(1026), 0.2)
# Luckily: little fanfare; Unluckily: sad trombone
for k, m in enumerate([65, 69, 72, 77]): M(I.glock(F(m + 12), 0.6, R()), fr(1030) + k * 0.12, 0.15)
M(I.triangle(0.4, R()), fr(1072))
for k, m in enumerate([62, 61, 60, 59]):
    M(I.brass(F(m - 12), 0.34 if k < 3 else 1.1, 0.6, R(), "horn", scoop=-8, fall=(-3.0 if k == 3 else 0.0)), fr(1118) + k * 0.36, -0.1)
# explanation (golden aerial + porch): light pluck and glock
band(39.25, [1, 2, 3, 4, 5, 6], 51.9, lead="glock", lead_vel=0.45, oct=12, snare=None, tuba_vel=0.0, pah_vel=0.0)
for k in range(6):
    tb = 39.25 + k * 2
    c = CH[CHORDS[k + 1]]
    for beat in range(4):
        M(I.pluck(F(c["oom"][beat % 2] + 12), 0.5, R(), dur=0.5), tb + beat * Q, -0.15)
# the major's quote and the farmer: the march comes back, softer
band(52.1, [1, 2, 3, 4], 60.0, lead_vel=0.45, snare="light", sn_vel=0.4, tuba_vel=0.5, pah_vel=0.28)
M(I.brass(F(29), 1.4, 0.8, R(), "tuba", scoop=-30, fall=-1.5), fr(1826), -0.1)  # "no"
# ending: last two bars, a stab + cymbal on "isn't"
band(61.4, [7, 8], 64.85, lead_vel=0.55, sn_vel=0.5)
for j, m in enumerate([53, 57, 60, 65, 69]): M(I.brass(F(m), 0.6, 0.75, R(), "stab", scoop=-6), fr(1946) + 0.004 * j, 0.3 - 0.12 * j)
M(I.brass(F(41), 0.9, 0.85, R(), "tuba"), fr(1946), -0.1)
M(I.cymbal(0.8, R()), fr(1946), 0.2)
M(I.snare(0.9, R()), fr(1946), 0.1)

# ---------------- effects ----------------
def gunshot(r, big=1.0):
    n = ns(0.5); t = np.arange(n) / SR
    crack = bp(r.standard_normal(n), 400, 5000) * np.exp(-t / 0.022)
    thump = np.sin(2 * np.pi * (70 + 60 * np.exp(-t / 0.02)) * t) * np.exp(-t / 0.07)
    return (0.8 * crack + 0.9 * thump) * big
def boing(r, f0=190, f1=420):
    n = ns(0.6); t = np.arange(n) / SR
    f = f0 + (f1 - f0) * (1 - np.exp(-t / 0.05)) + 25 * np.sin(2 * np.pi * 18 * t) * np.exp(-t / 0.2)
    return 0.6 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
def engine(dur, r, f0=26.0, f1=40.0, rough=0.4):
    n = ns(dur); t = np.arange(n) / SR
    f = f0 + (f1 - f0) * np.clip(t / max(dur, 1e-3), 0, 1) ** 0.5
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = sum(np.sin(k * ph) / k for k in range(1, 12))
    put = 0.6 + 0.4 * np.sign(np.sin(ph * 0.5))
    x = lp(x * put + rough * bp(r.standard_normal(n), 80, 600), 900)
    return 0.35 * x / (np.max(np.abs(x)) + 1e-9)
def thud(r, g=1.0):
    n = ns(0.35); t = np.arange(n) / SR
    return g * (np.sin(2 * np.pi * (55 + 40 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.08) + 0.3 * lp(r.standard_normal(n), 400) * np.exp(-t / 0.05))
def marble(r, f0=None):
    return G.clink(r, f0=f0 or (2200 + 1800 * r.random()), dur=0.09, bright=1.2)

A(G.breeze(34.2, R(), level=0.8), 0.0)
A(G.breeze(DUR - 51.9, R(), level=0.7), 51.9)
A(G.crickets(46.0 - 39.0, R()), 39.0, 0, 0.8)
A(G.crickets(57.6 - 52.0, R()), 52.0, 0, 0.8)
for t0, d in [(0.5, 4), (5, 8), (15, 4), (46, 5), (58, 6), (61.5, 4)]: A(G.bird_chirps(d, R(), density=0.35), t0, 0.3)
S(G.whoosh(0.7, R(), peak=0.35), fr(140) - 0.35)
for k in range(10): S(G.clink(R(), f0=700 + 300 * R0.random(), dur=0.05), 9.0 + 0.16 * k + 0.05 * R0.random(), 0.2, 0.5)  # pecking
S(thud(R(), 0.8), fr(396)); S(G.whoosh(0.9, R(), peak=0.45), fr(416))
for k in range(8): S(G.stroll_step(R(), 0.3), 17.3 + 0.27 * k, -0.2, 0.4)
for k, t in enumerate([22.42, 22.52, 22.62]): S(gunshot(R(), 0.9), t, 0.1)
S(G.clink(R(), f0=640, dur=0.25), fr(681)); S(G.rattle(0.45, R(), density=40), fr(681) + 0.03); S(boing(R(), 150, 300), fr(683))
for t in [fr(724), fr(745)]: S(G.hammer_hit(R(), 1.2), t, 0.1)
for k in range(5): S(thud(R(), 0.35), 25.85 + 0.12 * k)  # crank: putt-putt
S(engine(T := fr(817) - 26.2, R(), 24, 38), 26.2, -0.1, 0.9)
S(engine(fr(1028) - fr(817), R(), 38, 44, 0.6), fr(817), -0.1, 1.0)
S(G.whoosh(0.8, R(), peak=0.4), fr(785) - 0.4)
for k in range(int((fr(1028) - fr(817)) * 9)):
    S(G.stroll_step(R(), 0.1), fr(817) + k / 9 + 0.02 * R0.random(), 0.25, 0.35)  # emu feet
k = 0
while (tb := (k + 1) / 1.7) < fr(1028):
    if tb > fr(817): S(thud(R(), 0.8), tb, -0.1); S(G.rattle(0.25, R(), density=50), tb + 0.01, -0.2, 0.6)
    k += 1
for t in [fr(965), fr(979), fr(993)]: S(boing(R()), t, 0.0, 0.8)
for k in range(9): S(G.stroll_step(R(), 0.25), fr(1105) + 0.4 * k, 0.3, 0.4)
S(G.whoosh(1.2, R(), peak=0.5), fr(1293) - 0.3)
for k in range(40): S(G.stroll_step(R(), 0.1), fr(1293) + 0.05 * k + 0.05 * R0.random(), (R0.random() - 0.5), 0.3)
# marbles: the spill, rolling, a few knocks under the sofa
for k in range(30): S(marble(R()), 48.0 + 0.6 * R0.random() ** 1.5, (R0.random() - 0.5) * 0.8, 0.5)
roll_n = ns(3.0); rt = np.arange(roll_n) / SR
S(0.15 * bp(R().standard_normal(roll_n), 1500, 6000) * np.exp(-rt / 1.0) * (0.6 + 0.4 * np.sin(2 * np.pi * 23 * rt)), 48.2, 0.1)
for t in [49.6, 49.9, 50.3, 50.8]: S(marble(R(), 1500), t, 0.4, 0.5)
S(marble(R(), 3000), fr(1460), -0.2, 0.6)

# ---------------- mix ----------------
voice, vsr = read_wav(sys.argv[1])
if vsr != SR:
    from scipy.signal import resample_poly
    voice = np.vstack([resample_poly(c, SR, vsr) for c in voice])
voice = st(voice[0] if voice.shape[0] == 1 else voice.mean(axis=0))
vbuf = np.zeros((2, N)); place(vbuf, voice, 0.0)
ir = make_ir(1.1, 7)
music = 0.8 * music + 0.2 * convolve_st(music, ir)[:, :N]
sfx = 0.88 * sfx + 0.12 * convolve_st(sfx, ir)[:, :N]
# duck the music under the voice (fast attack, slow release)
env = lp(np.abs(vbuf[0]), 6)
env = env / (np.percentile(env[env > 1e-4], 90) + 1e-9)
duck = 1 - 0.5 * np.clip(env, 0, 1)
music *= duck
def lufs(x): v = integrated(x); return v if np.isfinite(v) else -70
vbuf *= dbg(-16 - lufs(vbuf))
music *= dbg(-27 + 3 - lufs(music))   # template rule: music +3 dB over the bed reference
sfx *= dbg(-27 - 6 + 6 - lufs(sfx))    # sfx -6 dB from the louder event reference
amb *= dbg(-36 - lufs(amb))
mix = vbuf + music + sfx + amb
mix *= dbg(-14 - lufs(mix))
pk = np.max(np.abs(mix))
if pk > 0.89: mix = np.tanh(mix / 0.89 * 1.0) * 0.89  # gentle limiter at about -1 dBFS
write_wav(sys.argv[2], mix[:, :N])
for name, x in [("music", music), ("sfx", sfx), ("amb", amb)]: write_wav(os.path.join(os.path.dirname(sys.argv[2]), f"stem_{name}.wav"), x[:, :N])
print("mix", round(N / SR, 2), "s  LUFS", round(lufs(mix), 1), " peak", round(float(np.max(np.abs(mix))), 3))
