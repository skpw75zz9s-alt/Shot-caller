# Makes the app's alert sounds (public/sounds/*.mp3), all synthesized here: no samples, no licenses.
#   bull.mp3      UP call: a snort and a bellow
#   bear.mp3      DOWN call: a growling roar
#   wait.mp3      sit out: a deep voice saying "Wait."
#   bail.mp3      sell signal: an alarm blip and a voice shouting "Bail!"
#   register.mp3  win: a cash register (key clunk, drawer, bell, coins)
# Needs numpy, scipy and ffmpeg (with libflite for the voices and libmp3lame).  Run: python3 scripts/make-sounds.py
import os, subprocess, tempfile, wave
import numpy as np
from scipy.signal import butter, sosfilt, resample_poly

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'sounds')
rng = np.random.default_rng(11)

def tt(d): return np.arange(int(d * SR)) / SR
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, b], 'band', fs=SR, output='sos'), x)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def env_adsr(n, a, r, sustain_end=None):
    t = np.arange(n) / SR; d = n / SR
    e = np.minimum(1, t / a) * np.minimum(1, np.maximum(0, (d - t) / r))
    return e
def glottal(f_curve, jitter=0.0, shimmer=0.0):
    # buzzy source: a sum of harmonics following a pitch curve, with a little roughness
    f = f_curve * (1 + jitter * lp(rng.standard_normal(len(f_curve)), 30) * 8)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = sum(np.sin(ph * k) / k ** 0.9 for k in range(1, 40))
    return s * (1 + shimmer * lp(rng.standard_normal(len(f_curve)), 60) * 6)
def formants(x, fs_bw):
    return sum(g * bp(x, f - bw / 2, f + bw / 2) for f, bw, g in fs_bw)
def norm(x, peak=0.95): return x / (np.max(np.abs(x)) + 1e-12) * peak
def drive(x, k): return np.tanh(x * k) / np.tanh(k)
def reverb(x, d=0.8, mix=0.18):
    n = int(d * SR); ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 6); ir = lp(ir, 5000); ir /= np.sqrt(np.sum(ir ** 2))
    wet = np.convolve(x, ir)[: len(x) + n]
    out = np.zeros(len(wet)); out[: len(x)] += x
    return out + mix * wet

# ---------- bear roar: low rough growl rising into an open-mouth roar, then falling ----------
def bear():
    d = 1.6; t = tt(d); n = len(t)
    f = 70 + 55 * np.sin(np.pi * np.minimum(1, t / 1.25)) ** 1.5           # pitch swells 70 -> 125 Hz and back
    src = glottal(f, jitter=0.08, shimmer=0.25)
    noise = rng.standard_normal(n) * (0.6 + 0.4 * np.sin(np.pi * np.minimum(1, t / 1.3)))
    open_ = np.sin(np.pi * np.minimum(1, t / 1.3)) ** 0.7                    # mouth opens: formants move up
    voiced = formants(src, [(320 + 280 * open_.mean(), 220, 1.0), (750, 400, 0.8), (1300, 500, 0.5), (2500, 900, 0.25)])
    breath = formants(noise, [(500, 500, 0.6), (1100, 700, 0.5), (2600, 1500, 0.25)])
    growl = 1 + 0.55 * np.sin(2 * np.pi * 28 * t + 3 * lp(rng.standard_normal(n), 10))   # throat flutter
    x = (voiced * 0.8 + breath * 0.9) * growl
    x = drive(norm(x), 2.5)
    e = np.minimum(1, t / 0.12) * np.exp(-np.maximum(0, t - 1.0) * 4.5)
    x = x * e
    x += 0.5 * lp(rng.standard_normal(n), 120) * np.exp(-t * 3) * e            # chest rumble
    return norm(reverb(x, 0.6, 0.12))

# ---------- bull: two quick nostril snorts, then a deep bellow ----------
def bull():
    parts = []
    for k in range(2):                                                       # snorts
        t = tt(0.16); s = bp(rng.standard_normal(len(t)), 600, 4500) * np.exp(-t * 18) * np.minimum(1, t / 0.008)
        s += 0.4 * bp(rng.standard_normal(len(t)), 150, 500) * np.exp(-t * 25)
        parts += [s * (0.9 if k else 0.7), np.zeros(int(0.07 * SR))]
    d = 1.15; t = tt(d)
    f = 155 * np.exp(-t * 0.5) - 25 * np.minimum(1, t / 0.9)                 # bellow: ~155 -> 105 Hz
    src = glottal(f, jitter=0.03, shimmer=0.12)
    vowel = np.minimum(1, t / 0.5)                                          # "mmm" -> "oww"
    x = formants(src, [(260 + 300 * vowel.mean(), 160, 1.0), (850, 300, 0.55), (2300, 700, 0.18)]) + 0.15 * bp(rng.standard_normal(len(t)), 400, 2500)
    x = drive(norm(x), 1.8) * np.minimum(1, t / 0.08) * np.exp(-np.maximum(0, t - 0.75) * 6)
    parts.append(x)
    return norm(reverb(np.concatenate(parts), 0.5, 0.12))

# ---------- voice lines (Flite through ffmpeg), pitched down and pumped up into an announcer ----------
def flite(text, voice='rms'):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'v.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f"flite=text='{text}':voice={voice}", '-ar', str(SR), '-ac', '1', p], check=True)
        with wave.open(p) as w: x = np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(float) / 32768
    nz = np.nonzero(np.abs(x) > 0.01)[0]
    return x[max(0, nz[0] - 200): nz[-1] + 2000] if len(nz) else x
def announcer(x, pitch=0.8, grit=1.6):
    up = resample_poly(x, 100, int(100 * pitch))                             # slower + deeper
    sub = resample_poly(x, 100, int(100 * pitch * 0.5))[: len(up)]           # an octave below for weight
    y = up + 0.25 * np.pad(sub, (0, len(up) - len(sub)))
    y = hp(y, 70) + 0.6 * bp(y, 2000, 5000)                                  # presence
    y = drive(norm(y), grit)
    slap = np.zeros(len(y) + int(0.09 * SR)); slap[: len(y)] += y; slap[int(0.09 * SR):] += 0.22 * y
    return norm(reverb(slap, 0.7, 0.15))
def wait():
    return announcer(flite('Wait.'), 0.78, 1.4)
def bail():
    t = tt(0.32); f = 1200 + 600 * (np.sin(2 * np.pi * 9 * t) > 0)          # two-tone alarm blip
    blip = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.25 * np.minimum(1, t / 0.01) * np.minimum(1, (0.32 - t) / 0.03)
    v = announcer(flite('Bail!'), 0.84, 2.2)
    return norm(np.concatenate([lp(blip, 4000), np.zeros(int(0.04 * SR)), v]))

# ---------- cash register: key clunk, drawer slide, bell "ching", coins ----------
def register():
    d = 1.5; n = int(d * SR); x = np.zeros(n)
    def put(s, at):
        i = int(at * SR); x[i: i + len(s)] += s[: n - i]
    t = tt(0.09); put(bp(rng.standard_normal(len(t)), 200, 2500) * np.exp(-t * 60) * 0.9, 0.0)                    # key
    t = tt(0.07); put(bp(rng.standard_normal(len(t)), 300, 3000) * np.exp(-t * 70) * 0.8, 0.09)                   # second key
    t = tt(0.35); put(bp(rng.standard_normal(len(t)), 150, 1200) * np.minimum(1, t / 0.02) * np.exp(-t * 9) * 0.6, 0.18)  # drawer rolls out
    t = tt(0.06); put(lp(rng.standard_normal(len(t)), 900) * np.exp(-t * 50) * 1.0, 0.5)                          # drawer stops: clunk
    t = tt(1.0)
    bell = sum(np.sin(2 * np.pi * f * t) * np.exp(-t * dc) * g for f, dc, g in ((2093, 3.5, 1.0), (2637, 4.2, 0.7), (3322, 5.5, 0.45), (4186, 7, 0.3), (5587, 9, 0.2)))
    put(bell * 0.45, 0.2); put(bell * 0.3, 0.27)                                                                    # the "ching"
    for k in range(9):                                                                                              # coins
        at = 0.55 + rng.random() * 0.45; f0 = 3500 + rng.random() * 3000; t = tt(0.12)
        put((np.sin(2 * np.pi * f0 * t) + 0.5 * np.sin(2 * np.pi * f0 * 1.41 * t)) * np.exp(-t * 40) * 0.12, at)
    return norm(reverb(x, 0.5, 0.15))

def save(name, x):
    os.makedirs(OUT, exist_ok=True)
    x = np.concatenate([x, np.zeros(int(0.05 * SR))]); fade = int(0.02 * SR); x[-fade:] *= np.linspace(1, 0, fade)
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'x.wav')
        with wave.open(p, 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', p, '-af', 'loudnorm=I=-14:TP=-1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', os.path.join(OUT, f'{name}.mp3')], check=True)
    print(f'{name}.mp3  {len(x) / SR:.2f}s')

if __name__ == '__main__':
    for name, fn in (('bull', bull), ('bear', bear), ('wait', wait), ('bail', bail), ('register', register)):
        save(name, fn())
