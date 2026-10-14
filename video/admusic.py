# The ad's music, synthesized here (no samples, nothing licensed): 41.4 s at 112 bpm, A minor (Am F C G).
#   pad     detuned saws through a soft low-pass, the chord changes every two bars, ducked by the kick
#   bass    the root on eighth notes from the first cut
#   drums   kick on every beat and an offbeat hat from the first cut, held back under the outro text
#   cuts    a rising noise swell into each scene change and a low hit on it (video/ad.html CUTS)
# Writes video/ad-music.wav (44.1 kHz stereo).
import json, os, wave
import numpy as np

SR, DUR, BPM = 44100, 41.4, 112
cuts = json.load(open('ad-cuts.json'))['cuts'] if os.path.exists('ad-cuts.json') else [0, 3.4, 9.4, 15.0, 21.0, 26.6, 31.8, 36.4]
N = int(SR * DUR); t = np.arange(N) / SR
beat = 60 / BPM
rng = np.random.default_rng(7)

def note(n):  # MIDI number -> Hz
    return 440 * 2 ** ((n - 69) / 12)

def saw(f, tt):
    return 2 * ((tt * f) % 1) - 1

def lowpass(x, a):  # one-pole
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):
        acc += a * (x[i] - acc); y[i] = acc
    return y

def env(n, a, r):
    e = np.ones(n)
    ai, ri = int(a * SR), int(r * SR)
    if ai: e[:ai] = np.linspace(0, 1, ai)
    if ri: e[-ri:] *= np.linspace(1, 0, ri)
    return e

chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G
bar = 4 * beat
mix = np.zeros((N, 2))

# pad
pad = np.zeros(N)
seg = 2 * bar
for k in range(int(DUR / seg) + 1):
    a, b = int(k * seg * SR), min(N, int((k + 1) * seg * SR))
    if a >= N: break
    tt = t[a:b]; ch = chords[k % 4]; s = np.zeros(b - a)
    for n in ch:
        for d in (-0.08, 0.0, 0.08):
            s += saw(note(n + 12) * (1 + d / 100), tt)
    pad[a:b] = s * env(b - a, 0.6, 0.6) / 9
pad = lowpass(pad, 0.06)

# kick, hats, bass from the first cut; quieter under the outro
start, outro = cuts[1], cuts[-1]
kick = np.zeros(N); hat = np.zeros(N); bass = np.zeros(N); duck = np.ones(N)
kl = int(0.35 * SR); kt = np.arange(kl) / SR
kshape = np.sin(2 * np.pi * (45 + 90 * np.exp(-kt * 30)) * kt) * np.exp(-kt * 9)
hl = int(0.05 * SR); hshape = rng.standard_normal(hl) * np.exp(-np.arange(hl) / SR * 90)
hshape = hshape - lowpass(hshape, 0.3)
bt = start
while bt < DUR - 0.4:
    i = int(bt * SR); w = 0.45 if bt >= outro else 1.0
    if i + kl < N: kick[i:i + kl] += kshape * w; duck[i:i + int(0.25 * SR)] = np.minimum(duck[i:i + int(0.25 * SR)], 0.35 + 0.65 * np.linspace(0, 1, int(0.25 * SR)))
    j = int((bt + beat / 2) * SR)
    if j + hl < N: hat[j:j + hl] += hshape * 0.5 * w
    bt += beat
et = start
while et < DUR - 0.3:
    k = int(et / (2 * bar)) % 4; i = int(et * SR); L = int(beat / 2 * SR * 0.9)
    if i + L < N:
        tt = np.arange(L) / SR; f = note(chords[k][0] - 12)
        bass[i:i + L] += (np.sin(2 * np.pi * f * tt) + 0.3 * saw(f, tt)) * env(L, 0.005, 0.05) * (0.5 if et >= outro else 1.0)
    et += beat / 2
bass = lowpass(bass, 0.12)

# swells into each cut, a hit on it
fx = np.zeros(N)
for c in cuts[1:]:
    a = int(max(0, c - 1.1) * SR); b = int(c * SR)
    nz = rng.standard_normal(b - a); ramp = np.linspace(0, 1, b - a) ** 2
    fx[a:b] += (nz - lowpass(nz, 0.05)) * ramp * 0.18
    hl2 = int(0.9 * SR)
    if b + hl2 < N:
        tt = np.arange(hl2) / SR
        fx[b:b + hl2] += np.sin(2 * np.pi * (38 + 40 * np.exp(-tt * 12)) * tt) * np.exp(-tt * 4.5) * 0.7
# the intro: a soft sweep and a hit as the logo lands
fx[: int(0.6 * SR)] += np.sin(2 * np.pi * np.linspace(200, 900, int(0.6 * SR)) * t[: int(0.6 * SR)]) * np.linspace(0, 0.15, int(0.6 * SR))

body = pad * duck * 0.55 + kick * 0.9 + bass * 0.45 + fx
mix[:, 0] = body + hat * 0.9 + pad * 0.08 * np.sin(2 * np.pi * 0.2 * t)
mix[:, 1] = body + hat * 0.6 - pad * 0.08 * np.sin(2 * np.pi * 0.2 * t)
fade = np.ones(N); fl = int(2.5 * SR); fade[-fl:] = np.linspace(1, 0, fl) ** 1.5
mix *= fade[:, None]
mix /= np.max(np.abs(mix)) / 0.89
with wave.open('ad-music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('ad-music.wav', DUR, 's')
