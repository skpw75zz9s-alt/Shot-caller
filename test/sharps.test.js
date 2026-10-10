import test from 'node:test';
import assert from 'node:assert/strict';
import { copyRecord, foldRound, gradeRound, isSharp, parseTrade, sharpLean, sharpList } from '../public/sharps.js';
import { createSmartMoney } from '../smartmoney.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const tr = (wallet, side, outcome, price, size, ts = 1_700_000_000) => ({ proxyWallet: wallet, side, outcome, price, size, timestamp: ts, transactionHash: `0x${Math.random().toString(16).slice(2)}` });

test('parses both API shapes and rejects junk', () => {
  const a = parseTrade(tr(A, 'BUY', 'Up', 0.55, 100));
  assert.equal(a.wallet, A); assert.equal(a.outcome, 'Up'); assert.equal(a.t, 1_700_000_000_000);
  const b = parseTrade({ proxy_wallet: B.toUpperCase().replace('0X', '0x'), side: 'sell', outcome: 'Down', price: '0.4', size: '10', timestamp: 1_700_000_000_000, transaction_hash: '0x1' });
  assert.equal(b.wallet, B); assert.equal(b.side, 'SELL');
  assert.equal(parseTrade({ proxyWallet: 'nope', side: 'BUY', outcome: 'Up', price: 0.5, size: 1 }), null);
  assert.equal(parseTrade(tr(A, 'BUY', 'Up', 1.5, 1)), null);
});

test('positions, grading, sharps and their lean', () => {
  const book = {};
  // A wins 16 of 20 rounds; B loses most; C bets dust (ignored)
  for (let i = 0; i < 20; i++) {
    const winner = i % 2 ? 'Up' : 'Down';
    const aSide = i < 16 ? winner : winner === 'Up' ? 'Down' : 'Up', bSide = i < 6 ? winner : winner === 'Up' ? 'Down' : 'Up';
    const pos = foldRound({}, [tr(A, 'BUY', aSide, 0.5, 100), tr(B, 'BUY', bSide, 0.5, 100), tr(C, 'BUY', winner, 0.5, 10)].map(parseTrade));
    gradeRound(book, pos, winner);
  }
  assert.equal(book[A].rounds, 20); assert.equal(book[A].wins, 16); assert.equal(book[A].pnl, 16 * 50 - 4 * 50);
  assert.equal(book[C], undefined, 'under $20 a round: not graded');
  assert.equal(isSharp(book[A]), true); assert.equal(isSharp(book[B]), false);
  assert.deepEqual(sharpList(book).map((x) => x.wallet), [A]);
  // a sell reduces the position
  const pos = foldRound({}, [tr(A, 'BUY', 'Up', 0.6, 100), tr(A, 'SELL', 'Up', 0.7, 40), tr(B, 'BUY', 'Down', 0.5, 300)].map(parseTrade));
  assert.equal(pos[A].Up, 60); assert.ok(Math.abs(pos[A].cash - (-60 + 28)) < 1e-9);
  const lean = sharpLean(book, pos);
  assert.equal(lean.n, 1); assert.equal(lean.upShare, 1); assert.equal(lean.lean, null, 'one sharp is not a consensus');
  assert.deepEqual(copyRecord([{ lean: 'Up', upShare: 0.8, result: 'Up' }, { lean: 'Down', upShare: 0.4, result: 'Up' }, { lean: null, result: 'Up' }]), { graded: 2, right: 1, strong: 1, strongRight: 1, rate: 0.5 });
});

test('the server follows rounds end to end: trades, results, grading, the copy signal', async () => {
  const W = 15 * 60000, start0 = Math.floor(1_800_000_000_000 / W) * W;
  let now = start0 + 30000;
  const markets = {}, trades = {};
  // three skilled wallets and noise; each round's winner alternates
  const winnerOf = (s) => ((s / W) % 2 ? 'Up' : 'Down');
  const fetchJSON = async (url) => {
    const slug = url.match(/slug=btc-updown-15m-(\d+)/)?.[1];
    if (slug) { const s = Number(slug) * 1000; const done = now > s + W + 60000; return [{ conditionId: `0xc${slug}`, outcomes: '["Up","Down"]', closed: done, outcomePrices: done ? (winnerOf(s) === 'Up' ? '["1","0"]' : '["0","1"]') : '["0.5","0.5"]' }]; }
    const cid = url.match(/market=(0xc\d+)/)?.[1];
    if (cid) return trades[cid] ||= (() => { const s = Number(cid.slice(3)) * 1000, w = winnerOf(s); return [A, B, C].map((x, i) => tr(x, 'BUY', i === 2 && (s / W) % 3 === 0 ? (w === 'Up' ? 'Down' : 'Up') : w, 0.5, 100, s / 1000 + 60)); })();
    throw new Error('unexpected ' + url);
  };
  const sm = createSmartMoney({ file: join(mkdtempSync(join(tmpdir(), 'sharps-')), 'sharps.json'), fetchJSON, clock: () => now, log: { error() {} } });
  await sm.load();
  for (let k = 0; k < 24; k++) { // 24 rounds, a few ticks each
    for (const off of [30000, 11 * 60000, 16 * 60000 + 70000]) { now = start0 + k * W + off; await sm.tick(now); }
  }
  const api = sm.api(now);
  assert.ok(api.sharps.length >= 2, `sharps found: ${api.sharps.length}`);
  assert.ok(api.record.graded >= 3, `copy signal graded: ${JSON.stringify(api.record)}`);
  assert.equal(api.record.right, api.record.graded, 'these sharps always win');
  assert.equal(api.status.ok, true);
});
