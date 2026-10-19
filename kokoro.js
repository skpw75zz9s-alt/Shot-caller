// The free natural voice (v13.49): Kokoro, an open text-to-speech model (Apache-2.0, 82M parameters), run on this
// server, so answers are read in a human-sounding voice with no per-character bill. This file is the pure part (text
// clean-up, phonemes to tokens, the voices file, WAV); ttsworker.js runs the model in its own process and freevoice.js
// starts and stops that process. Model files: the kokoro-onnx project's release on GitHub (MIT).

import { speechChunks } from './public/ask.js';

export const KOKORO = {
  voice: 'bm_george', // a warm British male voice; KOKORO_VOICE swaps it (bm_lewis, bm_daniel, bm_fable, am_michael…)
  rate: 24000,
  base: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0',
  files: { model: { name: 'kokoro-v1.0.fp16.onnx', size: 177464787 }, voices: { name: 'voices-v1.0.bin', size: 28214398 } },
  maxTokens: 509, // the model's limit, minus the two pad tokens
};
// the model's phoneme alphabet (Kokoro v1.0's config)
export const VOCAB = {";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177};

// British voices (b…) read British English, the rest American
export const langOf = (voice) => (/^b/.test(voice) ? 'en-gb' : 'en-us');
export const voiceOk = (v) => typeof v === 'string' && /^[a-z]{2}_[a-z]{2,16}$/.test(v);

// numbers, money and symbols said the way a person would: "$1,234" -> "1234 dollars", "56¢" -> "56 cents"
export function normalize(text) {
  return String(text || '')
    .replace(/\$\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)/g, (_, n) => `${n} dollars`)
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)\s?%/g, '$1 percent').replace(/(\d)\s?¢/g, '$1 cents')
    .replace(/(\d)(\.\d+)?×/g, '$1$2 times').replace(/\bvs\.?\s/gi, 'versus ')
    .replace(/\bUP\b/g, 'up').replace(/\bDOWN\b/g, 'down').replace(/\bBTC\b/g, 'Bitcoin').replace(/\bETH\b/g, 'Ether')
    .replace(/[*_#`~<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}
// split into what gets phonemized and the punctuation between (the model pauses on it)
export function clauses(text) {
  const parts = normalize(text).split(/([.,!?;:—…]+)(?=\s|$)/), out = []; // a decimal point isn't a pause
  for (let i = 0; i < parts.length; i += 2) out.push({ words: parts[i].trim(), punct: (parts[i + 1] || '').slice(0, 1) });
  return out.filter((c) => c.words || c.punct);
}
// espeak's phonemes, adjusted to the alphabet Kokoro was trained on
export function fixPhonemes(ph) {
  return ph.replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ʲ/g, 'j').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?—…" ]|$)/g, 'z').replace(/\s+/g, ' ').trim();
}
export const tokenize = (ph) => [...ph].map((c) => VOCAB[c]).filter((x) => x != null).slice(0, KOKORO.maxTokens);

// pieces short enough to read quickly and to keep the worker's memory down (public/ask.js: the phone splits the same way)
export const chunks = (text, max = 90) => speechChunks(normalize(text), max);

// the voices file: a numpy .npz (an uncompressed zip of .npy arrays, written with ZIP64 headers) -> name -> Float32Array
export function readVoices(buf) {
  const out = new Map();
  let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    let size = buf.readUInt32LE(o + 22);
    const nlen = buf.readUInt16LE(o + 26), xlen = buf.readUInt16LE(o + 28), name = buf.toString('utf8', o + 30, o + 30 + nlen), d = o + 30 + nlen + xlen;
    if (size === 0xffffffff) { // ZIP64: the real size is in the extra field (id 1: uncompressed then compressed, 8 bytes each)
      for (let x = o + 30 + nlen; x < d;) { const id = buf.readUInt16LE(x), len = buf.readUInt16LE(x + 2); if (id === 1) { size = Number(buf.readBigUInt64LE(x + 12)); break; } x += 4 + len; }
    }
    if (buf.readUInt16LE(o + 8) !== 0) throw new Error('voices file is compressed'); // numpy's savez stores, never deflates
    const hlen = buf.readUInt16LE(d + 8), data = buf.subarray(d + 10 + hlen, d + size);
    out.set(name.replace(/\.npy$/, ''), new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)));
    o = d + size;
  }
  return out;
}
// the voice's style for a sentence of n tokens (one 256-number row per length)
export const styleFor = (voice, n) => voice.slice(Math.min(n, voice.length / 256 - 1) * 256, Math.min(n, voice.length / 256 - 1) * 256 + 256);

// 16-bit mono WAV, which every phone plays
export function wav(f32, rate = KOKORO.rate) {
  const b = Buffer.alloc(44 + f32.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + f32.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(f32.length * 2, 40);
  for (let i = 0; i < f32.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), 44 + i * 2);
  return b;
}
