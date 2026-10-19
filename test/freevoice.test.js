import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KOKORO } from '../kokoro.js';
import { createFreeVoice } from '../freevoice.js';

// a stand-in worker: answers warm-up and each request (or fails/hangs on cue) without loading any model
function fakeFork({ fail = null, die = false, signal = null } = {}) {
  const made = [];
  const f = () => {
    const c = new EventEmitter();
    c.sent = []; c.killed = false;
    c.send = (m) => { c.sent.push(m); setImmediate(() => {
      if (m.type === 'warm') return c.emit('message', { type: 'warm' });
      if (die) { c.emit('exit', signal ? null : 1, signal); return; }
      c.emit('message', fail ? { id: m.id, error: fail } : { id: m.id, wav: Buffer.from(`wav:${m.voice}:${m.text}`) });
    }); };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)); };
    made.push(c);
    return c;
  };
  f.made = made;
  return f;
}
// the model files already downloaded, at their real sizes (sparse, so nothing big is written)
function readyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kokoro-'));
  for (const f of Object.values(KOKORO.files)) { writeFileSync(join(dir, f.name), ''); writeFileSync(join(dir, f.name), Buffer.alloc(0)); }
  return dir;
}
import { truncateSync } from 'node:fs';
function sized(dir) { for (const f of Object.values(KOKORO.files)) truncateSync(join(dir, f.name), f.size); return dir; }

test('off: 501, so the phone uses its own voice', async () => {
  const v = createFreeVoice({ dir: readyDir(), enabled: false });
  assert.equal((await v.speak({ owner: 'a', text: 'hi' })).status, 501);
  assert.equal(v.status().free, false);
});

test('starts the worker on the first answer, reads in the chosen voice, reuses it, and stops it when quiet', async () => {
  const fork = fakeFork(), v = createFreeVoice({ dir: sized(readyDir()), forkImpl: fork, idleMs: 40, fetchImpl: () => { throw new Error('no download needed'); } });
  assert.equal(v.status().freeLoaded, false, 'nothing loaded until someone listens');
  const a = await v.speak({ owner: 'a', text: '  Fairly   safe. ' });
  assert.equal(a.status, 200); assert.equal(a.type, 'audio/wav'); assert.equal(a.audio.toString(), 'wav:bm_george:Fairly safe.');
  assert.equal((await v.speak({ owner: 'a', text: 'Again', voice: 'am_michael' })).audio.toString(), 'wav:am_michael:Again');
  assert.equal((await v.speak({ owner: 'a', text: 'Bad name', voice: '../x' })).audio.toString(), 'wav:bm_george:Bad name');
  assert.equal(fork.made.length, 1, 'one worker for all of them');
  assert.equal(v.status().freeLoaded, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fork.made[0].killed, true, 'stopped after the quiet spell'); assert.equal(v.status().freeLoaded, false);
  await v.speak({ owner: 'a', text: 'Back' });
  assert.equal(fork.made.length, 2, 'started again when needed');
  v.stop();
});

test('downloads the model once (via a .part file), and says so while it is missing', async () => {
  const dir = readyDir(), calls = [];
  const fetchImpl = async (url) => { calls.push(url); const name = url.split('/').pop(), f = Object.values(KOKORO.files).find((x) => x.name === name);
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(f.size)); c.close(); } }) }; };
  const v = createFreeVoice({ dir, forkImpl: fakeFork(), fetchImpl });
  assert.equal((await v.speak({ owner: 'a', text: 'hi' })).status, 200);
  assert.equal(calls.length, 2); assert.ok(calls.every((u) => u.startsWith(KOKORO.base)));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.part')), []);
  await v.speak({ owner: 'a', text: 'again' });
  assert.equal(calls.length, 2, 'not downloaded twice');
  v.stop();
  const broken = createFreeVoice({ dir: readyDir(), forkImpl: fakeFork(), fetchImpl: async () => ({ ok: false, status: 404 }) });
  const out = await broken.speak({ owner: 'a', text: 'hi' });
  assert.equal(out.status, 503); assert.match(out.body.error, /download/);
});

test('a worker error or crash comes back as an error (the phone falls back), and the next answer starts a fresh worker', async () => {
  const bad = createFreeVoice({ dir: sized(readyDir()), forkImpl: fakeFork({ fail: 'boom' }) });
  const e = await bad.speak({ owner: 'a', text: 'hi' });
  assert.equal(e.status, 503); assert.match(e.body.error, /boom/);
  bad.stop();
  const fork = fakeFork({ die: true }), dies = createFreeVoice({ dir: sized(readyDir()), forkImpl: fork });
  assert.equal((await dies.speak({ owner: 'a', text: 'hi' })).status, 503);
  await dies.speak({ owner: 'a', text: 'hi' });
  assert.equal(fork.made.length, 2);
  dies.stop();
});

test('an empty text is refused, and each person has a limit', async () => {
  const v = createFreeVoice({ dir: sized(readyDir()), forkImpl: fakeFork(), perMin: 2 });
  assert.equal((await v.speak({ owner: 'a', text: '  ' })).status, 400);
  assert.equal((await v.speak({ owner: 'a', text: '1' })).status, 200);
  assert.equal((await v.speak({ owner: 'a', text: '2' })).status, 200);
  assert.equal((await v.speak({ owner: 'a', text: '3' })).status, 429);
  assert.equal((await v.speak({ owner: 'b', text: '1' })).status, 200);
  v.stop();
});

test('killed for memory: says so plainly, and two crashes pause the free voice instead of retrying into the limit', async () => {
  let t = 1e12;
  const fork = fakeFork({ die: true, signal: 'SIGKILL' }), v = createFreeVoice({ dir: sized(readyDir()), forkImpl: fork, now: () => t });
  const a = await v.speak({ owner: 'a', text: 'hi' });
  assert.equal(a.status, 503); assert.match(a.body.error, /ran out of memory/);
  assert.match(v.status().freeError, /ran out of memory/);
  assert.equal(v.status().free, true, 'one crash: still on');
  await v.speak({ owner: 'a', text: 'hi' });
  assert.equal(v.status().free, false, 'two in ten minutes: paused');
  const p = await v.speak({ owner: 'a', text: 'hi' });
  assert.equal(p.status, 503); assert.equal(p.body.paused, true); assert.equal(fork.made.length, 2, 'no third worker while paused');
  t += 1800001;
  assert.equal(v.status().free, true, 'back after half an hour');
  v.stop();
});
