import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, factsForAI, route } from '../public/ask.js';

const FACTS = {
  coin: 'BTC', digits: 0, crypto: true,
  card: { word: 'UP', label: 'ROUND CALL · LEAN, NOT A BUY', reason: 'Every round gets a call…' },
  round: { ticker: 'KXBTC15M-T1', minutesLeft: 6.5, strike: 100000, spot: 100120, change: 85 },
  odds: { botUp: 0.74, kalshiUp: 0.7, yesAsk: 0.72, noAsk: 0.3 },
  call: { side: null, price: null, conf: 70, hold: null, lane: null, bail: null },
  roundCall: { side: 'YES', p: 0.74, buy: false, price: 0.72, fallback: false },
  line: { leadSide: 'UP', lead: 120, move: 95, ratio: 1.26, word: 'moderate', razor: false, hist: { rate: 0.81, n: 412 }, settle: null },
  flip: { lead: 'YES', p: 0.22, base: 0.26, used: true, parts: [{ name: 'Sellers', push: 1 }] },
  moves: [{ ago: 2, dir: 'up', headline: 'BTC jumped $60', reasons: ['Coinbase buyers'] }],
  scan: { verdict: 'Buyers in control', score: 34, leader: 'Coinbase', bigBuy: 250000, bigSell: 90000, chance: { active: false } },
  patterns: { forming: { name: 'Rising wedge', up: 100300, dn: 99900 }, recent: [{ name: 'Bull flag', dir: 1, ago: 4, target: 100400, proven: false, hit: 0.52 }] },
  board: { side: 'YES', inCalls: 2, probation: 9, with: 1, against: 1, rows: [{ name: 'RSI 14', vs: 'with' }, { name: 'Momentum', vs: 'against' }], close: ['Flip chart'] },
  stability: { level: 'moderate', score: 58, parts: ['volatility rising'] },
  vol: 0.0007,
  record: { picks: { wins: 216, graded: 293, avgP: 0.71, buys: { wins: 20, graded: 24, usd: -44.95 } }, accuracy: [{ name: 'Picks', metric: '74% right', verdict: 'good' }] },
  sessions: [{ name: 'New York', open: true }, { name: 'London', open: false }],
  positions: [{ ticker: 'KXBTC15M-T1', side: 'YES', price: 0.66, contracts: 10, bid: 0.71 }],
};

test('routes a question to what it is about, plus what that needs; nothing matched means a deep dive', () => {
  assert.deepEqual(route('Should I buy right now?').asked, ['buy']);
  assert.deepEqual(route('what is the current price').asked, ['price']);
  assert.ok(route('Should I buy?').keys.includes('line'), 'a buy question also gets the lead');
  assert.deepEqual(route('Why is it dumping').asked, ['move']);
  assert.ok(route('any patterns on the chart').keys.includes('patterns'));
  const d = route('hmm');
  assert.equal(d.deep, true); assert.deepEqual(d.asked, []); assert.ok(d.keys.length >= 8);
  assert.equal(route('give me a deep dive').deep, true);
});

test('a buy question: bottom line first, the round call and its lean, a note that it is not advice', () => {
  const a = answer('should I buy?', FACTS);
  assert.match(a.bottom, /^Not a buy at this price\. The round call is UP at 74%/);
  assert.match(a.parts.find((p) => p.key === 'call').text, /locked UP at 74%.*never switches/);
  assert.match(a.parts.find((p) => p.key === 'line').text, /UP is winning by \$120 with 6:30 left.*1\.26 times.*81% of the time/);
  assert.match(a.tail, /not financial advice/);
  assert.match(a.speak, /^Not a buy/);
});

test('a live buy call is a yes by the bot\'s rules; a bail says bail', () => {
  const buy = answer('should I buy', { ...FACTS, call: { side: 'NO', price: 0.88, limit: 0.9, conf: 92 }, roundCall: null });
  assert.match(buy.bottom, /^Yes, by the bot's rules: it's calling DOWN, a buy at up to 90¢ with confidence 92/);
  const bail = answer('what do I do', { ...FACTS, call: { bail: { side: 'YES', p: 0.31, bid: 0.25 } } });
  assert.match(bail.bottom, /^Bail/);
});

test('before 10:00 left: no call yet, when it locks, and the lean', () => {
  const a = answer('which way?', { ...FACTS, round: { ...FACTS.round, minutesLeft: 12.25 }, roundCall: null });
  assert.match(a.bottom, /No call yet.*in 2:15\. Right now the math leans UP 74%/);
});

test('each part reads its own numbers: flip, moves, flow, patterns, signals, record, position', () => {
  const a = answer('deep dive', FACTS), part = (k) => a.parts.find((p) => p.key === k)?.text ?? '';
  assert.equal(a.title, 'Deep dive');
  assert.match(part('flip'), /UP leads, with a 22% chance it loses.*price math alone says 26%.*sellers raising it/);
  assert.match(part('move'), /2 min ago: BTC jumped \$60\. Coinbase buyers.*up \$85/);
  assert.match(part('flow'), /Buyers in control \(score \+34.*Coinbase is moving first.*\$250,000 bought against \$90,000/);
  assert.match(part('patterns'), /rising wedge is forming.*Bull flag 4 min ago, says UP.*None of these has proven itself/);
  assert.match(part('signals'), /2 factors have proven.*9 are on probation.*RSI 14 agrees, Momentum disagrees.*Flip chart/);
  assert.match(part('record'), /216 won of 293 \(74%\).*BUY: 20 of 24, down \$44\.95/);
  assert.match(answer('how is my position', FACTS).parts.find((p) => p.key === 'mine').text, /You hold 10 UP at 66¢, and that side is ahead; it would sell for about 71¢/);
});

test('asking about another coin says which market is open', () => {
  assert.match(answer('what about ETH?', FACTS).note, /You're looking at BTC.*ETH/);
  assert.equal(answer('what about BTC?', FACTS).note, null);
});

test('missing facts never throw: no round, an empty object, a broken part', () => {
  assert.match(answer('should I buy', { coin: 'SOL' }).bottom, /no open SOL round/);
  assert.doesNotThrow(() => answer('deep dive', {}));
  assert.doesNotThrow(() => answer('deep dive', { ...FACTS, line: { leadSide: 'UP' }, board: { rows: null } }));
  const a = answer('patterns', { ...FACTS, patterns: { forming: null, recent: [] } });
  assert.match(a.parts.find((p) => p.key === 'patterns').text, /No pattern confirmed/);
});

test('the facts sent to the AI are trimmed copies, positions without anything extra', () => {
  const f = { ...FACTS, moves: Array(9).fill(FACTS.moves[0]), positions: [{ ...FACTS.positions[0], id: 'k-1', secret: 'x' }] };
  const x = factsForAI(f);
  assert.equal(x.moves.length, 5); assert.deepEqual(Object.keys(x.positions[0]).sort(), ['bid', 'contracts', 'price', 'side', 'ticker']);
  assert.equal(f.moves.length, 9, 'the original is untouched');
});
