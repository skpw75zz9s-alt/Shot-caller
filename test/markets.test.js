import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSETS, HOME, SEEDS, assetFor, classifySeries, dataDir, isHome, label, marketOf, roundName, storeKey } from '../public/markets.js';
import { bailMessage, buyMessage, liveRow, sellMessage } from '../public/engine.js';
import { probAbove, probYes } from '../public/model.js';
import { exchangesFor, globalExchangesFor } from '../public/feeds.js';
import { sourcesFor } from '../index.js';
import { liqFeedsFor } from '../public/liquidations.js';
import { createDiscovery } from '../discovery.js';
import { createPrices, yahooRows, yahooTicker } from '../prices.js';
import { createBot } from '../bot.js';
import { createStacks, nullScan } from '../stacks.js';
import { callMessage, pickMessage, resultMessage } from '../discord.js';

test('the asset catalog: every coin plus stock indexes, gold and oil, and which Kalshi series each one prices', () => {
  assert.deepEqual(ASSETS.map((a) => a.key), ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SPX', 'NDX', 'DJI', 'GOLD', 'OIL']);
  for (const a of ASSETS) assert.ok(a.kind === 'crypto' ? a.product && a.sym : a.yahoo, a.key);
  assert.equal(assetFor({ series: 'KXBTCD' }).key, 'BTC'); assert.equal(assetFor({ series: 'KXETH15M' }).key, 'ETH');
  assert.equal(assetFor({ series: 'KXINXU' }).key, 'SPX'); assert.equal(assetFor({ series: 'KXNASDAQ100U' }).key, 'NDX');
  assert.equal(assetFor({ series: 'KXFOO', title: 'Gold price today at 5pm?' }).key, 'GOLD');
  assert.equal(assetFor({ series: 'KXFOO', title: 'WTI crude oil close' }).key, 'OIL');
  assert.equal(assetFor({ series: 'KXRAIN', title: 'Rain in NYC today?' }), null, 'no price, no market');
  assert.deepEqual(classifySeries({ ticker: 'KXBTCD', title: 'Bitcoin price today at 5pm EDT', frequency: 'hourly' }), { series: 'KXBTCD', asset: 'BTC', freq: 'hourly', title: 'Bitcoin price today at 5pm EDT' });
  assert.equal(classifySeries({ ticker: 'KXSOL15M', title: 'Solana' }).freq, '15m');
  assert.equal(marketOf('KXETHD', [{ series: 'KXETHD', asset: 'ETH', freq: 'daily' }]).freq, 'daily');
  assert.equal(label(marketOf('KXETH15M')), 'ETH · 15m'); assert.equal(marketOf('nonsense'), HOME);
  assert.equal(roundName('KXETH15M-26OCT141215-15'), '26OCT141215-15');
  assert.equal(storeKey('predLog', 'KXBTC15M'), 'predLog'); assert.equal(storeKey('predLog', 'KXBTCD'), 'predLog:KXBTCD', 'BTC hourly keeps its own logs too');
  assert.equal(dataDir('KXBTC15M'), ''); assert.equal(dataDir('KXETHD'), 'markets/KXETHD');
  assert.equal(isHome('KXBTC15M'), true); assert.equal(isHome('KXBTCD'), false);
});

test('each coin gets its own exchange feeds, index sources and liquidations; Bitcoin keeps its own', () => {
  const by = (k) => ASSETS.find((a) => a.key === k);
  assert.equal(exchangesFor(by('BTC').sym)[0].subscribe[0].params.symbol[0], 'BTC/USD');
  assert.equal(exchangesFor(by('ETH').sym).find((e) => e.name === 'Binance.US').url, 'wss://stream.binance.us:9443/ws/ethusd@trade');
  const okxSol = globalExchangesFor(by('SOL').sym).find((e) => e.name === 'OKX perp');
  assert.deepEqual(okxSol.parse({ arg: { channel: 'trades' }, data: [{ px: '150', sz: '3', side: 'buy', ts: '1' }] })[0].size, 3, 'SOL swap: 1 SOL a contract');
  assert.ok(!globalExchangesFor(by('XRP').sym).some((e) => e.name === 'Deribit perp'), 'no venue that does not list it');
  assert.equal(sourcesFor('https://cb', by('DOGE')).find((x) => x.name === 'Kraken').url, 'https://api.kraken.com/0/public/Ticker?pair=XDGUSD');
  assert.deepEqual(sourcesFor('https://cb', by('SPX')), [], 'an index has no exchange books');
  assert.equal(liqFeedsFor(by('ETH').sym)[0].url, 'wss://fstream.binance.com/ws/ethusdt@forceOrder');
});

test('discovery finds Kalshi\'s series, sorts them into assets and marks which can run now', async () => {
  const now = Date.UTC(2026, 9, 14, 15), soon = new Date(now + 3600000).toISOString(), far = new Date(now + 90 * 86400000).toISOString();
  const kalshi = {
    'series?category=Crypto': { series: [{ ticker: 'KXBTCD', title: 'Bitcoin price today', frequency: 'hourly' }, { ticker: 'KXBTCMAXY', title: 'How high will Bitcoin get this year?', frequency: 'annual' }, { ticker: 'KXETHD', title: 'Ethereum price today', frequency: 'daily' }] },
    'series?category=Financials': { series: [{ ticker: 'KXINXU', title: 'S&P 500 price today', frequency: 'daily' }, { ticker: 'KXRAIN', title: 'Rain in NYC' }] },
  };
  const markets = { KXBTC15M: [{ close_time: soon }], KXBTCD: [{ event_ticker: 'E1', floor_strike: 1, close_time: soon }, { event_ticker: 'E1', floor_strike: 2, close_time: soon }], KXBTCMAXY: [{ event_ticker: 'Y', floor_strike: 1, close_time: far }], KXETHD: [], KXINXU: [{ event_ticker: 'S', floor_strike: 1, close_time: soon }] };
  const fetchJSON = async (u) => {
    const q = u.replace('https://k/', '');
    if (q.startsWith('series?')) return kalshi[q] ?? { series: [] };
    const s = new URL(u).searchParams.get('series_ticker'); return { markets: markets[s] ?? [] };
  };
  const d = createDiscovery({ kalshi: 'https://k', fetchJSON, env: {}, clock: () => now, log: { warn() {} } });
  await d.refresh(now);
  const st = Object.fromEntries(d.list().map((m) => [m.series, m.state]));
  assert.equal(st.KXBTCD, 'active'); assert.equal(st.KXINXU, 'active'); assert.equal(st.KXBTCMAXY, 'later', 'a yearly market: listed, not run');
  assert.equal(st.KXETHD, 'closed'); assert.equal(st.KXRAIN, undefined);
  assert.equal(d.list().find((m) => m.series === 'KXBTCD').strikes, 2);
  assert.ok(d.running().includes('KXBTCD') && d.running().includes('KXBTC15M') && !d.running().includes('KXBTCMAXY'));
});

test('Yahoo prices for indexes, gold and oil come out in Coinbase\'s shapes, and a stale print is marked delayed', async () => {
  const t0 = 1_760_450_000, body = { chart: { result: [{ meta: { regularMarketPrice: 6702.5, regularMarketTime: t0 + 120 }, timestamp: [t0, t0 + 60, t0 + 120], indicators: { quote: [{ open: [6700, null, 6701], high: [6702, null, 6703], low: [6699, null, 6700], close: [6701, null, 6702.5], volume: [10, 0, 12] }] } }] } };
  assert.deepEqual(yahooRows(body), [[t0 + 120, 6700, 6703, 6701, 6702.5, 12], [t0, 6699, 6702, 6700, 6701, 10]], 'newest first, empty minutes skipped');
  assert.equal(yahooTicker(body, (t0 + 130) * 1000).delayed, false);
  assert.equal(yahooTicker(body, (t0 + 120) * 1000 + 600000).delayed, true, 'ten minutes old: delayed, no calls');
  const seen = []; const p = createPrices({ coinbase: 'https://cb', fetchJSON: async (u) => { seen.push(u); return u.includes('yahoo') ? body : { price: '4012.5', time: 'x' }; }, clock: () => (t0 + 130) * 1000 });
  assert.equal((await p.ticker(ASSETS.find((a) => a.key === 'SPX'))).price, 6702.5);
  assert.equal((await p.ticker(ASSETS.find((a) => a.key === 'ETH'))).price, 4012.5);
  assert.ok(seen.some((u) => u.includes('/v8/finance/chart/%5EGSPC')) && seen.some((u) => u.includes('/products/ETH-USD/ticker')));
});

test('settled on the price at the close (indexes, gold, oil): the log-normal, checked by simulation', () => {
  let seed = 31; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const S = 6700, K = 6710, sig = 0.0004, mins = 10, p = probAbove(S, K, sig, mins, 0, 0);
  let hit = 0; const n = 60000;
  for (let i = 0; i < n; i++) if (S * Math.exp(-sig * sig / 2 * mins + sig * Math.sqrt(mins) * gauss()) > K) hit++;
  assert.ok(Math.abs(hit / n - p) < 4 * Math.sqrt(p * (1 - p) / n), `${p.toFixed(4)} vs ${(hit / n).toFixed(4)}`);
  const m = { strike_type: 'greater', floor_strike: K };
  assert.notEqual(probYes(m, K, S, sig, 0.5, 0), probYes({ ...m, settleWin: 0 }, K, S, sig, 0.5, 0), 'the 60-second average and the close itself differ near the end');
  assert.equal(probAbove(S, K, sig, 0, 0, 0), 0, 'at the close: just the price');
});

test('a round with many strikes: the bot calls the one nearest even odds, locked once calls can start', () => {
  const close = '2026-10-14T21:00:00Z', row = (t, p, mins = 20) => ({ m: { ticker: t, event_ticker: 'E', close_time: close }, ev: { pYes: p, minutesLeft: mins } });
  const chosen = {};
  assert.equal(liveRow([row('A', 0.9, 20), row('B', 0.55, 20), row('C', 0.2, 20)], chosen).m.ticker, 'B');
  assert.deepEqual(chosen, {}, 'before calls can start it floats');
  assert.equal(liveRow([row('A', 0.9, 12), row('B', 0.45, 12), row('C', 0.2, 12)], chosen).m.ticker, 'B'); assert.equal(chosen.E, 'B');
  assert.equal(liveRow([row('A', 0.6, 8), row('B', 0.3, 8), row('C', 0.1, 8)], chosen).m.ticker, 'B', 'locked: the card doesn\'t jump to A');
  assert.equal(liveRow([row('X', 0.8)], {}).m.ticker, 'X', 'a 15-minute round: its only market');
});

test('alerts and Discord posts name the market, at its precision', () => {
  const row = (ticker, strike) => ({ m: { ticker }, strike, ev: { side: 'YES', price: 0.7, pYes: 0.8, quote: {} } });
  const sig = { callSide: 'YES', price: 0.7, contracts: 10, stance: 'new' };
  assert.match(buyMessage(row('KXETH15M-X-15', 4012.5), sig, 4020.25).body, /ETH above \$4,012\.50.*ETH \$4,020\.25/);
  assert.match(buyMessage(row('KXXRP15M-X-15', 2.5123), sig, 2.5201).body, /XRP above \$2\.5123/);
  assert.match(buyMessage(row('KXINXU-26OCT14H1600-T6700', 6700), sig, 6702.4).body, /SPX above \$6,700\.00/);
  assert.match(buyMessage(row('KXBTC15M-X-15', 100000), sig, 100250).body, /BTC above \$100,000.*BTC \$100,250/);
  assert.ok(bailMessage(row('KXETH15M-X-15', 4000), { bail: { side: 'YES', p: 0.3, bid: 0.25 } }).title.includes('BAIL'));
  assert.match(sellMessage({ id: 'p1', ticker: 'KXSOL15M-X-15', side: 'YES', price: 0.6, contracts: 5 }, { ex: { kind: 'take', why: 'Up.' }, bid: 0.9 }, 152.37).body, /SOL \$152\.37/);
  const e = { ticker: 'KXETHD-26OCT1417-T4000', side: 'YES', price: 0.7, at: Date.now(), closeTime: new Date().toISOString(), conf: 85, result: 'yes', p: 0.8, strike: 4000 };
  assert.match(callMessage(e, { strike: 4000 }).embeds[0].title, /^\[ETH · /); assert.match(callMessage(e, { strike: 4000 }).embeds[0].description, /ETH above \$4,000\.00/);
  assert.match(resultMessage(e).embeds[0].description, /^ETH closed above/); assert.match(pickMessage(e).embeds[0].description, /^ETH above \$4,000\.00/);
  assert.ok(!callMessage({ ...e, ticker: 'KXBTC15M-X-15' }, { strike: 100000 }).embeds[0].title.startsWith('['), 'Bitcoin\'s 15-minute posts stay as they were');
});

test('a full copy of the bot runs for another market: its own price, Kalshi rounds, record files and shared push keys', async () => {
  const NOW = Date.now(), close = new Date(NOW + 6 * 60000).toISOString(), open = new Date(NOW - 9 * 60000).toISOString();
  const up = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/products/ETH-USD/candles')) { const rows = []; for (let i = 120; i >= 1; i--) { const t = Math.floor(NOW / 60000) * 60000 - i * 60000, c = 4000 + Math.sin(i) * 2; rows.push([t / 1000, c - 1, c + 1, c, c, 1]); } return res.end(JSON.stringify(rows.reverse())); }
    if (req.url.startsWith('/products/ETH-USD/ticker')) return res.end(JSON.stringify({ price: '4006', bid: '4005.9', ask: '4006.1', time: new Date().toISOString() }));
    if (req.url.startsWith('/markets?') && req.url.includes('KXETH15M')) return res.end(JSON.stringify({ markets: [{ ticker: 'KXETH15M-T1', event_ticker: 'KXETH15M-T1', strike_type: 'greater_or_equal', floor_strike: 4000, open_time: open, close_time: close, yes_bid: 60, yes_ask: 62 }] }));
    if (req.url.startsWith('/markets?')) return res.end(JSON.stringify({ markets: [] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => up.listen(0, r));
  const base = `http://127.0.0.1:${up.address().port}`, dir = await mkdtemp(join(tmpdir(), 'stk-')), quiet = { log() {}, warn() {}, error() {} };
  const fetchJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
  const home = { bot: createBot({ kalshi: base, coinbase: base, dataFile: join(dir, 'shot-caller.json'), env: { INDEX: 'off' }, log: quiet }), scanFeed: nullScan() };
  await home.bot.load();
  const discovery = { list: () => SEEDS.map((s) => ({ ...s, state: 'active' })), running: () => ['KXETH15M'], refresh: async () => {}, at: () => 0 };
  const posts = { call: [], pick: [] }, discord = { call: (e) => posts.call.push(e), result() {}, pick: (e) => posts.pick.push(e), alert() {} };
  const stacks = createStacks({ home, dataDir: dir, kalshi: base, coinbase: base, prices: createPrices({ coinbase: base, fetchJSON }), discovery, discord, env: { SCAN_FEEDS: 'off', FUTURES: 'off', PLAYBOOK: 'off', LEARN: 'off', INDEX: 'off', PUSH_HOST_ALLOW: '127.0.0.1' }, log: quiet });
  try {
    await stacks.start('KXETH15M');
    const eth = stacks.bot('KXETH15M');
    assert.notEqual(eth, home.bot); assert.deepEqual(eth.market(), { series: 'KXETH15M', asset: 'ETH', freq: '15m', delayed: false });
    assert.equal(eth.publicKey(), home.bot.publicKey(), 'one set of push keys for every market');
    const phone = (await import('./helpers.js')).fakeBrowser();
    assert.equal(eth.sync({ subscription: { endpoint: 'http://127.0.0.1:9/push/eth', keys: phone.keys }, settings: { series: 'KXETH15M' }, positions: [] }).status, 200);
    await eth.tick(NOW);
    assert.ok(eth.status().lastTick > 0, 'it ticked on its own data');
    assert.equal(eth.index().coinbase, 4006, "Ethereum's price, not Bitcoin's");
    assert.equal(stacks.bot('KXNOPE'), home.bot, "a market with no bot falls back to Bitcoin's");
  } finally { stacks.stop(); home.bot.stop(); up.close(); up.closeAllConnections?.(); }
});
