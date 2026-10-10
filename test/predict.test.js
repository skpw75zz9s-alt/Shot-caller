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
