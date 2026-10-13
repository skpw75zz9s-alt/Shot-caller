# The soundtrack: each narration line at its scene's start, over a quiet, slow pad (tutorial only)
import json, sys, subprocess, numpy as np, wave
kind = sys.argv[1]; A = json.load(open(f'{kind}-audio.json')); SR = 44100; N = int((A['duration'] + 0.5) * SR)
mix = np.zeros(N)
if kind == 'tutorial':
    chords = [[220.0, 277.18, 329.63], [196.0, 246.94, 293.66], [174.61, 220.0, 261.63], [196.0, 246.94, 329.63]]  # A, G, F, G (soft)
    t = np.arange(N) / SR; seg = 8.0
    for i, ch in enumerate(chords * int(A['duration'] // (seg * 4) + 2)):
        a, b = int(i * seg * SR), int((i + 1) * seg * SR + 2 * SR)
        if a >= N: break
        b = min(b, N); tt = t[a:b] - t[a]; env = np.minimum(1, tt / 2.0) * np.minimum(1, np.maximum(0, (b - a) / SR - tt) / 2.0)
        for f in ch: mix[a:b] += env * (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * f * 2 * tt)) * 0.02
    fade = np.ones(N); fl = int(3 * SR); fade[:fl] = np.linspace(0, 1, fl); fade[-fl:] = np.linspace(1, 0, fl); mix *= fade
for x in A['audio']:
    with wave.open(f"vo/{x['id']}.wav") as w:
        v = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float) / 32768
    a = int(x['at'] * SR); mix[a:a + len(v)] += v[:max(0, N - a)]
mix = np.clip(mix, -0.98, 0.98)
with wave.open(f'{kind}-audio.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype(np.int16).tobytes())
print(kind, 'audio', round(len(mix) / SR, 1), 's')
