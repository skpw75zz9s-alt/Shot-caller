import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, evaluate, probYes, riskSettings } from '../public/model.js';
import { PICK, pickNow, pickScore } from '../public/pick.js';
import { sideOdds } from '../public/engine.js';
import { accuracyRows } from '../public/accuracy.js';
import { pickMessage } from '../discord.js';

const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002, prof = riskSettings('profit');
function setup({ yb, ya, lead = 250, mins = 10, pShift = 0 }) {
  const m = { ticker: 'T', close_time: new Date(NOW + mins * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya };
  const ev = evaluate({ market: m, strike: K, spot: K + lead, sigmaMin: SIG, pShift, now: NOW });
  return { row: { m, strike: K, ev }, snap: { sigmaMin: SIG, driftMin: 0, spot: K + lead } };
}

test('the pick: the side the math favours, its odds, and a worst case that can only be lower', () => {
  assert.equal(PICK.at, 10);
  const up = pickNow({ ...setup({ yb: 70, ya: 72, lead: 120 }), settings: prof });
  assert.equal(up.side, 'YES'); assert.ok(up.p > 0.8 && up.p < 1, String(up.p)); assert.ok(up.worst <= up.p);
  const down = pickNow({ ...setup({ yb: 28, ya: 30, lead: -120 }), settings: prof });
  assert.equal(down.side, 'NO'); assert.equal(down.ask, 0.72, 'buying DOWN costs 100 minus the YES bid');
  assert.equal(pickNow({ ...setup({ yb: 70, ya: 72 }), snap: { sigmaMin: 0 } }), null, 'no volatility yet: no pick');
});

test('BUY only when it pays: inside the 60-90c band with an 8c+ worst-case edge after the fee', () => {
  const buy = pickNow({ ...setup({ yb: 79, ya: 80, lead: 250 }), settings: prof });
  assert.equal(buy.buy, true, JSON.stringify(buy)); assert.ok(buy.gap >= 0.08); assert.match(buy.why, /worth buying/);
  const dear = pickNow({ ...setup({ yb: 95, ya: 96, lead: 250 }), settings: prof });
  assert.equal(dear.buy, false); assert.match(dear.why, /outside 60-90¢/);
  const thin = pickNow({ ...setup({ yb: 74, ya: 75, lead: 60 }), settings: prof });
  assert.equal(thin.side, 'YES'); assert.equal(thin.buy, false); assert.match(thin.why, /a pick, not a buy/);
});

test('the pick on Discord (with the last one\'s result) and on the accuracy card', () => {
  const e = { ticker: 'T', side: 'YES', price: 0.8, p: 0.93, worst: 0.9, gap: 0.09, buy: true, why: 'worth buying', strike: K, closeTime: new Date(NOW + 600000).toISOString() };
  const m = pickMessage(e, { prev: { side: 'NO', price: 0.7, result: 'no' }, stats: { graded: 10, wins: 7 } }).embeds[0];
  assert.match(m.title, /10-MIN PICK · 🐂 UP · ✅ BUY/); assert.match(m.description, /93%/);
  assert.equal(m.fields.find((f) => f.name === 'Last pick').value, '✅ won (DOWN at 70¢)');
  assert.ok(!pickMessage({ ...e, buy: false, why: 'a pick, not a buy: at 95c' }).embeds[0].title.includes('BUY'));
  const row = accuracyRows({ bot: { graded: 0, wins: 0, pick: { graded: 40, wins: 29, avgP: 0.71, buys: { graded: 5, wins: 4, usd: 3 } } } }).find((r) => r.key === 'pick10');
  assert.equal(row.verdict, 'good', 'won 72.5% where the math said 71%'); assert.match(row.metric, /won 29 of 40/); assert.match(row.vs, /BUY picks: 4 of 5/);
});

test("exact worst case: the engine's own math, every learned nudge included, and never above the odds", () => {
  // a learned nudge against UP (calibration, rejection tilt, Kalshi blend...): the old worst case ignored it and could
  // come out above the odds themselves
  const a = setup({ yb: 70, ya: 72, lead: 120, pShift: -0.04 }), pk = pickNow({ ...a, settings: prof });
  assert.equal(pk.side, 'YES');
  const engine = Math.min(...PICK.vols.map((k) => sideOdds(a.row, a.snap, { ...DEFAULTS, ...prof }, 'YES', k)));
  assert.ok(Math.abs(pk.worst - Math.min(pk.p, engine)) < 1e-12, 'the same number the call engine uses');
  assert.ok(pk.worst <= pk.p + 1e-12);
  const raw = probYes(a.row.m, K, K + 120, SIG * 0.8, 10, 0, null, 0);
  assert.ok(pk.worst < raw - 0.03, 'the nudge against the side is kept');
  // a nudge in the side's favour is dropped from the worst case (it can only be harder), but stays in the odds
  const b = pickNow({ ...setup({ yb: 70, ya: 72, lead: 120, pShift: 0.03 }), settings: prof });
  assert.ok(b.p > pk.p + 0.06); assert.ok(b.worst <= b.p - 0.03 + 1e-9);
  for (const lead of [-300, -80, 0, 40, 160, 400]) for (const sh of [-0.05, 0, 0.05]) { const x = pickNow({ ...setup({ yb: 40, ya: 42, lead, pShift: sh }), settings: prof }); assert.ok(x.worst <= x.p + 1e-12, `${lead}/${sh}`); }
});

test('when the official bot already called, the pick is that side with its own odds and worst case', () => {
  const pk = pickNow({ ...setup({ yb: 70, ya: 72, lead: 120 }), settings: prof, side: 'NO' });
  assert.equal(pk.side, 'NO'); assert.equal(pk.official, true); assert.ok(pk.p < 0.2); assert.ok(pk.worst != null && pk.worst <= pk.p);
  assert.ok(Math.abs(pk.ask - 0.3) < 1e-9); assert.match(pk.why, /^the official call stands/);
  assert.equal(pickNow({ ...setup({ yb: 70, ya: 72, lead: 120 }), settings: prof, side: 'YES' }).official, false);
});

test("the $10 order and Kalshi's odds: whole contracts, one fee on the order, the mid as the baseline", () => {
  const pk = pickNow({ ...setup({ yb: 79, ya: 80, lead: 250 }), settings: prof });
  assert.equal(pk.kalshi, 0.795);
  const n = Math.floor(10 / 0.8), fee = Math.ceil(0.07 * n * 0.8 * 0.2 * 100) / 100 / n;
  assert.ok(Math.abs(pk.gap - (pk.worst - 0.8 - fee)) < 1e-9);
});

test("the odds are exact for Kalshi's settlement: a brute-force simulation of the final minute's 60 prints agrees", () => {
  let seed = 4242; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  for (const [strike, sig, tails] of [[100100, 0.0005, 0], [99850, 0.0006, 0.35]]) {
    const m = { strike_type: 'greater', floor_strike: strike }, p = probYes(m, strike, 100000, sig, PICK.at, 0, null, tails);
    let hit = 0; const n = 40000, d = 1 / 60;
    for (let j = 0; j < n; j++) {
      const s = sig * Math.exp(tails * gauss() - tails * tails); let x = Math.log(100000), sum = 0;
      const step = (dt) => { x += -s * s / 2 * dt + s * Math.sqrt(dt) * gauss(); };
      step(PICK.at - 1 + d); sum += Math.exp(x);
      for (let i = 2; i <= 60; i++) { step(d); sum += Math.exp(x); }
      if (sum / 60 > strike) hit++;
    }
    const se = Math.sqrt(p * (1 - p) / n);
    assert.ok(Math.abs(hit / n - p) < 4 * se, `model ${p.toFixed(4)} vs simulated ${(hit / n).toFixed(4)} (±${se.toFixed(4)})`);
  }
});

test("the scorecard: Brier score against Kalshi's own odds, and calibration by band", () => {
  const picks = [
    { side: 'YES', p: 0.8, kalshi: 0.7, result: 'yes' }, { side: 'NO', p: 0.6, kalshi: 0.55, result: 'yes' },
    { side: 'YES', p: 0.9, kalshi: 0.85, result: 'yes' }, { side: 'YES', p: 0.7, result: 'no' }, { side: 'NO', p: 0.65, kalshi: 0.6, result: null },
  ];
  const sc = pickScore(picks);
  assert.equal(sc.n, 4); assert.equal(sc.vs, 3);
  assert.ok(Math.abs(sc.brierBot - (0.04 + 0.36 + 0.01) / 3) < 1e-12);
  assert.ok(Math.abs(sc.brierKalshi - (0.09 + 0.3025 + 0.0225) / 3) < 1e-12);
  const b = sc.bands.find((x) => x.lo === 0.6); assert.equal(b.n, 1); assert.equal(b.won, 0);
  const row = accuracyRows({ bot: { graded: 0, wins: 0, pick: { graded: 40, wins: 26, avgP: 0.72, score: { vs: 40, brierBot: 0.19, brierKalshi: 0.2 } } } }).find((r) => r.key === 'pick10');
  assert.equal(row.verdict, 'good', 'beats Kalshi head to head'); assert.match(row.metric, /Brier 0\.190 vs Kalshi's 0\.200/);
});
