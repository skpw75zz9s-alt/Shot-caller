import test from 'node:test';
import assert from 'node:assert/strict';
import { liveReport } from '../public/livereport.js';

const T0 = Date.parse('2026-10-05T14:00:00Z'), M = 60000;
const trade = (o) => ({ source: 'kalshi', side: 'YES', how: 'sold', price: 0.5, contracts: 4, ...o });

test('live results: only the bot\'s trades, split by how they sold and confidence at the buy, plus order outcomes', () => {
  const orders = [
    { at: T0, ticker: 'A', action: 'buy', side: 'YES', status: 'filled', filled: 4, conf: 92 },
    { at: T0 + 3 * M, ticker: 'A', action: 'sell', side: 'YES', status: 'filled', filled: 4, kind: 'lock' },
    { at: T0 + 20 * M, ticker: 'B', action: 'buy', side: 'NO', status: 'filled', filled: 2, conf: 81 },
    { at: T0 + 40 * M, ticker: 'C', action: 'buy', side: 'YES', status: 'no fill (cancelled)', filled: 0, conf: 85 },
    { at: T0 + 41 * M, ticker: 'C', action: 'buy', side: 'YES', status: 'error', error: 'insufficient balance · x' },
    { at: T0 + 50 * M, ticker: 'D', action: 'buy', side: 'YES', status: 'filled', filled: 3, conf: 70 },
    { at: T0 + 55 * M, ticker: 'D', action: 'sell', side: 'YES', status: 'filled', filled: 3, kind: 'cut' },
  ];
  const trades = [
    trade({ ticker: 'A', closedAt: T0 + 3 * M, pnl: 0.8 }),
    trade({ ticker: 'B', side: 'NO', how: 'settled', closedAt: T0 + 30 * M, pnl: 1.2 }),
    trade({ ticker: 'D', closedAt: T0 + 55 * M, pnl: -0.9 }),
    trade({ ticker: 'E', closedAt: T0 + 58 * M, pnl: 5 }), // bought by hand in the Kalshi app: not the bot's
    trade({ ticker: 'F', source: undefined, closedAt: T0, pnl: 3 }), // a manual "I bought it" trade
  ];
  const r = liveReport({ trades, orders, since: T0 - 1 });
  assert.deepEqual([r.total.n, r.total.wins, r.total.pnl, r.total.perTrade, r.total.best, r.total.worst], [3, 2, 1.1, 0.37, 1.2, -0.9]);
  assert.deepEqual(Object.keys(r.byExit).sort(), ['cut', 'lock', 'settle']);
  assert.equal(r.byExit.lock.pnl, 0.8);
  assert.equal(r.byConf['90+'].n, 1); assert.equal(r.byConf['under 80 (big gap)'].pnl, -0.9);
  assert.deepEqual([r.orders.buys, r.orders.filled, r.orders.noFill, r.orders.errors], [5, 3, 1, 1]);
  assert.deepEqual(r.orders.topErrors, [['insufficient balance', 1]]);
  assert.equal(liveReport({ trades, orders, since: T0 + 31 * M }).total.n, 1, 'period filter');
});
