import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../public/watch.js';

const T0 = 1_700_000_000_000;
// run `secs` quiet seconds (BTC wiggling a dollar, 5 exchanges in step, steady flow and a calm Kalshi book)
function quiet(d, secs, from = T0, extra = () => ({})) {
  for (let i = 0; i < secs; i++) {
    const now = from + i * 1000, p = 100000 + (i % 2);
    d.step({ now, price: p, sigmaMin: 0.0008, venues: { Coinbase: p, Kraken: p + 1, Bitstamp: p - 1, Gemini: p, 'Binance.US': p }, feeds: { Coinbase: now, Kraken: now, Bitstamp: now, Gemini: now }, flowUsd: 20000,
      kalshi: { ticker: 'T', yesBid: 0.6, yesAsk: 0.61, near: 900, levels: [['yes', 0.6, 200], ['yes', 0.59, 150], ['no', 0.39, 180], ['no', 0.38, 220]] }, ...extra(now, i) });
  }
  return from + secs * 1000;
}
const kinds = (es) => es.map((e) => `${e.kind}:${e.sev}`);

test('calm market: nothing to report, no hold', () => {
  const d = createDetector();
  quiet(d, 200);
  assert.deepEqual(d.events(), []);
  assert.equal(d.status(T0 + 200000).calm, true);
  assert.equal(d.hold(T0 + 200000), null);
});

test('a violent jump holds new calls for 30 seconds; a big one is only noted', () => {
  const d = createDetector();
  let t = quiet(d, 200);
  const base = { sigmaMin: 0.0008, venues: {}, feeds: {}, flowUsd: 20000 };
  d.step({ ...base, now: t, price: 100000 }); d.step({ ...base, now: t + 5000, price: 100090 }); // ~3.9x a normal 5 s ($23)
  assert.deepEqual(kinds(d.events()), ['jump:warn']);
  assert.equal(d.hold(t + 5000), null);
  const d2 = createDetector(); t = quiet(d2, 200);
  d2.step({ ...base, now: t, price: 100000 }); d2.step({ ...base, now: t + 5000, price: 99750 }); // ~7.6x
  assert.deepEqual(kinds(d2.events()), ['jump:severe']);
  assert.ok(d2.hold(t + 10000) && !d2.hold(t + 36000), 'held for 30 s');
});

test('volume burst, an exchange breaking away, a silent feed', () => {
  const d = createDetector();
  quiet(d, 200, T0, (now, i) => (i >= 190 ? { flowUsd: 300000 } : {}));
  assert.ok(kinds(d.events()).includes('burst:warn'));
  const d2 = createDetector();
  quiet(d2, 30, T0, (now, i) => ({ venues: { Coinbase: 100000, Kraken: i >= 20 ? 100080 : 100001, Bitstamp: 99999, Gemini: 100000 } }));
  assert.match(d2.events().find((e) => e.kind === 'breakaway').text, /^Kraken is \$80 above the other exchanges/);
  const d3 = createDetector();
  quiet(d3, 80, T0, (now, i) => ({ feeds: { Coinbase: now, Kraken: now, Bitstamp: now, Gemini: T0 } }));
  assert.match(d3.events().find((e) => e.kind === 'silent').text, /^Gemini feed silent/);
});

test('Kalshi: a blown-out spread holds calls; pulled liquidity, a wall, a flurry and repricing without BTC are logged', () => {
  const d = createDetector();
  quiet(d, 60, T0, (now, i) => (i >= 50 ? { kalshi: { ticker: 'T', yesBid: 0.55, yesAsk: 0.66, near: 900, levels: [] } } : {}));
  assert.ok(kinds(d.events()).includes('spread:severe')); assert.ok(d.hold(T0 + 55000));
  const d2 = createDetector();
  quiet(d2, 60, T0, (now, i) => (i >= 50 ? { kalshi: { ticker: 'T', yesBid: 0.6, yesAsk: 0.61, near: 120, levels: [['yes', 0.6, 200], ['yes', 0.59, 150], ['no', 0.39, 6000], ['no', 0.38, 220]] } } : {}));
  assert.ok(kinds(d2.events()).includes('pulled:warn'));
  assert.match(d2.events().find((e) => e.kind === 'wall').text, /6,000 contracts bid at 39¢ for DOWN/);
  const d3 = createDetector();
  quiet(d3, 200, T0, (now, i) => ({ kTrades: i >= 185 ? [{ t: now, count: 120, side: 'YES' }] : i % 10 === 0 ? [{ t: now, count: 20, side: 'NO' }] : [] }));
  assert.match(d3.events().find((e) => e.kind === 'flurry').text, /buying UP/);
  const d4 = createDetector();
  quiet(d4, 40, T0, (now, i) => (i >= 30 ? { kalshi: { ticker: 'T', yesBid: 0.7, yesAsk: 0.71, near: 900, levels: [] } } : {}));
  assert.ok(kinds(d4.events()).includes('reprice:warn'), kinds(d4.events()).join());
});

test('no fresh price for 30 seconds: hold (bad data never makes a call)', () => {
  const d = createDetector();
  const t = quiet(d, 10);
  d.step({ now: t + 31000, venues: {}, feeds: {} });
  assert.ok(kinds(d.events()).includes('silent:severe'));
  assert.ok(d.hold(t + 32000));
  assert.equal(d.status(t + 32000).events60, 1);
});
