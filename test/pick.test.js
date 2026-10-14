import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, riskSettings } from '../public/model.js';
import { PICK, pickNow } from '../public/pick.js';
import { accuracyRows } from '../public/accuracy.js';
import { pickMessage } from '../discord.js';

const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002, prof = riskSettings('profit');
function setup({ yb, ya, lead = 250, mins = 10 }) {
  const m = { ticker: 'T', close_time: new Date(NOW + mins * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya };
  const ev = evaluate({ market: m, strike: K, spot: K + lead, sigmaMin: SIG, now: NOW });
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
