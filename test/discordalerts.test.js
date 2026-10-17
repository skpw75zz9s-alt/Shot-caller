import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_KINDS, DEFAULT_ALERTS, alertEmbeds, alertKinds, createAlertWatcher } from '../discordalerts.js';
import { createDiscord } from '../discord.js';

const T0 = 1_700_000_000_000, K = 100000;
const watcher = (o = {}) => { const posts = []; const w = createAlertWatcher({ post: (e) => posts.push(e), kinds: new Set(ALERT_KINDS), whaleMin: 250000, ...o }); return { w, posts, titles: () => posts.map((p) => p.title) }; };
const bars = (closes) => closes.map((c, i) => ({ t: T0 + i * 60000, o: c, h: c, l: c, c }));
const snapAt = ({ spot = K + 50, pYes = 0.9, mins = 8, ticker = 'R1', b = [], hold = null } = {}) => ({ spot, bars: b, watchHold: hold, live: { m: { ticker, close_time: new Date(T0 + mins * 60000).toISOString() }, strike: K, ev: { pYes, minutesLeft: mins } } });

test('DISCORD_ALERTS: every kind but the sit-out notes by default, all, none, or a list', () => {
  assert.deepEqual([...alertKinds(undefined)], DEFAULT_ALERTS);
  assert.ok(!alertKinds(undefined).has('sitout') && alertKinds(undefined).has('bail'), 'no "no call" note every round by default');
  assert.deepEqual([...alertKinds('all')], ALERT_KINDS);
  const quiet = createAlertWatcher({ post: () => assert.fail('posted'), kinds: alertKinds(undefined) });
  assert.equal(quiet.settled({ ticker: 'Y', result: 'no', called: false, now: T0 }), false, 'a no-call round posts nothing by default');
  assert.equal(alertKinds('none').size, 0);
  assert.deepEqual([...alertKinds('bail, whale,bogus')], ['bail', 'whale']);
  const { w, posts } = watcher({ kinds: alertKinds('whale') });
  w.tick({ snap: snapAt(), sig: { called: 'YES', bail: { side: 'YES', p: 0.3, bid: 0.25 } }, now: T0 });
  assert.equal(posts.length, 0, 'bail not picked');
  w.whale({ ex: 'Coinbase', price: 100000, size: 3, side: 'sell' }, T0);
  assert.equal(posts.length, 1);
});

test('the official call going bad: one flip warning, then one bail, once a round', () => {
  const { w, titles } = watcher();
  w.tick({ snap: snapAt({ pYes: 0.45 }), sig: { called: 'YES' }, now: T0 });
  w.tick({ snap: snapAt({ pYes: 0.44 }), sig: { called: 'YES' }, now: T0 + 1000 });
  w.tick({ snap: snapAt({ pYes: 0.3 }), sig: { called: 'YES', bail: { side: 'YES', p: 0.3, bid: 0.27 } }, now: T0 + 2000 });
  w.tick({ snap: snapAt({ pYes: 0.2 }), sig: { called: 'YES', bail: { side: 'YES', p: 0.3, bid: 0.27 } }, now: T0 + 3000 });
  assert.deepEqual(titles().map((t) => t.split(' ')[0]), ['↺', '🚨']);
  assert.match(titles()[1], /BAIL OUT · UP call/);
});

test('target crosses: at most 3 a round, a minute apart; the first look never posts', () => {
  const { w, titles } = watcher();
  const at = (spot, s) => w.tick({ snap: snapAt({ spot }), sig: {}, now: T0 + s * 1000 });
  at(K + 10, 0); at(K - 10, 5); at(K + 10, 30); at(K + 10, 70); at(K - 10, 80); at(K + 10, 150); at(K - 10, 220); at(K + 10, 300);
  // 5 s: below · 30 s: back above but under a minute since, skipped · 80 s: below · 150 s: above · then the cap
  assert.deepEqual(titles(), ['⬇️ BTC crossed below the target', '⬇️ BTC crossed below the target', '⬆️ BTC crossed above the target']);
});

test('the trend turning, whales, Market watch holds and the early lane\'s test read', () => {
  const { w, posts, titles } = watcher();
  const down = [...Array(30)].map((_, i) => K + 300 - i * 10), up = [...down, ...[...Array(20)].map((_, i) => down.at(-1) + (i + 1) * 30)];
  w.tick({ snap: snapAt({ b: bars(down) }), sig: {}, now: T0 });
  w.tick({ snap: snapAt({ b: bars(up) }), sig: {}, now: T0 + 1000 });
  assert.match(titles().at(-1), /Chart turns bull/);
  w.whale({ ex: 'Coinbase', price: 100000, size: 1, side: 'buy' }, T0); // $100k: under the line
  w.whale({ ex: 'Kraken', price: 100000, size: 3, side: 'buy' }, T0 + 1);
  w.whale({ ex: 'Kraken', price: 100000, size: 5, side: 'sell' }, T0 + 60000); // inside 2 minutes
  assert.equal(titles().filter((t) => t.includes('Whale')).length, 1);
  assert.match(titles().find((t) => t.includes('Whale')), /Whale buy: \$300,000/);
  const hold = { until: T0 + 30000, why: 'No fresh BTC price for 30s+' };
  w.tick({ snap: snapAt({ hold }), sig: {}, now: T0 + 2000 }); w.tick({ snap: snapAt({ hold }), sig: {}, now: T0 + 3000 });
  assert.equal(titles().filter((t) => t.includes('on hold')).length, 1, 'once per hold');
  const sig = { early: { on: true, live: false, would: { side: 'NO', price: 0.84, p: 0.95 } } };
  w.tick({ snap: snapAt({ ticker: 'R2' }), sig, now: T0 + 4000 }); w.tick({ snap: snapAt({ ticker: 'R2' }), sig, now: T0 + 5000 });
  const early = posts.filter((p) => p.title.includes('Early read'));
  assert.equal(early.length, 1); assert.match(early[0].title, /TEST, not a call/); assert.match(early[0].title, /DOWN at 84¢/);
});

test('sit-out notes only for rounds without a call; status changes; the hourly cap', () => {
  const { w, titles } = watcher({ limits: { perHour: 3, crossPerRound: 3, crossGapMs: 0, trendGapMs: 0, whaleGapMs: 0, whaleMin: 0 } });
  assert.equal(w.settled({ ticker: 'X', result: 'yes', called: true, now: T0 }), false, 'a called round gets its result post instead');
  w.settled({ ticker: 'Y', result: 'no', called: false, value: 99950, strike: K, now: T0 });
  assert.match(titles()[0], /No call · the round closed DOWN/);
  w.tick({ snap: snapAt(), sig: {}, status: { profitPaused: false, earlyLive: false, floor: 0.9 }, now: T0 });
  w.tick({ snap: snapAt(), sig: {}, status: { profitPaused: true, earlyLive: true, floor: 0.93 }, now: T0 + 1000 });
  assert.equal(titles().filter((t) => t.includes('status')).length, 3, 'paused, early lane live, floor moved');
  for (let i = 0; i < 5; i++) w.whale({ ex: 'Kraken', price: K, size: 5, side: 'buy' }, T0 + 2000 + i);
  assert.equal(titles().filter((t) => t.includes('Whale')).length, 0, 'over the hourly cap (status changes still went out)');
});

test('alerts go to their own channel when DISCORD_ALERTS_WEBHOOK_URL is set, with the bot\'s name and disclaimer', async () => {
  const MAIN = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123', SIDE = MAIN.replace('123456789012345678', '876543210987654321');
  const hits = [];
  const d = createDiscord({ url: MAIN, alertsUrl: SIDE, base: null, sleep: async () => {}, log: { warn() {} }, fetchImpl: async (u, o) => { hits.push({ u, b: JSON.parse(o.body) }); return { status: 204, ok: true }; } });
  d.alert({ title: '🐋 Whale buy' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(hits[0].u, SIDE); assert.equal(hits[0].b.username, 'Shot Caller'); assert.match(hits[0].b.embeds[0].footer.text, /Not financial advice/);
  assert.equal(d.status().alerts, 'own channel');
  assert.equal(createDiscord({ url: MAIN, alertsUrl: '' }).status().alerts, 'calls channel');
  assert.equal(createDiscord({ url: '', alertsUrl: '' }).alert({ title: 'x' }), false, 'no webhook: nothing sent');
});

test('alerts name their own coin at its own precision', () => {
  const posts = [];
  const w = createAlertWatcher({ post: (e) => posts.push(e), market: { key: 'DOGE', digits: 5 }, kinds: new Set(['whale']), whaleMin: 1000 });
  w.whale({ side: 'buy', price: 0.07803, size: 20000, ex: 'Coinbase', t: 1 }, 1e9);
  assert.match(posts[0].description, /^20,000 DOGE at \$0\.07803 on Coinbase/);
  assert.match(alertEmbeds.cross({ above: true, spot: 0.0781, strike: 0.078, minsLeft: 4, mk: { key: 'DOGE', digits: 5 } }).description, /DOGE \$0\.07810 vs the target \$0\.07800/);
  assert.match(alertEmbeds.cross({ above: true, spot: 100250, strike: 100000, minsLeft: 4 }).description, /BTC \$100,250 vs the target \$100,000/);
});
