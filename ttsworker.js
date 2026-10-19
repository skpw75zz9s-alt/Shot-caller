// The free voice's worker (v13.49): its own process, so the model's memory (most of a gigabyte while loaded) is given
// back the moment freevoice.js stops it, and a crash here never takes the server down. Asked { id, text, voice },
// answers { id, wav } or { id, error }, one at a time.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KOKORO, chunks, clauses, fixPhonemes, langOf, readVoices, styleFor, tokenize, wav } from './kokoro.js';

const dir = process.env.KOKORO_DIR;
let ready = null;
function load() {
  return (ready ||= (async () => {
    const [{ default: ort }, { phonemize }] = await Promise.all([import('onnxruntime-node'), import('phonemizer')]);
    const session = await ort.InferenceSession.create(join(dir, KOKORO.files.model.name), { intraOpNumThreads: Number(process.env.KOKORO_THREADS) || 4, graphOptimizationLevel: process.env.KOKORO_OPT || 'basic', enableCpuMemArena: false, enableMemPattern: false }); // no memory arena: ~200 MB less, a little slower
    const all = readVoices(await readFile(join(dir, KOKORO.files.voices.name)));
    const voices = new Map([...all].filter(([k]) => /^[ab][mf]_/.test(k))); // the English voices only (the file has 54)
    return { ort, phonemize, session, voices };
  })());
}

// one short piece through the model (its memory grows with the piece's length, so pieces stay under ~90 characters)
async function piece(text, voice, lang) {
  const { ort, phonemize, session } = await load();
  let ph = '';
  for (const c of clauses(text)) {
    if (c.words) ph += (await phonemize(c.words, lang)).join(' ');
    ph += c.punct ? `${c.punct} ` : ' ';
  }
  const ids = tokenize(fixPhonemes(ph));
  if (!ids.length) return new Float32Array(0);
  const out = await session.run({
    tokens: new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0].map(BigInt)), [1, ids.length + 2]),
    style: new ort.Tensor('float32', Float32Array.from(styleFor(voice, ids.length)), [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.from([Number(process.env.KOKORO_SPEED) || 1]), [1]),
  });
  return out.audio.data;
}
async function speak(text, voiceName) {
  const { voices } = await load();
  const name = voices.has(voiceName) ? voiceName : KOKORO.voice, voice = voices.get(name);
  if (!voice) throw new Error(`no voice ${voiceName}`);
  const gap = new Float32Array(Math.round(KOKORO.rate * 0.08)), parts = [];
  for (const c of chunks(text)) { const a = await piece(c, voice, langOf(name)); if (a.length) parts.push(a, gap); }
  if (!parts.length) throw new Error('nothing to say');
  const all = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of parts) { all.set(a, o); o += a.length; }
  return wav(all);
}

let chain = Promise.resolve();
process.on('message', (m) => {
  if (m?.type === 'warm') { chain = chain.then(() => load()).then(() => process.send({ type: 'warm' }), (e) => process.send({ type: 'warm', error: String(e?.message || e) })); return; }
  chain = chain.then(async () => {
    try { process.send({ id: m.id, wav: await speak(m.text, m.voice) }); }
    catch (e) { process.send({ id: m.id, error: String(e?.message || e) }); }
  });
});
process.on('disconnect', () => process.exit(0)); // the server went away: so does this
