// The server's record of real Kalshi fees (public/fees.js): fills the phones report from your Kalshi account and the
// Auto-trader's own orders. The measured rates are applied to every fee the server figures (model.js setFeeRates)
// and shared with the phones through /api/learn. Kept in DATA_DIR/fees.json (the latest 1,000 fills).
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { feeSample, learnFeeRates } from './public/fees.js';
import { setFeeRates } from './public/model.js';
import { writeAtomic } from './atomicfile.js';

export function createFeeBook({ file, log = console }) {
  let samples = [], ids = new Set(), rates = null, timer = null;
  async function load() {
    try { const d = JSON.parse(await readFile(file, 'utf8')); samples = d.samples || []; ids = new Set(samples.map((s) => s.id).filter(Boolean)); } catch { /* none yet */ }
    relearn();
  }
  function relearn() { rates = learnFeeRates(samples); setFeeRates(rates); }
  function save() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify({ samples })); } catch (e) { log.error('saving fees failed', e.message); }
    }, 2000);
    timer.unref?.();
  }
  // list: [{ id?, count, price, fee, taker }]. Returns how many were new.
  function add(list) {
    let added = 0;
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 300)) {
      const s = feeSample(raw || {});
      if (!s || !(s.count <= 100000) || !(s.fee <= s.count)) continue;
      const id = typeof raw.id === 'string' ? raw.id.slice(0, 80) : null;
      if (id && ids.has(id)) continue;
      if (id) ids.add(id);
      samples.push({ ...s, ...(id ? { id } : {}), at: Date.now() });
      added++;
    }
    if (added) {
      if (samples.length > 1000) { samples = samples.slice(-1000); ids = new Set(samples.map((s) => s.id).filter(Boolean)); }
      relearn(); save();
    }
    return added;
  }
  return { load, add, rates: () => rates, count: () => samples.length };
}
