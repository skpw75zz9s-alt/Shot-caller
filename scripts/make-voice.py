# Makes the spoken alerts (public/sounds/wait.mp3, bail.mp3) with Piper, a natural neural voice that runs offline.
#   Voice: Piper "en-us-libritts-high", speaker 135 (a deep male voice). Trained on LibriTTS (CC BY 4.0,
#   http://www.openslr.org/60/): commercial use is fine with credit, which the README and the Learn tab give.
#   Setup:  python3 -m venv .venv && .venv/bin/pip install piper-tts
#           curl -LO https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-libritts-high.tar.gz && tar xzf voice-en-us-libritts-high.tar.gz
#   Run:    PIPER=.venv/bin/piper MODEL=en-us-libritts-high.onnx python3 scripts/make-voice.py
import os, subprocess, tempfile

PIPER = os.environ.get('PIPER', 'piper')
MODEL = os.environ.get('MODEL', 'en-us-libritts-high.onnx')
SPEAKER = os.environ.get('SPEAKER', '135')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'sounds')
LINES = {'wait': ('Wait.', '1.15'), 'bail': ('Bail!', '0.9')}   # text, length scale (bigger = slower)

# warm and present, a little compression, a short room; normalized loud enough for a phone speaker
FX = 'highpass=f=70,equalizer=f=150:t=q:w=1:g=3,equalizer=f=3000:t=q:w=1.5:g=3,acompressor=threshold=-20dB:ratio=4:attack=5:release=80,aecho=0.8:0.5:40:0.12,loudnorm=I=-14:TP=-1'

os.makedirs(OUT, exist_ok=True)
for name, (text, scale) in LINES.items():
    with tempfile.TemporaryDirectory() as d:
        raw = os.path.join(d, 'v.wav')
        subprocess.run([PIPER, '-m', MODEL, '-c', MODEL + '.json', '--speaker', SPEAKER, '--length-scale', scale, '-f', raw], input=text.encode(), check=True, capture_output=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af', f'apad=pad_dur=0.25,{FX}', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', os.path.join(OUT, f'{name}.mp3')], check=True)
    print(f'{name}.mp3: "{text}"')
