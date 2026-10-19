import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE, createVoice } from '../voice.js';

function fakeFetch(status = 200) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return { status, ok: status < 300, body: status < 300 ? Buffer.from('mp3') : null, headers: new Map([['content-type', 'audio/mpeg']]) }; };
  f.calls = calls;
  return f;
}

test('off without a key: 501, so the phone uses its own voice', async () => {
  const v = createVoice({ apiKey: '' });
  assert.equal(v.on(), false); assert.deepEqual(v.status(), { voice: false });
  assert.equal((await v.speak({ owner: 'a', text: 'hi' })).status, 501);
});

test('reads the text in the chosen voice: key in the header, text trimmed and capped', async () => {
  const f = fakeFetch(), v = createVoice({ apiKey: 'k', fetchImpl: f });
  const out = await v.speak({ owner: 'a', text: `  UP   is\nthe call. ${'x'.repeat(3000)}` });
  assert.equal(out.status, 200); assert.equal(out.type, 'audio/mpeg');
  const { url, opts } = f.calls[0], body = JSON.parse(opts.body);
  assert.match(url, new RegExp(`/v1/text-to-speech/${VOICE.id}/stream\\?output_format=`));
  assert.equal(VOICE.id, 'DEFpwxCUkrj3WAbTDRTZ');
  assert.equal(opts.headers['xi-api-key'], 'k');
  assert.ok(body.text.startsWith('UP is the call. x')); assert.equal(body.text.length, VOICE.maxChars);
  assert.equal(body.model_id, VOICE.model);
});

test('ELEVENLABS_VOICE_ID swaps the voice; a malformed one keeps it off', async () => {
  const f = fakeFetch();
  await createVoice({ apiKey: 'k', voiceId: 'abcDEF123456', fetchImpl: f }).speak({ owner: 'a', text: 'hi' });
  assert.match(f.calls[0].url, /text-to-speech\/abcDEF123456\//);
  assert.equal(createVoice({ apiKey: 'k', voiceId: '../x' }).on(), false);
});

test('errors come back clearly, and each person has a limit', async () => {
  assert.equal((await createVoice({ apiKey: 'k', fetchImpl: fakeFetch(401) }).speak({ owner: 'a', text: 'hi' })).status, 503);
  assert.equal((await createVoice({ apiKey: 'k', fetchImpl: fakeFetch(404) }).speak({ owner: 'a', text: 'hi' })).status, 503);
  assert.equal((await createVoice({ apiKey: 'k', fetchImpl: async () => { throw new Error('down'); } }).speak({ owner: 'a', text: 'hi' })).status, 502);
  assert.equal((await createVoice({ apiKey: 'k', fetchImpl: fakeFetch() }).speak({ owner: 'a', text: '  ' })).status, 400);
  const v = createVoice({ apiKey: 'k', fetchImpl: fakeFetch(), perMin: 1 });
  assert.equal((await v.speak({ owner: 'a', text: '1' })).status, 200);
  assert.equal((await v.speak({ owner: 'a', text: '2' })).status, 429);
  assert.equal((await v.speak({ owner: 'b', text: '1' })).status, 200);
});
