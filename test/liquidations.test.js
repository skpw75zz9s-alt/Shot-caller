import test from 'node:test';
import assert from 'node:assert/strict';
import { LIQ_FEEDS, liqRead } from '../public/liquidations.js';
import { FEATURES, scanRound } from '../public/roundscan.js';
import { callFeatures, learnGate, nyClock } from '../public/callgate.js';
import { ALERT_KINDS, createAlertWatcher } from '../discordalerts.js';

const T0 = 1_700_000_000_000;
const feed = (name) => LIQ_FEEDS.find((f) => f.name === name);

test('liquidation feeds: Binance\'s forced SELL is a long liquidated; OKX says the position side', () => {
  const b = feed('Binance').parse({ e: 'forceOrder', E: T0, o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '2.5', p: '99000', ap: '99100', X: 'FILLED', l: '2.5', z: '2.5', T: T0 } });
  assert.deepEqual(b, [{ t: T0, ex: 'Binance', liq: 'long', usd: 99100 * 2.5, price: 99100 }]);
  assert.equal(feed('Binance').parse({ e: 'forceOrder', o: { s: 'BTCUSDT', S: 'BUY', q: '1', ap: '100000', T: T0 } })[0].liq, 'short');
  assert.deepEqual(feed('Binance').parse({ e: 'forceOrder', o: { s: 'ETHUSDT', S: 'SELL', q: '1', ap: '3000' } }), [], 'BTC only');
  const o = feed('OKX').parse({ arg: { channel: 'liquidation-orders', instType: 'SWAP' }, data: [
    { instId: 'BTC-USDT-SWAP', details: [{ side: 'buy', posSide: 'short', sz: '150', bkPx: '100000', ts: String(T0) }] },
    { instId: 'ETH-USDT-SWAP', details: [{ side: 'sell', posSide: 'long', sz: '10', bkPx: '3000', ts: String(T0) }] }] });
  assert.deepEqual(o, [{ t: T0, ex: 'OKX', liq: 'short', usd: 150 * 0.01 * 100000, price: 100000 }], '150 contracts of 0.01 BTC');
});

test('the scan\'s liquidation input: shorts squeezed push up, longs flushed push down, small ones barely count', () => {
  assert.equal(liqRead([], T0).push, 0);
  const longs = [{ t: T0 - 30000, liq: 'long', usd: 2_000_000 }, { t: T0 - 10000, liq: 'long', usd: 1_000_000 }];
  const r = liqRead(longs, T0);
  assert.deepEqual([r.long, r.short, r.n], [3_000_000, 0, 2]); assert.ok(r.push < -0.9);
  assert.ok(liqRead([{ t: T0 - 1000, liq: 'short', usd: 50_000 }], T0).push < 0.2, '$50k: a whisper');
  assert.equal(liqRead([{ t: T0 - 200000, liq: 'short', usd: 5e6 }], T0).n, 0, 'older than 2 minutes');
  assert.ok(FEATURES.includes('liq'));
  const trades = [];
  for (let i = 0; i < 60; i++) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp']) trades.push({ t: T0 - 300000 + i * 5000, ex, price: 100000 + i, size: 0.1, side: i % 2 ? 'buy' : 'sell' });
  const sc = scanRound(trades, { openTime: T0 - 300000, now: T0, liqs: longs });
  assert.ok(sc.features.liq < -0.9);
  assert.match(sc.parts.find((p) => p.name === 'Liquidations').why, /longs.*forced selling/);
  assert.equal(scanRound(trades, { openTime: T0 - 300000, now: T0 }).features.liq, 0, 'no feed: 0 (old samples read 0 too)');
});

test('a Discord alert for a liquidation cascade: $2M+ of one side in a minute, 10 minutes apart', () => {
  assert.ok(ALERT_KINDS.includes('liquidation'));
  const posts = [], w = createAlertWatcher({ post: (e) => posts.push(e), kinds: new Set(ALERT_KINDS) });
  w.liquidation({ t: T0, liq: 'long', usd: 900_000 }, T0);
  w.liquidation({ t: T0 + 20000, liq: 'short', usd: 1_500_000 }, T0 + 20000);
  assert.equal(posts.length, 0, 'neither side at $2M');
  w.liquidation({ t: T0 + 30000, liq: 'long', usd: 1_200_000 }, T0 + 30000);
  assert.equal(posts.length, 1); assert.match(posts[0].title, /\$2,100,000 of longs force-closed/);
  w.liquidation({ t: T0 + 40000, liq: 'long', usd: 3_000_000 }, T0 + 40000);
  assert.equal(posts.length, 1, 'inside 10 minutes');
});

test('the call filter knows overnight and weekends in New York, and learns them from the whole record', () => {
  assert.deepEqual(nyClock(Date.UTC(2026, 9, 13, 2, 0)), { hour: 22, night: true, weekend: false }, 'Mon 10 PM ET');
  assert.deepEqual(nyClock(Date.UTC(2026, 9, 17, 15, 0)), { hour: 11, night: false, weekend: true }, 'Sat 11 AM ET');
  assert.equal(nyClock(Date.UTC(2026, 9, 13, 14, 0)).night, false, 'Tue 10 AM ET');
  const day = callFeatures({ conf: 95, price: 0.8, mins: 7, at: Date.UTC(2026, 9, 13, 14, 0) }), night = callFeatures({ conf: 95, price: 0.8, mins: 7, at: Date.UTC(2026, 9, 13, 3, 0) });
  assert.deepEqual([day.at(-2), night.at(-2)], [0, 1]);
  // calls that lose overnight and win in the day: the filter learns the night weight negative
  const rec = [];
  for (let i = 0; i < 160; i++) { const night = i % 2 === 1; rec.push({ side: 'YES', price: 0.8, conf: 92, at: Date.UTC(2026, 9, 13, night ? 3 : 15, 0) + i * 86400000 * 0 + i * 60000, result: night ? (i % 4 === 1 ? 'yes' : 'no') : 'yes', feat: { mins: 7, stab: 60, vr: 1, spread: 0.02, ev60: 0 } }); }
  const g = learnGate(rec);
  assert.ok(g.w.at(-2) < -0.3, `night weight ${g.w.at(-2)}`);
  assert.equal(g.active, true, 'and proven in the replay: overnight calls lost money');
});
