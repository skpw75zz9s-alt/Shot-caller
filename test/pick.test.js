import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, evaluate, probYes, riskSettings } from '../public/model.js';
import { PICK, mixOdds, pickAlways, pickFallback, pickMix, pickNow, pickScore } from '../public/pick.js';
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
  assert.match(m.title, /ROUND CALL · 🐂 UP · ✅ BUY/); assert.match(m.description, /93%/);
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
  assert.ok(Math.abs(pk.worstBot - Math.min(pk.pb, engine)) < 1e-12, 'the same number the call engine uses');
  assert.ok(pk.worstBot <= pk.pb + 1e-12 && pk.worst <= pk.p + 1e-12);
  const raw = probYes(a.row.m, K, K + 120, SIG * 0.8, 10, 0, null, 0);
  assert.ok(pk.worstBot < raw - 0.03, 'the nudge against the side is kept');
  // a nudge in the side's favour is dropped from the worst case (it can only be harder), but stays in the odds
  const b = pickNow({ ...setup({ yb: 70, ya: 72, lead: 120, pShift: 0.03 }), settings: prof });
  assert.ok(b.pb > pk.pb + 0.06); assert.ok(b.worstBot <= b.pb - 0.03 + 1e-9);
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
  assert.ok(Math.abs(sc.brierPick - sc.brierBot) < 1e-12, "old picks: the pick's odds were the bot's");
  const row = accuracyRows({ bot: { graded: 0, wins: 0, pick: { graded: 40, wins: 26, avgP: 0.72, mix: { mix: 0.25, learned: true }, score: { vs: 40, brierPick: 0.19, brierBot: 0.21, brierKalshi: 0.2 } } } }).find((r) => r.key === 'pick10');
  assert.equal(row.verdict, 'good', 'beats Kalshi head to head'); assert.match(row.metric, /Brier: pick 0\.190, bot alone 0\.210, Kalshi 0\.200/); assert.match(row.metric, /25% bot, 75% Kalshi \(learned\)/);
});

test("the pick combines the bot's odds with Kalshi's (log odds), half and half until its record says otherwise", () => {
  assert.ok(Math.abs(mixOdds(0.7, 0.7, 0.5) - 0.7) < 1e-12, 'agreeing forecasts stay put');
  assert.ok(Math.abs(mixOdds(0.8, 0.2, 0.5) - 0.5) < 1e-12, 'opposite views meet in the middle');
  assert.equal(mixOdds(0.8, null, 0.5), 0.8, 'no Kalshi price: the bot alone');
  // the bot says UP 60%, Kalshi prices UP at 25%: combined, DOWN is the side
  const a = setup({ yb: 24, ya: 26, lead: 30 }), pk = pickNow({ ...a, settings: prof });
  assert.ok(a.row.ev.pYes > 0.5, String(a.row.ev.pYes)); assert.equal(pk.side, 'NO'); assert.ok(Math.abs(pk.kalshi - 0.75) < 1e-9);
  assert.ok(pk.p > 0.5 && pk.pb < 0.5, "the pick's odds for DOWN, the bot's alone under half"); assert.ok(pk.worst <= pk.p + 1e-12); assert.equal(pk.mix, 0.5);
  assert.equal(pickNow({ ...a, settings: prof, mix: 1 }).side, 'YES', 'all bot: the old pick');
  const wide = pickNow({ ...setup({ yb: 10, ya: 40, lead: 30 }), settings: prof });
  assert.equal(wide.mix, 1, 'a 30c spread is no real price: left out'); assert.equal(wide.side, 'YES');
});

test("the mix is learned from the pick's own record from 30 graded picks: Kalshi's share grows when Kalshi was righter", () => {
  let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const make = (kalshiGood) => Array.from({ length: 200 }, () => {
    const truth = rnd(), won = rnd() < truth, side = 'YES';
    const k = kalshiGood ? Math.min(0.97, Math.max(0.03, truth + (rnd() - 0.5) * 0.1)) : 0.5 + (rnd() - 0.5) * 0.3;
    const b = kalshiGood ? Math.min(0.97, Math.max(0.03, 0.5 + (truth - 0.5) * 0.4 + (rnd() - 0.5) * 0.3)) : Math.min(0.97, Math.max(0.03, truth + (rnd() - 0.5) * 0.1));
    return { side, pb: b, p: b, kalshi: k, result: won ? 'yes' : 'no' };
  });
  assert.deepEqual(pickMix(make(true).slice(0, 29)), { mix: PICK.mix, n: 29, learned: false });
  const good = pickMix(make(true)), noise = pickMix(make(false));
  assert.equal(good.learned, true); assert.ok(good.mix <= 0.25, `Kalshi righter: mix ${good.mix}`);
  assert.ok(noise.mix >= 0.75, `Kalshi noise: mix ${noise.mix}`);
});

test('the guaranteed pick: when the bot\'s odds can\'t be worked out, Kalshi\'s favourite, else the side price is on; never a buy', () => {
  const row = (q, spot, type = 'greater') => ({ m: { ticker: 'T', strike_type: type }, strike: 100000, ev: { pYes: null, minutesLeft: 8, quote: q } });
  const kal = pickFallback({ row: row({ yesBid: 0.3, yesAsk: 0.32, noBid: 0.68, noAsk: 0.7 }), snap: { spot: 100500 } });
  assert.deepEqual([kal.side, kal.fallback, kal.buy, Math.round(kal.p * 100)], ['NO', 'kalshi', false, 69]);
  const px = pickFallback({ row: row({}), snap: { spot: 100500 } });
  assert.deepEqual([px.side, px.fallback, px.p], ['YES', 'price', 0.5]);
  assert.equal(pickFallback({ row: row({}, 0, 'less'), snap: { spot: 100500 } }).side, 'NO', 'a "less" market: above the target is NO');
  assert.equal(pickFallback({ row: row({}), snap: {} }), null, 'nothing to go on at all');
  assert.equal(pickAlways({ row: row({ yesBid: 0.6, yesAsk: 0.62 }), snap: {} }).fallback, 'kalshi');
  // fallback picks stay out of the bot-vs-Kalshi score and the learned mix (they're Kalshi's own side)
  const graded = [...Array(40)].map((_, i) => ({ side: 'YES', result: 'yes', p: 0.6, pb: null, kalshi: 0.6, fallback: 'kalshi', at: i }));
  assert.equal(pickScore(graded).vs, 0);
  assert.equal(pickMix(graded).learned ?? false, false);
});

test('the tune-up\'s calibration: temp above 1 pulls the odds and the worst case toward 50%, never changes the side', () => {
  const base = pickNow({ ...setup({ yb: 70, ya: 72, lead: 120 }), settings: prof });
  const cool = pickNow({ ...setup({ yb: 70, ya: 72, lead: 120 }), settings: prof, temp: 2 });
  assert.equal(cool.side, base.side); assert.equal(cool.temp, 2); assert.equal(base.temp, 1);
  assert.ok(cool.p < base.p && cool.p > 0.5, `${cool.p} vs ${base.p}`);
  assert.ok(cool.worst <= base.worst); assert.equal(cool.pb, base.pb, 'the bot\'s own odds are kept as they were (the tune-up tests on them)');
});
