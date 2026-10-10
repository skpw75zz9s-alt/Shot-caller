import test from 'node:test';
import assert from 'node:assert/strict';
import { normInv, kalshiImplied, exchangeTrend, predictionLines, predictionRecord } from '../public/predict.js';
import { normCdf } from '../public/model.js';

test('normInv undoes normCdf', () => {
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-3, String(p));
});

test('Kalshi-implied close: 50¢ YES = the target; dearer YES = above it; "below" markets flip', () => {
  const base = { strike: 100000, sigmaMin: 0.0008, minutesLeft: 9 };
  assert.ok(Math.abs(kalshiImplied({ ...base, yesMid: 0.5 }) - 100000) < 1);
  const up = kalshiImplied({ ...base, yesMid: 0.8 });
  assert.ok(up > 100000 && up < 100300, String(up));
  assert.ok(kalshiImplied({ ...base, yesMid: 0.8, strikeType: 'less' }) < 100000);
  assert.equal(kalshiImplied({ ...base, yesMid: null }), null);
});

test('exchange trend: a steady climb on all five projects higher (at half strength); too few trades, no line', () => {
  const now = 1_700_000_300_000, close = now + 6 * 60000, ts = [];
  for (let s = 0; s < 300; s += 2) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US']) ts.push({ t: now - 300000 + s * 1000, ex, price: 100000 + s * 0.2 });
  const tr = exchangeTrend(ts, now, close);
  assert.ok(tr.slopePerMin > 10 && tr.slopePerMin < 14, String(tr.slopePerMin)); // $12 a minute
  assert.ok(Math.abs(tr.end - (tr.start + 6 * 12 * 0.5)) < 4, `${tr.start} -> ${tr.end}`);
  assert.equal(exchangeTrend(ts.slice(0, 5), now, close), null);
});

test('prediction lines stay inside the 90% cone and end at the close', () => {
  const now = 1_700_000_000_000, close = now + 8 * 60000;
  const lines = predictionLines({ spot: 100000, sigmaMin: 0.0005, driftMin: 0.01, now, close, strike: 100000, yesMid: 0.99, trades: [] });
  assert.deepEqual(lines.map((l) => l.key), ['bot', 'kalshi']);
  const sd = 100000 * 0.0005 * Math.sqrt(8);
  for (const l of lines) { assert.ok(Math.abs(l.end - 100000) <= 1.645 * sd + 1e-6); assert.equal(l.pts.at(-1).t, close); }
});

test('record: average miss per line vs no change', () => {
  const r = predictionRecord([{ actual: 100, bot: 90, kalshi: 104, spot: 80 }, { actual: 200, bot: 210, kalshi: 200, spot: 200 }, { actual: null, bot: 1 }]);
  assert.equal(r.rounds, 2); assert.equal(r.bot.miss, 10); assert.equal(r.kalshi.miss, 2); assert.equal(r.still.miss, 10); assert.equal(r.exch, null);
});

// ---------- v10.1 prediction candles ----------
import { blendWeights, candleRecord, predictionCandles } from '../public/predict.js';
test('prediction candles: realistic minutes to the close, mixed up and down, sized like recent candles, landing on the blend', () => {
  const now = Date.UTC(2026, 0, 1, 12, 3, 30), close = Date.UTC(2026, 0, 1, 12, 15);
  const pts = (from, to) => [{ t: now, v: from }, { t: close, v: to }];
  const lines = [{ key: 'bot', pts: pts(100000, 100000) }, { key: 'kalshi', pts: pts(100000, 100140) }];
  const bars = [];
  for (let i = 40; i > 0; i--) { const t = Math.floor(now / 60000) * 60000 - i * 60000; bars.push({ t, o: 1e5, h: 1e5 + 60, l: 1e5 - 60, c: 1e5 }); }
  const c = predictionCandles({ lines, spot: 100000, sigmaMin: 0.0008, now, close, bars });
  assert.equal(c.length, 11, '12:04 … 12:14');
  assert.equal(c[0].t, Date.UTC(2026, 0, 1, 12, 4));
  for (let i = 1; i < c.length; i++) assert.equal(c[i].o, c[i - 1].c, 'each opens where the last closed');
  for (const x of c) assert.ok(x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c));
  assert.ok(Math.abs(c[0].o - c[0].eo) < 1e-6, 'the first ghost opens on the expected path, next to the live price');
  assert.ok(Math.abs(c.at(-1).c - 100070) < 1e-6, 'lands on the blend (equal weights: halfway) at the close');
  assert.ok(Math.abs(c.at(-1).ec - 100070) < 1e-6);
  assert.ok(c.some((x) => x.c > x.o) && c.some((x) => x.c < x.o), 'mixed up and down minutes');
  // the same moment gives the same candles (no reshuffling between refreshes)
  assert.deepEqual(predictionCandles({ lines, spot: 100000, sigmaMin: 0.0008, now: now + 2000, close, bars }).map((x) => x.c), c.map((x) => x.c));
  // across many rounds: as many up as down minutes, and ranges like the recent real ones ($120)
  let up = 0, n = 0, range = 0;
  for (let r = 0; r < 300; r++) {
    const t = Date.UTC(2026, 0, 2) + r * 900000 + 30000, cl = t - 30000 + 900000;
    const bs = bars.map((b, i) => ({ ...b, t: Math.floor(t / 60000) * 60000 - (40 - i) * 60000 }));
    for (const x of predictionCandles({ lines: [{ key: 'bot', pts: [{ t, v: 1e5 }, { t: cl, v: 1e5 }] }], spot: 1e5, sigmaMin: 0.0008, now: t, close: cl, bars: bs }).slice(0, -3)) { n++; up += x.c > x.o ? 1 : 0; range += x.h - x.l; }
  }
  assert.ok(Math.abs(up / n - 0.5) < 0.05, `up share ${up / n}`);
  assert.ok(Math.abs(range / n - 120) < 15, `average range ${range / n}`);
  // weighted toward the line that has missed less
  const w = blendWeights({ bot: { miss: 60, n: 10 }, kalshi: { miss: 20, n: 10 }, exch: null });
  assert.ok(w.kalshi > w.bot * 8);
  assert.ok(predictionCandles({ lines, spot: 100000, sigmaMin: 0.0008, now, close, weights: w, bars }).at(-1).c > 100120);
  assert.deepEqual(predictionCandles({ lines: [], spot: 1, sigmaMin: 1, now, close }), []);
});
test('prediction candle record: direction and miss vs no change', () => {
  const r = candleRecord([
    { t: 1, o: 100, c: 110, open: 100, actual: 105 }, // right way, miss 5 (no change missed 5)
    { t: 2, o: 100, c: 90, open: 100, actual: 120 },  // wrong way
    { t: 3, o: 100, c: 101, open: null, actual: null }, // not graded yet
  ]);
  assert.deepEqual({ n: r.n, called: r.called, right: r.right }, { n: 2, called: 2, right: 1 });
  assert.equal(r.miss, (5 + 30) / 2); assert.equal(r.still, (5 + 20) / 2);
  assert.deepEqual(candleRecord([]), { n: 0 });
});
