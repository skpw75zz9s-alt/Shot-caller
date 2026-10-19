import test from 'node:test';
import assert from 'node:assert/strict';
import { KOKORO, VOCAB, chunks, clauses, fixPhonemes, langOf, normalize, readVoices, styleFor, tokenize, voiceOk, wav } from '../kokoro.js';

test('numbers, money and symbols are said the way a person says them', () => {
  assert.equal(normalize('UP leads by $1,234.5 (59%), 56¢ ask; 0.25× the move'), 'up leads by 1234.5 dollars (59 percent), 56 cents ask; 0.25 times the move');
  assert.equal(normalize('BTC is at $100,259'), 'Bitcoin is at 100259 dollars');
  assert.equal(normalize('**bold** `code`'), 'bold code');
});

test('pauses on punctuation, never on a decimal point', () => {
  assert.deepEqual(clauses('Not safe: up by $0.0006, thin.'), [{ words: 'Not safe', punct: ':' }, { words: 'up by 0.0006 dollars', punct: ',' }, { words: 'thin', punct: '.' }]);
});

test('an answer is read in short pieces: the first sentence alone so speech starts sooner, the rest packed to a limit', () => {
  const c = chunks('Fairly safe, not locked. UP leads by $0.0006 with six minutes left. Bitcoin usually still moves about $95 in that time. Rounds like this finished UP 81% of the time.', 120);
  assert.equal(c[0], 'Fairly safe, not locked.');
  assert.ok(c.every((x) => x.length <= 120));
  assert.ok(c.join(' ').includes('0.0006 dollars'), 'decimals stay whole');
  assert.equal(chunks('x'.repeat(500), 220).length, 3, 'a sentence longer than the limit is cut');
});

test('phonemes map onto the model\'s alphabet; unknown symbols are dropped; long input is capped', () => {
  assert.equal(fixPhonemes('ðə rˈɛd  kˈɑːx'), 'ðə ɹˈɛd kˈɑːk');
  assert.deepEqual(tokenize('a b'), [VOCAB.a, VOCAB[' '], VOCAB.b]);
  assert.deepEqual(tokenize('a😀b'), [VOCAB.a, VOCAB.b]);
  assert.equal(tokenize('a'.repeat(900)).length, KOKORO.maxTokens);
});

test('British voices read British English; voice names are checked', () => {
  assert.equal(langOf('bm_george'), 'en-gb'); assert.equal(langOf('am_michael'), 'en-us');
  assert.equal(voiceOk('bm_george'), true); assert.equal(voiceOk('../etc'), false); assert.equal(voiceOk(null), false);
});

// a tiny .npz built the way numpy writes one (stored, ZIP64 extra field with the real size)
function npz(entries) {
  const parts = [];
  for (const [name, arr] of entries) {
    const header = Buffer.from("{'descr': '<f4', 'fortran_order': False, 'shape': (" + arr.length + ',), }'.padEnd(54) + '\n');
    const npy = Buffer.concat([Buffer.from([0x93]), Buffer.from('NUMPY'), Buffer.from([1, 0]), Buffer.from(Uint16Array.of(header.length).buffer), header, Buffer.from(Float32Array.from(arr).buffer)]);
    const fn = Buffer.from(`${name}.npy`), extra = Buffer.alloc(20);
    extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); extra.writeBigUInt64LE(BigInt(npy.length), 4); extra.writeBigUInt64LE(BigInt(npy.length), 12);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(0, 8); h.writeUInt32LE(0xffffffff, 18); h.writeUInt32LE(0xffffffff, 22); h.writeUInt16LE(fn.length, 26); h.writeUInt16LE(extra.length, 28);
    parts.push(h, fn, extra, npy);
  }
  return Buffer.concat([...parts, Buffer.from([0x50, 0x4b, 0x01, 0x02])]);
}

test('reads the voices file (numpy .npz with ZIP64 headers), and picks the style row for a sentence length', () => {
  const v = readVoices(npz([['bm_george', [...Array(512)].map((_, i) => i)], ['am_adam', [1, 2, 3]]]));
  assert.deepEqual([...v.keys()], ['bm_george', 'am_adam']);
  assert.equal(v.get('bm_george').length, 512); assert.equal(v.get('bm_george')[511], 511);
  assert.deepEqual([...styleFor(v.get('bm_george'), 1)].slice(0, 2), [256, 257]);
  assert.equal(styleFor(v.get('bm_george'), 99)[0], 256, 'past the last row: the last row');
});

test('WAV: 24 kHz 16-bit mono, clipped to range', () => {
  const b = wav(Float32Array.of(0, 1, -1, 2));
  assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt32LE(24), 24000); assert.equal(b.readUInt16LE(34), 16);
  assert.deepEqual([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48), b.readInt16LE(50)], [0, 32767, -32767, 32767]);
});
