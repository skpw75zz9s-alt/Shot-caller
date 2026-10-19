import test from 'node:test';
import assert from 'node:assert/strict';
import { createAskAI } from '../askai.js';

// a stand-in for the Anthropic client: the models list and a stream whose final message we choose
function fakeClient({ models = ['small-model', 'opus-new', 'opus-old'], reply = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'UP is the call.' }] }, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    models: { list: async function* () { for (const id of models) yield { id }; } },
    messages: { stream: (params) => { calls.push(params); return { finalMessage: async () => { if (fail) throw fail; return reply; } }; } },
  };
}

test('off without a key: 501, so the phone answers on its own', async () => {
  const ai = createAskAI({ apiKey: '' });
  assert.equal(ai.on(), false);
  const out = await ai.ask({ owner: 'a', question: 'buy?', facts: {} });
  assert.equal(out.status, 501); assert.equal(out.body.ai, false);
});

test('asks the newest Opus model the key lists, with the facts, the question and adaptive thinking', async () => {
  const c = fakeClient(), ai = createAskAI({ client: c });
  const out = await ai.ask({ owner: 'a', question: '  Is the lead safe? ', facts: { coin: 'BTC', line: { leadSide: 'UP' } }, history: [{ q: 'hi', a: 'hello' }, { q: 3 }] });
  assert.equal(out.status, 200); assert.equal(out.body.answer, 'UP is the call.');
  const p = c.calls[0];
  assert.equal(p.model, 'opus-new', 'the first Opus in the list, newest first');
  assert.deepEqual(p.thinking, { type: 'adaptive' });
  assert.match(p.system, /Never invent a number/);
  assert.equal(p.messages.length, 3, 'one past exchange (the malformed one dropped) and the question');
  assert.match(p.messages[2].content, /"leadSide":"UP"/); assert.match(p.messages[2].content, /Question: Is the lead safe\?$/);
});

test('ASK_MODEL wins over the list', async () => {
  const c = fakeClient(), ai = createAskAI({ client: c, model: 'my-model' });
  await ai.ask({ owner: 'a', question: 'q', facts: {} });
  assert.equal(c.calls[0].model, 'my-model');
});

test('a refusal, an empty answer and API errors each come back as a clear error (the phone keeps its own answer)', async () => {
  assert.equal((await createAskAI({ client: fakeClient({ reply: { stop_reason: 'refusal', content: [] } }) }).ask({ owner: 'a', question: 'q' })).status, 422);
  assert.equal((await createAskAI({ client: fakeClient({ reply: { stop_reason: 'end_turn', content: [] } }) }).ask({ owner: 'a', question: 'q' })).status, 502);
  const bad = await createAskAI({ client: fakeClient({ fail: Object.assign(new Error('no'), { status: 401 }) }) }).ask({ owner: 'a', question: 'q' });
  assert.equal(bad.status, 503); assert.match(bad.body.error, /ANTHROPIC_API_KEY/);
  assert.equal((await createAskAI({ client: fakeClient({ fail: Object.assign(new Error('busy'), { status: 429 }) }) }).ask({ owner: 'a', question: 'q' })).status, 429);
  assert.equal((await createAskAI({ client: fakeClient({ fail: new Error('network') }) }).ask({ owner: 'a', question: 'q' })).status, 502);
});

test('an empty question is refused, and each person gets a few questions a minute', async () => {
  let t = 1e12;
  const ai = createAskAI({ client: fakeClient(), perMin: 2, perHour: 3, now: () => t });
  assert.equal((await ai.ask({ owner: 'a', question: '   ' })).status, 400);
  assert.equal((await ai.ask({ owner: 'a', question: '1' })).status, 200);
  assert.equal((await ai.ask({ owner: 'a', question: '2' })).status, 200);
  assert.equal((await ai.ask({ owner: 'a', question: '3' })).status, 429, 'two a minute');
  assert.equal((await ai.ask({ owner: 'b', question: '1' })).status, 200, 'per person');
  t += 61000;
  assert.equal((await ai.ask({ owner: 'a', question: '3' })).status, 200);
  t += 61000;
  assert.equal((await ai.ask({ owner: 'a', question: '4' })).status, 429, 'three an hour');
});
