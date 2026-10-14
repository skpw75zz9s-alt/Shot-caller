import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME, MARKETS, isHome, marketOf, roundName, storeKey } from '../public/markets.js';
import { bailMessage, buyMessage, sellMessage } from '../public/engine.js';
import { createBot } from '../bot.js';
import { fakeBrowser } from './helpers.js';

test('the market catalog: Kalshi 15-minute crypto rounds, each with the Coinbase coin its odds are priced from', () => {
  assert.equal(HOME.series, 'KXBTC15M'); assert.equal(HOME.product, 'BTC-USD');
  assert.deepEqual(MARKETS.map((m) => m.key), ['BTC', 'ETH', 'SOL', 'XRP']);
  for (const m of MARKETS) { assert.match(m.series, /^KX[A-Z]+15M$/); assert.match(m.product, /^[A-Z]+-USD$/); }
  assert.equal(marketOf('KXETH15M').name, 'Ethereum'); assert.equal(marketOf('nonsense'), HOME, 'anything unknown is Bitcoin');
  assert.equal(isHome('KXBTC15M'), true); assert.equal(isHome('KXSOL15M'), false);
  assert.equal(roundName('KXETH15M-26OCT141215-15'), '26OCT141215-15');
});

test('each market keeps its own logs on the phone; Bitcoin keeps the original keys', () => {
  assert.equal(storeKey('predLog', 'KXBTC15M'), 'predLog');
  assert.equal(storeKey('predLog', 'KXETH15M'), 'predLog:ETH');
  assert.notEqual(storeKey('callLog', 'KXSOL15M'), storeKey('callLog', 'KXXRP15M'));
});

test("alerts name the round's coin, at its precision", () => {
  const row = (ticker, strike) => ({ m: { ticker }, strike, ev: { side: 'YES', price: 0.7, pYes: 0.8, quote: {} } });
  const sig = { callSide: 'YES', price: 0.7, contracts: 10, stance: 'new' };
  const eth = buyMessage(row('KXETH15M-X-15', 4012.5), sig, 4020.25).body;
  assert.match(eth, /ETH above \$4,012\.50/); assert.match(eth, /ETH \$4,020\.25/); assert.ok(!/BTC/.test(eth));
  assert.match(buyMessage(row('KXXRP15M-X-15', 2.5123), sig, 2.5201).body, /XRP above \$2\.5123.*XRP \$2\.5201/);
  assert.match(buyMessage(row('KXBTC15M-X-15', 100000), sig, 100250).body, /BTC above \$100,000.*BTC \$100,250/);
  assert.ok(bailMessage(row('KXETH15M-X-15', 4000), { bail: { side: 'YES', p: 0.3, bid: 0.25 } }).title.includes('BAIL'));
  const sell = sellMessage({ id: 'p1', ticker: 'KXSOL15M-X-15', side: 'YES', price: 0.6, contracts: 5 }, { ex: { kind: 'take', why: 'Up nicely.' }, bid: 0.9 }, 152.37);
  assert.match(sell.body, /SOL \$152\.37/);
});

test('the server only accepts markets it has a price for (the old free-text series box)', async () => {
  const b = createBot({ kalshi: 'http://127.0.0.1:1', coinbase: 'http://127.0.0.1:1', dataFile: join(await mkdtemp(join(tmpdir(), 'mk-')), 'd.json'), env: { PUSH_HOST_ALLOW: '127.0.0.1' }, log: { log() {}, warn() {}, error() {} } });
  const phone = fakeBrowser(), sub = (n) => ({ endpoint: `http://127.0.0.1:9/push/${n}`, keys: phone.keys });
  assert.equal(b.sync({ subscription: sub('a'), settings: { series: 'KXETH15M' }, positions: [] }).status, 200);
  assert.equal(b.devices.get(sub('a').endpoint).settings.series, 'KXETH15M');
  b.sync({ subscription: sub('b'), settings: { series: 'KXDOGE99' }, positions: [] });
  assert.equal(b.devices.get(sub('b').endpoint).settings.series, 'KXBTC15M', 'a market with no price feed falls back to Bitcoin');
  b.stop();
});
