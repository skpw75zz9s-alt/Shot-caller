// The council on the server (v13.60; public/council.js has the rules): every proven nudge for a market argues its case
// here before it reaches the bot's odds (bot.js shifts), and the council keeps each feature's record of graded arguments.
//   observe(series, snap)   the round's facts: the bot's own odds, the distance to the target, the time left
//   decide(series, voices)  voices: [[key, { ticker: pts } | null], …]; returns { ticker: net pts } for the bot
//   settle(series, ticker)  grades what each feature argued in that round (before its last minute) against the result
// One council for every market; records are kept per market in DATA_DIR/council.json.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { COUNCIL, FAMILIES, MEMBERS, councilFacts, credibility, debate } from './public/council.js';

export function createCouncil({ file, clock = () => Date.now(), log = console }) {
  let state = { records: {}, heard: {} }, dirty = false, saving = null;
  const ctx = {}, last = {}; // per series: the round facts, the latest rulings (per ticker)
  const recs = (series) => (state.records[series] ||= {});
  function observe(series, snap, settle = 'avg60') {
    if (!snap?.rows) return;
    const rows = {};
    for (const r of snap.rows) { const f = councilFacts(r, snap, settle); if (f.minutesLeft > 0 && f.pYes != null) rows[r.m.ticker] = f; }
    ctx[series] = { at: clock(), rows };
  }
  function decide(series, voices) {
    const byTicker = {};
    for (const [key, sh] of voices || []) for (const [t, pts] of Object.entries(sh || {})) if (Number.isFinite(pts) && pts) (byTicker[t] ||= []).push({ key, pts });
    const out = {}, now = clock(), c = ctx[series]?.rows || {};
    last[series] = {};
    for (const [t, args] of Object.entries(byTicker)) {
      const f = c[t] || {}, d = debate(args, f, recs(series));
      last[series][t] = { ...d, at: now, facts: f };
      if (d.net) out[t] = d.net;
      // what each feature argued in this round, graded at settlement (its last word before the final minute)
      if (!(f.minutesLeft < 1)) { const h = ((state.heard[series] ||= {})[t] ||= { at: now, sides: {} }); h.at = now; for (const r of d.rulings) h.sides[r.key] = r.side; dirty = true; }
    }
    return Object.keys(out).length ? out : null;
  }
  function settle(series, ticker, result) {
    const h = state.heard[series]?.[ticker];
    if (!h) return;
    delete state.heard[series][ticker];
    if (result === 'yes' || result === 'no') for (const [key, side] of Object.entries(h.sides)) {
      const r = (recs(series)[key] ||= []); r.push(side === result.toUpperCase() ? 1 : 0); if (r.length > COUNCIL.keep) r.splice(0, r.length - COUNCIL.keep);
    }
    // rounds that never settled (a restart, a market that closed) are dropped after a day
    for (const [t, x] of Object.entries(state.heard[series] || {})) if (clock() - x.at > 86400000) delete state.heard[series][t];
    dirty = true; save();
  }
  async function load() { try { const j = JSON.parse(await readFile(file, 'utf8')); if (j && typeof j === 'object') state = { records: j.records || {}, heard: j.heard || {} }; } catch { /* none yet */ } }
  async function save() {
    if (saving || !dirty) return saving;
    dirty = false;
    saving = (async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(state)); await rename(`${file}.tmp`, file); })()
      .catch((e) => log.error?.('saving the council failed', e.message)).finally(() => { saving = null; });
    return saving;
  }
  const keep = setInterval(() => { save(); }, 60000); keep.unref?.();
  // for the phone: the live round's debate (the round closing first) and every feature's record
  function api(series) {
    const rows = ctx[series]?.rows || {}, live = Object.entries(rows).sort((a, b) => a[1].minutesLeft - b[1].minutesLeft)[0]?.[0] ?? null;
    const d = live ? last[series]?.[live] ?? null : null;
    return { ticker: live, debate: d && clock() - d.at < 30000 ? d : null, facts: live ? rows[live] : null,
      records: Object.fromEntries(Object.entries(recs(series)).map(([k, h]) => [k, { ...credibility(h), name: MEMBERS[k]?.name || k }])), members: MEMBERS, families: FAMILIES, rules: COUNCIL };
  }
  return { load, observe, decide, settle, save, api, stop: () => clearInterval(keep) };
}
