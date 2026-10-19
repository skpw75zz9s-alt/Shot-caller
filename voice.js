// Ask's spoken answers in one chosen voice (v13.48): the phone sends the answer's text, the server has ElevenLabs read it
// and streams back the MP3. Off unless ELEVENLABS_API_KEY is set (Railway variables); the phone then uses its own voice.
// The key stays on the server. ELEVENLABS_VOICE_ID swaps the voice; ELEVENLABS_MODEL the speech model (a fast one by
// default: the answer should start talking within a second or two). No dependencies: one fetch.

export const VOICE = { id: 'DEFpwxCUkrj3WAbTDRTZ', model: 'eleven_flash_v2_5', maxChars: 1500, format: 'mp3_44100_128' };

export function createVoice({ apiKey = process.env.ELEVENLABS_API_KEY, voiceId = process.env.ELEVENLABS_VOICE_ID || VOICE.id, model = process.env.ELEVENLABS_MODEL || VOICE.model,
  base = process.env.ELEVENLABS_API || 'https://api.elevenlabs.io', fetchImpl = fetch, perMin = 6, perHour = 60, now = () => Date.now() } = {}) {
  const hits = new Map(); // owner -> [times]
  const on = () => !!apiKey && /^[A-Za-z0-9]{8,64}$/.test(voiceId);
  function limited(owner) {
    const t = now(), list = (hits.get(owner) || []).filter((x) => t - x < 3600000);
    hits.set(owner, list);
    if (list.filter((x) => t - x < 60000).length >= perMin || list.length >= perHour) return true;
    list.push(t);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k);
    return false;
  }
  // { status, body } for errors (JSON), or { status: 200, audio: ReadableStream|Buffer, type } to pipe back
  async function speak({ owner, text }) {
    if (!on()) return { status: 501, body: { error: 'the server voice is off (no ELEVENLABS_API_KEY)', voice: false } };
    const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, VOICE.maxChars) : '';
    if (!t) return { status: 400, body: { error: 'nothing to say' } };
    if (limited(owner || 'anon')) return { status: 429, body: { error: 'too many spoken answers for now' } };
    let r;
    try {
      r = await fetchImpl(`${base}/v1/text-to-speech/${voiceId}/stream?output_format=${VOICE.format}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: t, model_id: model }),
        signal: AbortSignal.timeout?.(30000),
      });
    } catch { return { status: 502, body: { error: 'couldn\'t reach the voice service' } }; }
    if (r.status === 401 || r.status === 403) return { status: 503, body: { error: 'the voice key was refused: check ELEVENLABS_API_KEY in Railway' } };
    if (r.status === 404) return { status: 503, body: { error: 'that voice isn\'t available to this key: check ELEVENLABS_VOICE_ID' } };
    if (r.status === 429) return { status: 429, body: { error: 'the voice service is busy or out of characters' } };
    if (!r.ok || !r.body) return { status: 502, body: { error: `the voice service answered ${r.status}` } };
    return { status: 200, audio: r.body, type: r.headers.get('content-type') || 'audio/mpeg' };
  }
  return { on, speak, status: () => ({ voice: on() }) };
}
