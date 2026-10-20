#!/usr/bin/env bash
# Finishing for the whole-bot ad (after AD=ad6 adrender2.mjs workers and AD=ad6 admusic2.py), same steps as ad5post.sh:
#   motion blur  the 120 fps render blended in pairs to 60 fps (a half-frame shutter)
#   grade        a vignette and a touch of contrast and color; light film grain on the master only (CRF 16: a sharper master)
#   outputs      shot-caller-ad-1080p60.mp4 (master) and shot-caller-ad-discord.mp4 (720p60, under 10 MB)
set -euo pipefail
cd "$(dirname "$0")"
L=$(mktemp); for f in $(ls ad6-seg-*.mp4 | sort -t- -k3 -n); do echo "file '$PWD/$f'" >> "$L"; done # however many workers rendered it
ffmpeg -v error -y -f concat -safe 0 -i "$L" -vf "tmix=frames=2:weights='1 1',select='not(mod(n\,2))',setpts=N/(60*TB),vignette=angle=PI/5,eq=contrast=1.04:saturation=1.07,format=yuv420p" \
  -r 60 -c:v libx264 -preset medium -crf 12 ad6-clean.mp4
ffmpeg -v error -y -i ad6-clean.mp4 -i ad6-music.wav -vf "noise=alls=2:allf=t,format=yuv420p" -c:v libx264 -preset slow -crf 16 -profile:v high -tune film -c:a aac -b:a 256k -shortest -movflags +faststart shot-caller-ad-1080p60.mp4
P=$(mktemp -d)/x264; DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 ad6-clean.mp4)
VB=$(python3 -c "print(int((8.9*8*1024*1024/$DUR - 128000)/1000))")k # about 9.3 MB total (Discord: 10 MB), audio 128 kbit/s
ffmpeg -v error -y -i ad6-clean.mp4 -vf "scale=1280:720:flags=lanczos" -c:v libx264 -preset slow -b:v $VB -pass 1 -passlogfile "$P" -an -f mp4 /dev/null
ffmpeg -v error -y -i ad6-clean.mp4 -i ad6-music.wav -vf "scale=1280:720:flags=lanczos" -c:v libx264 -preset slow -b:v $VB -maxrate $((${VB%k} * 2))k -bufsize $((${VB%k} * 3))k -pass 2 -passlogfile "$P" -pix_fmt yuv420p -c:a aac -b:a 128k -shortest -movflags +faststart shot-caller-ad-discord.mp4
ls -la shot-caller-ad-*.mp4
