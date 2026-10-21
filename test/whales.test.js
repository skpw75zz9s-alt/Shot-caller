import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WHALE, grade, groupStats, groupsOf, predict, sigmaOf, sizeBand, whaleRow } from '../public/whales.js';
import { createWhaleFilter } from '../whalefilter.js';
import { createAlertWatcher } from '../discordalerts.js';

test('sizes, groups and the typical minute\'s move', () => {
  assert.equal(sizeBand(120000), '$100k-250k'); assert.equal(sizeBand(400000), '$250k-1M'); assert.equal(sizeBand(3e6), '$1M+');
  assert.deepEqual(groupsOf({ usd: 3e6, ex: 'Binance.US', side: 'buy', sweep: true }).map(([k]) => k), ['all', 'size:$1M+', 'ex:Binance.US', 'side:buy', 'sweep:yes']);
  const ring = Array.from({ length: 200 }, (_, i) => ({ t: i * 5000, p: 100000 * (Math.floor(i / 12) % 2 ? 1.001 : 1) }));
  assert.ok(Math.abs(sigmaOf(ring) - Math.log(1.001)) < 1e-9, 'every minute ends 0.1% from where it started (samples 5 s apart, the price steps each minute)');
  assert.equal(sigmaOf(ring.slice(0, 15)), null, 'too little history: no guess');
  const g = grade({ side: 'sell', p0: 100000 }, 99800, 0.001);
  assert.equal(g.out, 'moved'); assert.ok(Math.abs(g.z - 2.002) < 0.01, 'a sell, then the price fell two typical moves');
  assert.equal(grade({ side: 'buy', p0: 100000 }, 99800, 0.001).out, 'faded'); assert.equal(grade({ side: 'buy', p0: 100000 }, 100050, 0.001).out, 'nothing');
});

test('which groups move the market: proven movers, proven noise, proven faders, and what to expect of a new whale', () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ usd: 2e6, ex: 'Coinbase', side: i % 2 ? 'buy' : 'sell', sweep: false, z: 1.2 + (i % 5) * 0.2, out: 'moved' }));
  const small = Array.from({ length: 60 }, (_, i) => ({ usd: 150000, ex: 'Kraken', side: i % 2 ? 'buy' : 'sell', sweep: false, z: [0.4, -0.5, 0.1, -0.2, 0.3, -0.1][i % 6], out: 'nothing' }));
  const fade = Array.from({ length: 35 }, (_, i) => ({ usd: 500000, ex: 'Gemini', side: i % 2 ? 'buy' : 'sell', sweep: false, z: -1.1 - (i % 3) * 0.2, out: 'faded' }));
  const g = groupStats([...big, ...small, ...fade]);
  assert.equal(g['size:$1M+'].verdict, 'movers'); assert.equal(g['size:$100k-250k'].verdict, 'noise'); assert.equal(g['size:$250k-1M'].verdict, 'faders');
  assert.equal(g['ex:Coinbase'].n, 40); assert.equal(g['ex:Coinbase'].moved, 40);
  assert.equal(groupStats(big.slice(0, 10))['size:$1M+'].verdict, 'grading', 'fewer than 30: no verdict');
  const m = predict({ usd: 3e6, ex: 'Coinbase', side: 'buy', sweep: false }, g);
  assert.equal(m.label, 'likely mover'); assert.match(m.why, /moved the price their way 100% of 40 times/);
  assert.equal(predict({ usd: 120000, ex: 'Kraken', side: 'buy', sweep: false }, g).label, 'likely noise');
  assert.equal(predict({ usd: 600000, ex: 'Gemini', side: 'buy', sweep: false }, g).label, 'likely to fade');
  assert.equal(predict({ usd: 3e6, ex: 'Coinbase', side: 'buy' }, {}).label, 'not proven yet');
});

test('the filter on a live stream: big whales that push the price are told from small ones that don\'t', async () => {
  let t = 1e12, price = 100000, k = 0;
  const file = join(mkdtempSync(join(tmpdir(), 'whales-')), 'whales.json');
  const wf = createWhaleFilter({ file, clock: () => t });
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { t += 1000; price *= 1 + (((k++ * 7919) % 11) - 5) * 0.00002; wf.add({ ex: 'Kraken', side: 'buy', price, size: 0.01 }, t); } };
  tick(400); // history for the typical minute's move
  for (let i = 0; i < 40; i++) {
    const side = i % 2 ? 'buy' : 'sell';
    wf.add({ ex: 'Coinbase', side, price, size: 25 }, t); // $2.5M, then the price moves its way
    for (let s = 0; s < 70; s++) { t += 1000; price *= side === 'buy' ? 1.00003 : 0.99997; wf.add({ ex: 'Kraken', side: 'buy', price, size: 0.01 }, t); }
    wf.add({ ex: 'Gemini', side, price, size: 1.5 }, t); // $150k: the price just wanders
    tick(70);
  }
  const a = wf.api();
  assert.equal(a.groups['size:$1M+'].verdict, 'movers', JSON.stringify(a.groups['size:$1M+']));
  assert.notEqual(a.groups['size:$100k-250k'].verdict, 'movers');
  assert.equal(wf.verdict({ ex: 'Coinbase', side: 'buy', price, size: 30 }).label, 'likely mover');
  assert.ok(a.recent.length && a.recent.every((c) => c.usd >= WHALE.minUsd)); assert.ok(a.recent.some((c) => c.expected === 'likely mover'), 'later whales carry what was expected of them');
  wf.add({ ex: 'Coinbase', side: 'buy', price, size: 30 }, t);
  assert.ok(wf.api().pressure.buy >= 3e6, 'a likely mover in the last 15 minutes counts toward the filtered pressure');
  // its row on the team, and the record survives a restart
  const r = whaleRow(wf.api());
  assert.match(r.status, /whales graded: \d+% moved the price their way · movers: \$1M\+ whales/); assert.equal(r.state, 'busy');
  await new Promise((res) => setTimeout(res, 5300));
  const again = createWhaleFilter({ file, clock: () => t }); await again.load();
  assert.equal(again.api().groups['size:$1M+'].verdict, 'movers');
  assert.equal(whaleRow(null).state, 'off'); assert.match(whaleRow({ groups: {}, recent: [] }).status, /^Grading whales: 0 of 30/);
});

test('Discord: each whale alert carries the filter\'s word, and DISCORD_WHALES=movers skips the proven noise', () => {
  const posts = [], w = createAlertWatcher({ post: (e) => posts.push(e), kinds: new Set(['whale']), whaleMin: 250000, limits: { perHour: 30, whaleGapMs: 0 } });
  const x = { ex: 'Coinbase', side: 'buy', price: 100000, size: 5 };
  w.whale(x, 1e12, { label: 'likely mover', why: '$250k-1M whales moved the price their way 61% of 44 times (t 2.3)' });
  assert.match(posts[0].description, /Whale filter: likely mover \(\$250k-1M whales moved/);
  const only = createAlertWatcher({ post: (e) => posts.push(e), kinds: new Set(['whale']), whaleMin: 250000, limits: { perHour: 30, whaleGapMs: 0 }, moversOnly: true });
  assert.equal(only.whale(x, 1e12, { label: 'likely noise', why: 'x' }), false);
  assert.notEqual(only.whale(x, 1e12 + 1, { label: 'not proven yet', why: 'x' }), false, 'what it can\'t say yet still posts');
});
