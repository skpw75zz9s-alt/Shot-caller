# Shot Caller videos

The tutorial (about 2 min) and disclaimer (about 1 min), vertical 1080×1920 with narration and captions.

- `script.json`: every scene's narration (`say`), on-screen title, screenshot and highlights
- `shots/`: real app screenshots, taken by running the app against sample market data (`mock.mjs`, never real prices)
- `video.html`: the compositor (zoom, highlights, captions); `render.mjs` records it frame by frame
- `audio.py`: places each narration line at its scene and adds a quiet pad under the tutorial

```
bash video/make.sh voice     # re-voice with ElevenLabs, then build both videos
bash video/make.sh           # build with the narration already in video/vo/
bash video/make.sh shots     # re-capture the screenshots first (after app changes)
```

ElevenLabs needs `ELEVENLABS_API_KEY` set and network access to `api.elevenlabs.io`. `VOICE_ID` picks the voice
(default `yj30vwTGJxSHezdAGsv9`). The finished MP4s land in `video/` and aren't committed.
