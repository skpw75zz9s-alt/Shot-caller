import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, riskSettings } from '../public/model.js';
import { buySignal } from '../public/engine.js';
import { accuracyRows } from '../public/accuracy.js';
import { callMessage } from '../discord.js';

// The bot called DOWN earlier; now BTC is well above the target (same harness as test/earlylane.test.js)
const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002;
const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
function setup({ yb, ya, lead = 250, mins = 8, secs = 70, flipOff = false }) {
  const m = { ticker: 'T', close_time: new Date(NOW + mins * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya };
  const ev = evaluate({ market: m, strike: K, spot: K + lead, sigmaMin: SIG, now: NOW });
  const log = { T: [...Array(secs / 2 + 1)].map((_, i) => ({ t: NOW - secs * 1000 + i * 2000, p: 0.99, yesAsk: null, noAsk: null })) };
  return { row: { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } }, snap: { now: NOW, bars, sigmaMin: SIG, sigmaLong: SIG, driftMin: 0, spot: K + lead, quoteLog: log, earlyLive: true, flipOff } };
}
const t90 = { ...riskSettings('target90'), switchLocked: true }; // the switching mechanics (off by default since v13.45: a locked call never switches)
const calledDown = () => ({ T: { side: 'NO', at: NOW - 240000, price: 0.9, n: 1, bail: { side: 'NO', at: NOW - 60000, p: 0.2 } } });
const run = (o, s = t90, mem = calledDown()) => { const x = setup(o); return { sig: buySignal(x.row, x.snap, s, NOW, mem), mem }; };

test('the 90% target level flips a locked call on clear evidence: once, at half size, labelled', () => {
  assert.equal(t90.flipCalls, 1); assert.equal(t90.lockCall, true);
  const { sig, mem } = run({ yb: 90, ya: 91 });
  assert.ok(sig.fire && sig.callSide === 'YES', JSON.stringify(sig.flip));
  assert.deepEqual([sig.lane, sig.stance, sig.flip.from], ['flip', 'switching', 'NO']);
  assert.deepEqual([mem.T.side, mem.T.flips, mem.T.bail], ['YES', 1, null], 'the new call gets its own bail line');
  const full = run({ yb: 90, ya: 91 }, { ...t90, flipSize: 1 }).sig;
  assert.ok(sig.contracts < full.contracts, `${sig.contracts} vs ${full.contracts}`);
  // flipping back the same round: never (no ping-pong)
  const x = setup({ yb: 90, ya: 91, lead: -250 }); x.row.ev = evaluate({ market: { ...x.row.m, yes_bid: 8, yes_ask: 9 }, strike: K, spot: K - 250, sigmaMin: SIG, now: NOW });
  const back = buySignal(x.row, { ...x.snap, spot: K - 250, quoteLog: { T: x.snap.quoteLog.T.map((e) => ({ ...e, p: 0.01 })) } }, t90, NOW, mem);
  assert.equal(back.fire, false); assert.match(back.flip?.why ?? '', /already flipped/);
});

test('under the 90c floor a flip has to pass the early lane\'s rules', () => {
  const { sig } = run({ yb: 84, ya: 85 });
  assert.ok(sig.fire && sig.lane === 'flip', JSON.stringify(sig.flip));
  assert.match(run({ yb: 74, ya: 75 }).sig.flip.why, /too much doubt/);
});

test('what keeps a locked call locked: thin evidence, flips off, its losing record, the last 5 minutes, no steady wait', () => {
  const thin = run({ yb: 90, ya: 91, lead: 90 }).sig;
  assert.equal(thin.fire, false); assert.match(thin.flip.why, /worst case on UP|not past the bar/);
  assert.equal(run({ yb: 90, ya: 91, lead: 30 }).sig.flip, null, 'the bot doesn\'t even lean the other way: nothing to flip');
  const off = run({ yb: 90, ya: 91 }, { ...t90, flipCalls: 0 }).sig;
  assert.equal(off.fire, false); assert.equal(off.flip, null);
  assert.match(run({ yb: 90, ya: 91, flipOff: true }).sig.flip.why, /lost money/);
  assert.equal(run({ yb: 90, ya: 91, mins: 3 }).sig.fire, false, 'no new calls in the last 5 minutes, flips included');
  assert.equal(run({ yb: 90, ya: 91, secs: 20 }).sig.fire, false, 'the evidence has to hold for the full wait');
});

test('flip calls on the accuracy card and in the Discord post', () => {
  const row = accuracyRows({ bot: { graded: 10, wins: 9, usd: 1, flip: { graded: 5, wins: 4, usd: 2.5, profitGuard: { paused: false } } } }).find((r) => r.key === 'flipcalls');
  assert.equal(row.verdict, 'wait'); assert.match(row.metric, /won 4 of 5/);
  const call = { ticker: 'T', side: 'YES', price: 0.91, conf: 96, at: NOW, closeTime: new Date(NOW + 480000).toISOString() };
  const e = callMessage(call, { flip: { from: 'NO' } }).embeds[0];
  assert.match(e.title, /↺ FLIP · 🐂 UP call/); assert.match(e.fields.find((f) => f.name === 'Flip').value, /from the earlier DOWN call/);
});

test('the flip check (chart history + buyers / sellers, once proven) blocks a flip it says would flip back', () => {
  const x = setup({ yb: 90, ya: 91 }), mem = calledDown();
  const fc = (p) => ({ ticker: 'T', lead: 'YES', used: true, pLose: { YES: p, NO: 1 - p } });
  const blocked = buySignal(x.row, { ...x.snap, flipCheck: fc(0.22) }, t90, NOW, mem);
  assert.equal(blocked.fire, false); assert.match(blocked.flip.why, /give UP a 22% chance of flipping back/);
  assert.ok(buySignal(x.row, { ...x.snap, flipCheck: fc(0.08) }, t90, NOW, calledDown()).fire, 'a check that agrees lets it through');
  assert.ok(buySignal(x.row, { ...x.snap, flipCheck: { ...fc(0.4), ticker: 'OTHER' } }, t90, NOW, calledDown()).fire, 'another round\'s check is ignored');
});

test('the flip study\'s rule (once proven) blocks a flip history says to skip, and only then', () => {
  const gate = (v, proven) => ({ proven, gate: { key: 'crossAge', op: '>=', v, label: `only after ${v}+ minutes on the new side` } });
  const withGate = (fg) => { const x = setup({ yb: 90, ya: 91 }); return buySignal(x.row, { ...x.snap, flipGate: fg }, t90, NOW, calledDown()); };
  const blocked = withGate(gate(40, true));
  assert.equal(blocked.fire, false); assert.match(blocked.flip.why, /history's flip rule: only after 40\+ minutes/);
  assert.ok(withGate(gate(2, true)).fire, 'the rule passes: the flip goes ahead');
  assert.ok(withGate(gate(40, false)).fire, 'an unproven rule never blocks');
});

test('in the last minutes a flip waits for history: allowed only down to the proven minute', () => {
  const late = (lastMin) => ({ proven: false, gate: null, late: { lastMin, bands: [], need: 0.9 } });
  const at = (mins, fg) => { const x = setup({ yb: 90, ya: 91, mins }); return buySignal(x.row, { ...x.snap, flipGate: fg }, t90, NOW, calledDown()); };
  const none = at(3.5, null);
  assert.equal(none.fire, false); assert.match(none.flip.why, /no flips in the last 5 minutes until history proves/);
  assert.ok(at(3.5, late(3)).fire, 'history proved flips to 3 minutes left');
  assert.match(at(2.5, late(3)).flip.why, /history proves flips only down to 3 min left/);
  assert.ok(at(8, late(null)).fire, 'inside the normal window nothing changes');
});

test('by default a locked call never switches sides, and nothing is called against the locked round', () => {
  const base = riskSettings('target90');
  const x = setup({ yb: 90, ya: 91 });
  const sig = buySignal(x.row, x.snap, base, NOW, calledDown());
  assert.equal(sig.fire, false); assert.match(sig.flip.why, /locked for this round: it never switches/);
  // no call yet, but the round call locked DOWN: the bot leans UP, so no call at all
  const y = setup({ yb: 90, ya: 91 });
  const locked = buySignal(y.row, { ...y.snap, lockedSide: { ticker: 'T', side: 'NO' } }, base, NOW, {});
  assert.equal(locked.callSide, null); assert.equal(locked.lockedOut, true); assert.equal(locked.roundLock, 'NO');
  const free = buySignal(y.row, { ...y.snap, lockedSide: { ticker: 'T', side: 'YES' } }, base, NOW, {});
  assert.equal(free.lockedOut, false, 'locked UP and leaning UP: nothing held back');
  assert.equal(buySignal(y.row, { ...y.snap, lockedSide: { ticker: 'OTHER', side: 'NO' } }, base, NOW, {}).lockedOut, false, 'another round\'s lock doesn\'t apply');
});
