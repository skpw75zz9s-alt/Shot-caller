import test from 'node:test';
import assert from 'node:assert/strict';
import { createAskAI, validInput } from '../askai.js';
import { ASK_TOOLS, createAskTools, createMarketBook } from '../asktools.js';
import { marketOf } from '../public/markets.js';

// a stand-in client that plays back a script of turns (tool calls, then an answer)
function scripted(turns, { beta = false } = {}) {
  const calls = [], next = () => { const t = turns.shift(); if (t instanceof Error) throw t; return t; };
  const stream = (params) => { calls.push(params); return { finalMessage: async () => next() }; };
  return { calls, models: { list: async function* () { yield { id: 'opus-x' }; } }, messages: { stream }, ...(beta ? { beta: { messages: { stream } } } : {}) };
}
const toolTurn = (...uses) => ({ stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '' }, ...uses.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input }))] });
const answer = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

test('the chatbot looks things up, gets every result back in one message, then answers', async () => {
  const c = scripted([toolTurn(['list_markets', {}], ['market_now', { series: 'KXETH15M' }]), answer('ETH is UP by 2 typical moves.')]);
  const seen = [], tools = { defs: ASK_TOOLS, call: async (name, input) => { seen.push([name, input]); return { error: false, text: JSON.stringify({ ok: name }) }; } };
  const ai = createAskAI({ client: c, tools });
  const out = await ai.ask({ owner: 'a', question: 'How is ETH doing?', facts: { coin: 'BTC' }, series: 'KXBTC15M' });
  assert.equal(out.status, 200); assert.equal(out.body.answer, 'ETH is UP by 2 typical moves.'); assert.equal(out.body.lookups, 2);
  assert.deepEqual(seen.map((x) => x[0]), ['list_markets', 'market_now']);
  const [first, second] = c.calls;
  assert.equal(first.tools.length, ASK_TOOLS.length); assert.ok(first.tools.every((t) => t.eager_input_streaming === true));
  assert.deepEqual(first.cache_control, { type: 'ephemeral' }); assert.match(first.messages[0].content, /has the KXBTC15M market open/);
  const results = second.messages.at(-1);
  assert.equal(results.role, 'user'); assert.equal(results.content.length, 2, 'both results in one message');
  assert.deepEqual(results.content.map((r) => r.tool_use_id), ['t0', 't1']);
  assert.equal(second.messages.at(-2).role, 'assistant', 'the whole assistant turn echoed back');
});

test('lookups are checked before they run: a bad input goes back as an error, never runs', async () => {
  assert.equal(validInput('list_markets', {}), true); assert.equal(validInput('list_markets', { x: 1 }), false);
  assert.equal(validInput('market_now', { series: 'KXETH15M' }), true); assert.equal(validInput('market_now', { series: 'KX ETH; drop' }), false);
  assert.equal(validInput('market_history', { series: 'KXBTC15M', minutes: 60 }), true); assert.equal(validInput('market_history', { series: 'KXBTC15M', minutes: '60' }), false);
  assert.equal(validInput('market_record', { series: 'KXBTC15M', extra: 1 }), false); assert.equal(validInput('market_now', null), false);
  const c = scripted([toolTurn(['market_now', { series: 'bad series!' }]), answer('Sorry.')]);
  let ran = 0; const ai = createAskAI({ client: c, tools: { defs: ASK_TOOLS, call: async () => { ran++; return { error: false, text: '{}' }; } } });
  await ai.ask({ owner: 'a', question: 'q' });
  assert.equal(ran, 0); const r = c.calls[1].messages.at(-1).content[0];
  assert.equal(r.is_error, true); assert.match(r.content, /INVALID_JSON/);
});

test('turn limits, a refusal mid-way, a stream that couldn\'t be parsed, and the refusal fallback', async () => {
  const loop = scripted(Array.from({ length: 6 }, () => toolTurn(['list_markets', {}])));
  const out = await createAskAI({ client: loop, maxTurns: 3, tools: { defs: ASK_TOOLS, call: async () => ({ error: false, text: '{}' }) } }).ask({ owner: 'a', question: 'q' });
  assert.equal(out.status, 502); assert.match(out.body.error, /kept looking things up/);
  assert.equal((await createAskAI({ client: scripted([{ stop_reason: 'refusal', content: [] }]), tools: { defs: ASK_TOOLS, call: async () => ({}) } }).ask({ owner: 'a', question: 'q' })).status, 422);
  // a stream rejected without an API status (unparseable tool input): that turn is re-issued once
  const again = scripted([new Error('bad json'), answer('ok')]);
  assert.equal((await createAskAI({ client: again, tools: { defs: ASK_TOOLS, call: async () => ({}) } }).ask({ owner: 'a', question: 'q' })).body.answer, 'ok');
  // the newest models ask with the server-side refusal fallback; a 400 for it drops it and asks again
  const fb = scripted([answer('with fallback')], { beta: true });
  await createAskAI({ client: fb, model: 'claude-opus-5-5' }).ask({ owner: 'a', question: 'q' });
  assert.equal(fb.calls[0].fallbacks, 'default'); assert.deepEqual(fb.calls[0].betas, ['server-side-fallback-2026-07-01']);
  const no = scripted([Object.assign(new Error('bad'), { status: 400 }), answer('plain')], { beta: true });
  const r = await createAskAI({ client: no, model: 'claude-opus-5-5' }).ask({ owner: 'a', question: 'q' });
  assert.equal(r.body.answer, 'plain'); assert.equal(no.calls[1].fallbacks, undefined);
  const old = scripted([answer('x')], { beta: true }); await createAskAI({ client: old, model: 'claude-sonnet-4-6' }).ask({ owner: 'a', question: 'q' });
  assert.equal(old.calls[0].fallbacks, undefined, 'older models ask without it');
});

// the lookups against a stand-in server: two markets, one running with a live round
function world() {
  const now = Date.UTC(2026, 9, 19, 12, 5), book = createMarketBook({ clock: () => now });
  const row = { m: { ticker: 'KXETH15M-X', title: 'ETH up?', open_time: new Date(now - 300000).toISOString(), close_time: new Date(now + 600000).toISOString(), strike_type: 'greater' },
    strike: 4000, sigma: 0.0006, pBot: 0.8, pPre: 0.82, ev: { minutesLeft: 10, pYes: 0.84, quote: { yesBid: 0.78, yesAsk: 0.81, noAsk: 0.22 } } };
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: now - (40 - i) * 60000, c: 3980 + i, h: 3981 + i, l: 3979 + i }));
  book.observe('KXETH15M', { snap: { spot: 4019, mSpot: 4019, sigmaMin: 0.0006, sigmaLong: 0.0005, rows: [row], bars }, sig: { callSide: 'YES', price: 0.81, winProb: 0.86, deep: { score: 88 }, hold: 0.9 } });
  const ethBot = { pick: () => ({ live: { side: 'YES', p: 0.84, at: now - 1000 } }), record: () => ({ level: 'Steady', since: 1, wins: 30, losses: 4, calls: [{ ticker: 'A', side: 'YES', price: 0.9, result: 'yes' }], pick: { n: 20, calls: [] } }), learnStatus: () => ({ using: [{ name: 'Round scan', on: true, detail: 'proven' }] }) };
  const discovery = { list: () => [{ series: 'KXBTC15M', asset: 'BTC', freq: '15m' }, { series: 'KXETH15M', asset: 'ETH', freq: '15m' }, { series: 'KXSOL15M', asset: 'SOL', freq: '15m' }] };
  const started = [], stacks = { has: (s) => s === 'KXETH15M', start: (s) => started.push(s), bot: () => ethBot, stack: () => ({ scanFeed: { liqs: () => [] }, futures: null }) };
  const tools = createAskTools({ book, discovery, stacks, marketOf, listed: () => true, isHome: (s) => s === 'KXBTC15M', home: { bot: ethBot }, council: { api: () => ({ ticker: 'KXETH15M-X', debate: { verdict: 'Round scan argues for UP', net: 0.02, rulings: [{ name: 'Round scan', side: 'YES', pts: 0.02, status: 'counted', why: 'counted in full' }] } }) },
    breakLab: { api: () => ({ kinds: { jump: { status: 'testing', text: 'claim being tested' } } }), open: () => [{ title: 'Breakout', detail: 'above', proofText: 'testing' }] }, strength: { api: () => ({ rounds: 3, daily: [], words: ['Still measuring'] }) }, crossFeed: { why: () => null }, clock: () => now });
  return { tools, started };
}
const J = async (tools, name, input = {}) => JSON.parse((await tools.call(name, input)).text);

test('the lookups answer from the server\'s own readers, for any market', async () => {
  const { tools, started } = world();
  const l = await J(tools, 'list_markets');
  assert.deepEqual(l.markets.map((m) => [m.series, m.running]), [['KXBTC15M', true], ['KXETH15M', true], ['KXSOL15M', false]]);
  assert.equal(l.markets[1].round.botUp, 84);
  const n = await J(tools, 'market_now', { series: 'kxeth15m' });
  assert.equal(n.market, 'Ethereum'); assert.equal(n.round.target, 4000); assert.equal(n.odds.botUpFinal, 84); assert.equal(n.odds.kalshiUpAsk, 81);
  assert.equal(n.buySignal.side, 'UP'); assert.equal(n.roundCall.side, 'UP'); assert.equal(n.council.netPointsOnUp, 2); assert.equal(n.breaksOpen[0].break, 'Breakout');
  assert.ok(n.lead.typicalMovesAway > 0); assert.equal(n.volatility.vsNormal, 1.2);
  const h = await J(tools, 'market_history', { series: 'KXETH15M', minutes: 10 });
  assert.equal(h.minutes, 10); assert.equal(h.closes.length, 10); assert.equal(h.change, 9);
  const rec = await J(tools, 'market_record', { series: 'KXETH15M' });
  assert.equal(rec.official.wins, 30); assert.equal(rec.official.calls, undefined, 'no raw call list'); assert.equal(rec.lastCalls[0].side, 'UP');
  assert.equal((await J(tools, 'market_strength', { series: 'KXETH15M' })).words[0], 'Still measuring');
  assert.equal((await J(tools, 'market_learning', { series: 'KXETH15M' })).learners[0].shapesCalls, true);
  assert.equal((await J(tools, 'market_xray', { series: 'KXETH15M' })).breakProof.jump.status, 'testing');
  assert.match((await J(tools, 'market_drivers', { series: 'KXETH15M' })).error, /for stock indexes, gold and oil/);
  // a market whose bot isn't running is started, and the AI is told to ask again
  assert.match((await J(tools, 'market_now', { series: 'KXSOL15M' })).error, /starting/); assert.deepEqual(started, ['KXSOL15M']);
  assert.match((await J(tools, 'market_now', { series: 'NOPE' })).error, /unknown market/);
  const bad = await tools.call('nope', {}); assert.equal(bad.error, true);
});
