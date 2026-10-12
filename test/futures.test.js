import test from 'node:test';
import assert from 'node:assert/strict';
import { createFutures } from '../futures.js';
import { createDetector } from '../public/watch.js';
import { featureVector, scanRound } from '../public/roundscan.js';

const T = 1_700_000_000_000;
test('futures reads: lead over spot, taker flow, open interest with the price, premium', () => {
  let now = T;
  const f = createFutures({ clock: () => now, WSImpl: null });
  // futures climb $60 over 30 s while spot climbs $10; mostly buyers (received live)
  now = T + 120000;
  for (let i = 0; i <= 120; i++) f.onTrades([{ side: i % 4 ? 'B' : 'A', px: String(100000 + (i >= 90 ? (i - 90) * 2 : 0)), sz: '0.5', time: T + i * 1000 }]);
  const ctx = (oi, mark) => [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{ funding: '0', openInterest: '1', markPx: '1', oraclePx: '1', premium: '0' }, { funding: '0.00012', openInterest: String(oi), markPx: String(mark), oraclePx: String(mark - 50), premium: '0.0005' }]];
  now = T; f.onCtx(ctx(10000, 100000));
  now = T + 120000; f.onCtx(ctx(10150, 100060)); // open interest +1.5% with the price up: new money pushing it
  const spotAt = (t) => 100000 + Math.max(0, (t - (T + 90000)) / 1000) * (10 / 30);
  const r = f.features({ now, spotAt, sigmaMin: 0.0008 });
  assert.equal(r.live, true);
  assert.ok(r.lead > 0.2, `futures ahead: ${r.lead}`);
  assert.ok(Math.abs(r.flow - 0.5) < 0.05, `75% buying -> +0.5: ${r.flow}`);
  assert.equal(r.oi, 1);
  assert.ok(Math.abs(r.premium - 0.5 / 3) < 1e-9);
  assert.deepEqual(createFutures({ clock: () => now, WSImpl: null }).features({ now }), { lead: 0, flow: 0, oi: 0, premium: 0, live: false }, 'no feed: all zero');
});

test('futures reads become scan inputs (flipped for "below" markets like the rest)', () => {
  const sc = scanRound([{ t: T + 1000, ex: 'Coinbase', side: 'buy', price: 100000, size: 1 }], { openTime: T, now: T + 5000, extra: { fLead: 0.4, fFlow: 0.5, fOi: 1, fPremium: 0.1, live: true } });
  assert.deepEqual(featureVector(sc, 'greater').slice(6, 10), [0.4, 0.5, 1, 0.1]);
  assert.deepEqual(featureVector(sc, 'less').slice(6, 10), [-0.4, -0.5, -1, -0.1]);
  assert.ok(sc.futures);
});

test('Market watch: futures flush, crowded funding, stretched premium', () => {
  const d = createDetector();
  d.step({ now: T, futures: { oiChange5: -0.02, priceChange5: -0.004, funding: 0.00015, premium: 0.0012 } });
  const k = d.events().map((e) => e.kind).sort();
  assert.deepEqual(k, ['flush', 'funding', 'premium']);
  assert.match(d.events().find((e) => e.kind === 'flush').text, /longs being forced out/);
});
