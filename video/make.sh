#!/usr/bin/env bash
# Builds both videos (video/shot-caller-tutorial.mp4, video/shot-caller-disclaimer.mp4). Run from anywhere:
#   bash video/make.sh            re-render with the narration already in video/vo/
#   bash video/make.sh voice      first re-voice every line with ElevenLabs (needs ELEVENLABS_API_KEY and network access
#                                 to api.elevenlabs.io; VOICE_ID overrides the voice, default yj30vwTGJxSHezdAGsv9)
#   bash video/make.sh shots      first re-capture the app screenshots (runs the real app against video/mock.mjs)
#   bash video/make.sh ad         the 41-second ad (video/shot-caller-v13-ad.mp4, 1280x720, under Discord's 10 MB limit)
#   bash video/make.sh ad2        the v13.39 ad: 1080p60 with motion blur (video/shot-caller-v13.39-ad-1080p60.mp4) and a
#                                 720p60 copy under Discord's 10 MB limit (video/shot-caller-v13.39-ad-discord.mp4)
#   bash video/make.sh ad3        the v13.45 update video, the same way (video/shot-caller-v13.45-update-*.mp4)
#   bash video/make.sh ad4        the v13.59 update video, the same way (video/shot-caller-v13.59-update-*.mp4)
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = ad ]; then
  TUT_LEARN=on node adcap.mjs
  (cd .. && python3 -m http.server 8820 >/dev/null 2>&1) & SRV=$!; trap 'kill $SRV' EXIT; sleep 1
  node adrender.mjs full && python3 admusic.py
  P=$(mktemp -d)/x264
  ffmpeg -v error -y -i ad-silent.mp4 -c:v libx264 -preset slow -b:v 1500k -pass 1 -passlogfile "$P" -an -f mp4 /dev/null
  ffmpeg -v error -y -i ad-silent.mp4 -i ad-music.wav -c:v libx264 -preset slow -b:v 1500k -maxrate 2500k -bufsize 4000k -pass 2 -passlogfile "$P" -pix_fmt yuv420p -c:a aac -b:a 128k -shortest -movflags +faststart shot-caller-v13-ad.mp4
  echo "built video/shot-caller-v13-ad.mp4 ($(du -h shot-caller-v13-ad.mp4 | cut -f1))"; exit 0
fi
if [ "${1:-}" = ad2 ]; then
  node adcap2.mjs
  (cd .. && python3 -m http.server 8820 >/dev/null 2>&1) & SRV=$!; trap 'kill $SRV' EXIT; sleep 1
  for i in 0 1 2; do node adrender2.mjs worker $i 3 & done; wait
  python3 admusic2.py && bash ad2post.sh; exit 0
fi
if [ "${1:-}" = ad3 ]; then
  node adcap3.mjs
  (cd .. && python3 -m http.server 8820 >/dev/null 2>&1) & SRV=$!; trap 'kill $SRV' EXIT; sleep 1
  for i in 0 1 2 3; do AD=ad3 node adrender2.mjs worker $i 4 & done; wait
  AD=ad3 python3 admusic2.py && bash ad3post.sh; exit 0
fi
if [ "${1:-}" = ad4 ]; then
  node adcap4.mjs
  (cd .. && python3 -m http.server 8820 >/dev/null 2>&1) & SRV=$!; trap 'kill $SRV' EXIT; sleep 1
  for i in 0 1 2 3; do AD=ad4 node adrender2.mjs worker $i 4 & done; wait
  AD=ad4 python3 admusic2.py && bash ad4post.sh; exit 0
fi
if [ "${1:-}" = shots ]; then rm -f shots/boxes.json; node capture.mjs app; node capture.mjs buy; node capture.mjs loss; node capture.mjs site; fi
if [ "${1:-}" = voice ]; then mkdir -p vo; python3 tts_elevenlabs.py; fi
# the saved narration (video/voice/*.mp3: your ElevenLabs voice) when there's no fresh one in vo/
if [ ! -d vo ] && [ -d voice ]; then mkdir -p vo; for f in voice/*.mp3; do ffmpeg -v error -y -i "$f" -ar 44100 -ac 1 "vo/$(basename "$f" .mp3).wav"; done; fi
[ -d vo ] || { echo "No narration yet: run  bash video/make.sh voice"; exit 1; }
(cd .. && python3 -m http.server 8820 >/dev/null 2>&1) & SRV=$!; trap 'kill $SRV' EXIT; sleep 1
for k in disclaimer tutorial; do
  node render.mjs "$k"
  python3 audio.py "$k"
  ffmpeg -v error -y -i "$k-silent.mp4" -i "$k-audio.wav" -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart "shot-caller-$k.mp4"
  echo "built video/shot-caller-$k.mp4"
done
