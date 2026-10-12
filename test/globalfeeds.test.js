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
