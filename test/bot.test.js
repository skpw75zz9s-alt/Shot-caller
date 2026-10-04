import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot } from '../bot.js';
import { fakeBrowser, fakePushService } from './helpers.js';

const NOW = Math.floor(Date.now() / 60000) * 60000 + 20000;
const quotes = { yes_bid: 38, yes_ask: 40 };
let nextWindow = false; // flip to serve the following 15-minute window

// Fake Kalshi + Coinbase: quiet tape near 100,000, BTC 60 above a 100,000 strike, 6 minutes left.
const upstream = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/products/BTC-USD/candles')) {
    const rows = [];
    for (let i = 120; i >= 1; i--) {
      const t = NOW - (NOW % 60000) - i * 60000, o = 100000 + Math.sin(i) * 10, c = 100000 + Math.sin(i - 1) * 10;
      rows.push([t / 1000, Math.min(o, c) - 3, Math.max(o, c) + 3, o, c, 1]);
    }
    return res.end(JSON.stringify(rows.reverse()));
  }
  if (req.url.startsWith('/products/BTC-USD/ticker')) return res.end(JSON.stringify({ price: '100060' }));
  if (req.url.startsWith('/markets/KXBTC15M-T1')) return res.end(JSON.stringify({ market: { ticker: 'KXBTC15M-T1', result: 'yes' } }));
  if (req.url.startsWith('/markets?') && nextWindow) {
    return res.end(JSON.stringify({ markets: [{
      ticker: 'KXBTC15M-T2', title: 'BTC up?', strike_type: 'greater_or_equal', floor_strike: 100050,
      open_time: new Date(NOW + 6 * 60000).toISOString(), close_time: new Date(NOW + 21 * 60000).toISOString(), yes_bid: 50, yes_ask: 52,
    }] }));
  }
  if (req.url.startsWith('/markets?')) {
    return res.end(JSON.stringify({ markets: [{
      ticker: 'KXBTC15M-T1', title: 'BTC up?', strike_type: 'greater_or_equal', floor_strike: 100000,
      open_time: new Date(NOW - 9 * 60000).toISOString(), close_time: new Date(NOW + 6 * 60000).toISOString(), ...quotes,
    }] }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => upstream.listen(0, r));
const base = `http://127.0.0.1:${upstream.address().port}`;
const svc = await fakePushService();
const dataFile = join(await mkdtemp(join(tmpdir(), 'shot-')), 'data.json');
const quiet = { log() {}, warn() {}, error() {} };
const bot = createBot({ kalshi: base, coinbase: base, dataFile, env: { PUSH_HOST_ALLOW: '127.0.0.1' }, log: quiet });
await bot.load();
const phone = fakeBrowser();
const subscription = { endpoint: `${svc.base}/push/phone1`, keys: phone.keys };
const lastPush = () => JSON.parse(phone.decrypt(svc.received[svc.received.length - 1].body));

test.after(() => { bot.stop(); upstream.close(); svc.server.close(); });

test('rejects subscriptions that are not real push services', () => {
  assert.equal(bot.sync({ subscription: { endpoint: 'https://evil.example.com/x', keys: phone.keys } }).status, 400);
  assert.equal(bot.sync({ subscription: { endpoint: 'https://fcm.googleapis.com/x' } }).status, 400);
});

test('sends BUY THE LOW once when Kalshi is below the bot odds', async () => {
  assert.equal(bot.sync({ subscription, settings: { minEdge: 0.04 }, positions: [] }).status, 200);
  await bot.tick(NOW);
  assert.equal(svc.received.length, 1);
  const msg = lastPush();
  assert.match(msg.title, /^Buy the low: YES · Above at 40%$/);
  assert.match(msg.body, /Kalshi 40% vs bot \d+%.*BTC above \$100,000/);
  assert.match(msg.body, /BTC \$100,060$/);
  assert.equal(svc.received[0].headers.urgency, 'high');
  await bot.tick(NOW + 5000);
  assert.equal(svc.received.length, 1, 'no duplicate alert');
});

test('respects notifyBuy = false', async () => {
  const phone2 = fakeBrowser();
  bot.sync({ subscription: { endpoint: `${svc.base}/push/phone2`, keys: phone2.keys }, settings: { notifyBuy: false } });
  const before = svc.received.filter((r) => r.url === '/push/phone2').length;
  await bot.tick(NOW + 6000);
  assert.equal(svc.received.filter((r) => r.url === '/push/phone2').length, before);
  bot.unsubscribe({ endpoint: `${svc.base}/push/phone2` });
});

test('sends SELL NOW for a tracked position when the bid catches up', async () => {
  bot.sync({ subscription, settings: {}, positions: [{ id: 'p1', ticker: 'KXBTC15M-T1', side: 'YES', price: 0.40, contracts: 50, closeTime: new Date(NOW + 6 * 60000).toISOString() }] });
  const before = svc.received.length;
  await bot.tick(NOW + 10000);
  assert.equal(svc.received.length, before, 'holds while the bid is low');
  Object.assign(quotes, { yes_bid: 95, yes_ask: 97 });
  await bot.tick(NOW + 15000);
  const msg = lastPush();
  assert.match(msg.title, /^SELL NOW: YES · Above at 95% · cash out \$47\.\d\d \(\+\$\d+\.\d\d\)$/);
  assert.match(msg.body, /take the profit|flipping/);
});

test('grades the whole window on the server and serves the report card', async () => {
  assert.equal(bot.report({ endpoint: subscription.endpoint }).body.reports.length, 0);
  await bot.tick(NOW + 8 * 60000); // after close + 1 minute: fetch the result and grade
  const { reports } = bot.report({ endpoint: subscription.endpoint }).body;
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.ticker, 'KXBTC15M-T1');
  assert.equal(r.result, 'yes');
  assert.ok(r.avgWinnerOdds > 0.5 && r.timeRight === 1, 'bot favored YES the whole time');
  assert.ok(r.calls >= 1, 'followed its call');
  assert.equal(bot.report({ endpoint: 'nope' }).status, 404);
});

test('every new 15-minute window sends one update with the last result, in local time', async () => {
  bot.sync({ subscription, settings: {}, positions: [], tz: 'America/New_York' });
  const before = svc.received.length;
  nextWindow = true;
  await bot.tick(NOW + 8 * 60000 + 30000); // T2 is live, T1 already graded
  const fresh = svc.received.slice(before).map((r) => JSON.parse(phone.decrypt(r.body)));
  const updates = fresh.filter((x) => x.tag === 'window-update');
  assert.equal(updates.length, 1);
  const msg = updates[0];
  assert.match(msg.title, /^🕒 \d{1,2}:\d\d (AM|PM)–\d{1,2}:\d\d (AM|PM) window · target \$100,050$/);
  assert.doesNotMatch(msg.title, /UTC/);
  assert.match(msg.body, /window settled YES · bot had \d+% on the winner/);
  assert.doesNotMatch(msg.body, /grade/);
  assert.match(msg.body, /Now BTC \$100,060 \(\+\$10\) · bot leans (YES|NO) \d+%/);
  assert.match(msg.body, /calls start \d{1,2}:\d\d (AM|PM)\.$/, 'new window is 2.5 min old: bot is still watching');
  assert.equal(fresh.filter((x) => /^Buy the low/.test(x.title)).length, 0, 'no calls in the first 5 minutes');
  const local = new Date(NOW + 6 * 60000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  assert.ok(msg.title.includes(local), `${msg.title} should start at ${local} New York time`);

  await bot.tick(NOW + 9 * 60000);
  assert.equal(svc.received.filter((r) => JSON.parse(phone.decrypt(r.body)).tag === 'window-update').length, 1, 'one update per window');
});

test('updates can be turned off', async () => {
  const p2 = fakeBrowser();
  const ep = `${svc.base}/push/quiet`;
  bot.sync({ subscription: { endpoint: ep, keys: p2.keys }, settings: { notifyUpdates: false, notifyBuy: false } });
  await bot.tick(NOW + 9 * 60000 + 10000); // first sight of T2: no update right after subscribing anyway
  assert.equal(svc.received.filter((r) => r.url === '/push/quiet').length, 0);
  bot.unsubscribe({ endpoint: ep });
});

test('test endpoint pushes, and a 410 from the push service drops the device', async () => {
  assert.equal((await bot.test({ endpoint: subscription.endpoint })).status, 200);
  assert.match(lastPush().title, /Shot Caller/);
  svc.status = 410;
  await bot.test({ endpoint: subscription.endpoint });
  assert.equal(bot.status().devices, 0);
  svc.status = 201;
});

test('persists keys and devices to disk', async () => {
  bot.sync({ subscription, settings: {}, positions: [] });
  await bot.save();
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(data.devices.length, 1);
  assert.equal(data.vapid.publicKey, bot.publicKey());
});
