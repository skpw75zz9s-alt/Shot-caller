import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIMS, POOLS, PROOF, verdict } from '../public/breakproof.js';
import { createBreakLab } from '../breaklab.js';

const ones = (k, n) => Array.from({ length: n }, (_, i) => (i < k ? 1 : 0));

test('verdicts: testing until 30 cases, then proven, proven wrong or noise against a coin flip', () => {
  assert.equal(verdict('breakout', ones(20, 29)).status, 'testing');
  assert.match(verdict('breakout', ones(20, 29)).text, /claim being tested: it holds.*\(29 of 30 graded\)/);
  const p = verdict('breakout', ones(70, 100));
  assert.equal(p.status, 'proven'); assert.match(p.text, /^Proven: it holds.*held 5 minutes later in 70% of 100 breakouts/);
  assert.equal(verdict('breakout', ones(25, 100)).status, 'opposite');
  assert.match(verdict('breakout', ones(25, 100)).text, /Proven wrong: the opposite holds/);
  const n = verdict('breakout', ones(52, 100)); assert.equal(n.status, 'noise'); assert.match(n.text, /no better than a coin flip.*Treat it as noise/);
});

test('verdicts against a control: a jump has to beat ordinary moments, not a coin flip', () => {
  // big 5-minute moves after 45% of jumps, after 32% of ordinary moments: with 200 of each, that's clear
  const v = verdict('jump', ones(90, 200), ones(64, 200));
  assert.equal(v.status, 'proven'); assert.ok(v.z >= 2); assert.match(v.text, /45% of 200 were followed by a bigger-than-usual 5-minute move, against 32% of ordinary moments/);
  assert.equal(verdict('jump', ones(66, 200), ones(64, 200)).status, 'noise', 'the same as ordinary moments');
  assert.equal(verdict('jump', ones(90, 200), ones(10, 20)).status, 'testing', 'the control needs 30 too');
  assert.equal(verdict('flip', ones(20, 100), ones(40, 100)).status, 'opposite', 'the side ahead lost LESS often: the claim is wrong');
});

test('two-sided claims say which way the evidence points', () => {
  assert.match(verdict('gap', ones(70, 100)).text, /Proven: when they disagree this much, the bot has been right more often/);
  assert.match(verdict('gap', ones(30, 100)).text, /Proven: when they disagree this much, Kalshi has been right more often: trust Kalshi/);
  assert.match(verdict('flow', ones(52, 100)).text, /no clear answer yet/);
  assert.equal(verdict('book').status, 'fact'); assert.equal(verdict('split').status, 'untested'); assert.equal(verdict('order').status, 'untested');
  assert.equal(verdict('nope').status, 'untested');
});

test('the claims grade the outcomes they say', () => {
  const e = { spot: 100000, sigmaMin: 0.0005, dir: 1, level: 100100, mid: 0.5, p: 0.7, from: 0.4, size: 0.2 };
  assert.equal(CLAIMS.jump.out(e, { spot: 100200 }), true, '$200 > a typical 5-minute move (~$112)');
  assert.equal(CLAIMS.jump.out(e, { spot: 100050 }), false);
  assert.equal(CLAIMS.breakout.out(e, { spot: 100150 }), true); assert.equal(CLAIMS.breakout.out({ ...e, dir: -1, level: 99900 }, { spot: 99950 }), false);
  assert.equal(CLAIMS.lag.out({ ...e, size: 0.1 }, { mid: 0.56 }), true); assert.equal(CLAIMS.lag.out({ ...e, size: 0.1 }, { mid: 0.53 }), false);
  assert.equal(CLAIMS.gap.out(e, 1), true, 'the bot at 70% was closer to UP than Kalshi at 50%'); assert.equal(CLAIMS.gap.out(e, 0), false);
  assert.equal(CLAIMS.flip.out(e, 0), true, 'UP led and lost'); assert.equal(CLAIMS.lead.out({ dir: -1 }, 1), true, 'the new leader (DOWN) lost');
  assert.equal(CLAIMS.swing.out(e, { p: 0.55 }), true); assert.equal(CLAIMS.swing.out(e, { p: 0.45 }), false);
  assert.equal(CLAIMS.flow.out(e, { spot: 100010 }), true); assert.equal(CLAIMS.liqs.out({ ...e, dir: -1 }, { spot: 100010 }), false);
  assert.equal(POOLS.leader.out({ p: 0.3 }, 1), true);
});

// a synthetic market: a quiet round with one jump at minute 3, then a flat price, then settlement
function snapAt(t, spot, { open, strike = 100000, p = 0.6, yb = 0.55, ya = 0.6, bars = [] } = {}) {
  return { spot, mSpot: spot, sigmaMin: 0.0005, sigmaLong: 0.0005, bars, quoteLog: {},
    rows: [{ m: { ticker: 'T1', open_time: new Date(open).toISOString(), close_time: new Date(open + 900000).toISOString() }, strike, pPre: p, sigma: 0.0005,
      ev: { minutesLeft: (open + 900000 - t) / 60000, pYes: p, quote: { yesBid: yb, yesAsk: ya, noAsk: 1 - yb } } }] };
}
test('the lab: finds a jump, records it, takes control samples, grades both at the horizon, grades the gap at settlement', async () => {
  const open = Date.UTC(2026, 9, 19, 12, 0), file = join(mkdtempSync(join(tmpdir(), 'blab-')), 'breaks.json');
  let now = open + 30000; const lab = createBreakLab({ file, clock: () => now, log: { error() {} } });
  const bars = [];
  for (let s = 0; s <= 600; s += 1) { // ten minutes, a second at a time
    now = open + 30000 + s * 1000;
    const min = Math.floor((now - open) / 60000), price = min >= 3 ? 100300 : 100000; // the jump: +$300 into minute 3
    if (bars.length < min) bars.push({ t: open + bars.length * 60000, c: bars.length >= 3 ? 100300 : 100000 });
    lab.observe('KXBTC15M', snapAt(now, price, { open, bars: bars.slice(), p: 0.6, yb: 0.3, ya: 0.35 }), { kind: 'index' });
  }
  const a = lab.api('KXBTC15M');
  assert.ok(a.controls.move5.n >= 3, 'a control a minute'); assert.ok(a.pending > 0);
  // the jump was graded 5 minutes on: the price stayed flat after it, so no bigger-than-usual move
  assert.equal(a.kinds.jump.status, 'testing'); assert.equal(a.kinds.jump.n, 1);
  // Kalshi at 32.5% vs the bot's 60%: a gap, graded at settlement (UP won: the bot was closer)
  lab.settle('KXBTC15M', 'T1', 'yes'); await lab.save(); lab.stop();
  const b = lab.api('KXBTC15M');
  assert.equal(b.kinds.gap.n, 1); assert.equal(b.kinds.gap.status, 'testing');
  assert.ok(b.controls.leader.n >= 3, 'the ordinary moments graded at settlement too');
  const again = createBreakLab({ file, log: { error() {} } }); await again.load();
  assert.equal(again.api('KXBTC15M').kinds.gap.n, 1, 'kept across a restart'); again.stop();
  assert.equal(PROOF.minN, 30);
});
