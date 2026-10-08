import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestEntry, suggestExit } from '../public/suggest.js';
import { DEFAULTS, riskSettings } from '../public/model.js';

const s = { ...DEFAULTS, ...riskSettings('steady') };
const ev = { open: true, pYes: 0.9, evYes: 0.12, evNo: -0.5, quote: { yesAsk: 0.75, noAsk: 0.27 } };

test('confident buy, buy, buy light (with the bar it missed), wait', () => {
  const call = (conf, hold) => ({ callSide: 'YES', side: 'YES', price: 0.75, contracts: 8, deep: { score: conf }, hold });
  assert.equal(suggestEntry(call(93, 0.94), ev, s).kind, 'confident');
  assert.match(suggestEntry(call(93, 0.94), ev, s).title, /^CONFIDENT BUY UP at 75¢/);
  assert.equal(suggestEntry(call(87, 0.83), ev, s).kind, 'buy');
  const near = { callSide: null, side: 'YES', robust: true, deep: { score: 88 }, hold: 0.7, holdOk: false, steadyOk: true };
  const l = suggestEntry(near, ev, s);
  assert.equal(l.kind, 'light');
  assert.match(l.why, /hold odds 70% are under the 80% bar/);
  assert.ok(l.contracts >= 1);
  assert.equal(suggestEntry({ ...near, deep: { score: 75 } }, ev, s).kind, 'wait', 'too unsure even for light');
  assert.equal(suggestEntry({ ...near, robust: false }, ev, s).kind, 'wait', 'gap not robust');
  assert.equal(suggestEntry({ ...near, called: 'NO' }, ev, s).kind, 'wait', 'not against a locked call');
  assert.match(suggestEntry({ ...near, deep: { score: 82 }, holdOk: true }, ev, s).why, /confidence 82 is under your 85 bar/);
});

test('sell high vs bail vs hold', () => {
  assert.equal(suggestExit({ action: 'SELL', kind: 'take', why: 'x' }).kind, 'sellHigh');
  assert.equal(suggestExit({ action: 'SELL', kind: 'cut', why: 'x' }).kind, 'bail');
  assert.equal(suggestExit({ action: 'HOLD', kind: 'hold', why: 'x' }).kind, 'hold');
  assert.equal(suggestExit({ action: 'HOLD', kind: 'steady', why: 'x' }).kind, 'watch');
});
