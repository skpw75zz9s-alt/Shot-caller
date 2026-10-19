import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeAsk, readQuestion } from '../freeask.js';

const markets = [
  { series: 'KXBTC15M', name: 'Bitcoin', asset: 'BTC', kind: 'crypto', running: true },
  { series: 'KXETH15M', name: 'Ethereum', asset: 'ETH', kind: 'crypto', running: true },
  { series: 'KXINX', name: 'S&P 500', asset: 'SPX', kind: 'index', running: true },
  { series: 'KXGOLD', name: 'Gold', asset: 'GOLD', kind: 'commodity', running: false },
];
const R = (q, open = 'KXBTC15M') => readQuestion(q, { markets, open });

test('reading a question: which markets it names and what it asks', () => {
  assert.deepEqual([R('Should I buy?').intent, R('Should I buy?').targets.map((m) => m.asset)], ['buy', ['BTC']], 'no market named: the one open');
  assert.deepEqual(R('is the ethereum lead safe').targets.map((m) => m.asset), ['ETH']); assert.equal(R('is the ethereum lead safe').intent, 'lead');
  assert.equal(R('compare bitcoin and ETH').intent, 'compare'); assert.equal(R('bitcoin eth').intent, 'compare', 'two markets named: a comparison');
  assert.equal(R('Which market has the safest lead right now?').intent, 'best');
  assert.equal(R('how accurate has the bot been?').intent, 'strength'); assert.equal(R('what is the win rate on gold').intent, 'record');
  assert.equal(R('what has it learned').intent, 'learning'); assert.equal(R('any breaks on the s&p?').intent, 'breaks');
  assert.equal(R('why is gold moving').intent, 'why'); assert.equal(R('BTC last 30 minutes').intent, 'trend'); assert.equal(R('BTC last 30 minutes').minutes, 30);
  assert.equal(R('how are the coins doing').targets.length, 2, 'the coins: every crypto market'); assert.equal(R('every market').targets.length, 4);
  assert.equal(R('hello').intent, 'now');
});

// a stand-in for the live lookups
function fakeTools() {
  const now = (series, z, up, buy) => ({ market: markets.find((m) => m.series === series).name, series, round: { minutesLeft: 8, target: 100 }, lead: { gap: z * 10, typicalMoveLeft: 10, typicalMovesAway: z, side: z >= 0 ? 'above the target' : 'below the target' },
    volatility: { vsNormal: 1.6 }, odds: { botUpFinal: up, kalshiUpBid: up - 4, kalshiUpAsk: up - 2 }, buySignal: buy ? { side: 'UP', price: 81, worstCaseWinChance: 86, confidence: 88 } : { none: true }, roundCall: { side: 'UP', odds: up },
    council: { verdict: 'Round scan argues for UP', arguments: [{}] }, breaksOpen: [{ break: 'High flip risk: 45/100' }] });
  const data = {
    list_markets: () => ({ markets }),
    market_now: ({ series }) => (series === 'KXBTC15M' ? now(series, 1.2, 80, true) : series === 'KXETH15M' ? now(series, 2.6, 96, false) : series === 'KXINX' ? now(series, -0.3, 40, false) : { market: 'Gold', error: 'the Gold market\'s bot is starting: ask again in a minute or two' }),
    market_record: () => ({ market: 'Bitcoin', official: { graded: 40, wins: 34, usd: 12.5, since: Date.UTC(2026, 9, 1) }, roundCalls: { graded: 50, wins: 31 } }),
    market_strength: () => ({ words: ['Stronger than a coin flip.', 'Level with Kalshi.'] }),
    market_learning: () => ({ learners: [{ learner: 'Round scan', shapesCalls: true }, { learner: 'Micro model', shapesCalls: false }] }),
    market_xray: () => ({ breaksOpen: ['Breakout'], breakProof: { jump: { status: 'proven', text: 'Proven: the next 5 minutes move more than usual.' }, book: { status: 'fact', text: 'fact' } } }),
    market_drivers: () => ({ market: 'S&P 500', windowMinutes: 60, move: 6, parts: [{ group: 'macro', usd: 4 }, { group: 'sector', usd: 3 }, { group: 'own', usd: -1 }] }),
    market_history: ({ minutes }) => ({ market: 'Bitcoin', minutes: minutes ?? 60, first: 100000, last: 100250, change: 250, changePct: 0.25, high: 100300, low: 99900 }),
  };
  return { call: async (name, input) => ({ error: false, text: JSON.stringify(data[name](input)) }) };
}
const A = async (q, series = 'KXBTC15M') => createFreeAsk({ tools: fakeTools() }).answer(q, { series });

test('free answers, written from the live numbers', async () => {
  const buy = await A('should I buy?');
  assert.match(buy.answer, /buy signal is on: UP at 81¢, 86% to win/); assert.match(buy.answer, /round call is locked UP/); assert.match(buy.answer, /not financial advice/);
  const lead = await A('is the lead safe?');
  assert.match(lead.answer, /UP leads by 1\.20 typical moves/); assert.match(lead.answer, /decent, not safe.*about 88% to stay ahead/); assert.match(lead.answer, /1\.6× normal/); assert.match(lead.answer, /High flip risk/);
  const best = await A('which market has the safest lead?');
  assert.match(best.answer, /^Ethereum has the safest lead right now: UP by 2\.60 typical moves/); assert.match(best.answer, /isn't the best buy/);
  const cmp = await A('compare bitcoin and ethereum');
  assert.match(cmp.answer, /Bitcoin: UP leads by 1\.20/); assert.match(cmp.answer, /Ethereum: UP leads by 2\.60/); assert.match(cmp.answer, /Bitcoin has a buy signal/);
  assert.match((await A('what is the record')).answer, /won 34 of 40 graded calls \(85%\) since 2026-10-01, \+\$12\.50 on \$10 a call/);
  assert.match((await A('how accurate is it')).answer, /Stronger than a coin flip\. Level with Kalshi\./);
  assert.match((await A('what has it learned')).answer, /proven and shaping the calls: Round scan\. Still being tested: Micro model/);
  assert.match((await A('any breaks?')).answer, /open breaks: Breakout\. Proven so far: Proven: the next 5 minutes/);
  assert.match((await A('why is the s&p moving')).answer, /S&P 500 moved up 6 over 60 minutes: the dollar and rates \+4, the rest of its market \+3, its own buying and selling −1/);
  assert.match((await A('why is it moving')).answer, /Bitcoin is up 0\.3% over the last 15 minutes/);
  assert.match((await A('bitcoin last 30 minutes')).answer, /up 250 \(0\.3%\) over the last 30 minutes/);
  assert.match((await A('gold now')).answer, /starting/);
  assert.match((await A('hello')).answer, /^Bitcoin: UP leads by 1\.20 typical moves with 8 minutes left\. The bot gives UP 80%, Kalshi 77%\./);
});
