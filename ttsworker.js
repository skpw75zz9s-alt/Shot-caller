// The free voice's worker (v13.49): its own process, so the model's memory (most of a gigabyte while loaded) is given
// back the moment freevoice.js stops it, and a crash here never takes the server down. Asked { id, text, voice },
// answers { id, wav } or { id, error }, one at a time.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KOKORO, clauses, fixPhonemes, langOf, readVoices, styleFor, tokenize, wav } from './kokoro.js';

const dir = process.env.KOKORO_DIR;
let ready = null;
function load() {
  return (ready ||= (async () => {
    const [{ default: ort }, { phonemize }] = await Promise.all([import('onnxruntime-node'), import('phonemizer')]);
    const session = await ort.InferenceSession.create(join(dir, KOKORO.files.model.name), { intraOpNumThreads: Number(process.env.KOKORO_THREADS) || 4, graphOptimizationLevel: 'all' });
    const voices = readVoices(await readFile(join(dir, KOKORO.files.voices.name)));
    return { ort, phonemize, session, voices };
  })());
}

async function speak(text, voiceName) {
  const { ort, phonemize, session, voices } = await load();
  const voice = voices.get(voiceName) || voices.get(KOKORO.voice);
  if (!voice) throw new Error(`no voice ${voiceName}`);
  const lang = langOf(voices.has(voiceName) ? voiceName : KOKORO.voice);
  let ph = '';
  for (const c of clauses(text)) {
    if (c.words) ph += (await phonemize(c.words, lang)).join(' ');
    ph += c.punct ? `${c.punct} ` : ' ';
  }
  const ids = tokenize(fixPhonemes(ph));
  if (!ids.length) throw new Error('nothing to say');
  const out = await session.run({
    tokens: new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0].map(BigInt)), [1, ids.length + 2]),
    style: new ort.Tensor('float32', Float32Array.from(styleFor(voice, ids.length)), [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.from([Number(process.env.KOKORO_SPEED) || 1]), [1]),
  });
  return wav(out.audio.data);
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
