// The strength meter on the server (v13.62; public/strength.js has the scoring): every second, the live round's odds at
// each stage (the bot's price math, after Kalshi's blend, after the council) and Kalshi's own price; at settlement every
// second is scored against the result. Per market, the last 3,000 rounds are kept in DATA_DIR/strength.json.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STRENGTH, addSecond, newRound, scoreRound, strengthSummary } from './public/strength.js';

export function createStrength({ file, clock = () => Date.now(), log = console }) {
  let state = { rounds: {}, open: {} }, dirty = false, saving = null;
  const last = {}; // per series: the second last sampled (once a second, however often the bot ticks)
  function observe(series, snap) {
    const now = clock(), sec = Math.floor(now / 1000);
    if (!snap?.rows || last[series] === sec) return;
    last[series] = sec;
    const row = snap.rows.filter((r) => r.ev?.minutesLeft > 0).sort((a, b) => a.ev.minutesLeft - b.ev.minutesLeft)[0];
    if (!row || row.ev.pYes == null) return;
    const q = row.ev.quote, kalshi = q?.yesBid != null && q?.yesAsk != null && q.yesAsk >= q.yesBid ? (q.yesBid + q.yesAsk) / 2 : null;
    const open = (state.open[series] ||= {}), t = row.m.ticker;
    const acc = (open[t] ||= { close: Date.parse(row.m.close_time), ...newRound() });
    addSecond(acc, { math: row.pBot ?? null, blend: row.pPre ?? null, final: row.ev.pYes, kalshi }, row.ev.minutesLeft);
    dirty = true;
  }
  function settle(series, ticker, result) {
    const acc = state.open[series]?.[ticker];
    if (!acc) return;
    delete state.open[series][ticker];
    if (result === 'yes' || result === 'no') {
      const rs = (state.rounds[series] ||= []);
      rs.push(scoreRound(acc, result === 'yes' ? 1 : 0, { ticker, close: acc.close }));
      if (rs.length > STRENGTH.keep) rs.splice(0, rs.length - STRENGTH.keep);
    }
    for (const [t, a] of Object.entries(state.open[series] || {})) if (a.close < clock() - 86400000) delete state.open[series][t]; // never settled here
    dirty = true; save();
  }
  const api = (series) => strengthSummary(state.rounds[series] || [], clock());
  async function load() { try { const j = JSON.parse(await readFile(file, 'utf8')); if (j && typeof j === 'object') state = { rounds: j.rounds || {}, open: j.open || {} }; } catch { /* none yet */ } }
  async function save() {
    if (saving || !dirty) return saving;
    dirty = false;
    saving = (async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(state)); await rename(`${file}.tmp`, file); })()
      .catch((e) => log.error?.('saving the strength meter failed', e.message)).finally(() => { saving = null; });
    return saving;
  }
  const keep = setInterval(() => { save(); }, 60000); keep.unref?.();
  return { load, observe, settle, save, api, stop: () => clearInterval(keep) };
}
