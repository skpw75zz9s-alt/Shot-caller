// The break lab (v13.61; public/breakproof.js has the claims and the verdicts): the server runs the X-ray's break finder
// on every market, every second, and grades what each break is supposed to mean against what happened next.
//   observe(series, snap, x)   x: { kind, tape (the exchange trades, crypto), liqs }. Finds breaks, records each new one
//                              with the facts at that moment, samples an ordinary moment every minute (the control),
//                              and grades whatever has reached its horizon
//   settle(series, ticker, r)  grades the claims judged on a round's result
// The graded cases are kept per market in DATA_DIR/breaks.json (the last 400 of each).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { findBreaks, trackBreaks } from './public/xray.js';
import { CLAIMS, POOLS, PROOF, verdict } from './public/breakproof.js';

const RING_MS = 20 * 60000;
export function createBreakLab({ file, clock = () => Date.now(), log = console }) {
  let state = { cases: {}, controls: {}, pending: {} }, dirty = false, saving = null;
  const live = {}; // per series: { ring: [{ t, spot, tk, p, mid }], log, controlAt }
  const S = (series) => (live[series] ||= { ring: [], log: null, controlAt: 0 });
  const push = (bucket, series, key, v) => { const a = ((state[bucket][series] ||= {})[key] ||= []); a.push(v ? 1 : 0); if (a.length > PROOF.keep) a.splice(0, a.length - PROOF.keep); dirty = true; };
  const pend = (series) => (state.pending[series] ||= []);
  const mid = (q) => (q?.yesAsk != null && (q.noAsk != null || q.yesBid != null) ? (q.yesAsk + (q.noAsk != null ? 1 - q.noAsk : q.yesBid)) / 2 : null);

  function observe(series, snap, x = {}) {
    if (!snap?.rows) return;
    const now = clock(), s = S(series), row = snap.rows.filter((r) => r.ev?.minutesLeft > 0).sort((a, b) => a.ev.minutesLeft - b.ev.minutesLeft)[0];
    const spot = snap.mSpot ?? snap.spot, tk = row?.m.ticker ?? null, p = row ? row.pPre ?? row.ev.pYes : null, q = row?.ev.quote, m = mid(q);
    if (spot > 0) { s.ring.push({ t: now, spot, tk, p, mid: m }); while (s.ring.length && s.ring[0].t < now - RING_MS) s.ring.shift(); }
    if (row && spot > 0) {
      const open = Date.parse(row.m.open_time), sig = row.sigma ?? snap.sigmaMin;
      const lv = { pYes: p, yesBid: q?.yesBid ?? null, yesAsk: q?.yesAsk ?? null, noAsk: q?.noAsk ?? null, spot, strike: row.strike, sigmaMin: sig, sigmaLong: snap.sigmaLong, minutesLeft: row.ev.minutesLeft };
      const bars = (snap.bars || []).filter((b) => b.t >= open && b.t < now).map((b) => ({ t: Math.min(b.t + 60000, now), c: b.c }));
      const preBars = (snap.bars || []).filter((b) => b.t < open && b.t >= open - 15 * 60000);
      let found = [];
      try { found = findBreaks({ now, kind: x.kind, live: lv, bars, preBars, quoteLog: snap.quoteLog?.[tk], trades: x.tape, srv: x.liqs ? { liqs: x.liqs } : null }); } catch (e) { log.error?.('break finder failed', e.message); }
      const before = s.log?.ticker === tk ? new Set(s.log.items.map((b) => b.key)) : new Set();
      for (const b of found) {
        if (before.has(b.key) || !CLAIMS[b.proof] || CLAIMS[b.proof].fact || CLAIMS[b.proof].untested) continue;
        // a new break: the facts now, to grade its claim later
        pend(series).push({ proof: b.proof, t: now, tk, spot, sigmaMin: sig, p, mid: m, dir: b.dir ?? 0, level: b.level ?? null, from: b.from ?? null, size: b.size ?? null, due: CLAIMS[b.proof].h ? now + CLAIMS[b.proof].h : null });
        dirty = true;
      }
      s.log = trackBreaks(s.log, found, now, tk);
      // an ordinary moment, once a minute: the controls
      if (now - s.controlAt >= 60000 && lv.minutesLeft > 1 && lv.minutesLeft < 14) {
        s.controlAt = now;
        const back = s.ring.find((r) => r.t >= now - 30000 && r.tk === tk), dp = back?.p != null && p != null ? p - back.p : 0;
        pend(series).push({ pool: 'move5', t: now, tk, spot, sigmaMin: sig, due: now + POOLS.move5.h });
        if (dp && m != null) pend(series).push({ pool: 'kalshi', t: now, tk, mid: m, dir: Math.sign(dp), size: 0.08, due: now + POOLS.kalshi.h });
        if (p != null) pend(series).push({ pool: 'leader', t: now, tk, p });
        dirty = true;
      }
    }
    // grade what has reached its horizon, from the ring (the same round for the odds and Kalshi's price)
    const P = pend(series);
    for (let i = P.length - 1; i >= 0; i--) {
      const e = P[i]; if (e.due == null || e.due > now - 2000) continue;
      P.splice(i, 1);
      const a = s.ring.find((r) => r.t >= e.due && r.t <= e.due + 20000);
      if (!a || ((e.proof === 'lag' || e.proof === 'swing' || e.proof === 'kswing' || e.pool === 'kalshi') && a.tk !== e.tk)) continue; // a restart, or the round closed first
      if (e.pool) push('controls', series, e.pool, POOLS[e.pool].out(e, a)); else push('cases', series, e.proof, CLAIMS[e.proof].out(e, a));
    }
    if (P.length > 3000) P.splice(0, P.length - 3000);
  }
  function settle(series, ticker, result) {
    if (result !== 'yes' && result !== 'no') return;
    const y = result === 'yes' ? 1 : 0, P = pend(series);
    for (let i = P.length - 1; i >= 0; i--) {
      const e = P[i]; if (e.tk !== ticker || e.due != null) continue;
      P.splice(i, 1);
      if (e.pool) push('controls', series, e.pool, POOLS[e.pool].out(e, y)); else push('cases', series, e.proof, CLAIMS[e.proof].out(e, y));
    }
    // settle-graded cases whose round never settled here (a restart in between) are dropped after a day
    for (let i = P.length - 1; i >= 0; i--) if (P[i].due == null && clock() - P[i].t > 86400000) P.splice(i, 1);
    save();
  }
  function api(series) {
    const cases = state.cases[series] || {}, controls = state.controls[series] || {};
    return { kinds: Object.fromEntries(Object.keys(CLAIMS).map((k) => [k, verdict(k, cases[k], CLAIMS[k].pool ? controls[CLAIMS[k].pool] : [])])),
      controls: Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, { n: v.length, rate: v.length ? v.reduce((a, x) => a + x, 0) / v.length : null }])), pending: pend(series).length };
  }
  async function load() { try { const j = JSON.parse(await readFile(file, 'utf8')); if (j && typeof j === 'object') state = { cases: j.cases || {}, controls: j.controls || {}, pending: j.pending || {} }; } catch { /* none yet */ } }
  async function save() {
    if (saving || !dirty) return saving;
    dirty = false;
    saving = (async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(state)); await rename(`${file}.tmp`, file); })()
      .catch((e) => log.error?.('saving the break lab failed', e.message)).finally(() => { saving = null; });
    return saving;
  }
  const keep = setInterval(() => { save(); }, 60000); keep.unref?.();
  // the breaks open right now on a market's live round (for Ask), each with its proof so far
  function open(series) {
    const l = live[series]?.log, v = api(series).kinds;
    return (l?.items || []).filter((b) => b.open).map((b) => ({ title: b.title, detail: b.detail, sev: b.sev, proof: b.proof, proofText: v[b.proof]?.text ?? null }));
  }
  return { load, observe, settle, save, api, open, stop: () => clearInterval(keep) };
}
