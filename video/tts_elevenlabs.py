# Re-voices both videos with an ElevenLabs voice: each scene's line -> vo/<id>.wav (then: python3 relength.py, render, mux)
# Needs ELEVENLABS_API_KEY in the environment and network access to api.elevenlabs.io
import json, os, subprocess, urllib.request
VOICE = os.environ.get('VOICE_ID', 'yj30vwTGJxSHezdAGsv9'); KEY = os.environ['ELEVENLABS_API_KEY']
S = json.load(open('script.json'))
for kind in S:
    for sc in S[kind]:
        body = json.dumps({'text': sc['say'], 'model_id': 'eleven_multilingual_v2', 'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}}).encode()
        req = urllib.request.Request(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=mp3_44100_128', data=body, headers={'xi-api-key': KEY, 'content-type': 'application/json', 'accept': 'audio/mpeg'})
        open(f"vo/{sc['id']}.mp3", 'wb').write(urllib.request.urlopen(req, timeout=60).read())
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f"vo/{sc['id']}.mp3", '-af', 'loudnorm=I=-16:TP=-1.5', '-ar', '44100', '-ac', '1', f"vo/{sc['id']}.wav"], check=True)
        sc['dur'] = round(float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f"vo/{sc['id']}.wav"], capture_output=True, text=True).stdout), 2)
        print(kind, sc['id'], sc['dur'])
json.dump(S, open('script.json', 'w'), indent=1)
