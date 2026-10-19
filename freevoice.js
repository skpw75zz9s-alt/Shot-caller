// The free natural voice's manager (v13.49): downloads the model once (to DATA_DIR/kokoro, from GitHub), starts the
// worker (ttsworker.js) on the first spoken answer and stops it after 10 quiet minutes, so the server only holds the
// model's memory while people are listening. FREE_VOICE=off turns it off; KOKORO_VOICE picks the voice.
import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { KOKORO, voiceOk } from './kokoro.js';

const WORKER = fileURLToPath(new URL('./ttsworker.js', import.meta.url));

export function createFreeVoice({ dir, enabled = process.env.FREE_VOICE !== 'off', voice = voiceOk(process.env.KOKORO_VOICE) ? process.env.KOKORO_VOICE : KOKORO.voice,
  idleMs = 600000, timeoutMs = 60000, fetchImpl = fetch, forkImpl = fork, perMin = 60, perHour = 900, maxChars = 200, now = () => Date.now() } = {}) {
  let files = null, filesErr = null, child = null, warm = null, warmFail = null, idle = null, seq = 0, busy = 0;
  let lastExit = null, crashes = [], pausedUntil = 0; // why the worker last died, and a pause after repeated crashes
  const pending = new Map(), hits = new Map();

  // the model and the voices, downloaded once (a .part file renamed when complete, so a cut-off download never counts)
  async function have(f) { try { return (await stat(join(dir, f.name))).size === f.size; } catch { return false; } }
  async function download(f) {
    if (await have(f)) return;
    const part = join(dir, `${f.name}.part`), r = await fetchImpl(`${KOKORO.base}/${f.name}`, { redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`model download answered ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(part));
    if ((await stat(part)).size !== f.size) { await unlink(part).catch(() => {}); throw new Error('model download came out the wrong size'); }
    await rename(part, join(dir, f.name));
  }
  function ensureFiles() {
    if (!enabled) return Promise.reject(new Error('off'));
    return (files ||= (async () => {
      await mkdir(dir, { recursive: true });
      await download(KOKORO.files.voices);
      await download(KOKORO.files.model);
      filesErr = null;
    })().catch((e) => { files = null; filesErr = String(e?.message || e); throw e; }));
  }

  function failAll(why = 'the voice stopped') { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); } pending.clear(); }
  // a worker that dies on its own: killed by the system (SIGKILL: almost always out of memory) or crashed. Two in ten
  // minutes pause the free voice for half an hour, so it can't keep pushing the server over its memory limit.
  function exitReason(code, signal, tail) {
    if (signal === 'SIGKILL') return 'the server ran out of memory for the voice (it was killed): give the Railway service more memory, or set FREE_VOICE=off';
    const last = (tail || '').trim().split('\n').filter((l) => l && !/^var A=/.test(l)).pop();
    return `the voice crashed (${signal || `exit ${code}`})${last ? `: ${last.slice(0, 160)}` : ''}`;
  }
  function stop() {
    clearTimeout(idle); idle = null;
    if (child) { child.removeAllListeners('exit'); child.kill(); }
    warmFail?.(new Error('the voice stopped'));
    child = null; warm = null; warmFail = null;
    failAll();
  }
  // quiet for idleMs with nothing being read: stop, and give the memory back
  function touch() { clearTimeout(idle); idle = setTimeout(() => (busy ? touch() : stop()), idleMs); idle.unref?.(); }
  function worker() {
    if (child) return warm;
    child = forkImpl(WORKER, [], { env: { ...process.env, KOKORO_DIR: dir }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let tail = '';
    child.stderr?.on('data', (d) => { const x = String(d); tail = (tail + x).slice(-4000); if (!/^var A=/.test(x)) process.stderr.write(`[voice] ${x.slice(0, 2000)}`); });
    warm = new Promise((resolve, reject) => {
      warmFail = reject;
      child.on('message', (m) => {
        if (m?.type === 'warm') return m.error ? reject(new Error(m.error)) : resolve();
        const p = pending.get(m?.id);
        if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(Buffer.from(m.wav));
      });
      child.on('exit', (code, signal) => {
        const was = child, why = exitReason(code, signal, tail);
        child = null; warm = null; lastExit = { why, at: now() };
        console.error(`[voice] worker stopped: ${why}`);
        crashes = [...crashes.filter((t) => now() - t < 600000), now()];
        if (crashes.length >= 2) pausedUntil = now() + 1800000;
        failAll(why);
        if (was) reject(new Error(why));
      });
    });
    warm.catch(() => {});
    child.send({ type: 'warm' });
    return warm;
  }

  function limited(owner) {
    const t = now(), list = (hits.get(owner) || []).filter((x) => t - x < 3600000);
    hits.set(owner, list);
    if (list.filter((x) => t - x < 60000).length >= perMin || list.length >= perHour) return true;
    list.push(t);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k);
    return false;
  }

  // one piece of an answer (the phone sends them a sentence or two at a time, so speech starts quickly)
  async function speak({ owner, text, voice: v }) {
    if (!enabled) return { status: 501, body: { error: 'the free voice is off on this server (FREE_VOICE=off)', free: false } };
    const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, maxChars) : '';
    if (!t) return { status: 400, body: { error: 'nothing to say' } };
    if (limited(owner || 'anon')) return { status: 429, body: { error: 'too many spoken answers for now' } };
    if (now() < pausedUntil) return { status: 503, body: { error: `the free voice is paused for ${Math.ceil((pausedUntil - now()) / 60000)} min after crashing twice (${lastExit?.why || 'unknown'})`, paused: true } };
    try { await ensureFiles(); } catch { return { status: 503, body: { error: `the free voice is still downloading or couldn't download (${filesErr || 'try again in a minute'})`, retry: true } }; }
    busy++;
    try {
      touch();
      await worker();
      const id = ++seq;
      const audio = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('the voice took too long')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, text: t, voice: voiceOk(v) ? v : voice });
      });
      touch();
      return { status: 200, audio, type: 'audio/wav' };
    } catch (e) {
      return { status: 503, body: { error: `the free voice couldn't read that (${e?.message || e})` } };
    } finally { busy--; }
  }

  // someone opened Ask: load the model now, so their first answer doesn't wait for it (stops again when quiet)
  async function warmUp() {
    if (!enabled || now() < pausedUntil) return false;
    try { await ensureFiles(); touch(); worker(); return true; } catch { return false; }
  }

  return {
    speak, stop, voice, warmUp,
    prefetch: () => { if (enabled) ensureFiles().catch(() => {}); }, // at startup: download only, nothing loaded
    status: () => ({ free: enabled && now() >= pausedUntil, freeVoice: voice, freeReady: !!files && !filesErr, freeLoaded: !!child, ...(lastExit ? { freeError: lastExit.why } : {}) }),
  };
}
