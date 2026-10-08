import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilot, liveUnlocked, LIVE_UNLOCK } from '../public/autopilot.js';
import { DEFAULTS, riskSettings } from '../public/model.js';

// Just enough of the page for the Auto-trader card
function fakePage() {
  const els = {};
  const $ = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } });
  return { $, els };
}
const mem = () => { const m = {}; return { m, get: (k, d) => (k in m ? JSON.parse(m[k]) : d), set: (k, v) => { m[k] = JSON.stringify(v); } }; };

test('Live stays locked until Test has settled enough trades with no serious error', () => {
  const closed = Array.from({ length: LIVE_UNLOCK }, () => ({ closed: true }));
  assert.equal(liveUnlocked({ ledger: closed.slice(1), log: [] }).ok, false);
  assert.equal(liveUnlocked({ ledger: closed, log: [] }).ok, true);
  assert.equal(liveUnlocked({ ledger: closed, log: [{ kind: 'error', err: 'unknown' }] }).ok, true, 'a Kalshi hiccup is fine');
  assert.equal(liveUnlocked({ ledger: closed, log: [{ kind: 'error', err: 'cash' }] }).ok, false, 'insufficient balance is not');
});

test('Test mode: buys the locked call on the live book, never sends anything, and a reload never restarts real trading', async () => {
  const { $, els } = fakePage(), store = mem();
  store.set('traderCfg', { mode: 'test' });
  const sent = [];
  const getJSON = async (path) => {
    sent.push(path);
    if (path.endsWith('/orderbook')) return { orderbook_fp: { yes_dollars: [['0.3800', '50.00']], no_dollars: [['0.6000', '40.00'], ['0.5900', '90.00']] } };
    throw new Error('not here');
  };
  const ap = createAutopilot({ $, esc: String, store, API: './api', idb: async () => null, toast: () => {}, getJSON, paywalled: () => {}, liveCred: () => ({}), render: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  const settings = { ...DEFAULTS, ...riskSettings('steady') };
  const close = new Date(Date.now() + 10 * 60000).toISOString();
  const live = { m: { ticker: 'KXBTC15M-X', close_time: close }, ev: { minutesLeft: 10, quote: { yesAsk: 0.4, yesBid: 0.38 } } };
  const snap = { now: Date.now(), rows: [live], bars: [], quoteLog: {} };
  ap.tick({ live, snap, sig: { callSide: 'YES', limit: 0.42, contracts: 12, deep: { score: 90 } }, settings });
  await new Promise((r) => setTimeout(r, 1500)); // the trader spaces its requests
  const st = ap.traders.test.state();
  assert.equal(st.ledger.length, 1);
  assert.equal(st.ledger[0].count, 12);
  assert.ok(sent.every((p) => p.startsWith('kalshi/markets/')), 'only public market data was read');
  assert.match(els.atStripText.textContent, /TEST/);
  assert.match(els.atModes.innerHTML, /🔒 Live/);
  // reload with Live on: comes back Off
  store.set('traderCfg', { mode: 'live' });
  const ap2 = createAutopilot({ $, esc: String, store, API: './api', idb: async () => null, toast: () => {}, getJSON, paywalled: () => {}, liveCred: () => ({}), render: () => {} });
  assert.equal(ap2.mode(), 'off');
});
