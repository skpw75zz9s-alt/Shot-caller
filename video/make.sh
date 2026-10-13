#!/usr/bin/env bash
# Builds both videos (video/shot-caller-tutorial.mp4, video/shot-caller-disclaimer.mp4). Run from anywhere:
#   bash video/make.sh            re-render with the narration already in video/vo/
#   bash video/make.sh voice      first re-voice every line with ElevenLabs (needs ELEVENLABS_API_KEY and network access
#                                 to api.elevenlabs.io; VOICE_ID overrides the voice, default yj30vwTGJxSHezdAGsv9)
#   bash video/make.sh shots      first re-capture the app screenshots (runs the real app against video/mock.mjs)
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = shots ]; then rm -f shots/boxes.json; node capture.mjs app; node capture.mjs buy; node capture.mjs loss; node capture.mjs site; fi
if [ "${1:-}" = voice ]; then mkdir -p vo; python3 tts_elevenlabs.py; fi
[ -d vo ] || { echo "No narration yet: run  bash video/make.sh voice"; exit 1; }
(cd .. && python3 -m http.server 8820 >/dev/null 2>&1) & SRV=$!; trap 'kill $SRV' EXIT; sleep 1
for k in disclaimer tutorial; do
  node render.mjs "$k"
  python3 audio.py "$k"
  ffmpeg -v error -y -i "$k-silent.mp4" -i "$k-audio.wav" -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart "shot-caller-$k.mp4"
  echo "built video/shot-caller-$k.mp4"
done
