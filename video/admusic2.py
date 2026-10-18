# The v13.39 ad's soundtrack, synthesized here (no samples, nothing licensed): 124 bpm in F minor (Fm Db Ab Eb).
#   pad      supersaw chords through a low-pass that opens over each scene, sidechained to the kick, wide stereo
#   pluck    a 16th-note arpeggio, ping-pong delay
#   bass     sub sine + a little saw on the root, sidechained
#   drums    kick on the beat, clap on 2 and 4, offbeat hats (from the first cut), a fill into each cut
#   fx       a noise riser and a reversed swell into each cut, a sub drop + noise burst on it (video/ad2.html CUTS),
#            a filtered intro and a long final hit with a tail on the outro
#   master   a small Schroeder reverb on the pad and plucks, then a soft limiter
# Writes video/ad2-music.wav (48 kHz stereo).
import json, os, wave
import numpy as np
from scipy.signal import lfilter, butter, sosfilt

SR, BPM = 48000, 124
AD = os.environ.get('AD', 'ad2')  # AD=ad3: the v13.45 update video's cuts and soundtrack
meta = json.load(open(f'{AD}-cuts.json')) if os.path.exists(f'{AD}-cuts.json') else {'duration': 47.0, 'cuts': [0, 3.8, 10.2, 17.0, 23.2, 29.4, 36.0, 41.0]}
DUR, cuts = meta['duration'], meta['cuts']
N = int(SR * DUR); t = np.arange(N) / SR
beat = 60 / BPM; bar = 4 * beat
rng = np.random.default_rng(13)
note = lambda n: 440 * 2 ** ((n - 69) / 12)
saw = lambda f, tt, ph=0: 2 * ((tt * f + ph) % 1) - 1

def env(n, a, r):
    e = np.ones(n); ai, ri = int(a * SR), int(r * SR)
    if ai: e[:ai] = np.linspace(0, 1, ai)
    if ri: e[-ri:] *= np.linspace(1, 0, ri)
    return e

def lp(x, fc, order=2):
    return sosfilt(butter(order, min(fc, SR / 2 - 100) / (SR / 2), 'low', output='sos'), x)

def hp(x, fc, order=2):
    return sosfilt(butter(order, fc / (SR / 2), 'high', output='sos'), x)

chords = [[53, 56, 60], [49, 53, 56], [56, 60, 63], [51, 55, 58]]  # Fm Db Ab Eb
start, outro = cuts[1], cuts[-1]

# ---- sidechain envelope (kick on every beat from the first cut)
duck = np.ones(N)
kick = np.zeros(N); kl = int(0.4 * SR); kt = np.arange(kl) / SR
kshape = np.sin(2 * np.pi * (42 * kt + 110 / 28 * (1 - np.exp(-kt * 28)))) * np.exp(-kt * 7.5)
kshape += 0.25 * np.exp(-kt * 400) * rng.standard_normal(kl)  # click
bt = start
while bt < DUR - 0.5:
    i = int(bt * SR)
    if i + kl < N and not (outro - 0.05 < bt < outro + 1.6):
        kick[i:i + kl] += kshape * (0.55 if bt >= outro else 1.0)
        dl = int(0.28 * SR); duck[i:i + dl] = np.minimum(duck[i:i + dl], 0.25 + 0.75 * np.linspace(0, 1, dl) ** 1.5)
    bt += beat

# ---- pad: detuned supersaw, filter opening across each scene
padL = np.zeros(N); padR = np.zeros(N)
for k in range(int(DUR / (2 * bar)) + 1):
    a, b = int(k * 2 * bar * SR), min(N, int((k + 1) * 2 * bar * SR))
    if a >= N: break
    tt = t[a:b]; L = np.zeros(b - a); Rr = np.zeros(b - a)
    for n in chords[k % 4]:
        for j, d in enumerate((-0.12, -0.05, 0.0, 0.05, 0.12)):
            v = saw(note(n + 12) * (1 + d / 100), tt, j * 0.17)
            L += v * (1.2 - j * 0.2); Rr += v * (0.4 + j * 0.2)
    e = env(b - a, 0.5, 0.5); padL[a:b] = L * e / 18; padR[a:b] = Rr * e / 18
# filter sweep per scene (cutoff 500 Hz -> 4.5 kHz)
sweep = np.zeros(N)
for i, c in enumerate(cuts):
    e = cuts[i + 1] if i + 1 < len(cuts) else DUR
    a, b = int(c * SR), int(e * SR)
    sweep[a:b] = np.linspace(0, 1, b - a) ** 0.7
fc = 500 + 4000 * sweep
# block-wise variable low-pass
def varlp(x):
    y = np.zeros_like(x); blk = 2048; zi = None
    for s in range(0, len(x), blk):
        f = fc[min(s, len(fc) - 1)]
        bb, aa = butter(2, f / (SR / 2), 'low')
        if zi is None: zi = np.zeros(max(len(aa), len(bb)) - 1)
        y[s:s + blk], zi = lfilter(bb, aa, x[s:s + blk], zi=zi)
    return y
padL, padR = varlp(padL) * duck, varlp(padR) * duck

# ---- pluck arpeggio, 16ths, with a ping-pong delay
pl = np.zeros(N); sx = beat / 4; k = 0; tt0 = start - 2 * beat
while tt0 < DUR - 0.3:
    ch = chords[int(tt0 / (2 * bar)) % 4]; n = ch[[0, 1, 2, 1, 2, 0, 2, 1][k % 8]] + 24
    i = int(tt0 * SR); L = int(0.22 * SR)
    if i >= 0 and i + L < N:
        u = np.arange(L) / SR; f = note(n)
        pl[i:i + L] += (saw(f, u) * 0.5 + np.sin(2 * np.pi * f * u)) * np.exp(-u * 18) * (0.45 if tt0 >= outro else 1)
    tt0 += sx; k += 1
pl = lp(pl, 3800)
dly = int(beat * 0.75 * SR); plL = pl.copy(); plR = np.zeros(N)
for r in range(1, 5):
    g = 0.42 ** r
    if r % 2: plR[r * dly:] += pl[:-r * dly] * g
    else: plL[r * dly:] += pl[:-r * dly] * g

# ---- bass
bass = np.zeros(N); et = start
while et < DUR - 0.3:
    ch = chords[int(et / (2 * bar)) % 4]; i = int(et * SR); L = int(beat / 2 * SR * 0.92)
    if i + L < N and not (outro - 0.05 < et < outro + 1.6):
        u = np.arange(L) / SR; f = note(ch[0] - 24)
        bass[i:i + L] += (np.sin(2 * np.pi * f * u) + 0.22 * saw(f * 2, u)) * env(L, 0.004, 0.04)
    et += beat / 2
bass = lp(bass, 900) * duck

# ---- clap and hats
clap = np.zeros(N); hats = np.zeros(N)
cl = int(0.18 * SR); cs = hp(rng.standard_normal(cl), 900) * np.exp(-np.arange(cl) / SR * 26)
hl = int(0.05 * SR); hs = hp(rng.standard_normal(hl), 7000) * np.exp(-np.arange(hl) / SR * 80)
bt = start; n = 0
while bt < DUR - 0.4:
    if not (outro - 0.05 < bt < outro + 1.6):
        i = int(bt * SR)
        if n % 2 == 1 and i + cl < N: clap[i:i + cl] += cs * (0.5 if bt >= outro else 1)
        j = int((bt + beat / 2) * SR)
        if j + hl < N: hats[j:j + hl] += hs * (0.55 if bt >= outro else 1)
        j2 = int((bt + beat / 4 * 3) * SR)
        if j2 + hl < N and n % 4 == 3: hats[j2:j2 + hl] += hs * 0.5
    bt += beat; n += 1

# ---- transitions: riser + reversed swell into each cut, sub drop + burst on it
fx = np.zeros(N)
for c in cuts[1:]:
    a, b = int(max(0, c - 1.6) * SR), int(c * SR)
    u = np.linspace(0, 1, b - a)
    nz = rng.standard_normal(b - a)
    riser = np.zeros(b - a)
    for s in range(0, b - a, 2048):  # a band-pass climbing 400 Hz -> 9 kHz
        f0 = 400 * (9000 / 400) ** (s / (b - a)); blk = nz[s:s + 2048]
        riser[s:s + 2048] = sosfilt(butter(2, [f0 * 0.7 / (SR / 2), min(0.99, f0 * 1.4 / (SR / 2))], 'band', output='sos'), blk)
    fx[a:b] += riser * u ** 2.5 * 0.5
    i = b; L = int(1.1 * SR)
    if i + L < N:
        u2 = np.arange(L) / SR
        fx[i:i + L] += np.sin(2 * np.pi * (30 + 70 * np.exp(-u2 * 9)) * u2) * np.exp(-u2 * 3.2) * 0.9  # sub drop
        fx[i:i + int(0.4 * SR)] += hp(rng.standard_normal(int(0.4 * SR)), 2500) * np.exp(-np.arange(int(0.4 * SR)) / SR * 9) * 0.35
# intro: a filtered swell into the logo, a hit as it lands
iL = int(0.9 * SR); fx[:iL] += lp(rng.standard_normal(iL), 1500) * np.linspace(0, 0.3, iL)
L = int(1.5 * SR); u = np.arange(L) / SR; i = int(0.9 * SR)
fx[i:i + L] += np.sin(2 * np.pi * (36 + 60 * np.exp(-u * 7)) * u) * np.exp(-u * 2.2) * 0.9
# outro: a long cinematic hit (sub + chord stab + noise) with its own tail
i = int(outro * SR); L = min(N - i, int(5.5 * SR)); u = np.arange(L) / SR
stab = sum(saw(note(n + 12), u, j * 0.3) for j, n in enumerate(chords[0] + [chords[0][0] + 12])) / 4
fx[i:i + L] += (np.sin(2 * np.pi * (34 + 50 * np.exp(-u * 5)) * u) * 1.0 + lp(stab, 2200) * 0.5) * np.exp(-u * 0.9)

# ---- a small Schroeder reverb for the pad and plucks
def reverb(x, mix=0.25):
    out = np.zeros_like(x)
    for d, g in ((1557, 0.84), (1617, 0.83), (1491, 0.85), (1422, 0.86)):
        d = int(d * SR / 44100); b = np.zeros(d + 1); b[0] = 1; a = np.zeros(d + 1); a[0] = 1; a[d] = -g
        out += lfilter(b, a, x)
    for d, g in ((225, 0.7), (556, 0.7)):
        d = int(d * SR / 44100); b = np.zeros(d + 1); b[0] = -g; b[d] = 1; a = np.zeros(d + 1); a[0] = 1; a[d] = -g
        out = lfilter(b, a, out)
    return x * (1 - mix) + out * mix / 4

wetL = reverb(padL * 0.55 + plL * 0.28, 0.3); wetR = reverb(padR * 0.55 + plR * 0.28, 0.3)
drums = kick * 0.95 + clap * 0.35 + bass * 0.5 + fx * 0.8
L = wetL + drums + hats * 0.28
R = wetR + drums + hats * 0.22
mix = np.stack([L, R], 1)
fade = np.ones(N); fl = int(2.0 * SR); fade[-fl:] = np.linspace(1, 0, fl) ** 1.6; fade[:int(0.05 * SR)] = np.linspace(0, 1, int(0.05 * SR))
mix *= fade[:, None]
# soft limiter to about -1 dBFS
mix /= np.percentile(np.abs(mix), 99.9) / 0.8
mix = 0.89 * np.tanh(mix * 1.1)
with wave.open(f'{AD}-music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
print(f'{AD}-music.wav', DUR, 's')
