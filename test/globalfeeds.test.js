import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_FEEDS, EXCHANGES, GLOBAL_EXCHANGES, createAligner, createFeeds, parseCoinbase } from '../public/feeds.js';

const ex = (name) => GLOBAL_EXCHANGES.find((e) => e.name === name);
const one = (name, msg) => ex(name).parse(msg).filter(Boolean);

test('the global markets\' trade messages parse to taker-side trades in BTC', () => {
  assert.deepEqual(one('Binance', { e: 'aggTrade', p: '100050.5', q: '0.25', T: 1700000000000, m: false }), [{ ex: 'Binance', t: 1700000000000, price: 100050.5, size: 0.25, side: 'buy' }]);
  assert.equal(one('Binance perp', { e: 'aggTrade', p: '100080', q: '3', T: 1, m: true })[0].side, 'sell', 'buyer was the maker: the taker sold');
  assert.deepEqual(one('Bybit perp', { topic: 'publicTrade.BTCUSDT', data: [{ T: 5, S: 'Sell', v: '0.4', p: '100070' }, { T: 6, S: 'Buy', v: '1', p: '100071' }] }).map((x) => [x.side, x.size]), [['sell', 0.4], ['buy', 1]]);
  const okx = one('OKX perp', { arg: { channel: 'trades', instId: 'BTC-USDT-SWAP' }, data: [{ px: '100060', sz: '250', side: 'buy', ts: '7' }] })[0];
  assert.ok(Math.abs(okx.size - 2.5) < 1e-12 && okx.side === 'buy', '250 contracts of 0.01 BTC');
  const dr = one('Deribit perp', { method: 'subscription', params: { channel: 'trades.BTC-PERPETUAL.100ms', data: [{ timestamp: 9, price: 100000, amount: 50000, direction: 'sell' }] } })[0];
  assert.deepEqual([dr.size, dr.side], [0.5, 'sell'], '$50,000 of contracts at $100k = 0.5 BTC');
  assert.deepEqual(one('Bitfinex', [17, 'te', [1, 11, -0.3, 100010]]).map((x) => [x.side, x.size, x.price]), [['sell', 0.3, 100010]]);
  assert.deepEqual(one('Bitfinex', [17, 'hb']), []); assert.deepEqual(one('Bitfinex', [17, [[1, 2, 3, 4]]]), [], 'the snapshot on subscribe is skipped');
  assert.deepEqual(one('Crypto.com', { result: { channel: 'trade', data: [{ t: 12, p: '100020', q: '0.1', s: 'BUY' }] } }).map((x) => x.side), ['buy']);
  assert.deepEqual(ex('Crypto.com').reply({ id: 42, method: 'public/heartbeat' }), { id: 42, method: 'public/respond-heartbeat' });
  for (const e of GLOBAL_EXCHANGES) { assert.deepEqual(e.parse({ hello: 1 }).filter(Boolean), [], `${e.name} ignores other messages`); assert.ok(e.align, `${e.name} is level-aligned`); }
  assert.equal(ALL_FEEDS.length, 1 + EXCHANGES.length + GLOBAL_EXCHANGES.length);
});

test('alignment: a USDT / futures price level is moved onto USD spot, its moves kept; nothing drawn before the first offset', () => {
  const align = createAligner();
  assert.deepEqual(align([{ ex: 'Bybit perp', t: 0, price: 100100, size: 1, side: 'buy' }]), [], 'no USD reference yet: held back');
  const out = align([...parseCoinbase({ type: 'match', time: new Date(1000).toISOString(), price: '100000', size: '1', side: 'sell' }), { ex: 'Bybit perp', t: 1500, price: 100100, size: 1, side: 'buy' }]);
  assert.equal(out.length, 2); assert.ok(Math.abs(out[1].price - 100000) < 1e-6 && out[1].raw === 100100, 'the $100 premium removed');
  const next = align([{ ex: 'Bybit perp', t: 2000, price: 100150, size: 1, side: 'buy' }])[0];
  assert.ok(Math.abs(next.price - 100150 * 100000 / 100100) < 1e-6, 'futures move $50 first: it stays a $50 move (the offset doesn\'t chase it)');
  // over minutes the offset follows a premium that really changed (spot and futures both trading, the gap now $60)
  let x = null;
  for (let t = 3000; t < 3000 + 600000; t += 1000) { align([{ ex: 'Coinbase', t, price: 100000, size: 1, side: 'buy' }]); x = align([{ ex: 'Bybit perp', t: t + 100, price: 100060, size: 1, side: 'buy' }])[0]; }
  assert.ok(Math.abs(x.price - 100000) < 2, `after 10 minutes the new $60 premium is aligned away: ${x.price.toFixed(2)}`);
  assert.equal(align([{ ex: 'Kraken', t: 3000, price: 99990, size: 1, side: 'buy' }])[0].price, 99990, 'USD spot untouched');
});

test('the feed manager keeps venues alive: subscribe after its delay, pings on schedule, answers heartbeats', async () => {
  const sent = {}, socks = {};
  class FakeWS { constructor(url) { this.url = url; socks[url] = this; sent[url] = []; setTimeout(() => this.onopen?.(), 0); } send(x) { sent[this.url].push(x); } close() { this.onclose?.(); } }
  const prev = globalThis.WebSocket; globalThis.WebSocket = FakeWS;
  const realSetInterval = globalThis.setInterval; const intervals = []; globalThis.setInterval = (f, ms) => { intervals.push({ f, ms }); return 0; };
  try {
    const got = []; const feeds = createFeeds({ onTrades: (t) => got.push(...t) });
    feeds.start(); await new Promise((r) => setTimeout(r, 1100));
    const okx = ex('OKX perp').url, bybit = ex('Bybit perp').url, cdc = ex('Crypto.com').url;
    assert.ok(sent[okx].some((x) => x.includes('BTC-USDT-SWAP')) && sent[bybit].some((x) => x.includes('publicTrade.BTCUSDT')));
    assert.ok(sent[cdc].some((x) => x.includes('trade.BTC_USD')), 'Crypto.com subscribed after its 1 s delay');
    const pings = intervals.map((i) => i.ms).sort(); assert.deepEqual(pings, [20000, 25000], 'Bybit every 20 s, OKX every 25 s');
    intervals.forEach((i) => i.f()); assert.ok(sent[okx].includes('ping') && sent[bybit].includes(JSON.stringify({ op: 'ping' })), 'OKX gets a bare "ping"');
    socks[cdc].onmessage({ data: JSON.stringify({ id: 7, method: 'public/heartbeat' }) });
    assert.ok(sent[cdc].includes(JSON.stringify({ id: 7, method: 'public/respond-heartbeat' })));
    socks[okx].onmessage({ data: 'pong' }); // not JSON: ignored
    feeds.stop();
  } finally { globalThis.WebSocket = prev; globalThis.setInterval = realSetInterval; }
});

// ---------- v13.10: the global markets in the Round scan ----------
import { FEATURES, GLOBAL_SCAN, scanRound } from '../public/roundscan.js';
test('the Round scan reads the global markets as two more inputs, leaving the USD exchanges\' reads exactly as they were', () => {
  const open = 1_700_000_000_000, now = open + 6 * 60000, usd = [], glob = [];
  // the five USD exchanges: balanced, flat at $100,000
  for (let s = 0; s < 360; s += 2) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US']) usd.push({ ex, t: open + s * 1000, price: 100000, size: 0.1, side: s % 4 ? 'buy' : 'sell' });
  // the global markets: buyers in control, and the perpetuals just ran $60 above spot in the last 30 s
  for (let s = 0; s < 360; s += 2) for (const ex of GLOBAL_SCAN) glob.push({ ex, t: open + s * 1000, price: 100000 + (/ perp$/.test(ex) && s >= 340 ? 60 : 0), size: 0.3, side: s % 6 ? 'buy' : 'sell' });
  const alone = scanRound(usd, { openTime: open, now, sigmaMin: 0.0008 }), both = scanRound([...usd, ...glob], { openTime: open, now, sigmaMin: 0.0008 });
  for (const k of ['flow', 'agree', 'momentum', 'big', 'absorb', 'leader']) assert.equal(both.features[k], alone.features[k], `${k}: unchanged by the global markets`);
  assert.deepEqual([both.exchanges, both.totalUsd], [alone.exchanges, alone.totalUsd], 'the USD table is the USD table');
  assert.equal(alone.features.gFlow, 0); assert.equal(alone.features.gLead, 0); assert.equal(alone.global.live, 0);
  assert.ok(Math.abs(both.features.gFlow - 1 / 3) < 0.02, `two thirds buyers = +0.33: ${both.features.gFlow}`);
  assert.ok(both.global.edge > 50 && both.features.gLead > 0.3, `futures ahead: $${both.global.edge}, lead ${both.features.gLead}`);
  assert.equal(both.global.live, GLOBAL_SCAN.length);
  assert.ok(both.parts.some((p) => p.name === 'Global flow' && p.pts > 0) && both.parts.some((p) => p.name === 'Global lead' && p.pts > 0));
  assert.deepEqual(FEATURES.slice(-3), ['gFlow', 'gLead', 'liq'], 'appended: older graded samples read them as 0');
});
