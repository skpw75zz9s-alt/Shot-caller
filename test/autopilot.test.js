import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilot, liveUnlocked, LIVE_UNLOCK } from '../public/autopilot.js';

// Just enough of the page for the Auto-trader card
function fakePage() {
  const els = {};
  const $ = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; }, querySelector: () => null });
  return { $, els };
}
globalThis.document ||= { hidden: false, activeElement: null, addEventListener() {} };

test('Live stays locked until Test has settled enough trades with no serious error', () => {
  const closed = Array.from({ length: LIVE_UNLOCK }, () => ({ closed: true }));
  assert.equal(liveUnlocked({ ledger: closed.slice(1), log: [] }).ok, false);
  assert.equal(liveUnlocked({ ledger: closed, log: [] }).ok, true);
  assert.equal(liveUnlocked({ ledger: closed, log: [{ kind: 'error', err: 'unknown' }] }).ok, true, 'a Kalshi hiccup is fine');
  assert.equal(liveUnlocked({ ledger: closed, log: [{ kind: 'error', err: 'cash' }] }).ok, false, 'insufficient balance is not');
});

test('the card is a remote control: it shows the server\'s trader and sends changes there; the phone never trades', async () => {
  const { $, els } = fakePage();
  const state = { canHoldKeys: true, cfg: { mode: 'test', perTrade: 10, dailyLoss: 30, maxTrades: 20, maxOpen: 40, testCash: 100 }, keys: { live: null, demo: null }, unlock: { ok: false, settled: 3, serious: false },
    why: 'Waiting for a call', stopped: false, paused: false, today: { buys: 1, realized: 0.5, open: 4.6, worst: -4.1 }, stats: { trades: 2, closed: 1, wins: 1, pnl: 0.5, open: 1, errors: 0 }, testCash: 95.4, log: [{ t: 1, kind: 'fill', text: 'BUY UP 10' }] };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, json: async () => state }; };
  const toasts = [];
  createAutopilot({ $, esc: String, API: './api', toast: (t) => toasts.push(t), paywalled: () => {}, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls[0].url, './api/auto/state');
  assert.match(els.atStatus.textContent, /running on the server \(phone can be closed\)/);
  assert.match(els.atStripText.textContent, /TEST · on the server/);
  assert.match(els.atModes.innerHTML, /🔒 Live/);
  assert.match(els.atToday.innerHTML, /\$95\.40/);
  // tapping Live while locked: nothing sent
  await els.atModes.handlers.click({ target: { closest: () => ({ dataset: { mode: 'live' } }) } });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(toasts.at(-1), /Run Test first/);
  // STOP goes to the server
  await els.atStop.handlers.click();
  assert.deepEqual(calls.at(-1), { url: './api/auto/stop', method: 'POST', body: {} });
});
