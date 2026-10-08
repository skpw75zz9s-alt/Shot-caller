import { DEFAULTS, EXIT_DEFAULTS, RISK_LEVELS, dipLimit, kalshiFee, quote, riskLevelOf, riskSettings } from './model.js';
import { patterns } from './candles.js';
import { addMessage, buyMessage, buySignal, leanSide, parseCandles, positionCheck, releaseCall, sellMessage, sideName, snapshot } from './engine.js';
import { TIMEFRAMES, aggregate, floorCeiling, forecastCone } from './indicators.js';
import { CHART_TOGGLES, chartDefaults, drawPro } from './chart.js';
import { addTrade, flowStats, newFlow, pressureUpdate } from './flow.js';
import { ALL_FEEDS, byExchange, createFeeds, kalshiFlow, parseCoinbase, parseKalshiTrades } from './feeds.js';
import { callSound, sustained } from './alerts.js';
import { createAlertCenter } from './alertui.js';
import { createFx, trendTurn } from './fx.js';
import { suggestEntry, suggestExit } from './suggest.js';
import { ema } from './indicators.js';
import { confTier } from './analysis.js';
import { balanceDollars, foldFills, importKey, parseFill, parsePosition, parseSettlement, reconcilePositions, signHeaders } from './kalshi.js';
import { allowAlert } from './notify.js';
import { healthCheck, healthDue, newProblems } from './health.js';
import { callStats, dailyRecord, logCall, settleCalls, unsettledCalls } from './record.js';
import { slotLabel } from './learner.js';

const API = './api';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SETTINGS_META = [
  ['series', 'Kalshi series', 'Series ticker for 15-min BTC markets', 'text'],
  ['minEdge', 'Min gap (pts)', 'How far Kalshi\'s price must be below the bot\'s odds, after fees, even if volatility is 20% off either way, to call BUY THE LOW', 'cents'],
  ['minConfidence', 'Min confidence (0-100)', 'Win odds a call needs before BUY THE LOW fires (80 = wins about 8 times in 10)', 'num'],
  ['rejectionWeight', 'Rejection weight', 'How much rejection trends move the bot\'s odds (0 = off, 1 = up to ±5 pts)', 'num'],
  ['multiFeeds', 'Live orders from all exchanges', 'Also stream trades from Kraken, Bitstamp, Gemini and Binance.US (more data). Off: Coinbase only', 'bool'],
  ['learn', 'Use what the bot learned', 'Price with the market patterns the server has learned over days and weeks (see History)', 'bool'],
  ['waitForDip', 'Also wait for candle dip', 'Only alert when the candles also show a dip', 'bool'],
  ['notifyBuy', 'Notify: buy the low', 'Alert when Kalshi is below the bot\'s odds', 'bool'],
  ['notifySell', 'Notify: sell now', 'Alert when a tracked position should be sold', 'bool'],
  ['notifyUpdates', 'Notify: hourly updates', 'Once an hour: the last window\'s result and the bot\'s read on the new one', 'bool'],
  ['maxSpread', 'Max spread (pts)', 'Skip markets where buy and sell % are further apart', 'cents'],
  ['minMinutesLeft', 'Min minutes left', 'Stop calling this close to settlement', 'num'],
  ['waitMinutes', 'Wait before calling (min)', 'Minutes into each 15-minute window before the bot makes any call', 'num'],
  ['volMultiplier', 'Vol multiplier', '1 = measured volatility. Above 1 expects bigger swings (odds closer to 50/50)', 'num'],
  ['momentumWeight', 'Momentum weight', 'How much of the 10-min drift to carry forward (0 to 1)', 'num'],
  ['minProfit', 'Min profit (pts)', 'Profit per contract (after fees) for a sell to count as taking profit', 'cents'],
  ['trail', 'Trailing drop (pts)', 'Flag a flip sign if the sell % falls this far from its peak (a warning, not a sell)', 'cents'],
  ['oddsDrop', 'Odds drop (pts)', 'Flag a flip sign if the bot\'s odds fall this far from their peak (a warning, not a sell)', 'cents'],
  ['cutConfirmSec', 'Hold steady (sec)', 'A sell at a loss has to stay true this long before SELL NOW, so one jumpy tick doesn\'t shake you out', 'num'],
  ['cutMargin', 'Cut margin (pts)', 'A sell at a loss needs Kalshi to pay at least this much more than the bot\'s odds', 'cents'],
  ['tradeAmount', 'Fixed trade amount ($)', 'What "I bought it" records each time. 0 = use the bot\'s suggested amount', 'num'],
  ['bankroll', 'Bankroll ($)', 'Used for position sizing', 'num'],
  ['kellyFraction', 'Kelly fraction', '0.25 means quarter Kelly', 'num'],
  ['maxStake', 'Max stake ($)', 'Cap per call', 'num'],
  ['refreshSec', 'Kalshi refresh (sec)', 'How often to reload Kalshi prices (BTC streams live)', 'num'],
];
// A fresh install has nothing to migrate: skip straight past the old upgrade steps (the v4.1 step used to double a new
// phone's confidence bar to 95). Only the latest step (default risk level) runs.
if (store.get('settings', null) == null && store.get('settingsVersion', null) == null) store.set('settingsVersion', 11);
const settings = { series: 'KXBTC15M', refreshSec: 3, multiFeeds: true, waitForDip: false, notifyBuy: true, notifySell: true, notifyUpdates: true, tradeAmount: 0, ...DEFAULTS, ...EXIT_DEFAULTS, ...store.get('settings', {}) };
// v1.2: "buy the low" means Kalshi below the bot's odds, so candle-dip gating is off unless re-enabled.
if (store.get('settingsVersion', 1) < 2) { settings.waitForDip = false; store.set('settings', settings); store.set('settingsVersion', 2); }
// v1.6: Kalshi prices refresh every 3s (was 5s)
if (store.get('settingsVersion', 1) < 3) { if (settings.refreshSec === 5) settings.refreshSec = 3; store.set('settings', settings); store.set('settingsVersion', 3); }
// v2.6: calls need confidence 60 or more
if (store.get('settingsVersion', 1) < 4 && settings.minConfidence === 55) { settings.minConfidence = 60; store.set('settings', settings); }
if (store.get('settingsVersion', 1) < 4) store.set('settingsVersion', 4);
// v3.2: vol multiplier 1.15 -> 1.0 (it made the bot's odds too timid next to real BTC swings)
if (store.get('settingsVersion', 1) < 5) { if (settings.volMultiplier === 1.15) { settings.volMultiplier = 1; store.set('settings', settings); } store.set('settingsVersion', 5); }
// v3.3: profit tuning: no drift carry, 8-pt robust gap
if (store.get('settingsVersion', 1) < 6) {
  if (settings.momentumWeight === 0.25) settings.momentumWeight = 0;
  if (settings.minEdge === 0.04) settings.minEdge = 0.08;
  store.set('settings', settings); store.set('settingsVersion', 6);
}

// v3.9: Safe was leaving trades on the table for hand trading; old Safe defaults move to Balanced
if (store.get('settingsVersion', 1) < 7) {
  if (riskLevelOf(settings) === 'safe') Object.assign(settings, { minEdge: RISK_LEVELS.balanced.minEdge, minConfidence: RISK_LEVELS.balanced.minConfidence });
  store.set('settings', settings); store.set('settingsVersion', 7);
}

// v3.10: Aggressive scales in; anyone already on Aggressive gets it
if (store.get('settingsVersion', 1) < 8) {
  if (riskLevelOf(settings) === 'aggressive') settings.scaleIn = true;
  store.set('settings', settings); store.set('settingsVersion', 8);
}
// v3.12: the optimized Aggressive replaces the old one for anyone on it
if (store.get('settingsVersion', 1) < 10) {
  if (Math.abs(settings.minEdge - 0.04) < 1e-9 && settings.minConfidence === 50) {
    Object.assign(settings, riskSettings('aggressive'));
  }
  store.set('settings', settings); store.set('settingsVersion', 10);
}
// v3.11: Aggressive bets double size (only if the sizing was never changed by hand)
if (store.get('settingsVersion', 1) < 9) {
  if (riskLevelOf(settings) === 'aggressive' && settings.kellyFraction === 0.25 && settings.maxStake === 25) Object.assign(settings, { kellyFraction: 0.5, maxStake: 50 });
  store.set('settings', settings); store.set('settingsVersion', 9);
}

// v4.1: confidence is now the call's win odds, and every confidence bar doubles (Aggressive 40 -> 80).
// Risk levels get their new settings; custom bars double (capped at 95).
if (store.get('settingsVersion', 1) < 11) {
  const dbl = (c) => Math.min(95, Math.round((Number(c) || 0) * 2));
  const lvl = Object.keys(RISK_LEVELS).find((k) => Math.abs(RISK_LEVELS[k].minEdge - settings.minEdge) < 1e-9 && { safe: 60, balanced: 55, aggressive: 40 }[k] === settings.minConfidence);
  if (lvl) Object.assign(settings, riskSettings(lvl)); else settings.minConfidence = dbl(settings.minConfidence);
  store.set('settings', settings); store.set('settingsVersion', 11);
}

// v5.3: Steady (calls whose confidence is likely to hold all round) replaces Balanced as the default
if (store.get('settingsVersion', 1) < 12) {
  // (also phones hit by the old fresh-install bug: Balanced's gap with the bar doubled to 95 and no big-gap exception)
  const freshBug = Math.abs(settings.minEdge - 0.06) < 1e-9 && settings.minConfidence === 95 && !settings.bigEdgeOverride;
  if (riskLevelOf(settings) === 'balanced' || freshBug) { Object.assign(settings, riskSettings('steady')); if (store.get('settings', null) != null) store.set('steadyNote', true); } // (a brand-new phone just starts on Steady: no note)
  store.set('settings', settings); store.set('settingsVersion', 12);
}

const state = { markets: [], spot: null, candles: [], candlesAt: 0, marketsAt: 0, strikes: {}, quoteLog: {}, alerted: {},
  positions: store.get('positions', []), trades: store.get('trades', []), kalshi: { key: null, keyId: null },
  notifyLog: {}, // anti-spam limiter for in-app alerts
  calls: store.get('calls', {}),
  ruleLog: store.get('ruleLog', []), // scorecard for the two-rejections rule
  callLog: store.get('callLog', []), // every call the bot makes, graded at settlement (public/record.js)
  memory: store.get('marketMemory', null) }; // what the server has learned about the market (public/learner.js)
// v5.0: auto-trading and Practice were removed: drop what they stored
try { for (const k of ['practice', 'practiceCfg', 'liveCfg', 'liveOrders', 'learned']) localStorage.removeItem(k); } catch { /* storage blocked */ }
for (const [k, c] of Object.entries(state.calls)) if (!(c.at > Date.now() - 2 * 3600000)) delete state.calls[k];
try { localStorage.removeItem('tracker'); } catch { /* report cards were removed in v2.9 */ }

// Access lapsed (paywall): reload so the server shows the paywall page.
function paywalled(r) {
  if (r.status === 401) { location.reload(); throw new Error('payment required'); }
}

async function getJSON(path) {
  const r = await fetch(`${API}/${path}`);
  paywalled(r);
  const srv = Date.parse(r.headers.get('date') || ''); // server clock, for the health check's phone-clock test
  if (srv) state.skewMs = Date.now() - srv - 500; // the Date header drops milliseconds: half a second on average
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------- data ----------
async function refreshCandles() {
  // Coinbase rows: [time, low, high, open, close, volume], newest first
  state.candles = parseCandles(await getJSON('coinbase/products/BTC-USD/candles?granularity=60'));
  state.candlesAt = Date.now();
}

async function refreshMarkets() {
  const data = await getJSON(`kalshi/markets?series_ticker=${encodeURIComponent(settings.series)}&status=open&limit=50`);
  state.markets = (data.markets || []).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  state.marketsAt = Date.now();
}

// What the server has learned (volatility by time of week, calibration, basis). Small; refreshed every 10 minutes.
async function refreshMemory() {
  state.memory = { ...(await getJSON('learn')), at: Date.now() };
  store.set('marketMemory', state.memory);
  renderMemory();
}

async function refreshIndex() {
  const ix = await getJSON('index');
  state.index = ix.index ? { offset: ix.offset || 0, used: ix.used || [], at: Date.now() } : null;
}

async function refreshSpot() {
  const t = await getJSON('coinbase/products/BTC-USD/ticker');
  state.spot = Number(t.price); state.spotAt = Date.now();
}

// ---------- settlement ----------
async function settlePositions() {
  // Positions still open when their market settled
  // (Kalshi-linked positions are closed from Kalshi's own settlement records in syncKalshi; this is only a fallback)
  for (const pos of state.positions.filter((p) => Date.parse(p.closeTime) < Date.now() - (p.source === 'kalshi' && state.kalshi.key ? 15 * 60000 : 60000)).slice(0, 3)) {
    try {
      const { market } = await getJSON(`kalshi/markets/${encodeURIComponent(pos.ticker)}`);
      if (market && (market.result === 'yes' || market.result === 'no')) {
        const payout = pos.side.toLowerCase() === market.result ? 1 : 0;
        closePosition(pos, payout, 'settled');
      }
    } catch { /* retry next cycle */ }
  }
}

// ---------- positions ----------
// What one contract cost including fees: Kalshi's actual fees when known, otherwise its fee formula
const entryCost = (pos) => pos.price + (pos.fees != null && pos.contracts > 0 ? pos.fees / pos.contracts : kalshiFee(pos.price));
function savePositions() { store.set('positions', state.positions); }

function openPosition(m, side, price, contracts, at = Date.now()) {
  const pos = { id: String(at), ticker: m.ticker, title: m.title, closeTime: m.close_time, side, price, contracts, at, peakBid: null, peakP: null };
  state.positions.push(pos);
  savePositions();
  pushSyncSoon();
  return pos;
}

// exit = sale price in dollars, or 1/0 when it settled. `contracts` < pos.contracts closes part of it.
// fees: what Kalshi actually charged for these contracts (entry + exit), when known; otherwise Kalshi's fee formula
function closePosition(pos, exit, how, at = Date.now(), contracts = pos.contracts, fees = null) {
  const proceeds = how === 'settled' ? exit : exit - kalshiFee(exit);
  const pnl = fees != null ? (exit - pos.price) * contracts - fees : (proceeds - entryCost(pos)) * contracts;
  const trade = { ...pos, contracts, exit, how, closedAt: at, pnl, ...(fees != null ? { fees, exact: true } : {}) };
  if (pos.fees != null && contracts < pos.contracts - 1e-9) pos.fees *= 1 - contracts / pos.contracts; // fees left on what's still held
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 500);
  if (contracts < pos.contracts - 1e-9) pos.contracts -= contracts;
  else state.positions = state.positions.filter((p) => p.id !== pos.id);
  if (how === 'sold') { releaseCall(state.calls, pos.ticker, at, settings); store.set('calls', state.calls); } // re-entry: a new call can fire after the cooldown
  store.set('trades', state.trades);
  savePositions();
  pushSyncSoon();
  return trade;
}

function renderPositions(snap) {
  const html = state.positions.map((pos) => {
    const check = positionCheck(pos, snap, settings);
    (state.posChecks ||= {})[pos.id] = check; // the Suggestions strip reads the same result
    const { row, minutesLeft, pSide, bid, ex } = check;
    if (check.changed) savePositions();

    if (ex.action === 'SELL') {
      const key = `${pos.id}:${ex.kind}`;
      if (!state.alerted[key]) {
        state.alerted[key] = true;
        if (settings.notifySell) alert(sellMessage(pos, check, state.spot), 'sell', { posId: pos.id });
        if (ex.kind === 'take') alerts.event('sellHigh', `SELL HIGH: ${pos.side === 'YES' ? 'UP' : 'DOWN'} at ${pc(bid)}`, `cash out ${ex.net != null ? dollars(ex.net * pos.contracts) : ''} (${money(ex.pnl)})`, `sellHigh:${pos.id}`);
        else alerts.event('sell', `BAIL: ${pos.side === 'YES' ? 'UP' : 'DOWN'} at ${pc(bid)}`, ex.why, `sell:${pos.id}`);
      }
    }

    const sx = suggestExit(ex);
    const head = sx.kind === 'sellHigh' ? `SELL HIGH at ${pc(bid)}` : sx.kind === 'bail' ? `BAIL at ${pc(bid)}` : ex.action === 'SELL' ? `SELL NOW at ${pc(bid)}` : ex.action === 'WAIT' ? 'SETTLING' : 'HOLD';
    const worth = ex.net != null ? ex.net * pos.contracts : null;
    const where = row?.strike ? ` ${pos.side === 'YES' ? 'above' : 'below'} ${usd(row.strike, 0)}` : '';
    const signs = ex.signs?.length ? ex.signs.map((x) => `<li>${esc(x)}</li>`).join('') : '<li class="calm">No flip signs</li>';
    return `<div class="card pos-card ${ex.action.toLowerCase()} ${ex.kind}">
      <div class="pos-top"><span><b>${dollars(pos.contracts * pos.price)}</b> at <b>${pc(pos.price)}</b> <b class="side-tag ${pos.side.toLowerCase()}">${sideName(pos.side)}</b></span><span class="pos-clock" data-close="${Date.parse(pos.closeTime)}">${minutesLeft > 0 ? mmss(minutesLeft) : 'closed'}</span></div>
      <div class="pos-action">${head}</div>
      <div class="pos-why">${esc(ex.why)}</div>
      <div class="pos-grid">
        <div><label>Cash out at</label><b>${pc(bid)}</b></div>
        <div><label>Cash out value</label><b>${worth == null ? '—' : dollars(worth)}</b></div>
        <div><label>P&amp;L</label><b class="${ex.pnl > 0 ? 'pos' : ex.pnl < 0 ? 'neg' : ''}">${ex.pnl == null ? '—' : money(ex.pnl)}</b></div>
        <div><label>Bot odds</label><b>${pc(pSide)}</b></div>
        <div><label>Target sell</label><b>${ex.action === 'SELL' ? 'now' : pc(ex.target)}</b></div>
        <div><label>Pays if right</label><b>${dollars(pos.contracts)}</b></div>
      </div>
      <div class="pos-where">${pos.source === 'kalshi' ? '<span class="src-tag">From Kalshi</span> · ' : ''}Bought ${clock(pos.at)}${pos.source === 'kalshi' ? ` · ${+pos.contracts.toFixed(2)} contracts` : ''} · wins if BTC is${where || (pos.side === 'YES' ? ' above the target' : ' below the target')} at close</div>
      <ul class="flips"><span>Flip watch</span>${signs}</ul>
      <div class="pos-btns">${pos.source === 'kalshi' ? '' : `<button data-act="sell" data-id="${pos.id}">I sold${bid != null ? ` at ${pc(bid)}` : ''}</button>`}<button data-act="remove" data-id="${pos.id}" class="ghost">Remove</button></div>
    </div>`;
  }).join('');
  $('positions').innerHTML = html;
}

// ---------- one-tap tracking ----------
// "I bought it" / "I sold" are single taps: side, Kalshi's live price and the time are locked in
// automatically, and the amount is the bot's suggestion (or the fixed amount from Settings).
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
let undoTimer = null;
function toast(text, undo) {
  $('toastText').textContent = text;
  $('toastUndo').hidden = !undo;
  $('toastUndo').onclick = () => { undo?.(); $('toast').hidden = true; render(); };
  $('toast').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
}

// ---------- alerts ----------
// In-app alert. When push is on, the server sends the notification, so only vibrate here.
async function alert({ tag, title, body }, kind = 'buy', extra = {}) {
  if (!allowAlert(state.notifyLog, kind, extra)) return; // same anti-spam limits as push (public/notify.js)
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* needs a tap first */ }
  if (state.pushOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(title, { body, tag, icon: 'icon.svg' });
  else new Notification(title, { body, tag });
}

// ---------- render helpers ----------
const usd = (v, d = 2) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })}`;
const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const pc = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const dollars = (v) => `$${v.toFixed(2)}`;
const money = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const sign = (el, v) => { el.classList.toggle('pos', v > 0); el.classList.toggle('neg', v < 0); };
const mmss = (min) => { const s = Math.max(0, Math.round(min * 60)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The price the bot prices with: live Coinbase shifted onto the server's multi-exchange index estimate (index.js),
// when that's fresh and sane. Kalshi settles on an index of several exchanges, not Coinbase alone.
const indexFresh = () => !!state.index && Date.now() - state.index.at < 20000 && state.spot && Math.abs(state.index.offset) < state.spot * 0.003;
const modelSpot = () => (indexFresh() ? state.spot + state.index.offset : state.spot);
const compute = () => snapshot({ markets: state.markets, candles: state.candles, spot: modelSpot(), settings, strikes: state.strikes, quoteLog: state.quoteLog, learned: state.memory?.learned ?? null });

// Deep dive (confidence and its reasons) and the window's rejection trends.
function renderDeep(row, sig) {
  const deep = sig?.deep, rej = row?.rej;
  $('deepCard').hidden = !deep;
  $('conf').hidden = !deep;
  if (deep) {
    $('conf').className = `conf ${confTier(deep.score)}`;
    $('conf').textContent = `Confidence ${deep.score}`;
    $('deepScore').textContent = `Confidence ${deep.score}`;
    $('deepScore').className = confTier(deep.score);
    $('deepChecks').innerHTML = deep.checks.map((c) =>
      `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'meh'}"><i>${c.ok === true ? '✓' : c.ok === false ? '✕' : '•'}</i><span>${esc(c.label)}</span><b>${c.pts > 0 ? '+' : ''}${c.pts || ''}</b></li>`).join('') +
      learnedNotes(row).map((x) => `<li class="meh"><i>🧠</i><span>${esc(x)}</span><b></b></li>`).join('');
  }
  $('rejCard').hidden = !rej;
  if (!rej) return;
  const shift = row.ev.pShift || 0;
  $('rejBias').textContent = `${rej.bias[0].toUpperCase()}${rej.bias.slice(1)}${Math.abs(shift) >= 0.005 ? ` · ${shift > 0 ? '+' : '−'}${Math.abs(shift * 100).toFixed(1)} pts on YES` : ''}`;
  $('rejBias').className = rej.bias === 'bullish' ? 'pos' : rej.bias === 'bearish' ? 'neg' : '';
  $('rejCaps').textContent = rej.strikeCaps;
  $('rejFloors').textContent = rej.strikeFloors;
  $('rejHigh').textContent = rej.highRejects;
  $('rejLow').textContent = rej.lowHolds;
  const w = (rej.wickBias + 1) / 2; // 0 = all upper wicks (sellers), 1 = all lower wicks (buyers)
  $('wickFill').style.cssText = w >= 0.5 ? `left:50%;width:${(w - 0.5) * 100}%;background:var(--yes)` : `left:${w * 100}%;width:${(0.5 - w) * 100}%;background:var(--no)`;
  $('rejSummary').innerHTML = rej.summary.map((x) => `<li>${esc(x)}</li>`).join('');
}

// What the long-term memory changed in this window's odds
function learnedNotes(row) {
  const a = row?.learnedAdj;
  if (!a) return [];
  const out = [];
  if (Math.abs(a.volFactor - 1) >= 0.08) out.push(`Learned: at this time of the week the next minutes are usually ${a.volFactor > 1 ? 'busier' : 'calmer'} than the last half hour (volatility ×${a.volFactor.toFixed(2)})`);
  if (a.basis) out.push(`Learned: Kalshi's settlement index runs ${a.basis > 0 ? '+' : '−'}$${Math.abs(a.basis).toFixed(2)} vs Coinbase, included`);
  if (a.cal) out.push(`Learned: odds like these ${a.cal * (row.ev.pYes >= 0.5 ? 1 : -1) > 0 ? 'won more' : 'won less'} than the bot said, corrected ${(Math.abs(a.cal) * 100).toFixed(1)} pts`);
  return out;
}

// Kalshi % vs bot % for each side. "Low" = Kalshi's price is below the bot's odds by the min gap after fees.
function oddsRows(ev, minEdge) {
  if (ev.pYes == null) return '';
  const row = (side, kalshi, bot, edge, cashOut) => {
    if (kalshi == null) return `<div class="odds-row"><span class="side">${side}</span><span class="muted">no offers${cashOut != null ? ` · cash out ${pc(cashOut)}` : ''}</span></div>`;
    const gap = (bot - kalshi) * 100;
    const status = edge != null && edge >= minEdge ? ['low', `LOW by ${gap.toFixed(0)} pts`] : gap > 0 ? ['near', `${gap.toFixed(0)} pts low, not enough after fees`] : ['high', `${Math.abs(gap).toFixed(0)} pts high`];
    const a = Math.min(kalshi, bot) * 100, b = Math.max(kalshi, bot) * 100;
    return `<div class="odds-row ${status[0]}"><span class="side">${side}</span>` +
      `<span class="nums">Kalshi <b>${(kalshi * 100).toFixed(0)}%</b> · Bot <b>${(bot * 100).toFixed(0)}%</b></span>` +
      `<span class="track"><i class="fill" style="left:${a}%;width:${b - a}%"></i><i class="mk kalshi" style="left:${kalshi * 100}%"></i><i class="mk bot" style="left:${bot * 100}%"></i></span>` +
      `<span class="status">${status[1]}<em class="cash">Cash out ${cashOut != null ? `<b>${pc(cashOut)}</b>` : '—'}${cashOut != null ? ` · $10 → ${dollars((10 / kalshi) * (cashOut - kalshiFee(cashOut)))} now` : ''}</em></span></div>`;
  };
  const q = ev.quote;
  return row('YES<small>Above</small>', q.yesAsk, ev.pYes, ev.evYes, q.yesBid) + row('NO<small>Below</small>', q.noAsk, 1 - ev.pYes, ev.evNo, q.noBid) +
    '<div class="odds-legend"><i class="mk kalshi"></i> Kalshi buy price <i class="mk bot"></i> Bot odds · cash out = sell now</div>';
}

// The side the model leans to, even below the edge threshold, so timing has something to read.

// ---------- v6 deck: status tiles, hold meter, price boxes, tug of war, live notes, market events ----------
const alerts = createAlertCenter({ $, store, esc, clock, onNote: (key, title, text) => addNote(key, `${title}${text ? ` · ${text}` : ''}`) });
const flow = newFlow();
const fx = createFx($);
const trendState = {};
$('fxTryLock').addEventListener('click', () => { alerts.play('call', 'bull'); fx.lockIn({ side: 'YES', conf: 91, hold: 0.87, price: 0.72 }); });
$('fxTryBull').addEventListener('click', () => { alerts.play('trendBull'); fx.charge('bull'); });
const watch = {}; // sustained conditions for alerts (alerts.js)
state.notes = [];
function addNote(key, text, t = Date.now()) {
  state.notes.unshift({ t, key, text });
  state.notes.length = Math.min(state.notes.length, 40);
}
const noteClass = (k) => ({ call: 'call', win: 'good', whaleBuy: 'good', feedUp: 'good', loss: 'bad', whaleSell: 'bad', feedDown: 'bad' }[k] || (k === 'info' ? '' : 'warn'));

// ---------- live orders from all markets (public/feeds.js) ----------
// Every exchange's trades feed the tug of war, whales and the tape; the round's per-exchange split resets each round.
const tape = { list: [], round: null, ex: [], kalshi: [], kalshiSeen: new Set(), kalshiTicker: null, rate: [] };
function handleTrades(trades) {
  const p = alerts.prefs();
  for (const x of trades) {
    const live = state.markets.find((m) => Date.parse(m.close_time) > x.t);
    const round = live ? Date.parse(live.open_time) : null;
    if (round !== tape.round) { tape.round = round; tape.ex = []; }
    tape.ex.push(x);
    if (tape.ex.length > 20000) tape.ex.splice(0, 5000);
    const w = addTrade(flow, x, { round, whaleMin: p.whaleMin });
    x.whale = !!w;
    tape.list.unshift(x); tape.rate.push(Date.now());
    if (w) alerts.event(w.side === 'buy' ? 'whaleBuy' : 'whaleSell', `Whale ${w.side}: ${usd(w.usd, 0)}`, `${w.size.toFixed(2)} BTC at ${usd(w.price, 0)} on ${w.ex}`, `whale:${w.ex}:${w.t}`);
  }
  if (tape.list.length > 200) tape.list.length = 200;
}
const feeds = createFeeds({ onTrades: handleTrades, onStatus: (s) => { state.feedStatus = s; } });
function feedsOn() { if (settings.multiFeeds !== false && !document.hidden) feeds.start(); else feeds.stop(); }

// Kalshi's own tape for the live contract (public, through the server's market-data proxy)
async function pollKalshiTrades() {
  const live = state.markets.find((m) => Date.parse(m.close_time) > Date.now());
  if (!live || document.hidden) return;
  if (tape.kalshiTicker !== live.ticker) { tape.kalshiTicker = live.ticker; tape.kalshi = []; tape.kalshiSeen.clear(); }
  try {
    const fresh = parseKalshiTrades(await getJSON(`kalshi/markets/trades?ticker=${encodeURIComponent(live.ticker)}&limit=100`)).filter((x) => !tape.kalshiSeen.has(x.id)).reverse();
    for (const x of fresh) {
      tape.kalshiSeen.add(x.id); tape.kalshi.push(x);
      tape.list.unshift({ ...x, ex: 'Kalshi', kalshi: true });
    }
    if (tape.list.length > 200) tape.list.length = 200;
    state.kalshiTapeAt = Date.now();
  } catch { /* next poll */ }
}
setInterval(pollKalshiTrades, 3000);

state.tapeTab = 'all';
$('tapeTabs').addEventListener('click', (e) => {
  const k = e.target.dataset.tape; if (!k) return;
  state.tapeTab = k;
  for (const b of $('tapeTabs').children) b.classList.toggle('on', b.dataset.tape === k);
  renderTape(true);
});
const hms = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\s?[AP]M/, '');
function renderTape(force = false) {
  const now = Date.now();
  if (!force && now - (state.tapeAt || 0) < 500) return;
  state.tapeAt = now;
  const st = state.feedStatus || {};
  const liveFeed = (n) => (n === 'Coinbase' ? isLive() : st[n]?.state === 'live' && now - (st[n].lastAt || 0) < 120000);
  const off = settings.multiFeeds === false;
  $('feedChips').innerHTML = [...ALL_FEEDS.map((n) => {
    const s = n === 'Coinbase' ? (isLive() ? 'live' : 'down') : off ? 'off' : liveFeed(n) ? 'live' : st[n]?.state || 'connecting';
    return `<span class="${s}">${n}</span>`;
  }), `<span class="${state.kalshiTapeAt && now - state.kalshiTapeAt < 15000 ? 'live' : 'connecting'}">Kalshi</span>`].join('');
  tape.rate = tape.rate.filter((t) => t > now - 60000);
  $('tapeRate').textContent = `${tape.rate.length} trades/min`;
  const tab = state.tapeTab;
  // Per-exchange split of the round (BTC) or the Kalshi contract's taker flow
  $('tapeEx').hidden = tab === 'kalshi'; $('kalshiFlow').hidden = tab !== 'kalshi';
  if (tab !== 'kalshi') {
    const by = byExchange(tape.ex);
    $('tapeEx').innerHTML = Object.entries(by).sort((a, b) => (b[1].buy + b[1].sell) - (a[1].buy + a[1].sell)).map(([n, e]) => {
      const tot = e.buy + e.sell, b = tot ? e.buy / tot : 0.5;
      return `<span>${n}</span><span class="bar" title="buy ${Math.round(b * 100)}%"><i style="width:${(b * 100).toFixed(0)}%"></i></span><em>${Math.round(b * 100)}% buy · ${usd(tot, 0)}</em>`;
    }).join('') || '<span class="muted">Waiting for trades this round…</span>';
  } else {
    const kf = kalshiFlow(tape.kalshi);
    $('kalshiFlow').innerHTML = `<div>UP (YES) bought<b>${Math.round(kf.YES.count).toLocaleString()}</b>${usd(kf.YES.usd, 0)}</div><div>DOWN (NO) bought<b>${Math.round(kf.NO.count).toLocaleString()}</b>${usd(kf.NO.usd, 0)}</div>`;
  }
  tape.list.sort((a, b) => b.t - a.t); // feeds arrive a little out of order; the tape reads newest first
  const rows = tape.list.filter((x) => (tab === 'all' ? true : tab === 'kalshi' ? x.kalshi : !x.kalshi)).slice(0, 40);
  const seen = state.tapeTop;
  state.tapeTop = rows[0];
  $('tape').innerHTML = rows.map((x, i) => {
    const fresh = seen && rows.indexOf(seen) > i ? ' new' : '';
    if (x.kalshi) return `<li class="kalshi ${x.side === 'YES' ? 'buy' : 'sell'}${fresh}"><time>${hms(x.t)}</time><span class="ex">Kalshi</span><span class="sd">${x.side === 'YES' ? 'UP' : 'DOWN'}</span><span>${Math.round(x.count).toLocaleString()} @ ${(x.price * 100).toFixed(0)}¢</span><span class="amt">${usd(x.usd, 0)}</span></li>`;
    return `<li class="${x.side}${x.whale ? ' whale' : ''}${fresh}"><time>${hms(x.t)}</time><span class="ex">${x.ex.replace('.US', '')}</span><span class="sd">${x.side === 'buy' ? 'BUY' : 'SELL'}</span><span>${x.size < 0.001 ? x.size.toFixed(5) : x.size.toFixed(4)} @${Math.round(x.price).toLocaleString()}</span><span class="amt">${x.whale ? '🐋 ' : ''}${usd(x.price * x.size, 0)}</span></li>`;
  }).join('') || `<li><span class="muted">${tab === 'kalshi' ? 'No Kalshi trades on this contract yet.' : 'Waiting for trades…'}</span></li>`;
}

function setTile(id, text, cls = '', sub = null) {
  const el = $(id); el.textContent = text; el.className = cls;
  if (sub != null) $(`${id}Sub`).textContent = sub;
}

function dataHealth(now) {
  const mAge = now - (state.marketsAt || 0), sAge = now - (state.spotAt || 0);
  if (!state.marketsAt || !state.spotAt) return ['STARTING', 'warn'];
  if (mAge > 30000 || sAge > 30000) return ['STALE', 'bad'];
  return [isLive() ? 'LIVE' : 'CURRENT', 'ok'];
}

function renderDeck(snap, live, sig, now) {
  // Status tiles
  const [health, hcls] = dataHealth(now);
  const ix = indexFresh() && state.index.used.length > 1 ? `index of ${state.index.used.length} exchanges` : 'Coinbase price';
  const feedsLive = ALL_FEEDS.filter((n) => (n === 'Coinbase' ? isLive() : state.feedStatus?.[n]?.state === 'live' && now - (state.feedStatus[n].lastAt || 0) < 120000)).length;
  setTile('stFeed', isLive() ? 'LIVE' : state.spotAt ? 'POLLING' : '…', isLive() ? 'ok' : 'warn', `${feedsLive}/${ALL_FEEDS.length} trade feeds · ${ix}`);
  setTile('stClock', new Date(now - (state.skewMs || 0)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }), '',
    state.skewMs == null ? 'server-synced' : Math.abs(state.skewMs) > 5000 ? `phone is ${Math.round(state.skewMs / 1000)}s off` : 'server-synced ✓');
  setTile('stContract', live ? live.m.ticker.replace(/^KXBTC15M-/, '') : 'none', live ? 'ok' : 'warn', live ? `closes in ${mmss(live.ev.minutesLeft)}` : 'between markets');
  const br = state.botRecord, st = br?.graded ? br : callStats(state.callLog);
  setTile('stRecord', st.graded ? `${st.wins}–${st.graded - st.wins}` : 'no calls yet', st.graded ? (st.wins / st.graded >= 0.8 ? 'ok' : 'warn') : '',
    st.graded ? `${Math.round((st.wins / st.graded) * 100)}% won${br?.graded ? ` · ${br.streak ? `${br.streak.kind}${br.streak.n} streak` : 'bot record'}` : ' on this phone'}` : 'graded at settlement');
  setTile('dataHealth', health, hcls);
  $('timeLeft').textContent = live ? mmss(live.ev.minutesLeft) : '—';
  const lf = live?.learnedAdj;
  $('learnedNow').textContent = !lf ? '—' : `vol ×${lf.volFactor.toFixed(2)}${lf.basis ? ` · basis ${lf.basis >= 0 ? '+' : '−'}$${Math.abs(lf.basis).toFixed(0)}` : ''}`;

  // Hold meter + Kalshi price boxes
  const q = live?.ev.quote;
  $('upAsk').textContent = q?.yesAsk != null ? `${(q.yesAsk * 100).toFixed(0)}¢` : '—';
  $('downAsk').textContent = q?.noAsk != null ? `${(q.noAsk * 100).toFixed(0)}¢` : '—';
  $('upBot').textContent = live?.ev.pYes != null ? `bot ${Math.round(live.ev.pYes * 100)}%` : '';
  $('downBot').textContent = live?.ev.pYes != null ? `bot ${Math.round((1 - live.ev.pYes) * 100)}%` : '';
  const conf = sig?.deep?.score ?? null, hold = sig?.hold ?? null;
  $('holdBox').hidden = conf == null;
  if (conf != null) {
    const flipRisk = hold == null ? null : Math.round((1 - hold) * 100);
    setTile('confBig', `${conf}`, conf >= 85 ? 'ok' : conf >= 70 ? 'warn' : 'bad');
    setTile('holdBig', hold == null ? '—' : `${Math.round(hold * 100)}%`, hold == null ? '' : hold >= 0.8 ? 'ok' : hold >= 0.6 ? 'warn' : 'bad');
    setTile('flipBig', flipRisk == null ? '—' : `${flipRisk}/100`, flipRisk == null ? '' : flipRisk <= 20 ? 'ok' : flipRisk <= 40 ? 'warn' : 'bad');
    $('holdFill').style.width = `${hold == null ? 0 : Math.round(hold * 100)}%`;
    $('holdNote').textContent = `${sig.side === 'YES' ? 'UP' : 'DOWN'} side · hold odds = chance confidence stays above ${Math.round(settings.holdFloor * 100)} until the last minute (300 simulated paths)${sig.locked ? ' · call locked' : ''}`;
  }

  // Tug of war
  const fs = flowStats(flow, now);
  const pr = pressureUpdate(flow, now);
  const buy = fs.nowBuyShare;
  $('tugBuy').textContent = buy == null ? '—' : `${(buy * 100).toFixed(1)}%`;
  $('tugSell').textContent = buy == null ? '—' : `${((1 - buy) * 100).toFixed(1)}%`;
  $('tugFill').style.width = `${buy == null ? 50 : (1 - buy) * 100}%`;
  $('tugMark').style.left = `calc(${buy == null ? 50 : (1 - buy) * 100}% - 1px)`;
  $('tugLead').textContent = buy == null ? '' : buy >= 0.6 ? 'BUYERS DOMINANT' : buy <= 0.4 ? 'SELLERS DOMINANT' : 'BALANCED';
  $('tugLead').className = buy == null ? '' : buy >= 0.6 ? 'pos' : buy <= 0.4 ? 'neg' : '';
  $('tugBull').classList.toggle('dom', buy != null && buy >= 0.55); // the winning side's animal steps up
  $('tugBear').classList.toggle('dom', buy != null && buy <= 0.45);
  $('tugNow').textContent = fs.nowUsd > 0 ? `Last 2 minutes: ${usd(fs.nowUsd, 0)} traded across ${feedsLive} exchange${feedsLive === 1 ? '' : 's'}${flow.pressure ? ` · sustained ${flow.pressure} pressure` : ''}` : 'Needs the live feeds (they open when the app is in front).';
  $('tugRound').textContent = fs.prints ? `${fs.net >= 0 ? '+' : '−'}${usd(Math.abs(fs.net), 0)}` : '—';
  $('tugRound').className = fs.net > 0 ? 'pos' : fs.net < 0 ? 'neg' : '';
  $('tugRoundSub').textContent = fs.prints ? `buy ${usd(fs.buyUsd, 0)} / sell ${usd(fs.sellUsd, 0)} · ${fs.prints} prints` : 'since the round opened';
  $('tugWhales').textContent = fs.whaleBuys + fs.whaleSells ? `${fs.whaleBuys} buy · ${fs.whaleSells} sell` : '—';
  $('tugWhaleSub').textContent = `trades ≥ ${usd(alerts.prefs().whaleMin, 0)}`;
  const fc = live ? floorCeiling(snap.bars, Date.parse(live.m.open_time)) : null, ms = modelSpot();
  $('floorDist').textContent = fc && ms ? usd(ms - fc.floor, 0) : '—';
  $('ceilDist').textContent = fc && ms ? usd(fc.ceiling - ms, 0) : '—';
  if (pr.flipped) alerts.event('pressure', `Pressure flipped: ${pr.side === 'buy' ? 'buyers' : 'sellers'} took over`, '60%+ of the last 2 minutes, held 10s');

  // Market events: round change (sit out), BTC crossing the target, flip warnings, feed health
  if (live) {
    const tk = live.m.ticker;
    if (state.deckTicker && state.deckTicker !== tk) {
      const prev = state.deckTicker;
      if (!state.callLog.some((e) => e.ticker === prev)) alerts.event('sitout', 'Sat out last round', `${prev}: no call met the bar`, `sit:${prev}`);
      addNote('info', `New round ${tk.replace(/^KXBTC15M-/, '')} · target ${usd(live.strike, 0)}`);
    }
    state.deckTicker = tk;
    const above = ms && live.strike ? ms > live.strike : null;
    if (above != null && state.deckAbove != null && state.deckAbove.tk === tk && state.deckAbove.v !== above) alerts.event('cross', `BTC crossed ${above ? 'above' : 'below'} the target`, `${usd(ms, 0)} vs ${usd(live.strike, 0)}`, `cross:${tk}`);
    if (above != null) state.deckAbove = { tk, v: above };
    const lean = leanSide(live.ev), called = sig?.called;
    if (sustained(watch, 'flip', !!called && !!lean && lean !== called && live.ev.minutesLeft > 0.5, now)) alerts.event('flip', `Flip warning: bot now leans ${lean === 'YES' ? 'UP' : 'DOWN'}`, `against the ${called === 'YES' ? 'UP' : 'DOWN'} call · held 10s`, `flip:${tk}`);
    const risky = !!called && hold != null && (1 - hold) * 100 >= alerts.prefs().flipRisk;
    if (sustained(watch, 'fliprisk', risky, now)) alerts.event('fliprisk', `High flip risk: ${Math.round((1 - hold) * 100)}/100`, `hold odds ${Math.round(hold * 100)}% on the ${called === 'YES' ? 'UP' : 'DOWN'} call`, `fliprisk:${tk}`);
  }
  const down = hcls === 'bad';
  if (state.feedDown == null) state.feedDown = down;
  else if (down !== state.feedDown) { state.feedDown = down; alerts.event(down ? 'feedDown' : 'feedUp', down ? 'Live data lost' : 'Live data back', down ? 'prices are more than 30s old; calls paused until they refresh' : 'prices are fresh again'); }

  renderSuggestions(snap, live, sig, now);
  renderTape();

  // The chart's trend (EMA 9 vs 21 on 1-minute closes): when it turns and holds 15s, the bull or bear charges in
  const cl = snap.bars.map((b) => b.c), f9 = ema(cl, 9), f21 = ema(cl, 21);
  const tNow = f9.at(-1) != null && f21.at(-1) != null ? (f9.at(-1) >= f21.at(-1) ? 'bull' : 'bear') : null;
  const turn = trendTurn(trendState, tNow, now);
  if (turn) {
    const p = alerts.prefs();
    if (p.trendAnim && !p.quiet) fx.charge(turn);
    alerts.event(turn === 'bull' ? 'trendBull' : 'trendBear', turn === 'bull' ? 'Chart turned bull' : 'Chart turned bear', `EMA 9 crossed ${turn === 'bull' ? 'above' : 'below'} EMA 21 at ${usd(cl.at(-1), 0)}`);
  }

  // Live notes
  const head = live && sig?.deep ? `BTC ${usd(Math.abs((ms || 0) - live.strike), 0)} ${(ms || 0) >= live.strike ? 'above' : 'below'} target · bot leans ${leanSide(live.ev) === 'YES' ? 'UP' : 'DOWN'} · confidence ${sig.deep.score}${hold != null ? ` · flip risk ${Math.round((1 - hold) * 100)}/100` : ''}${buy != null ? ` · ${buy >= 0.5 ? 'buyers' : 'sellers'} ${(Math.max(buy, 1 - buy) * 100).toFixed(0)}% of flow` : ''}` : '';
  $('notesWhen').textContent = `updated ${clock(now)}`;
  $('notes').innerHTML = (head ? `<li><time>now</time><span>${esc(head)}</span></li>` : '') +
    state.notes.slice(0, 12).map((n) => `<li class="${noteClass(n.key)}"><time>${clock(n.t)}</time><span>${esc(n.text)}</span></li>`).join('');
  if ($('view-chart').classList.contains('active')) drawChartTab();
}

// ---------- suggestions: confident buys, buy light, sell high (public/suggest.js) ----------
function renderSuggestions(snap, live, sig, now) {
  const items = [];
  const e = live && live.ev.minutesLeft > 0 ? suggestEntry(sig, live.ev, settings) : { kind: 'none' };
  const el = $('suggest');
  el.hidden = !live || e.kind === 'none';
  if (!el.hidden) {
    el.className = `suggest ${e.kind}`;
    const size = e.contracts && e.price ? ` · ${dollars(e.contracts * e.price)}${e.kind === 'light' ? ' (light)' : ''}` : '';
    $('sugTitle').textContent = `${e.title}${size}`; $('sugWhy').textContent = e.why;
    if (e.kind !== 'wait') items.push({ kind: e.kind, label: e.kind === 'confident' ? 'CONFIDENT BUY' : e.kind === 'light' ? 'BUY LIGHT' : 'BUY', text: `${e.side === 'YES' ? 'UP' : 'DOWN'} at ${pc(e.price)}${size}`, why: e.why });
    // a light buy is worth one heads-up per round and side
    if (e.kind === 'light') alerts.event('light', e.title, e.why, `light:${live.m.ticker}:${e.side}`);
  }
  for (const pos of state.positions) {
    const c = state.posChecks?.[pos.id];
    if (!c) continue;
    const x = suggestExit(c.ex);
    if (x.kind === 'none' || x.kind === 'settle') continue;
    const label = { sellHigh: 'SELL HIGH', bail: 'BAIL', watch: 'WATCH', hold: 'HOLD' }[x.kind];
    items.push({ kind: x.kind, label, text: `${pos.side === 'YES' ? 'UP' : 'DOWN'} from ${pc(pos.price)}${c.bid != null ? ` · sells at ${pc(c.bid)}` : ''}${c.ex.pnl != null ? ` (${money(c.ex.pnl)})` : ''}`, why: x.kind === 'hold' ? `Worth ${pc(c.pSide)} to the bot; holding beats selling now.` : x.why });
  }
  $('sugCard').hidden = !items.length;
  $('sugWhen').textContent = items.length ? clock(now) : '';
  $('sugList').innerHTML = items.map((i) => `<li class="${i.kind}"><b>${i.label}</b><span>${esc(i.text)}<small>${esc(i.why)}</small></span></li>`).join('');
}

// ---------- Chart tab ----------
const chartState = { tf: store.get('chartTf', 'round'), show: { ...chartDefaults(), ...store.get('chartShow', {}) }, cache: {}, drawnAt: 0 };
function buildChartControls() {
  $('tfBtns').innerHTML = Object.entries(TIMEFRAMES).map(([k, t]) => `<button data-tf="${k}" class="${chartState.tf === k ? 'on' : ''}">${t.label}</button>`).join('');
  $('chartToggles').innerHTML = CHART_TOGGLES.map(([k, label]) => `<label><input type="checkbox" data-show="${k}" ${chartState.show[k] ? 'checked' : ''}>${esc(label)}</label>`).join('');
}
$('tfBtns').addEventListener('click', (e) => { const k = e.target.dataset.tf; if (!k) return; chartState.tf = k; store.set('chartTf', k); buildChartControls(); drawChartTab(true); });
$('chartToggles').addEventListener('change', (e) => { const k = e.target.dataset.show; if (!k) return; chartState.show[k] = e.target.checked; store.set('chartShow', chartState.show); drawChartTab(true); });
async function chartBars(tf) {
  const T = TIMEFRAMES[tf];
  if (T.gran === 60) return state.candles;
  const c = chartState.cache[tf];
  if (c && Date.now() - c.at < 60000) return c.bars;
  if (!chartState.loading) {
    chartState.loading = true;
    getJSON(`coinbase/products/BTC-USD/candles?granularity=${T.gran}`).then((rows) => {
      const bars = parseCandles(rows);
      chartState.cache[tf] = { at: Date.now(), bars: T.combine > 1 ? aggregate(bars, (T.gran / 60) * T.combine) : bars };
      drawChartTab(true);
    }).catch(() => {}).finally(() => { chartState.loading = false; });
  }
  return c?.bars ?? [];
}
async function drawChartTab(force = false) {
  const now = Date.now();
  if (!force && now - chartState.drawnAt < 1000) return;
  chartState.drawnAt = now;
  if (!$('tfBtns').children.length) buildChartControls();
  const tf = chartState.tf, T = TIMEFRAMES[tf];
  const snap = compute(), live = snap.live;
  let bars = await chartBars(tf);
  const open = live ? Date.parse(live.m.open_time) : null, close = live ? Date.parse(live.m.close_time) : null;
  if (T.gran === 60) bars = withLive(bars, now);
  // Indicators warm up on all the history; the chart shows the round (plus 10 minutes before it), or the last 60 / 120 bars
  const viewFrom = tf === 'round' && open ? open - 10 * 60000 : bars[Math.max(0, bars.length - (tf === '1m' ? 60 : 120))]?.t;
  const sigma = live?.sigma ?? snap.sigmaMin, spot = modelSpot();
  const showCone = (tf === 'round' || tf === '1m') && live;
  const markers = state.callLog.filter((e) => e.at).map((e) => ({ t: e.at, side: e.side, label: `${e.side === 'YES' ? 'UP' : 'DN'} ${e.conf ?? ''}` }));
  drawPro($('proChart'), $('rsiChart'), $('macdChart'), bars, {
    strike: live?.strike, openTime: open, closeTime: close, spot, round: tf === 'round' || tf === '1m',
    cone: showCone ? forecastCone(spot, sigma, now, close) : [], markers, show: chartState.show, barMs: T.gran * 1000 * T.combine, viewFrom,
  });
}
// 1-minute candles with the live price folded into the current minute
function withLive(bars, now) {
  if (!bars.length || !state.spot) return bars;
  const t = Math.floor(now / 60000) * 60000, last = bars[bars.length - 1], s = state.spot;
  if (last.t === t) return [...bars.slice(0, -1), { ...last, c: s, h: Math.max(last.h, s), l: Math.min(last.l, s) }];
  return [...bars, { t, o: last.c, h: Math.max(last.c, s), l: Math.min(last.c, s), c: s, v: 0 }];
}

function render() {
  state.renderedAt = Date.now();
  state.clock = null;
  const snap = compute();
  const { now, bars, sigmaMin, driftMin, rows, live } = snap;
  renderPositions(snap);
  const sig = live ? buySignal(live, snap, settings, now, state.calls) : null;
  if (sig?.fire) store.set('calls', state.calls);
  trackRule(snap, live, now);
  renderDeep(live, sig);
  state.liveCall = sig?.callSide ? { ...live, sig } : null;
  const showBuy = !!state.liveCall && !state.positions.some((p) => p.ticker === live.m.ticker);
  $('boughtBtn').hidden = !showBuy || !!state.kalshi.key; // linked: buys arrive from Kalshi on their own
  $('autoNote').hidden = !showBuy || !state.kalshi.key;
  const card = $('callCard'), callEl = $('call'), entry = $('entry');
  card.className = 'card call-card';
  entry.className = 'entry';
  let timing = null;

  if (!live) {
    $('marketTitle').textContent = state.marketsAt ? `No open ${settings.series} markets` : 'Loading markets…';
    callEl.textContent = '—'; callEl.className = 'call pass';
    ['countdown', 'reason', 'order', 'entry', 'callLabel', 'odds'].forEach((id) => { $(id).textContent = ''; });
    entry.hidden = true;
  } else {
    const { m, ev, strike } = live;
    const { side, buyNow } = sig;
    const call = sig.callSide; // a low price that passed the robust-edge and deep-dive checks (or a call it's sticking with)
    timing = sig.timing;
    const limit = side && timing.dipLevel ? dipLimit({ market: m, strike, spot: state.spot, dipLevel: timing.dipLevel, sigmaMin, driftMin, side, now, settings }) : null;

    $('marketTitle').textContent = m.title || m.ticker;
    $('countdown').textContent = `closes in ${mmss(ev.minutesLeft)}`;
    const waitingToCall = ev.callsAt && now < ev.callsAt;
    state.clock = { close: Date.parse(m.close_time), callsAt: waitingToCall ? ev.callsAt : null };
    if (waitingToCall && sig.deep) { // a read on the window, not a call yet
      $('conf').className = 'conf';
      $('conf').textContent = `Preview · confidence ${sig.deep.score} · no call yet`;
    }
    const otherSide = sig.called === 'YES' ? 'NO' : 'YES';
    const sticking = sig.stance === 'holding' && now - (sig.calledAt ?? now) > 60000; // the first minute of a call is just the call
    $('reason').textContent = call && sig.sticking && sig.locked ? `Steady: the call is locked for this round. Confidence now ${sig.deep?.score ?? '—'}${sig.hold != null ? `, stays above ${Math.round(settings.holdFloor * 100)} to the end in ${Math.round(sig.hold * 100)}% of paths` : ''}.`
      : call && sig.sticking ? `${sideName(otherSide)} looks a little better this tick, but not by enough to drop the call. Sticking with it.`
      : call && sticking ? 'Called earlier and still a buy: one tick of movement isn\'t a reason to change.'
      : call ? '' : waitingToCall ? `Calls start in ${mmss((ev.callsAt - now) / 60000)} (bot watches the first ${settings.waitMinutes} min)`
      : sig.cooldown ? `Just sold on this market. A fresh call can come in ${sig.cooldown}s if the gap is still there.`
      : sig.called && sig.stance === 'holding' ? `Called ${sideName(sig.called)} earlier. That edge has faded, so no new buy; if you're in, the position card says when to sell.`
      : sig.called && sig.stance === 'switching' && ev.side ? `Called ${sideName(sig.called)} earlier. ${sideName(ev.side)} looks cheap now, but switching needs a ${(sig.edgeNeed * 100).toFixed(0)}-pt gap and confidence ${sig.confNeed}.`
      : ev.side && settings.doubleRejRule !== false && live.rej?.double && live.rej.double.dir !== (ev.side === 'YES' ? 1 : -1) ? `${sideName(ev.side)} looks cheap, but not calling it: ${live.rej.double.label}`
      : ev.side && sig.robust && sig.deep && sig.deep.score >= sig.confNeed && !sig.holdOk ? `Confidence ${sig.deep.score}, but it stays above ${Math.round(settings.holdFloor * 100)} to the end in only ${sig.hold == null ? '—' : Math.round(sig.hold * 100)}% of simulated paths (Steady needs ${Math.round(settings.minHold * 100)}%). Waiting for a call that holds.`
      : ev.side && sig.robust && sig.deep && sig.deep.score >= sig.confNeed && !sig.steadyOk ? `Confidence ${sig.deep.score}: making sure it holds for ${settings.steadySec}s before calling (one good tick isn't enough).`
      : ev.side && !sig.robust ? `Low price, but the gap drops to ${sig.robustEdge == null ? '—' : (sig.robustEdge * 100).toFixed(1)} pts if volatility is a bit off (need ${(sig.edgeNeed * 100).toFixed(0)})`
      : ev.side ? `Low price, but confidence ${sig.deep?.score ?? '—'} is below ${sig.confNeed}` : ev.reason;
    $('odds').innerHTML = oddsRows(ev, settings.minEdge);

    // Call + entry timing
    const waiting = call && !buyNow && settings.waitForDip;
    $('callLabel').textContent = call ? (waiting ? 'Low price, waiting for candle dip' : sig.stance === 'switching' ? 'SWITCH · BUY THE LOW' : sticking ? 'BUY THE LOW · sticking with it' : 'BUY THE LOW')
      : sig.called ? `Called ${sig.called} earlier · no new buy`
      : waitingToCall ? `Watching the first ${settings.waitMinutes} minutes` : sig.cooldown ? 'Just sold · re-entry soon' : ev.side && !sig.robust ? 'Low price, edge too thin'
      : ev.side && sig.deep && sig.deep.score >= sig.confNeed && !(sig.holdOk && sig.steadyOk) ? 'Low price, not steady yet' : ev.side ? 'Low price, not confident' : 'No low price';
    callEl.textContent = call ? (call === 'YES' ? 'UP' : 'DOWN') : 'SIT OUT';
    callEl.className = `call ${(call ?? 'pass').toLowerCase()}`;
    $('callSub').textContent = call && strike ? `BTC ${call === 'YES' ? 'above' : 'below'} ${usd(strike, 0)} at close` : '';
    if (call) card.classList.add(call.toLowerCase());
    if (waiting) card.classList.add('waiting');

    entry.hidden = !side;
    if (side) {
      const label = timing.state === 'NOW' ? `Candles: dip now, good timing for ${side}` : timing.state === 'CHASE' ? 'Candles: chasing, price just ran' : `Candles: no dip yet for ${side}`;
      entry.classList.add(timing.state.toLowerCase());
      entry.innerHTML = `<b>${label}</b><span>${esc(timing.reasons.slice(0, 4).join(' · '))}</span>` +
        (limit && timing.state !== 'NOW' ? `<span>Even lower: limit ${sideName(side)} at <b>${pc(limit.price)}</b> if BTC hits ${usd(limit.dipLevel, 0)}</span>` : '');
    }

    if (!call) $('order').textContent = '';
    else if (buyNow || !settings.waitForDip) {
      const age = sig.calledAt ? Math.round((now - sig.calledAt) / 1000) : 0;
      $('order').textContent = `Buy ${dollars(sig.contracts * sig.price)} at ${pc(sig.price)} ${sideName(call)}` +
        `${sig.limit ? ` · max ${pc(sig.limit)}, skip if higher` : ''} · +${(sig.edge * 100).toFixed(0)} pts edge${age >= 5 ? ` · called ${age}s ago` : ''}`;
    }
    else $('order').textContent = limit ? `Limit ${dollars(sig.contracts * limit.price)} at ${pc(limit.price)} ${sideName(call)} (now ${pc(sig.price)})` : 'Hold off: no dip yet';

    // Record + alert: right away, or only on a confirmed low when waiting for the dip
    if (sig.fire) {
      if (logCall(state.callLog, { ticker: m.ticker, side: call, price: sig.price, conf: sig.deep?.score, at: now, closeTime: m.close_time, n: sig.callN })) store.set('callLog', state.callLog);
      const key = `${m.ticker}:${call}:${sig.callN}`;
      if (!state.alerted[key]) {
        state.alerted[key] = true;
        if (settings.notifyBuy) alert(buyMessage(live, sig, state.spot), 'buy', { ticker: m.ticker });
        if (alerts.prefs().lockAnim && !alerts.prefs().quiet) fx.lockIn({ side: call, conf: sig.deep?.score, hold: sig.hold, price: sig.price, confident: (sig.deep?.score ?? 0) >= 90 && (sig.hold ?? 0) >= 0.9 });
        alerts.event('call', `Call: ${call === 'YES' ? 'UP' : 'DOWN'} at ${pc(sig.price)}`, `confidence ${sig.deep?.score ?? '—'}${sig.hold != null ? ` · hold odds ${Math.round(sig.hold * 100)}%` : ''} · target ${usd(strike, 0)}`, key, Date.now(), callSound(call));
      }
    }
    // Aggressive scale-in: tell people who hold the call that the gap grew
    if (sig.add) {
      store.set('calls', state.calls);
      const key = `add:${m.ticker}:${sig.tier}`;
      if (state.positions.some((p) => p.ticker === m.ticker && p.side === call) && !state.alerted[key]) {
        state.alerted[key] = true;
        if (settings.notifyBuy) alert(addMessage(live, sig, state.spot), 'add', { ticker: m.ticker });
      }
    }

    $('strike').textContent = usd(strike);
    const d = modelSpot() && strike ? modelSpot() - strike : null;
    $('dist').textContent = d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)} (${((d / strike) * 100).toFixed(2)}%)`;
    sign($('dist'), d);
    drawChart(bars, strike, Date.parse(m.open_time), timing, limit, live.rej);
  }
  renderDeck(snap, live, sig, now);

  $('spot').textContent = usd(state.spot);
  renderTicker(live?.strike ?? null);
  $('vol').textContent = sigmaMin ? `${(sigmaMin * 100).toFixed(3)}%` : '—';
  const r = timing?.rsi;
  $('rsi').textContent = r == null ? '—' : r.toFixed(0);
  $('rsi').className = r == null ? '' : r < 35 ? 'pos' : r > 65 ? 'neg' : '';
  $('levels').textContent = timing?.support ? `${Math.round(timing.support).toLocaleString()} / ${Math.round(timing.resistance).toLocaleString()}` : '—';

  $('others').innerHTML = rows.filter((x) => x !== live && x.ev.minutesLeft > 0).slice(0, 6).map(({ m, ev }) =>
    `<div class="card mini"><span>${esc(m.yes_sub_title || m.ticker)}<br><small>${mmss(ev.minutesLeft)} · bot ${pct(ev.pYes)} YES</small></span>` +
    `<span class="pill ${ev.call.toLowerCase()}">${ev.call}</span></div>`).join('');
  renderHistory();
}

// ---------- candlestick chart ----------
function drawChart(allBars, strike, openTime, timing, limit, rej) {
  const cv = $('chart'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 220, axis = 52;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bars = allBars.slice(-40);
  if (bars.length < 2) return;

  const marks = patterns(allBars).filter((p) => p.t >= bars[0].t && p.t + 60000 <= Date.now());
  const ys = bars.flatMap((b) => [b.h, b.l]);
  if (strike) ys.push(strike);
  if (limit?.dipLevel) ys.push(limit.dipLevel);
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.08 || 1;
  const Y = (v) => h - 14 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (h - 28);
  const slot = (w - axis) / bars.length, bw = Math.max(2, slot * 0.6);
  const X = (i) => i * slot + slot / 2;

  // Current window shading
  const openIdx = bars.findIndex((b) => b.t >= openTime);
  if (openIdx >= 0) { ctx.fillStyle = '#38bdf80d'; ctx.fillRect(X(openIdx) - slot / 2, 0, w - axis - X(openIdx) + slot / 2, h); }

  const hline = (v, color, dash, text) => {
    if (v == null) return;
    ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(0, Y(v)); ctx.lineTo(w - axis, Y(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '10px system-ui'; ctx.fillText(text, w - axis + 4, Y(v) + 3);
  };
  hline(timing?.support, '#22c55e88', [2, 3], 'support');
  hline(timing?.resistance, '#ef444488', [2, 3], 'resist');
  hline(strike, '#cbd5e1', [5, 4], 'strike');
  if (limit?.dipLevel && timing?.state !== 'NOW') hline(limit.dipLevel, '#facc15', [1, 2], 'buy low');

  // Candles
  bars.forEach((b, i) => {
    const up = b.c >= b.o, x = X(i);
    ctx.strokeStyle = ctx.fillStyle = up ? '#22c55e' : '#ef4444';
    ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
    const top = Y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(Y(b.o) - Y(b.c)));
    ctx.fillRect(x - bw / 2, top, bw, bh);
  });

  // Pattern markers: ▲ under bullish reversals, ▼ over bearish ones
  ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  marks.forEach((p) => {
    const i = bars.findIndex((b) => b.t === p.t);
    if (i < 0) return;
    ctx.fillStyle = p.dir > 0 ? '#22c55e' : '#ef4444';
    ctx.fillText(p.dir > 0 ? '▲' : '▼', X(i), p.dir > 0 ? Math.min(h - 2, Y(bars[i].l) + 12) : Math.max(10, Y(bars[i].h) - 4));
  });
  // Rejection markers: ✕ at the wick tip that got rejected
  (rej?.events || []).forEach((e) => {
    const i = bars.findIndex((b) => b.t === e.t);
    if (i < 0) return;
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 11px system-ui';
    ctx.fillText('✕', X(i), e.dir < 0 ? Math.max(10, Y(e.price) - 6) : Math.min(h - 2, Y(e.price) + 14));
  });
  ctx.textAlign = 'start';

  // Last price tag
  const last = bars[bars.length - 1].c;
  ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 10px system-ui';
  ctx.fillText(Math.round(last).toLocaleString(), w - axis + 4, Math.min(h - 4, Math.max(10, Y(last) + 3)));
}

function renderHistory() {
  const tp = state.trades.reduce((a, t) => a + t.pnl, 0), tw = state.trades.filter((t) => t.pnl > 0).length;
  $('tPnl').textContent = state.trades.length ? money(tp) : '—';
  sign($('tPnl'), tp);
  $('tWins').textContent = state.trades.length ? `${tw}/${state.trades.length}` : '—';
  $('tradeList').innerHTML = state.trades.slice(0, 50).map((t) =>
    `<li><span><b>${dollars(t.contracts * t.price)}</b> at ${pc(t.price)} ${sideName(t.side)} → ${t.how === 'settled' ? (t.exit ? 'won at close' : 'lost at close') : `sold at ${pc(t.exit)}`}` +
    `<small>bought ${clock(t.at)} → ${t.how === 'settled' ? 'settled' : 'sold'} ${clock(t.closedAt)} · ${esc(t.ticker)}</small></span><b class="${t.pnl >= 0 ? 'pos' : 'neg'}">${money(t.pnl)}</b></li>`).join('') ||
    '<li><span class="muted">Tap "I bought it" on a call to track a trade and get sell signals.</span></li>';
  renderRecord();
  renderMemory();
}

// What the bot has learned about the market (from the server, which watches every window around the clock)
function renderMemory() {
  const st = state.memory?.status;
  if (!st) { $('memSummary').textContent = 'Not loaded yet. The server learns the market around the clock and shares it here.'; return; }
  const days = st.since ? Math.max(1, Math.round((Date.now() - st.since) / 86400000)) : 0;
  const lines = [];
  lines.push(st.minutes ? `Watched BTC for ${days} day${days === 1 ? '' : 's'} (${st.minutes.toLocaleString()} one-minute moves)${st.backfilling ? ', still reading history' : ''}, graded ${st.windows.toLocaleString()} window${st.windows === 1 ? '' : 's'}.` : 'Just started watching the market.');
  if (st.busiest) lines.push(`Busiest half hour: ${slotLabel(st.busiest.slot)} (${st.busiest.x.toFixed(1)}× normal volatility). Quietest: ${slotLabel(st.quietest.slot)} (${st.quietest.x.toFixed(1)}×).`);
  if (st.nowFactor && Math.abs(st.nowFactor - 1) >= 0.05) lines.push(`Right now the coming minutes are usually ${st.nowFactor > 1 ? 'busier' : 'calmer'} than the last half hour (×${st.nowFactor.toFixed(2)}), and the odds account for it.`);
  if (indexFresh() && state.index.used.length > 1) lines.push(`Price: median of ${state.index.used.join(', ')} (Kalshi settles on a multi-exchange index; right now it's ${state.index.offset >= 0 ? '+' : '−'}$${Math.abs(state.index.offset).toFixed(2)} vs Coinbase).`);
  lines.push(st.basisN >= 10 ? `Kalshi's settlement index vs Coinbase: ${st.basis >= 0 ? '+' : '−'}$${Math.abs(st.basis).toFixed(2)} (middle of the last ${st.basisN} settlements), included in the odds.` : `Learning the gap between Coinbase and Kalshi's settlement index: ${st.basisN} of 10 settlements.`);
  if (settings.learn === false) lines.push('Off in Settings: the bot isn\'t using any of this right now.');
  $('memSummary').textContent = lines.join(' ');
  // Weekday volatility by half hour (New York time)
  const prof = st.profile;
  if (prof) {
    const day = [...Array(48).keys()].map((h) => { const xs = [1, 2, 3, 4, 5].map((d) => prof[d * 48 + h]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; });
    const max = Math.max(...day, 1e-9);
    $('memBars').innerHTML = day.map((x, h) => `<i style="height:${Math.max(4, (x / max) * 100)}%" title="${slotLabel(48 + h).slice(4)}: ${x.toFixed(2)}×"></i>`).join('');
    $('memBarsWrap').hidden = false;
  }
  const rows = (st.calibration || []).filter((b) => b.n >= 20);
  $('memCal').innerHTML = rows.map((b) => `<li><span><b>Said ${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%</b><small>${b.n} window${b.n === 1 ? '' : 's'} · won ${Math.round(b.won * 100)}%${b.shift ? ` · corrected ${b.shift > 0 ? '+' : '−'}${(Math.abs(b.shift) * 100).toFixed(1)} pts` : ' · no correction needed'}</small></span></li>`).join('');
}

// ---------- the official bot record (server: every call it made, around the clock) ----------
async function refreshBotRecord() {
  try { state.botRecord = await getJSON('record'); state.botRecordAt = Date.now(); renderBotRecord(); } catch { /* next time */ }
}
setInterval(() => { if (!document.hidden) refreshBotRecord(); }, 60000);
function renderBotRecord() {
  const r = state.botRecord;
  if (!r) return;
  const losses = r.graded - r.wins, pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  $('brLevel').textContent = `${r.level} settings`;
  $('brWL').textContent = r.graded ? `${r.wins}–${losses}` : '0–0';
  $('brPct').textContent = pctOf(r.wins, r.graded);
  $('brPct').className = !r.graded ? '' : r.wins / r.graded >= 0.8 ? 'pos' : r.wins / r.graded < 0.6 ? 'neg' : '';
  $('brStreak').textContent = r.streak ? `${r.streak.kind}${r.streak.n}` : '—';
  $('brStreak').className = r.streak?.kind === 'W' ? 'pos' : r.streak?.kind === 'L' ? 'neg' : '';
  const since = r.since ? new Date(r.since).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;
  $('brSub').textContent = !r.calls.length ? 'No calls yet. The bot calls on its own around the clock (Steady settings), and every call shows up here, win or lose.'
    : `Every call the bot made${since ? ` since ${since}` : ''}, around the clock, graded against Kalshi's result. It said ${r.said != null ? Math.round(r.said) : '—'}% on average and won ${pctOf(r.wins, r.graded)}. $10 on every call, held to settlement: ${money(r.usd)}. Best win streak: ${r.bestWin}.` +
      `${r.graded < 30 ? ' Under 30 graded calls is too early to judge: luck still dominates.' : ''}`;
  const days = dailyRecord(r.calls, 14), top = Math.max(1, ...days.map((d) => d.w + d.l));
  $('brDays').innerHTML = days.map((d) => `<div title="${d.day}: ${d.w} won, ${d.l} lost"><i class="w" style="height:${(d.w / top) * 100}%"></i><i class="l" style="height:${(d.l / top) * 100}%"></i></div>`).join('');
  $('brBuckets').innerHTML = ['90+', '80–89', '70–79', 'under 70'].filter((k) => r.buckets?.[k]).map((k) => {
    const b = r.buckets[k];
    return `<li><span><b>Confidence ${k}</b><small>${b.calls} call${b.calls > 1 ? 's' : ''} · said ${Math.round(b.said)}% · won ${pctOf(b.wins, b.calls)}</small></span><b class="${b.usd >= 0 ? 'pos' : 'neg'}">${money(b.usd)}</b></li>`;
  }).join('');
  const now = Date.now();
  $('brCalls').innerHTML = r.calls.slice(-12).reverse().map((e) => {
    const up = e.side === 'YES', graded = e.result === 'yes' || e.result === 'no', won = graded && e.side.toLowerCase() === e.result;
    const badge = graded ? (won ? '<span class="badge win">WIN</span>' : '<span class="badge loss">LOSS</span>') : e.result === 'unknown' ? '<span class="badge">VOID</span>' : Date.parse(e.closeTime) > now ? '<span class="badge live">LIVE</span>' : '<span class="badge">SETTLING</span>';
    const when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<li><img src="${up ? 'bull' : 'bear'}.svg" alt=""><span><b>${up ? 'UP' : 'DOWN'} at ${pc(e.price)}</b><small>${when} · confidence ${e.conf ?? '—'}${e.hold != null ? ` · hold ${Math.round(e.hold * 100)}%` : ''}</small></span>${badge}</li>`;
  }).join('') || '<li><span></span><span class="muted">The first call will show up here.</span><span></span></li>';
}

// The bot's call record: what it claimed (confidence = win odds) next to how often its calls really won
function renderRecord() {
  const st = callStats(state.callLog);
  const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  $('recSummary').textContent = !st.calls ? 'No calls yet. Every BUY THE LOW call the bot makes while the app is open is logged here and graded when Kalshi settles it.'
    : !st.graded ? `${st.calls} call${st.calls > 1 ? 's' : ''} logged, waiting for Kalshi to settle them.`
    : `${st.graded} call${st.graded > 1 ? 's' : ''} graded${st.calls > st.graded ? ` (${st.calls - st.graded} waiting for Kalshi)` : ''}: won ${st.wins} (${pctOf(st.wins, st.graded)})${st.said != null ? `, the bot said ${Math.round(st.said)}% on average` : ''}. $10 on every call, held to settlement: ${money(st.usd)}.${st.graded < 30 ? ' Under 30 calls is too few to judge: luck still dominates.' : ''}`;
  const order = ['90+', '80–89', '70–79', 'under 70'];
  $('recBuckets').innerHTML = order.filter((k) => st.buckets[k]).map((k) => {
    const b = st.buckets[k];
    return `<li><span><b>Confidence ${k}</b><small>${b.calls} call${b.calls > 1 ? 's' : ''} · said ${Math.round(b.said)}% · won ${pctOf(b.wins, b.calls)}</small></span><b class="${b.usd >= 0 ? 'pos' : 'neg'}">${money(b.usd)}</b></li>`;
  }).join('');
}

// ---------- live BTC price ----------
// Streams every trade from Coinbase's public WebSocket. Falls back to polling if it drops.
const LIVE_WS = 'wss://ws-feed.exchange.coinbase.com';
let ws = null, wsRetry = 0, wsTimer = null, renderQueued = false, shownSpot = null, flashTimer = null;
const isLive = () => !!state.liveAt && Date.now() - state.liveAt < 10000;

function liveConnect() {
  if (ws || document.hidden || typeof WebSocket === 'undefined') return;
  try { ws = new WebSocket(LIVE_WS); } catch { ws = null; return; }
  ws.onopen = () => {
    wsRetry = 0;
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat', 'matches'] }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'heartbeat') { state.liveAt = Date.now(); return; }
    if (m.type === 'match') { handleTrades(parseCoinbase(m).filter(Boolean)); return; }
    if (m.type !== 'ticker' || !m.price) return;
    state.spot = Number(m.price); state.spotAt = Date.now();
    state.open24h = Number(m.open_24h) || state.open24h;
    state.liveAt = Date.now();
    queueRender();
  };
  ws.onclose = () => {
    ws = null; state.liveAt = 0;
    clearTimeout(wsTimer);
    if (!document.hidden) wsTimer = setTimeout(liveConnect, Math.min(30000, 1000 * 2 ** wsRetry++));
  };
  ws.onerror = () => ws?.close();
}
function liveDisconnect() { clearTimeout(wsTimer); if (ws) { ws.onclose = null; ws.close(); ws = null; } state.liveAt = 0; }

// Price ticks arrive many times a second; redraw at most 4 times a second.
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 250);
}

function renderTicker(strike) {
  const live = isLive(), spot = state.spot;
  $('liveBadge').textContent = live ? 'LIVE' : spot ? 'DELAYED' : '…';
  $('liveBadge').className = `tk-badge ${live ? 'live' : ''}`;
  $('livePrice').textContent = spot ? `BTC ${usd(spot)}` : 'BTC —';
  if (spot && shownSpot && spot !== shownSpot) {
    const el = $('ticker');
    el.classList.remove('up', 'down');
    void el.offsetWidth; // restart the flash animation
    el.classList.add(spot > shownSpot ? 'up' : 'down');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('up', 'down'), 600);
  }
  shownSpot = spot;
  const day = spot && state.open24h ? spot - state.open24h : null;
  $('liveMove').textContent = day == null ? '' : `24h ${day >= 0 ? '+' : '-'}${usd(Math.abs(day), 0)} (${((day / state.open24h) * 100).toFixed(2)}%)`;
  $('liveMove').className = `tk-move ${day > 0 ? 'pos' : day < 0 ? 'neg' : ''}`;
  const d = spot && strike ? modelSpot() - strike : null;
  $('liveTarget').textContent = d == null ? '' : `${d >= 0 ? '▲' : '▼'} ${usd(Math.abs(d), 0)} ${d >= 0 ? 'above' : 'below'} target${indexFresh() && state.index.used.length > 1 ? ` · index of ${state.index.used.length} exchanges` : ''}`;
  $('liveTarget').className = `tk-target ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`;
}

// ---------- push notifications ----------
// The server runs the same bot and sends Web Push, so alerts arrive with the app closed.
// iPhone needs iOS 16.4+ and the app opened from the Home Screen.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
let pushSub = null, syncTimer = null;

async function postJSON(path, body) {
  const r = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  paywalled(r);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// Subscribe with the server's current key (resubscribing if the server's key changed).
async function subscribe(reg) {
  const { publicKey } = await getJSON('push/key');
  let sub = await reg.pushManager.getSubscription();
  if (sub && store.get('pushKey', null) !== publicKey) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  store.set('pushKey', publicKey);
  return sub;
}

async function pushSync() {
  if (!pushSub) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; // so update times show in local time
  await postJSON('push/sync', { subscription: pushSub.toJSON(), settings, positions: state.positions, tz });
  state.pushOn = true;
}
function pushSyncSoon() {
  if (!pushSub) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushSync().catch((e) => console.warn('push sync', e)), 800);
}

async function pushInit() {
  try {
    if (pushSupported() && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker.ready;
      if (await reg.pushManager.getSubscription()) { pushSub = await subscribe(reg); await pushSync(); }
    }
  } catch (e) { console.warn('push init', e); }
  renderPush();
}

async function pushEnable() {
  if ((await Notification.requestPermission()) !== 'granted') return renderPush('Notifications are blocked. Allow them for Shot Caller in your phone\'s Settings → Notifications.');
  pushSub = await subscribe(await navigator.serviceWorker.ready);
  await pushSync();
  renderPush();
}

async function pushDisable() {
  if (pushSub) {
    await postJSON('push/unsubscribe', { endpoint: pushSub.endpoint }).catch(() => {});
    await pushSub.unsubscribe().catch(() => {});
  }
  pushSub = null; state.pushOn = false;
  renderPush();
}

function renderPush(msg) {
  const on = !!pushSub && !!state.pushOn;
  let text = msg;
  if (!text && !pushSupported()) {
    text = isIOS && !standalone
      ? 'On iPhone: tap Share → Add to Home Screen, open Shot Caller from your Home Screen, then turn on notifications here.'
      : 'This browser doesn\'t support push notifications.';
  }
  if (!text) text = on ? 'On ✓ BUY THE LOW and SELL NOW alerts arrive even with the app closed.' : 'Off. Alerts only show while the app is open.';
  $('pushStatus').textContent = text;
  $('pushStatus').classList.toggle('on', on && !msg);
  $('pushOn').hidden = on || !pushSupported();
  $('pushTest').hidden = !on;
  $('pushOff').hidden = !on;
  $('pushNudge').hidden = on || store.get('nudgeDismissed', false);
}

// ---------- access & admin ----------
const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
let adminTimer = null;

// Remember this phone's code and signed pass so access survives a cleared cookie or a server reset.
function rememberAccess(st) {
  try {
    if (st.code) localStorage.setItem('sc_code', st.code);
    if (st.pass) localStorage.setItem('sc_pass', st.pass);
  } catch { /* storage blocked */ }
}

async function loadAccess() {
  try {
    const st = await getJSON('access/status');
    state.access = st;
    rememberAccess(st);
    $('accessLine').textContent = st.role === 'admin' ? 'Admin (no expiry)'
      : st.access ? `Active until ${day(st.expires)} · code ${st.code} (use it to unlock your other devices)`
      : 'No access';
    $('adminCard').hidden = st.role !== 'admin';
    $('adminLogin').hidden = st.role === 'admin';
    if (st.role === 'admin') loadAdmin();
  } catch { /* offline */ }
}

async function loadAdmin() {
  try {
    const { config, members } = await getJSON('admin/members');
    if (document.activeElement !== $('admPrice')) $('admPrice').value = config.price;
    if (document.activeElement !== $('admDays')) $('admDays').value = config.days;
    const now = Date.now();
    const pending = members.filter((m) => m.status === 'pending' || (m.paidAt && m.paidAt > (m.approvedAt || 0) && m.status !== 'denied' && m.status !== 'revoked'));
    const others = members.filter((m) => !pending.includes(m) && m.status !== 'pending');
    $('admPending').innerHTML = pending.map((m) => `<li><span><b>${m.code}</b><small>${m.paidAt ? `says paid ${clock(m.paidAt)} · ${day(m.paidAt)}` : 'hasn\'t tapped "I\'ve paid" yet'}${m.expires > now ? ' · renewing' : ''}</small></span>
      <span class="adm-btns"><button data-adm="approve" data-code="${m.code}">Approve</button><button data-adm="deny" data-code="${m.code}" class="ghost">Deny</button></span></li>`).join('') ||
      '<li class="muted">Nobody waiting. You\'ll get a push when someone taps "I\'ve paid" (turn on notifications).</li>';
    $('admMembers').innerHTML = others.map((m) => {
      const active = m.status === 'active' && m.expires > now;
      const label = active ? `active until ${day(m.expires)}` : m.status === 'active' ? `expired ${day(m.expires)}` : m.status;
      return `<li><span><b>${m.code}</b><small>${label} · ${m.devices} device${m.devices === 1 ? '' : 's'}</small></span>
        <span class="adm-btns">${active ? `<button data-adm="approve" data-code="${m.code}" class="ghost">+${state.access?.days ?? ''}d</button><button data-adm="revoke" data-code="${m.code}" class="ghost">Revoke</button>` : `<button data-adm="approve" data-code="${m.code}">Approve</button>`}</span></li>`;
    }).join('') || '<li class="muted">No members yet.</li>';
  } catch (e) { $('admErr').textContent = e.message; }
}

async function adminAction(action, body) {
  $('admErr').textContent = '';
  try { await postJSON(`admin/${action}`, body); await loadAdmin(); }
  catch (e) { $('admErr').textContent = e.message; }
}
$('adminCard').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-adm]');
  if (!b) return;
  if (b.dataset.adm === 'revoke' && !confirm(`Revoke ${b.dataset.code}? They lose access right away.`)) return;
  adminAction(b.dataset.adm, { code: b.dataset.code });
});
$('admApprove').addEventListener('click', () => { if ($('admCode').value.trim()) adminAction('approve', { code: $('admCode').value }).then(() => { $('admCode').value = ''; }); });
$('admSave').addEventListener('click', () => adminAction('config', { price: $('admPrice').value, days: $('admDays').value }).then(loadAccess));
$('adminLogin').addEventListener('click', async () => {
  const code = prompt('Admin code');
  if (!code) return;
  try { rememberAccess(await postJSON('access/admin', { code, device: localStorage.getItem('sc_device') })); location.reload(); }
  catch (e) { window.alert(e.message); }
});
$('signOut').addEventListener('click', async () => {
  if (!confirm('Sign out on this device? You\'ll need your code (or the admin code) to get back in.')) return;
  try { localStorage.removeItem('sc_pass'); localStorage.removeItem('sc_code'); } catch { /* storage blocked */ }
  await fetch(`${API}/access/logout`, { method: 'POST', body: '{}' }).catch(() => {});
  location.reload();
});
function adminPolling(on) {
  clearInterval(adminTimer);
  if (on && state.access?.role === 'admin') adminTimer = setInterval(loadAdmin, 20000);
}

// ---------- settings ----------
function buildSettings() {
  $('settingsForm').innerHTML = SETTINGS_META.map(([k, label, hint, kind]) => {
    if (kind === 'bool') return `<label><span>${label}<small>${hint}</small></span><input type="checkbox" name="${k}" ${settings[k] ? 'checked' : ''}></label>`;
    const v = kind === 'cents' ? Math.round(settings[k] * 1000) / 10 : settings[k];
    return `<label><span>${label}<small>${hint}</small></span><input name="${k}" ${kind === 'text' ? '' : 'inputmode="decimal"'} value="${esc(v)}"></label>`;
  }).join('');
  $('settingsForm').addEventListener('change', (e) => {
    const meta = SETTINGS_META.find((x) => x[0] === e.target.name);
    if (!meta) return;
    const [k, , , kind] = meta;
    if (kind === 'bool') settings[k] = e.target.checked;
    else if (kind === 'text') settings[k] = e.target.value.trim().toUpperCase();
    else {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) return;
      settings[k] = kind === 'cents' ? n / 100 : n;
    }
    store.set('settings', settings);
    pushSyncSoon();
    if (k === 'series') { state.marketsAt = 0; state.markets = []; }
    if (k === 'refreshSec') schedule();
    if (k === 'multiFeeds') feedsOn();
    render();
  });
}

// ---------- loop ----------
let timer;
async function tick() {
  try {
    const jobs = isLive() ? [] : [refreshSpot()];
    if (Date.now() - state.candlesAt > 20000) jobs.push(refreshCandles());
    if (!(Date.now() - (state.memory?.at || 0) < 10 * 60000) && !state.memoryBusy) { state.memoryBusy = true; refreshMemory().catch(() => {}).finally(() => { state.memoryBusy = false; }); }
    const closed = state.markets.length && Date.parse(state.markets[0].close_time) < Date.now();
    if (Date.now() - state.marketsAt > settings.refreshSec * 1000 || closed) jobs.push(refreshMarkets());
    refreshIndex().catch(() => { state.index = null; }); // optional: without it the bot uses Coinbase alone
    await Promise.all(jobs);
    $('status').className = 'dot ok';
    $('status').title = 'connected';
    settlePositions();
  } catch (e) {
    console.warn(e);
    $('status').className = 'dot err';
    $('status').title = e.message;
  }
  render();
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(tick, Math.max(2, settings.refreshSec) * 1000);
}

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button, .view').forEach((el) => el.classList.remove('active'));
  b.classList.add('active');
  $(`view-${b.dataset.view}`).classList.add('active');
  if (b.dataset.view === 'settings') loadAccess();
  if (b.dataset.view === 'chart') drawChartTab(true);
  if (b.dataset.view === 'alerts') alerts.render();
  if (b.dataset.view === 'history') refreshBotRecord();
  adminPolling(b.dataset.view === 'settings');
}));
$('status').addEventListener('click', () => window.alert($('status').title || 'connecting…'));
$('pushOn').addEventListener('click', () => pushEnable().catch((e) => renderPush(`Couldn't turn on push: ${e.message}`)));
$('pushOff').addEventListener('click', () => pushDisable());
$('pushTest').addEventListener('click', async () => {
  $('pushTest').textContent = 'Sending…';
  try { await postJSON('push/test', { endpoint: pushSub.endpoint }); $('pushTest').textContent = 'Sent ✓'; }
  catch (e) { $('pushTest').textContent = 'Send test'; renderPush(`Test failed: ${e.message}`); }
  setTimeout(() => { $('pushTest').textContent = 'Send test'; }, 3000);
});
$('nudgeGo').addEventListener('click', () => document.querySelector('nav button[data-view=settings]').click());
$('nudgeX').addEventListener('click', () => { store.set('nudgeDismissed', true); renderPush(); });
$('boughtBtn').addEventListener('click', () => {
  const live = state.liveCall;
  if (!live) return;
  const at = Date.now();
  const { m } = live, side = live.sig.callSide;
  const q = quote(state.markets.find((x) => x.ticker === m.ticker) ?? m); // freshest prices, locked at this tap
  const price = side === 'YES' ? q.yesAsk : q.noAsk;
  if (!price) return toast(`No Kalshi price for ${sideName(side)} right now`);
  const amount = settings.tradeAmount > 0 ? settings.tradeAmount : live.sig.contracts * price;
  const pos = openPosition(m, side, price, amount / price, at);
  toast(`Tracking ${dollars(amount)} at ${pc(price)} ${sideName(side)} · ${clock(at)}`, () => removePosition(pos.id));
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' }); // the new position card is at the top
});
$('positions').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const pos = state.positions.find((p) => p.id === btn.dataset.id);
  if (!pos) return;
  if (btn.dataset.act === 'remove') {
    if (confirm('Stop tracking this position? It won\'t be added to your trades.')) { removePosition(pos.id); render(); }
    return;
  }
  // One tap: cash out the whole position at Kalshi's live price
  const at = Date.now();
  const m = state.markets.find((x) => x.ticker === pos.ticker);
  const q = m ? quote(m) : {};
  const bid = pos.side === 'YES' ? q.yesBid : q.noBid;
  if (!bid) return toast(`No Kalshi cash-out price for ${sideName(pos.side)} right now`);
  const trade = closePosition(pos, bid, 'sold', at);
  toast(`Sold at ${pc(bid)} · ${clock(at)} · ${money(trade.pnl)}`, () => {
    state.trades = state.trades.filter((t) => t !== trade);
    store.set('trades', state.trades);
    state.positions.push(pos);
    savePositions();
    pushSyncSoon();
  });
  render();
});
function removePosition(id) {
  state.positions = state.positions.filter((p) => p.id !== id);
  savePositions();
  pushSyncSoon();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) liveDisconnect();
  else { liveConnect(); tick(); }
  feedsOn();
});
// Between polls only the clocks move, so update just those each second (a full redraw every second
// cost the most phone battery). Full redraw if no poll or price tick has rendered for ~3 seconds,
// and when the opening wait ends so the call appears right on time.
function tickClocks() {
  const now = Date.now(), c = state.clock;
  if (!document.hidden && now - bootAt > 20000 && healthDue(state.health?.at, now)) runHealth();
  if (now - (state.renderedAt || 0) > 2900 || (c?.callsAt && now >= c.callsAt) || (c && now >= c.close)) return render();
  if (c) {
    $('countdown').textContent = `closes in ${mmss((c.close - now) / 60000)}`;
    if (c.callsAt) $('reason').textContent = `Calls start in ${mmss((c.callsAt - now) / 60000)} (bot watches the first ${settings.waitMinutes} min)`;
  }
  for (const el of document.querySelectorAll('.pos-clock')) {
    const left = (Number(el.dataset.close) - now) / 60000;
    el.textContent = left > 0 ? mmss(left) : 'closed';
  }
}
setInterval(tickClocks, 1000);

// Pick up new deploys: check for a new service worker on open and reload once it takes over.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

// ---------- Kalshi account link (read-only) ----------
// The API key is kept in IndexedDB as a non-extractable CryptoKey: usable for signing, never readable.
const idb = (mode, fn) => new Promise((resolve, reject) => {
  const open = indexedDB.open('shot-caller', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { resolve(req?.result); open.result.close(); };
    tx.onerror = () => { reject(tx.error); open.result.close(); };
  };
});
const kalshiMarkets = {}; // ticker -> { close_time, title } for markets that are no longer listed as open
let kalshiPrefix = null, kalshiBusy = false;

async function kalshiGet(endpoint, params = {}) {
  const { key, keyId } = state.kalshi;
  if (!key) throw new Error('Kalshi not linked');
  kalshiPrefix ||= (await getJSON('kalshi-auth/info')).pathPrefix;
  const headers = await signHeaders(key, keyId, 'GET', kalshiPrefix + endpoint);
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  const r = await fetch(`${API}/kalshi-auth/${endpoint}${q ? `?${q}` : ''}`, { headers });
  paywalled(r);
  const body = await r.json().catch(() => ({}));
  if (r.status === 403) throw new Error('Kalshi rejected the key. Check the key ID and private key, or make a new key on Kalshi.');
  if (!r.ok) throw new Error(body.error?.message || body.error || `Kalshi: HTTP ${r.status}`);
  return body;
}

async function marketInfo(ticker) {
  const open = state.markets.find((x) => x.ticker === ticker);
  if (open) return open;
  if (!kalshiMarkets[ticker]) kalshiMarkets[ticker] = (await getJSON(`kalshi/markets/${encodeURIComponent(ticker)}`)).market;
  return kalshiMarkets[ticker];
}

// Pull new fills for this series and turn them into positions (buys) and trades (sales), exactly as filled.
async function syncKalshi() {
  if (!state.kalshi.key || kalshiBusy) return;
  kalshiBusy = true;
  try {
    const seen = new Set(store.get('kalshiSeen', []));
    const since = store.get('kalshiSince', Math.floor(Date.now() / 1000) - 24 * 3600); // first link: the last 24 hours
    const fills = [];
    let cursor = null, pages = 0;
    do { // read every page (it used to stop at 5 and could skip fills for good)
      const page = await kalshiGet('fills', { min_ts: since, limit: 200, cursor });
      fills.push(...(page.fills || []).map(parseFill));
      cursor = page.cursor || null;
    } while (cursor && ++pages < 50);
    const complete = !cursor;
    const mine = fills.filter((f) => f.ticker.startsWith(`${settings.series}-`) && !seen.has(f.id) && f.at);
    if (mine.length) {
      const linked = state.positions.filter((p) => p.source === 'kalshi');
      const holdings = Object.fromEntries(linked.map((p) => [p.ticker, { side: p.side, contracts: p.contracts, price: p.price, at: p.at, fees: p.fees ?? null }]));
      const { holdings: next, closes } = foldFills(holdings, mine);
      for (const c of closes) {
        const pos = state.positions.find((p) => p.source === 'kalshi' && p.ticker === c.ticker);
        if (pos) closePosition({ ...pos, price: c.entry }, c.exit, 'sold', c.at, Math.min(c.contracts, pos.contracts), c.fees); // contracts left are set from `next` below
      }
      state.positions = state.positions.filter((p) => !(p.source === 'kalshi' && !next[p.ticker]));
      for (const [ticker, h] of Object.entries(next)) {
        let pos = state.positions.find((p) => p.source === 'kalshi' && p.ticker === ticker);
        if (!pos) {
          const m = await marketInfo(ticker).catch(() => null);
          if (!m?.close_time) continue; // can't place it on the clock yet; retried next sync (fill stays unseen)
          // Kalshi's record replaces a manual "I bought it" tap on the same market
          state.positions = state.positions.filter((p) => p.ticker !== ticker);
          pos = { id: `k-${ticker}`, source: 'kalshi', ticker, title: m.title, closeTime: m.close_time, peakBid: null, peakP: null };
          state.positions.push(pos);
        }
        Object.assign(pos, { side: h.side, contracts: h.contracts, price: h.price, at: h.at, fees: h.fees ?? null });
      }
      const placed = new Set(state.positions.map((p) => p.ticker));
      for (const f of mine) if (placed.has(f.ticker) || !next[f.ticker]) seen.add(f.id);
      store.set('kalshiSeen', [...seen].slice(-2000));
      savePositions();
      store.set('trades', state.trades);
      pushSyncSoon();
      const n = mine.length;
      toast(`Kalshi: ${n} new fill${n === 1 ? '' : 's'} synced`);
    }
    // Next time, start from the newest fill, or from the oldest one we couldn't place yet so it's retried
    const waiting = mine.filter((f) => !seen.has(f.id)).map((f) => f.at);
    const newest = waiting.length ? Math.min(...waiting) : Math.max(0, ...fills.map((f) => f.at || 0));
    if (newest && complete) store.set('kalshiSince', Math.max(since, Math.floor(newest / 1000) - 5));
    await checkAgainstKalshi(); // Kalshi's own settlements and positions: the source of truth
    state.kalshi.lastSync = Date.now(); state.kalshi.error = null;
    if (!state.kalshi.balanceAt || Date.now() - state.kalshi.balanceAt > 60000) {
      state.kalshi.balance = balanceDollars(await kalshiGet('balance')); state.kalshi.balanceAt = Date.now();
    }
  } catch (e) {
    state.kalshi.error = e.message;
  } finally {
    kalshiBusy = false;
    renderKalshi();
    render();
  }
}

// ---------- 100% accuracy: Kalshi's own records win ----------
// Settlements close linked positions at Kalshi's settlement; the positions list corrects anything the fills missed.
async function checkAgainstKalshi() {
  const asOf = Date.now(), fixes = [];
  // 1) settlements for linked positions whose market has closed
  const closed = state.positions.filter((p) => p.source === 'kalshi' && Date.parse(p.closeTime) < asOf);
  if (closed.length) {
    try {
      const out = await kalshiGet('settlements', { min_ts: Math.floor(Math.min(...closed.map((p) => Date.parse(p.closeTime))) / 1000) - 3600, limit: 200 });
      const byTicker = new Map((out.settlements || []).map(parseSettlement).map((s) => [s.ticker, s]));
      for (const pos of closed) {
        const s = byTicker.get(pos.ticker);
        if (!s || (s.result !== 'yes' && s.result !== 'no')) continue;
        closePosition(pos, pos.side.toLowerCase() === s.result ? 1 : 0, 'settled', s.at || asOf, pos.contracts, pos.fees ?? null);
        toast(`Kalshi settled ${pos.ticker}: ${pos.side} ${pos.side.toLowerCase() === s.result ? 'won' : 'lost'}`);
      }
    } catch { /* tried again next sync */ }
  }
  // 2) positions: Kalshi's list wins
  try {
    const out = await kalshiGet('positions', { count_filter: 'position', limit: 200 });
    if (!Array.isArray(out.market_positions)) throw new Error('unexpected reply from Kalshi'); // never read a bad reply as "no positions"
    const truth = out.market_positions.map(parsePosition);
    const r = reconcilePositions(state.positions, truth, { series: settings.series, asOf });
    for (const x of r.set) { const p = state.positions.find((q) => q.source === 'kalshi' && q.ticker === x.ticker); if (p) { Object.assign(p, { side: x.side, contracts: x.contracts, price: x.price }); if (x.why.includes('→') && !x.why.includes('¢')) p.fees = null; fixes.push(`${x.ticker}: ${x.why}`); } }
    for (const x of r.remove) { state.positions = state.positions.filter((q) => !(q.source === 'kalshi' && q.ticker === x.ticker)); fixes.push(`${x.ticker}: ${x.why}`); }
    for (const x of r.add) {
      const m = await marketInfo(x.ticker).catch(() => null);
      if (!m?.close_time || x.price == null) continue;
      state.positions = state.positions.filter((p) => p.ticker !== x.ticker);
      state.positions.push({ id: `k-${x.ticker}`, source: 'kalshi', ticker: x.ticker, title: m.title, closeTime: m.close_time, side: x.side, contracts: x.contracts, price: x.price, at: asOf, fees: null, peakBid: null, peakP: null });
      fixes.push(`${x.ticker}: ${x.why}`);
    }
    state.kalshi.verify = { at: Date.now(), positions: truth.filter((k) => k.ticker.startsWith(`${settings.series}-`) && k.contracts > 0).length, fixes };
    if (fixes.length) { state.kalshi.lastFix = { at: Date.now(), fixes }; savePositions(); store.set('trades', state.trades); pushSyncSoon(); toast(`Corrected from Kalshi: ${fixes[0]}${fixes.length > 1 ? ` (+${fixes.length - 1} more)` : ''}`); }
  } catch (e) { state.kalshi.verify = { at: Date.now(), error: e.message, fixes }; }
}

function renderKalshi() {
  const k = state.kalshi, linked = !!k.key;
  $('kForm').hidden = linked;
  $('kLinked').hidden = !linked;
  $('kErr').textContent = k.error || '';
  if (!linked) return;
  const bal = k.balance != null ? ` · balance ${dollars(k.balance)}` : '';
  const last = k.lastSync ? ` · synced ${clock(k.lastSync)}` : ' · syncing…';
  const v = k.verify;
  const check = !v ? '' : v.error ? ` · couldn't check against Kalshi (${v.error})`
    : v.fixes.length ? ` · corrected from Kalshi at ${clock(v.at)}: ${v.fixes.join('; ')}`
    : ` · ✓ matches Kalshi (${v.positions} open position${v.positions === 1 ? '' : 's'}, checked ${clock(v.at)})${k.lastFix && Date.now() - k.lastFix.at < 3600000 ? ` · last correction ${clock(k.lastFix.at)}: ${k.lastFix.fixes.join('; ')}` : ''}`;
  $('kStatus').textContent = `Linked (key ${k.keyId.slice(0, 8)}…)${bal}${last}${check}. Your ${settings.series} buys and sells show up on their own.`;
}

async function loadKalshi() {
  try {
    const saved = await idb('readonly', (st) => st.get('kalshi'));
    if (saved?.key && saved?.keyId) { state.kalshi.key = saved.key; state.kalshi.keyId = saved.keyId; syncKalshi(); }
  } catch { /* private mode etc: linking just isn't available */ }
  renderKalshi();
}

$('kFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) $('kPem').value = await f.text();
  e.target.value = '';
});
$('kLink').addEventListener('click', async () => {
  const keyId = $('kKeyId').value.trim(), pem = $('kPem').value;
  $('kErr').textContent = '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(keyId)) { state.kalshi.error = 'Enter the API key ID from Kalshi'; return renderKalshi(); }
  $('kLink').textContent = 'Linking…';
  try {
    const key = await importKey(pem);
    state.kalshi = { key, keyId };
    state.kalshi.balance = balanceDollars(await kalshiGet('balance')); // proves the key works before saving it
    state.kalshi.balanceAt = Date.now();
    await idb('readwrite', (st) => st.put({ key, keyId }, 'kalshi'));
    $('kPem').value = ''; $('kKeyId').value = '';
    store.set('kalshiSince', Math.floor(Date.now() / 1000) - 24 * 3600);
    toast('Kalshi linked');
    syncKalshi();
  } catch (e) {
    state.kalshi = { key: null, keyId: null, error: e.message };
  } finally {
    $('kLink').textContent = 'Link account';
    renderKalshi();
  }
});
$('kSync').addEventListener('click', () => { state.kalshi.balanceAt = 0; syncKalshi(); });
$('kUnlink').addEventListener('click', async () => {
  if (!confirm('Unlink Kalshi? The key is deleted from this phone. Positions already synced stay.')) return;
  await idb('readwrite', (st) => st.delete('kalshi')).catch(() => {});
  state.kalshi = { key: null, keyId: null };
  store.set('kalshiSeen', []); store.set('kalshiSince', null);
  for (const p of state.positions) if (p.source === 'kalshi') delete p.source; // keep tracking them by hand
  savePositions();
  renderKalshi(); render();
});
setInterval(() => { if (!document.hidden) syncKalshi(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncKalshi(); });


function renderRisk() {
  const cur = riskLevelOf(settings);
  $('riskBtns').innerHTML = Object.entries(RISK_LEVELS).map(([k, r]) => `<button type="button" data-risk="${k}" class="${cur === k ? 'on' : ''}">${r.label}</button>`).join('');
  $('riskHint').textContent = cur === 'custom'
    ? `Custom: min gap ${(settings.minEdge * 100).toFixed(0)} pts, confidence ${settings.minConfidence}. Tap a level to reset.`
    : `${RISK_LEVELS[cur].hint}. Calls need a gap of ${(RISK_LEVELS[cur].minEdge * 100).toFixed(0)} pts and confidence ${RISK_LEVELS[cur].minConfidence}${RISK_LEVELS[cur].bigEdgeOverride ? ` (or a ${Math.round(RISK_LEVELS[cur].bigEdgeOverride * 100)}-pt worst-case gap)` : ''}; bets up to $${RISK_LEVELS[cur].maxStake}.`;
}
$('riskBtns').addEventListener('click', (e) => {
  const k = e.target.closest('button[data-risk]')?.dataset.risk;
  if (!k) return;
  const r = RISK_LEVELS[k];
  Object.assign(settings, riskSettings(k));
  store.set('settings', settings);
  for (const [name, v] of [['minEdge', r.minEdge * 100], ['minConfidence', r.minConfidence], ['kellyFraction', r.kellyFraction], ['maxStake', r.maxStake], ['cutMargin', r.cutMargin * 100]]) { const el = $('settingsForm').elements[name]; if (el) el.value = v; }
  pushSyncSoon(); renderRisk(); render();
  toast(`Risk level: ${r.label}`);
});
$('settingsForm').addEventListener('change', () => setTimeout(renderRisk)); // after the form's own handler saves the value


// ---------- scorecard for the two-rejections rule (is it right on real markets?) ----------
function trackRule(snap, live, now) {
  const log = state.ruleLog;
  const d = live?.rej?.double;
  if (d && snap.spot && !log.some((e) => e.ticker === live.m.ticker && e.at === d.at)) {
    log.push({ ticker: live.m.ticker, dir: d.dir, level: Math.round(d.price), at: d.at, seenAt: now, spot0: snap.spot, closeTime: live.m.close_time, spot5: null, result: null });
    if (log.length > 300) log.splice(0, log.length - 300);
    store.set('ruleLog', log);
  }
  let changed = false;
  for (const e of log) if (e.spot5 == null && snap.spot && now - e.seenAt >= 5 * 60000 && now - e.seenAt < 7 * 60000) { e.spot5 = snap.spot; changed = true; }
  if (changed) store.set('ruleLog', log);
}
// Kalshi results for the scorecards (two-rejections rule and the call record), a few markets per pass
async function settleLogs() {
  const now = Date.now();
  const tickers = new Map();
  for (const e of state.ruleLog) if (!e.result && Date.parse(e.closeTime) < now - 90000) tickers.set(e.ticker, e.closeTime);
  for (const e of unsettledCalls(state.callLog, now)) tickers.set(e.ticker, e.closeTime);
  for (const [ticker, closeTime] of [...tickers].slice(0, 3)) {
    try {
      const { market } = await getJSON(`kalshi/markets/${encodeURIComponent(ticker)}`);
      let result = market?.result === 'yes' || market?.result === 'no' ? market.result : null;
      if (!result && Date.parse(closeTime) < now - 6 * 3600000) result = 'unknown'; // voided or never reported
      if (!result) continue;
      for (const e of state.ruleLog) if (e.ticker === ticker && !e.result) e.result = result;
      const graded = state.callLog.filter((e) => e.ticker === ticker && !e.result);
      settleCalls(state.callLog, ticker, result);
      for (const e of graded) if (result === 'yes' || result === 'no') {
        const won = e.side.toLowerCase() === result;
        alerts.event(won ? 'win' : 'loss', `Call ${won ? 'WON' : 'lost'}: ${e.side === 'YES' ? 'UP' : 'DOWN'}`, `${ticker} settled ${result.toUpperCase()} · bot said ${e.conf ?? '—'}`, `${won ? 'win' : 'loss'}:${ticker}`);
      }
      store.set('ruleLog', state.ruleLog); store.set('callLog', state.callLog);
    } catch { /* next time */ }
  }
}
function ruleStats(log) {
  const five = log.filter((e) => e.spot5 != null && e.spot5 !== e.spot0);
  const settled = log.filter((e) => e.result === 'yes' || e.result === 'no');
  return { fired: log.length, five: five.length, right5: five.filter((e) => (e.spot5 - e.spot0) * e.dir > 0).length,
    settled: settled.length, won: settled.filter((e) => (e.result === 'yes') === (e.dir > 0)).length };
}
setInterval(() => { if (!document.hidden) settleLogs(); }, 30000);
function renderRuleScore() {
  const rs = ruleStats(state.ruleLog);
  $('ruleScore').textContent = rs.fired ? `Two-rejections rule scorecard: fired ${rs.fired} time${rs.fired > 1 ? 's' : ''} · price went the expected way 5 min later ${rs.right5} of ${rs.five} · the side it favored won ${rs.won} of ${rs.settled} settled` : 'Two-rejections rule scorecard: hasn\'t fired yet (it\'s scored on every market while the app is open)';
}

// ---------- health check (every 2 rounds) ----------
const bootAt = Date.now();
// Is the server's data kept across deploys? (for the admin's health check)
async function refreshStorage() {
  try { const r = await fetch('healthz'); state.storagePersistent = (await r.json())?.storage?.persistent ?? null; } catch { /* offline */ }
}
function runHealth(manual = false) {
  if (state.access?.role === 'admin' && state.storagePersistent === undefined) { state.storagePersistent = null; refreshStorage().then(() => runHealth(manual)); return; }
  const now = Date.now();
  const items = healthCheck({
    now, marketsAt: state.marketsAt, candlesAt: state.candlesAt, spotAt: state.spotAt, streaming: isLive(), skewMs: state.skewMs ?? null,
    noMarket: !!state.marketsAt && !state.markets.some((m) => Date.parse(m.close_time) > now),
    linked: !!state.kalshi.key, balanceAt: state.kalshi.balanceAt, kalshiError: state.kalshi.error, balance: state.kalshi.balance,
    pushSupported: 'PushManager' in window, pushOn: !!state.pushOn,
    admin: state.access?.role === 'admin', storagePersistent: state.storagePersistent,
  });
  const fresh = newProblems(state.health?.items, items);
  state.health = { at: now, items };
  renderHealth();
  if (fresh.length) {
    toast(`Health check: ${fresh[0].label}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`);
    // A local notification even with push on: the server can't see these problems
    if ('Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.getRegistration().then((reg) => reg?.showNotification('Shot Caller health check', { body: fresh.map((r) => r.label).join(' · '), tag: 'health', icon: 'icon.svg' })).catch(() => {});
    }
  } else if (manual) toast(items.some((r) => r.level !== 'ok') ? 'Health check done: see Settings' : 'Health check: all good');
}
function renderHealth() {
  const h = state.health;
  if (!h) return;
  const bad = h.items.filter((r) => r.level !== 'ok');
  const next = (Math.floor(h.at / 1800000) + 1) * 1800000;
  $('healthStatus').textContent = `${bad.length ? `${bad.length} problem${bad.length > 1 ? 's' : ''}` : 'All good'} · checked ${clock(h.at)} · next ${clock(next)} (every 2 rounds)`;
  $('healthList').innerHTML = [...bad, ...h.items.filter((r) => r.level === 'ok')].map((r) =>
    `<li class="${r.level}"><b>${r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✕'}</b><span>${esc(r.label)}${r.fix ? `<small>${esc(r.fix)}</small>` : ''}</span></li>`).join('');
  renderRuleScore();
}
$('healthRun').addEventListener('click', () => runHealth(true));
buildSettings(); // (v5.0 cleanup dropped these two: the settings form and risk buttons were blank)
renderRisk();
if (store.get('steadyNote', false)) { store.set('steadyNote', false); setTimeout(() => toast('New default: Steady. Calls only when confidence is 85+ and likely to hold all round. Change it in Settings → Risk level.'), 1500); }
loadKalshi();
try { sessionStorage.removeItem('sc_restore'); } catch { /* the app loaded, so any restore worked: re-arm the paywall's auto sign-in */ }
loadAccess();
liveConnect();
feedsOn();
refreshBotRecord();
pushInit();
tick();
schedule();
