import test from 'node:test';
import assert from 'node:assert/strict';
import { crossings, distance, hiddenStats, kalshiBig, liqSummary, niceStep, positioning, xraySvg } from '../public/xray.js';
import { kalshiFee, normCdf } from '../public/model.js';

const now = 1e12, live = { pYes: 0.7, yesBid: 0.6, yesAsk: 0.64, spot: 100100, strike: 100000, sigmaMin: 0.0005, sigmaLong: 0.0004, minutesLeft: 4 };
const by = (xs) => Object.fromEntries(xs.map((x) => [x.key, x]));

test('readers: Kalshi orders, liquidations, funding per year, distance, round steps and target crossings', () => {
  const k = kalshiBig([{ side: 'YES', usd: 60 }, { side: 'NO', usd: 200 }, { side: 'YES', usd: 0 }]);
  assert.deepEqual([k.n, k.total, k.biggest], [2, 260, 200]);
  assert.deepEqual(liqSummary([{ t: now - 1, liq: 'long', usd: 3 }, { t: now - 2, liq: 'short', usd: 1 }, { t: now - 4e6, liq: 'long', usd: 9 }], now), { n: 2, long: 3, short: 1, minutes: 30 });
  assert.ok(Math.abs(positioning({ funding: 0.00001 }).fundingYear - 0.0876) < 1e-9); assert.equal(positioning(null), null);
  const d = distance(live); assert.equal(d.gap, 100); assert.ok(Math.abs(d.move - 100.1) < 1e-9); assert.equal(distance({ ...live, minutesLeft: 0 }), null);
  assert.deepEqual([niceStep(10.01), niceStep(2.7), niceStep(0.06), niceStep(80)], [10, 2, 0.05, 100]);
  assert.equal(crossings([99, 101, 102, 100, 98, 101], 100), 3, 'a close exactly on the target is no crossing by itself');
});

test('the hidden stats: cross chance, clock value, odds per move, break-even, the toll, crossings, volatility, lock-in', () => {
  const s = by(hiddenStats({ now, kind: 'crypto', settle: 'avg60', live, closes: [99900, 100050, 99950, 100080] }));
  const z = Math.log(1.001) / (0.0005 * 2);
  assert.equal(s.cross.value, `${Math.round(2 * normCdf(-z) * 100)}%`); assert.match(s.cross.note, /has to finish below it/);
  const gain = (normCdf(z * Math.sqrt(4 / 3)) - normCdf(z)) * 100;
  assert.equal(s.theta.value, `+${gain.toFixed(1)} pts/min`);
  assert.match(s.delta.value, / pts per \$10\.00$/);
  const be = 0.64 + kalshiFee(0.64);
  assert.equal(s.breakeven.value, `${(be * 100).toFixed(1)}% wins`); assert.equal(s.breakeven.tone, 'pos'); assert.match(s.breakeven.note, /UP at 64¢.*The bot gives it 70\.0%/);
  assert.match(s.toll.note, /Buying UP and selling it straight back costs/);
  assert.equal(s.crossings.value, '3×');
  assert.equal(s.regime.value, '1.25×');
  assert.equal(s.lockin.value, '1/60 per sec');
  assert.equal(by(hiddenStats({ now, kind: 'crypto', settle: 'avg60', live: { ...live, minutesLeft: 0.25 } })).lockin.value, '75%');
});

test('the bot favouring DOWN: break-even and the toll are for DOWN, priced off the YES bid', () => {
  const s = by(hiddenStats({ now, kind: 'index', settle: 'spot', live: { ...live, pYes: 0.2, yesBid: 0.25, yesAsk: 0.28 } }));
  assert.match(s.breakeven.note, /DOWN at 75¢/); assert.ok(!s.lockin, 'spot-settled markets have no 60-second average');
});

test('crypto extras: trade pace, the Kalshi crowd, the cost of leverage and forced closes; nothing without data', () => {
  const trades = [...Array.from({ length: 30 }, (_, i) => ({ t: now - 120000 - i * 10000 })), ...Array.from({ length: 12 }, (_, i) => ({ t: now - i * 4000 }))];
  const s = by(hiddenStats({ now, kind: 'crypto', live: null, trades, kalshiTrades: [{ side: 'YES', usd: 30 }, { side: 'NO', usd: 10 }],
    srv: { futures: { fundingYear: 0.42 }, liqs: { n: 3, long: 2e6, short: 5e5, minutes: 30 } } }));
  assert.equal(s.pace.value, `${(12 / 4.2).toFixed(1)}× · 12/min`);
  assert.equal(s.crowd.value, '$20 · 2 orders');
  assert.equal(s.funding.value, 'longs pay 42.0%/yr'); assert.equal(s.funding.tone, 'neg');
  assert.equal(s.liqs.value, '$2.5M · 30 min');
  assert.deepEqual(hiddenStats({ now, kind: 'crypto', live: null }), []);
});

test('the film: ribs per minute, the target, the spine, crossing bones, the cone to the close and the live dot', () => {
  const open = now - 5 * 60000, close = now + 10 * 60000;
  const bars = [{ t: open + 60000, c: 99950 }, { t: open + 120000, c: 100050 }, { t: open + 180000, c: 99980 }, { t: open - 60000, c: 1 }];
  const { svg, ok } = xraySvg({ bars, spot: 100020, strike: 100000, open, close, now, sigmaMin: 0.0005 });
  assert.equal(ok, true);
  assert.equal((svg.match(/class="rib"/g) || []).length, 16);
  assert.equal((svg.match(/class="bone cross"/g) || []).length, 3);
  assert.match(svg, /class="target"/); assert.match(svg, /class="spine"/); assert.match(svg, /class="tissue"/); assert.match(svg, /class="bone now"/);
  assert.doesNotMatch(svg, /NaN/);
  assert.equal(xraySvg({ open, close: open, strike: 1 }).ok, false);
});

// ---------- breaks ----------
import { BREAKS, findBreaks, trackBreaks } from '../public/xray.js';
const kinds = (xs) => xs.map((b) => b.kind).sort();

test('breaks: a jump, a breakout, Kalshi lagging and disagreeing with the bot, UP and DOWN prices that disagree', () => {
  const t0 = now - 5 * 60000, typ = 100100 * 0.0005; // a typical minute: ~$50
  const bars = [{ t: t0, c: 100000 }, { t: t0 + 60000, c: 100020 }, { t: t0 + 120000, c: 100300 }, { t: now, c: 100100 }];
  const preBars = Array.from({ length: 8 }, (_, i) => ({ t: t0 - (i + 1) * 60000, c: 100000, h: 100150, l: 99900 }));
  const quoteLog = [{ t: now - 30000, p: 0.6, yesAsk: 0.6, noAsk: 0.42 }, { t: now - 2000, p: 0.7, yesAsk: 0.62, noAsk: 0.42 }];
  const b = findBreaks({ now, kind: 'index', live: { ...live, yesBid: 0.3, yesAsk: 0.44, pYes: 0.7 }, bars, preBars, quoteLog });
  assert.deepEqual(kinds(b), ['book', 'breakout', 'gap', 'jump', 'jump', 'lag']);
  const j = b.find((x) => x.kind === 'jump' && x.price === 100300);
  assert.equal(j.sev, 3, `$280 is ${(280 / typ).toFixed(1)}x a typical minute`); assert.match(j.title, /Jump up of \$280\.00 in a minute/);
  assert.match(b.find((x) => x.kind === 'breakout').title, /Broke above the last 15 minutes' high \(\$100150\.00\)/);
  assert.match(b.find((x) => x.kind === 'lag').detail, /10 points toward UP in 28 seconds; Kalshi's quote moved 1/);
  assert.equal(b.find((x) => x.kind === 'gap').title, 'Bot and Kalshi disagree by 33 points'); assert.equal(b.find((x) => x.kind === 'gap').sev, 3);
  assert.equal(b.find((x) => x.kind === 'book').title, 'UP and DOWN prices disagree by 14¢'); assert.match(b.find((x) => x.kind === 'book').detail, /^UP 44¢ \+ DOWN 70¢ = 114¢/);
});

test('breaks (crypto): a 15-second spike, an exchange split, one-sided flow, a big Kalshi order, a liquidation burst, a volatility shift', () => {
  const trades = [];
  for (let i = 0; i < 100; i++) trades.push({ t: now - 590000 + i * 5000, ex: 'Coinbase', price: 100000, size: 0.01, side: i % 2 ? 'buy' : 'sell' });
  for (let i = 0; i < 3; i++) trades.push({ t: now - 17000 + i * 500, ex: 'Coinbase', price: 99900, size: 0.01, side: 'sell' }); // 15 seconds ago
  for (let i = 0; i < 20; i++) trades.push({ t: now - 4000 + i * 100, ex: ['Coinbase', 'Kraken', 'Bitstamp', 'OKX'][i % 4], price: i % 4 === 3 ? 99800 : 100100, size: 1, side: 'buy' });
  const b = findBreaks({ now, kind: 'crypto', live: { ...live, sigmaMin: 0.0009, sigmaLong: 0.0004 }, trades,
    kalshiTrades: [{ t: now - 1, side: 'NO', usd: 900, price: 0.4 }, { t: now - 2, side: 'YES', usd: 300, price: 0.6 }],
    srv: { liqs: { n: 9, long: 7e6, short: 1e6, minutes: 30 } } });
  assert.deepEqual(kinds(b), ['flow', 'liqs', 'order', 'regime', 'spike', 'split']);
  assert.match(b.find((x) => x.kind === 'split').title, /^OKX split from the other exchanges/);
  assert.match(b.find((x) => x.kind === 'flow').title, /One-sided buying: 100%/);
  assert.equal(b.find((x) => x.kind === 'liqs').sev, 2); assert.match(b.find((x) => x.kind === 'liqs').means, /pushes the price down/);
  assert.match(b.find((x) => x.kind === 'order').title, /75% of the round/);
  assert.deepEqual(findBreaks({ now, kind: 'crypto', live: null }), [], 'nothing to scan, nothing found');
  assert.ok(BREAKS.jump > 0);
});

test('breaks: high flip risk, odds and Kalshi swings, the price and Kalshi pulling apart, a lead change, a crossed book', () => {
  const quoteLog = [{ t: now - 60000, p: 0.3, yesAsk: 0.62, noAsk: 0.4, s: 99990 }, { t: now - 30000, p: 0.45, yesAsk: 0.55, noAsk: 0.47, s: 100010 }, { t: now - 2000, p: 0.55, yesAsk: 0.38, noAsk: 0.64, s: 100020 }];
  const b = findBreaks({ now, kind: 'index', live: { ...live, pYes: 0.55, yesBid: 0.5, yesAsk: 0.52, noAsk: 0.47, hold: 0.35, holdSide: 'YES' }, quoteLog });
  const k = (key) => b.find((x) => x.key === key || x.key.startsWith(key));
  assert.equal(k('flip').title, 'High flip risk: 65/100'); assert.equal(k('flip').sev, 3); assert.match(k('flip').detail, /Hold odds 35% on UP/);
  assert.match(k('swing:bot').title, /Odds swing: 25 points toward UP/); assert.match(k('swing:bot').detail, /30% → 55% in 58 seconds/);
  assert.match(k('swing:kalshi').title, /Kalshi swing: 24 points toward DOWN/);
  assert.equal(k('diverge').title, 'The price and Kalshi are moving opposite ways');
  assert.match(k('lead').title, /Lead change: now UP/); assert.equal(k('lead').at, now - 30000); assert.equal(k('lead').price, 100000);
  assert.equal(k('crossed').title, 'UP and DOWN cost less than $1 together');
  // no hold odds: a late toss-up counts; an early one doesn't
  const late = findBreaks({ now, kind: 'index', live: { ...live, pYes: 0.42, minutesLeft: 3 } });
  assert.match(late.find((x) => x.kind === 'flip').detail, /DOWN leads at only 58% with 3\.0 minutes left/);
  assert.ok(!findBreaks({ now, kind: 'index', live: { ...live, pYes: 0.42, minutesLeft: 9 } }).some((x) => x.kind === 'flip'));
});

test('the break log: open while found, healed after 20 seconds, the crack stays where it opened, a new round starts over', () => {
  const g = (at) => ({ key: 'gap', kind: 'gap', at, price: null, sev: 2, title: 'gap' });
  let log = trackBreaks(null, [g(now)], now, 'T1');
  log = trackBreaks(log, [g(now + 10000)], now + 10000, 'T1');
  assert.equal(log.items.length, 1); assert.equal(log.items[0].open, true); assert.equal(log.items[0].at, now); assert.equal(log.items[0].first, now);
  log = trackBreaks(log, [], now + 31000, 'T1');
  assert.equal(log.items[0].open, false); assert.equal(log.items[0].last, now + 10000);
  assert.deepEqual(trackBreaks(log, [], now + 40000, 'T2').items, []);
});

test('the film draws a crack for each break in the round', () => {
  const open = now - 5 * 60000, close = now + 10 * 60000;
  const { svg } = xraySvg({ bars: [{ t: open + 60000, c: 100000 }], spot: 100050, strike: 100000, open, close, now, sigmaMin: 0.0005,
    breaks: [{ at: now - 1000, sev: 3, open: true }, { at: open + 60000, price: 100000, sev: 1, open: false }, { at: open - 1, sev: 2 }] });
  assert.equal((svg.match(/class="crack s3 open"/g) || []).length, 1); assert.equal((svg.match(/class="crack s1"/g) || []).length, 1);
  assert.doesNotMatch(svg, /crack s2/, 'a break from before the round is off the film');
});
