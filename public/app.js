import { DEFAULTS, EXIT_DEFAULTS, OFFICIAL_LEVEL, RISK_LEVELS, dipLimit, kalshiFee, quote, riskLevelOf, riskSettings, setFeeRates } from './model.js';
import { patterns } from './candles.js';
import { addMessage, buyMessage, buySignal, leanSide, parseCandles, positionCheck, releaseCall, sellMessage, sideName, snapshot } from './engine.js';
import { TIMEFRAMES, aggregate, floorCeiling } from './indicators.js';
import { CHART_TOGGLES, chartDefaults, createImpact } from './chart.js';
import { explainMove } from './why.js';
import { createSplit } from './split.js';
import { createTvChart } from './tvchart.js';
import { addTrade, flowStats, newFlow, pressureUpdate } from './flow.js';
import { byExchange, createAligner, createFeeds, feedNames, kalshiFlow, parseCoinbase, parseKalshiTrades } from './feeds.js';
const ALL_FEEDS_FOR = () => (CRYPTO ? feedNames(MKT.sym) : []);
import { callSound, feedWatch, sustained } from './alerts.js';
import { createAlertCenter } from './alertui.js';
import { createFx, trendTurn } from './fx.js';
import { suggestEntry, suggestExit } from './suggest.js';
import { ema } from './indicators.js';
import { confTier, stability } from './analysis.js';
import { createAutopilot } from './autopilot.js';
import { CHECKPOINTS, FEATURES, FEATURE_NAMES, GLOBAL_SCAN, MIN_SAMPLES, SCAN_EXCHANGES, checkpointFor, featureVector, fmtK, scanChance, scanRound } from './roundscan.js';
import { LINE_NAMES, blendBand, blendFit, blendScore, coneRecord, correctLines, expectedPath, marketCone, pathMinutes, pathRecord, pathTurns, predictionLines, predictionRecord, scaleLines } from './predict.js';
import { flipForecast, flipRecord, turnBaseRate, turnHappened } from './flip.js';
import { radarRead, radarRecord, scopeIdle, scopeSvg, SCOPE } from './radar.js';
import { accuracyReport, accuracyRows } from './accuracy.js';
import { withGuard } from './winguard.js';
import { dailyLoss, profitGuard } from './profitguard.js';
import { successMap } from './success.js';
import { ASSETS, HOME as HOME_MARKET, SEEDS, isHome, label as marketLabel, listed, marketOf, roundName, storeKey } from './markets.js';
import { structureRead } from './structure.js';
import { DRV, chartSvg, explain as explainDrivers, moveText } from './drivers.js';
import { lessonsNow } from './lessons.js';
import { PICK, pickFallback, pickNow } from './pick.js';
import { cushionHistory, cushionRead, sessions, settlementWatch, span } from './settle.js';
import { VERDICTS, signalBoard } from './signals.js';
import { patternsNow } from './chartpatterns.js';
import { answer as askAnswer, englishVoices, factsForAI, parseWake, pickVoice, speechChunks } from './ask.js';
import { balanceDollars, foldFills, importKey, parseFill, parsePosition, parseSettlement, reconcilePositions, signHeaders } from './kalshi.js';
import { allowAlert } from './notify.js';
import { healthCheck, healthDue, newProblems } from './health.js';
import { callStats, dailyRecord, logCall, settleCalls, unsettledCalls } from './record.js';
import { slotLabel } from './learner.js';
window.SC_BOOT = '197'; // this code's build: index.html reloads with fresh files if it doesn't match its SC_BUILD

const API = './api';
const $ = (id) => document.getElementById(id);
// Writes that skip when nothing changed: re-setting the same HTML or text still makes the phone re-lay-out the page
// (and restarts CSS animations inside it), several times a second
function setHTML(el, html) { if (el && el.__h !== html) { el.innerHTML = html; el.__h = html; el.__t = undefined; return true; } return false; }
function setText(el, text) {
  const t = String(text ?? '');
  if (!el || el.__t === t) return false;
  const was = el.__t; el.textContent = t; el.__t = t; el.__h = undefined;
  return was !== undefined; // true when it changed (not the first write)
}
function setClass(el, cls) { if (el && el.className !== cls) el.className = cls; }
function setHidden(el, on) { on = !!on; if (el && el.hidden !== on) el.hidden = on; }
function setStyle(el, prop, v) { if (el && el.__s?.[prop] !== v) { (el.__s ||= {})[prop] = v; el.style[prop] = v; } }
// One bounce on an element whose value just changed (Web Animations, so re-rendering its classes can't cut it off)
function pop(el) {
  if (!el?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  el.animate([{ transform: 'scale(.7)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2, 1.4, .4, 1)' });
}
// The ticker slims down once you scroll (hysteresis: it doesn't flicker at the edge)
addEventListener('scroll', () => {
  const y = scrollY, on = document.body.classList.contains('scrolled');
  if (!on && y > 160) document.body.classList.add('scrolled');
  else if (on && y < 60) document.body.classList.remove('scrolled');
}, { passive: true });
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SETTINGS_META = [
  ['minEdge', 'Min gap (pts)', 'How far Kalshi\'s price must be below the bot\'s odds, after fees, even if volatility is 20% off either way, to call BUY THE LOW', 'cents'],
  ['minConfidence', 'Min confidence (0-100)', 'Win odds a call needs before BUY THE LOW fires (80 = wins about 8 times in 10)', 'num'],
  ['kalshiAgree', 'Kalshi must agree (pts)', 'A new call needs Kalshi\'s own price for that side at least this high (85 on Near-certain; 0 = off). When the bot is sure and the market isn\'t, the bot is usually the one that\'s wrong', 'cents'],
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
  ['dailyLossLimit', 'Daily loss limit ($)', 'Once your tracked trades lose this much in a day, buy alerts stop until midnight (0 = off). Protects you from chasing losses', 'num'],
  ['momentumWeight', 'Momentum weight', 'How much of the 10-min drift to carry forward (0 to 1)', 'num'],
  ['learnBlend', 'Learn how much to trust Kalshi', 'Once the bot has proven a blend of its odds and Kalshi\'s price scores better (150+ rounds), use it instead of the setting below', 'bool'],
  ['marketWeight', 'Respect the market', 'Blend Kalshi\'s own price into the bot\'s odds (0 = the bot alone, 1 = Kalshi alone). History → What the bot has learned shows which blend has scored best, graded every second', 'num'],
  ['minProfit', 'Min profit (pts)', 'Profit per contract (after fees) for a sell to count as taking profit', 'cents'],
  ['trail', 'Trailing drop (pts)', 'Flag a flip sign if the sell % falls this far from its peak (a warning, not a sell)', 'cents'],
  ['oddsDrop', 'Odds drop (pts)', 'Flag a flip sign if the bot\'s odds fall this far from their peak (a warning, not a sell)', 'cents'],
  ['cutConfirmSec', 'Hold steady (sec)', 'A sell at a loss has to stay true this long before SELL NOW, so one jumpy tick doesn\'t shake you out', 'num'],
  ['cutMargin', 'Cut margin (pts)', 'A sell at a loss needs Kalshi to pay at least this much more than the bot\'s odds', 'cents'],
  ['bailBelow', 'Bail-out line (%)', 'BAIL OUT when the bot\'s odds on its call (or your position) fall under this: stops a bad call before it loses everything. 0 = off', 'cents'],
  ['tradeAmount', 'Fixed trade amount ($)', 'What "I bought it" records each time. 0 = use the bot\'s suggested amount', 'num'],
  ['bankroll', 'Bankroll ($)', 'Used for position sizing', 'num'],
  ['kellyFraction', 'Kelly fraction', '0.25 means quarter Kelly', 'num'],
  ['maxStake', 'Max stake ($)', 'Cap per call', 'num'],
  ['refreshSec', 'Kalshi refresh (sec)', 'How often to reload Kalshi prices (crypto prices stream live)', 'num'],
];
// A fresh install has nothing to migrate: skip straight past the old upgrade steps (the v4.1 step used to double a new
// phone's confidence bar to 95). Only the latest step (default risk level) runs.
if (store.get('settings', null) == null && store.get('settingsVersion', null) == null) store.set('settingsVersion', 11);
// Simple mode (v13.42): the call, the line and the signal board's summary; everything marked data-pro hides. A brand-new
// phone starts in Simple, a phone that already used the app keeps Pro; the header button switches.
let simpleMode = store.get('simpleMode', store.get('settings', null) == null);
document.body.classList.toggle('simple', simpleMode); // before the first paint, so Pro cards never flash
const settings = { series: 'KXBTC15M', refreshSec: 3, multiFeeds: true, waitForDip: false, notifyBuy: true, notifySell: true, notifyUpdates: true, tradeAmount: 0, ...DEFAULTS, ...EXIT_DEFAULTS, ...store.get('settings', {}) };
const marketList = store.get('marketList', SEEDS).filter((m) => listed(m)); // the server's discovery (every 15-minute Kalshi market it can call), kept for the next start
if (!/^[A-Z0-9]+$/.test(settings.series || '') || marketOf(settings.series, marketList) === HOME_MARKET && settings.series !== HOME_MARKET.series || !listed(marketOf(settings.series, marketList))) settings.series = HOME_MARKET.series; // only 15-minute markets the bot has a price for
const MKT = marketOf(settings.series, marketList), HOME = isHome(settings.series); // the market picked (public/markets.js); HOME = Bitcoin's 15-minute one
const CRYPTO = MKT.kind === 'crypto'; // exchange trade feeds and a live price socket (stock indexes, gold and oil have neither)
// the server's readers for this market (v13.30: every market has its own copy): ?m=SERIES on their API calls
const api = (path) => (HOME ? path : `${path}${path.includes('?') ? '&' : '?'}m=${encodeURIComponent(settings.series)}`);
const LK = (k) => storeKey(k, settings.series); // each market keeps its own logs, so one coin's predictions are never graded on another's prices
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

// v13.15: phones on the 90% target level get the late lane (the last 5 minutes' stress-tested calls)
if (store.get('settingsVersion', 1) < 13) {
  if (riskLevelOf(settings) === 'target90' && settings.lateMin == null) settings.lateMin = RISK_LEVELS.target90.lateMin;
  store.set('settings', settings); store.set('settingsVersion', 13);
}
// v13.20: phones on the 90% target level move to Profit, the official level (calls priced 60-90c that pay)
if (store.get('settingsVersion', 1) < 17) {
  if (riskLevelOf(settings) === 'target90') Object.assign(settings, riskSettings('profit'));
  store.set('settings', settings); store.set('settingsVersion', 17);
}
// v13.19: the 90% target level can flip a locked call on clear evidence
if (store.get('settingsVersion', 1) < 16) {
  if (riskLevelOf(settings) === 'target90' && settings.flipCalls == null) settings.flipCalls = RISK_LEVELS.target90.flipCalls;
  store.set('settings', settings); store.set('settingsVersion', 16);
}
// v13.17: the 90% target level makes no new calls in the last 5 minutes (the late lane is off)
if (store.get('settingsVersion', 1) < 15) {
  if (riskLevelOf(settings) === 'target90') Object.assign(settings, { lateMin: RISK_LEVELS.target90.lateMin, noCallLastMin: RISK_LEVELS.target90.noCallLastMin });
  store.set('settings', settings); store.set('settingsVersion', 15);
}
// v13.16: and the early lane (10 to 5 minutes left: test calls until proven on real rounds)
if (store.get('settingsVersion', 1) < 14) {
  if (riskLevelOf(settings) === 'target90' && settings.earlyMin == null) settings.earlyMin = RISK_LEVELS.target90.earlyMin;
  store.set('settings', settings); store.set('settingsVersion', 14);
}

// saved logs, type-checked as they load (v13.42.2): one damaged entry used to stop the app before it drew anything
const savedList = (k) => { const v = store.get(k, []); return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []; };
const savedMap = (k) => { const v = store.get(k, {}); return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x && typeof x === 'object')) : {}; };
const state = { markets: [], spot: null, candles: [], candlesAt: 0, marketsAt: 0, strikes: {}, quoteLog: {}, alerted: {},
  positions: savedList('positions'), trades: savedList('trades'), kalshi: { key: null, keyId: null },
  notifyLog: {}, // anti-spam limiter for in-app alerts
  calls: savedMap(LK('calls')), chosen: {}, // the strike called in a round with many (hourly and daily markets)
  ruleLog: savedList(LK('ruleLog')), // scorecard for the two-rejections rule
  callLog: savedList(LK('callLog')), // every call the bot makes, graded at settlement (public/record.js)
  flipLog: savedList(LK('flipLog')), // predicted turns (frozen a minute before), graded on whether a V really formed
  coneLog: savedList(LK('coneLog')), // each round's cone at 5 min left (close band, chance above the target), graded at the close
  pcLog: savedList(LK('pcLog')), // each minute's prediction candle as it stood when the minute began, graded at its close
  predLog: savedList(LK('predLog')), // each round's prediction-line closes with 5 min left, graded at the close (public/predict.js)
  // what the server has learned about this market (public/learner.js): kept per market (v13.42.2), and never another market's
  memory: ((m) => (m?.market?.series && m.market.series !== settings.series ? null : m))(store.get(LK('marketMemory'), null)) };
// v5.0: auto-trading and Practice were removed: drop what they stored
try { for (const k of ['practice', 'practiceCfg', 'liveCfg', 'liveOrders', 'learned']) localStorage.removeItem(k); } catch { /* storage blocked */ }
// v8.0: the Auto-trader moved to the server: drop what the phone-side one stored
try { for (const k of ['traderCfg', 'trader:test', 'trader:demo', 'trader:live', 'traderTestEx']) localStorage.removeItem(k); } catch { /* storage blocked */ }
for (const [k, c] of Object.entries(state.calls)) if (!(c.at > Date.now() - 2 * 3600000)) delete state.calls[k];
try { localStorage.removeItem('tracker'); } catch { /* report cards were removed in v2.9 */ }
try { localStorage.removeItem('scanLog'); } catch { /* the scan is graded on the server since v9.1 */ }

// Access lapsed (paywall): reload so the server shows the paywall page.
// the server marks its own sign-in 401s (x-paywall); anything else is a data error, retried on the next poll. At most one
// reload a minute, so nothing can bounce the app in a loop
function paywalled(r) {
  if (r.status !== 401 || r.headers.get('x-paywall') !== '1') return;
  let last = 0; try { last = Number(sessionStorage.getItem('scPaywallAt')) || 0; sessionStorage.setItem('scPaywallAt', String(Date.now())); } catch { /* storage blocked */ }
  if (Date.now() - last > 60000) location.reload();
  throw new Error('payment required');
}

async function getJSON(path) {
  // The page's first lines already started the startup requests (index.html): use those once, if they're fresh
  const pre = window.__pre && window.__pre[path];
  if (pre) delete window.__pre[path];
  // a request stuck on a flaky phone connection gives up after 10s (the next poll tries again) instead of hanging
  const r = (pre && Date.now() - window.__pre.at < 15000 && await pre) || await fetch(`${API}/${path}`, { signal: AbortSignal.timeout?.(10000) });
  paywalled(r);
  const srv = Date.parse(r.headers.get('date') || ''); // server clock, for the health check's phone-clock test
  if (srv) state.skewMs = Date.now() - srv - 500; // the Date header drops milliseconds: half a second on average
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------- data ----------
async function refreshCandles() {
  // Coinbase rows: [time, low, high, open, close, volume], newest first
  state.candles = parseCandles(await getJSON(CRYPTO ? `coinbase/products/${MKT.product}/candles?granularity=60` : `price/${MKT.key}/candles?granularity=60`));
  state.candlesAt = Date.now();
}

async function refreshMarkets() {
  const data = await getJSON(`kalshi/markets?series_ticker=${encodeURIComponent(settings.series)}&status=open&limit=200`);
  state.markets = (data.markets || []).map((m) => (MKT.settle === 'spot' ? { ...m, settleWin: 0 } : m)).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time) || (a.floor_strike ?? 0) - (b.floor_strike ?? 0));
  state.marketsAt = Date.now();
}

// What the server has learned (volatility by time of week, calibration, basis). Small; refreshed every 10 minutes.
async function refreshMemory() {
  const got = await getJSON(api('learn'));
  if (got?.market?.series && got.market.series !== settings.series) throw new Error('another market\'s learning'); // never price one coin with another's
  state.memory = { ...got, at: Date.now() };
  setFeeRates(state.memory.learned?.fees); // Kalshi's real fee rates, measured from fills
  store.set(LK('marketMemory'), state.memory);
  renderMemory();
}

async function refreshIndex() {
  const ix = await getJSON(api('index'));
  state.index = ix.index ? { offset: ix.offset || 0, used: ix.used || [], at: Date.now() } : null;
}

async function refreshSpot() {
  const t = await getJSON(CRYPTO ? `coinbase/products/${MKT.product}/ticker` : `price/${MKT.key}/ticker`);
  state.spot = Number(t.price); state.spotAt = Date.now(); state.priceDelayed = !!t.delayed; // a delayed index or futures print: shown, never called on
  if (Date.now() - (state.spotSavedAt || 0) > 10000) { state.spotSavedAt = Date.now(); store.set(LK('lastSpot'), { p: state.spot, t: Date.now() }); }
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
  if (how === 'sold') { releaseCall(state.calls, pos.ticker, at, settings); store.set(LK('calls'), state.calls); } // re-entry: a new call can fire after the cooldown
  store.set('trades', state.trades);
  savePositions();
  pushSyncSoon();
  return trade;
}

function renderPositions(snap) {
  const html = state.positions.map((pos) => { try { return positionCard(pos, snap); } catch (e) {
    // one unreadable position (damaged on the phone, or from another market) gets a small card instead of blanking the Deck
    console.error('position card failed', e);
    return `<div class="card pos-card"><div class="pos-why">Couldn't read a saved position${pos?.ticker ? ` (${esc(String(pos.ticker))})` : ''}.</div><div class="pos-btns"><button data-act="remove" data-id="${esc(String(pos?.id ?? ''))}" class="ghost">Remove</button></div></div>`;
  } }).join('');
  setHTML($('positions'), html);
}
function positionCard(pos, snap) {
  {
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
      <div class="pos-where">${pos.source === 'kalshi' ? '<span class="src-tag">From Kalshi</span> · ' : ''}Bought ${clock(pos.at)}${pos.source === 'kalshi' ? ` · ${+pos.contracts.toFixed(2)} contracts` : ''} · wins if ${esc(marketOf(String(pos.ticker || '').split('-')[0], marketList).key)} is${where || (pos.side === 'YES' ? ' above the target' : ' below the target')} at close</div>
      <ul class="flips"><span>Flip watch</span>${signs}</ul>
      <div class="pos-btns">${pos.source === 'kalshi' ? '' : `<button data-act="sell" data-id="${pos.id}">I sold${bid != null ? ` at ${pc(bid)}` : ''}</button>`}<button data-act="remove" data-id="${pos.id}" class="ghost">Remove</button></div>
    </div>`;
  }
}

// ---------- one-tap tracking ----------
// "I bought it" / "I sold" are single taps: side, Kalshi's live price and the time are locked in
// automatically, and the amount is the bot's suggestion (or the fixed amount from Settings).
// Formatters made once: toLocaleString / toLocaleTimeString build a new formatter on every call, which added up to a
// noticeable share of the phone's time with the live tape streaming
const TIME_FMT = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const INT_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const USD_FMT = {};
const clock = (t) => TIME_FMT.format(t);
const int = (v) => INT_FMT.format(Math.round(v));
let undoTimer = null;
let autopilot = null; // the Auto-trader (public/autopilot.js), made once the key store is ready
function toast(text, undo) {
  setText($('toastText'), text);
  setHidden($('toastUndo'), !undo);
  $('toastUndo').onclick = () => { undo?.(); setHidden($('toast'), true); render(); };
  setHidden($('toast'), false);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { setHidden($('toast'), true); }, 7000);
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
const usd = (v, d = 2) => { if (v == null) return '—'; if (d === 0 && MKT.digits && Math.abs(v) < 1000) d = MKT.digits; return `$${(USD_FMT[d] ||= new Intl.NumberFormat(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })).format(v)}`; };
// shared text written for Bitcoin (the deep-dive checks, health checks), said for this market's coin
const coinText = (t) => (MKT.key === 'BTC' ? t : String(t).replace(/\bBTC\b(?! Trader's)/g, MKT.key));
// money amounts (volume traded, whale size, flow) in whole dollars, whatever the coin's price precision
const cash = (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const pc = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const dollars = (v) => `$${v.toFixed(2)}`;
const money = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const sign = (el, v) => { el.classList.toggle('pos', v > 0); el.classList.toggle('neg', v < 0); };
const mmss = (min) => { const s = Math.max(0, Math.round(min * 60)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The price the bot prices with: live Coinbase shifted onto the server's multi-exchange index estimate (index.js),
// when that's fresh and sane. Kalshi settles on an index of several exchanges, not Coinbase alone.
const indexFresh = () => CRYPTO && !!state.index && Date.now() - state.index.at < 20000 && state.spot && Math.abs(state.index.offset) < state.spot * 0.003;
const modelSpot = () => (indexFresh() ? state.spot + state.index.offset : state.spot);
const compute = () => {
  // the server's proven nudges to the odds: the Round scan, the micro model, tuned indicators and the reversal checklist (added per market)
  const nudges = [state.scanSrv?.inCalls && Date.now() - (state.scanFetchAt || 0) < 30000 ? state.scanSrv.inCalls : null, state.micro?.read && Date.now() - state.micro.read.at < 20000 ? state.micro.inCalls : null,
    state.tune?.inCalls && Date.now() - (state.tuneAt || 0) < 30000 ? state.tune.inCalls : null,
    state.playbook?.inCalls && Date.now() - (state.playbookAt || 0) < 30000 ? state.playbook.inCalls : null];
  let shifts = null;
  for (const n of nudges) for (const [k, v] of Object.entries(n || {})) (shifts ||= {})[k] = (shifts[k] || 0) + v;
  const snap = snapshot({ markets: state.markets, candles: state.candles, spot: state.priceDelayed ? null : modelSpot(), settings, strikes: state.strikes, quoteLog: state.quoteLog, learned: state.memory?.learned ?? null, shifts, chosen: state.chosen }); // this market's own learning (the server's copy for it)
  // Market watch (server): its holds pause new calls here too, and its event count feeds the call filter
  const w = state.watch && Date.now() - state.watchAt < 15000 ? state.watch.status : null;
  snap.watchHold = w?.hold ?? null; snap.watchEvents60 = w?.events60 ?? 0; snap.lateOff = !!state.botRecord?.late?.profitGuard?.paused; snap.earlyLive = !!state.botRecord?.early?.live; snap.flipOff = !!state.botRecord?.flip?.profitGuard?.paused; snap.flipCheck = flipCheckNow(); snap.flipGate = state.tune?.report?.flipStudy ?? null; snap.lockedSide = lockedSideFor(snap.live, snap.now); // the late lane's own guard and the early lane's proof (the server's records)
  state.sigmaNow = snap.sigmaMin; // the chart's bubbles scale "moved the price" to it
  state.strikeNow = snap.live ? { ticker: snap.live.m.ticker, strike: snap.live.strike } : null; // "why it moved" notes target crosses
  return snap;
};

// Deep dive (confidence and its reasons) and the window's rejection trends.
function renderDeep(row, sig) {
  const deep = sig?.deep, rej = row?.rej;
  setHidden($('deepCard'), !deep);
  setHidden($('conf'), !deep);
  if (deep) {
    setClass($('conf'), `conf ${confTier(deep.score)}`);
    if (setText($('conf'), `Confidence ${deep.score}`)) pop($('conf'));
    setText($('deepScore'), `Confidence ${deep.score}`);
    setClass($('deepScore'), confTier(deep.score));
    setHTML($('deepChecks'), deep.checks.map((c) =>
      `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'meh'}"><i>${c.ok === true ? '✓' : c.ok === false ? '✕' : '•'}</i><span>${esc(coinText(c.label))}</span><b>${c.pts > 0 ? '+' : ''}${c.pts || ''}</b></li>`).join('') +
      learnedNotes(row).map((x) => `<li class="meh"><i>🧠</i><span>${esc(x)}</span><b></b></li>`).join(''));
  }
  setHidden($('rejCard'), !rej);
  if (!rej) return;
  const shift = row.ev.pShift || 0;
  setText($('rejBias'), `${rej.bias[0].toUpperCase()}${rej.bias.slice(1)}${Math.abs(shift) >= 0.005 ? ` · ${shift > 0 ? '+' : '−'}${Math.abs(shift * 100).toFixed(1)} pts on YES` : ''}`);
  setClass($('rejBias'), rej.bias === 'bullish' ? 'pos' : rej.bias === 'bearish' ? 'neg' : '');
  setText($('rejCaps'), rej.strikeCaps);
  setText($('rejFloors'), rej.strikeFloors);
  setText($('rejHigh'), rej.highRejects);
  setText($('rejLow'), rej.lowHolds);
  const w = (rej.wickBias + 1) / 2; // 0 = all upper wicks (sellers), 1 = all lower wicks (buyers)
  setStyle($('wickFill'), 'cssText', w >= 0.5 ? `left:50%;width:${(w - 0.5) * 100}%;background:var(--yes)` : `left:${w * 100}%;width:${(0.5 - w) * 100}%;background:var(--no)`);
  setHTML($('rejSummary'), rej.summary.map((x) => `<li>${esc(x)}</li>`).join(''));
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
    const pts = (v) => `${Math.round(Math.abs(v))} pt${Math.round(Math.abs(v)) === 1 ? '' : 's'}`;
    const status = edge != null && edge >= minEdge ? ['low', `LOW by ${pts(gap)}`] : Math.round(gap) > 0 ? ['near', `${pts(gap)} low, not enough after fees`] : Math.round(gap) < 0 ? ['high', `${pts(gap)} high`] : ['fair', 'priced right at the bot\'s odds'];
    const n10 = Math.floor(10 / kalshi + 1e-9); // $10 buys whole contracts; selling them pays the bid less one fee on the whole order
    const a = Math.min(kalshi, bot) * 100, b = Math.max(kalshi, bot) * 100;
    return `<div class="odds-row ${status[0]}"><span class="side">${side}</span>` +
      `<span class="nums">Kalshi <b>${(kalshi * 100).toFixed(0)}%</b> · Bot <b>${(bot * 100).toFixed(0)}%</b></span>` +
      `<span class="track"><i class="fill" style="left:${a}%;width:${b - a}%"></i><i class="mk kalshi" style="left:${kalshi * 100}%"></i><i class="mk bot" style="left:${bot * 100}%"></i></span>` +
      `<span class="status">${status[1]}<em class="cash">Cash out ${cashOut != null ? `<b>${pc(cashOut)}</b>` : '—'}${cashOut != null && n10 > 0 ? ` · $10 → ${dollars(n10 * cashOut - kalshiFee(cashOut, n10))} now` : ''}</em></span></div>`;
  };
  const q = ev.quote;
  return row('YES<small>Above</small>', q.yesAsk, ev.pYes, ev.evYes, q.yesBid) + row('NO<small>Below</small>', q.noAsk, 1 - ev.pYes, ev.evNo, q.noBid) +
    '<div class="odds-legend"><i class="mk kalshi"></i> Kalshi buy price <i class="mk bot"></i> Bot odds · cash out = sell now</div>';
}

// The side the model leans to, even below the edge threshold, so timing has something to read.

// ---------- v6 deck: status tiles, hold meter, price boxes, tug of war, live notes, market events ----------
const alerts = createAlertCenter({ $, store, esc, clock, onNote: (key, title, text) => addNote(key, `${title}${text ? ` · ${text}` : ''}`),
  // your own sound files, kept on this phone (IndexedDB holds the file itself, so it works offline)
  custom: { get: (n) => idb('readonly', (st) => st.get(`sound:${n}`)), set: (n, v) => idb('readwrite', (st) => (v ? st.put(v, `sound:${n}`) : st.delete(`sound:${n}`))) } });
const flow = newFlow();
const fx = createFx($);
const trendState = {};
$('fxTryLock').addEventListener('click', () => { alerts.play('call', 'bull'); fx.lockIn({ side: 'YES', conf: 91, hold: 0.87, price: 0.72 }); });
$('fxTryBull').addEventListener('click', () => { alerts.play('trendBull'); fx.charge('bull'); });
$('accCopy').addEventListener('click', copyAccuracy);
const watch = {}; // sustained conditions for alerts (alerts.js)
const feedState = {}; // live-data health (alerts.js feedWatch)
state.notes = [];
function addNote(key, text, t = Date.now()) {
  state.notes.unshift({ t, key, text });
  state.notes.length = Math.min(state.notes.length, 40);
}
const noteClass = (k) => ({ call: 'call', win: 'good', whaleBuy: 'good', feedUp: 'good', loss: 'bad', whaleSell: 'bad', feedDown: 'bad' }[k] || (k === 'info' ? '' : 'warn'));

// ---------- live orders from all markets (public/feeds.js) ----------
// Every exchange's trades feed the tug of war, whales and the tape; the round's per-exchange split resets each round.
const tape = { list: [], round: null, ex: [], kalshi: [], kalshiSeen: new Set(), kalshiTicker: null, rate: [], big: [], bigV: 0 }; // big: market-moving orders, 6h, for the chart's bubbles (bigV bumps on each)
const impact = createImpact(); // which trades moved the price (public/chart.js)
tape.recent = []; // every exchange trade in the last ~10 minutes, for "why it moved" (public/why.js)
const alignPrices = createAligner(0.005, MKT.sym || undefined); // the global markets' USDT / futures price levels, aligned to USD spot (public/feeds.js)
function handleTrades(trades) {
  trades = alignPrices(trades);
  const p = alerts.prefs();
  for (const x of trades) {
    const live = state.markets.find((m) => Date.parse(m.close_time) > x.t);
    const round = live ? Date.parse(live.open_time) : null;
    if (round !== tape.round) { tape.round = round; tape.ex = []; }
    tape.ex.push(x); tape.recent.push(x);
    if (tape.ex.length > 150000) tape.ex.splice(0, 20000); // the whole round (busy rounds run to tens of thousands)
    const w = addTrade(flow, x, { round, whaleMin: p.whaleMin });
    x.whale = !!w;
    tape.list.unshift(x); tape.rate.push(Date.now());
    const moved = impact(x, { sigmaMin: state.sigmaNow || undefined }); // only orders that move the price bubble on the chart
    if (moved) { tape.big.push(moved); tape.bigV++; }
    if (w) alerts.event(w.side === 'buy' ? 'whaleBuy' : 'whaleSell', `Whale ${w.side}: ${cash(w.usd)}`, `${w.size >= 100 ? int(w.size) : w.size.toFixed(2)} ${MKT.key} at ${usd(w.price, 0)} on ${w.ex}`, `whale:${w.ex}:${w.t}`);
  }
  if (tape.list.length > 200) tape.list.length = 200;
  if (tape.recent[0] && tape.recent[0].t < Date.now() - 11 * 60000) tape.recent = tape.recent.filter((x) => x.t >= Date.now() - 10 * 60000);
  orderFrame(); // new trades show on the chart right away, not at the next refresh
  if (tape.big.length > 4000 || (tape.big[0] && tape.big[0].t < Date.now() - 6 * 3600000)) tape.big = tape.big.filter((x) => x.t >= Date.now() - 6 * 3600000).slice(-3000);
}
const feeds = createFeeds({ onTrades: handleTrades, onStatus: (s) => { state.feedStatus = s; }, sym: CRYPTO ? MKT.sym : null });
function feedsOn() { if (CRYPTO && settings.multiFeeds !== false && !document.hidden) feeds.start(); else feeds.stop(); } // the coin's exchange feeds

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
const hmsCache = new Map(); // one tape row per trade, many in the same second
const hms = (t) => { const k = Math.floor(t / 1000); let v = hmsCache.get(k); if (!v) { v = clock(t).replace(/\s?[AP]M/, ''); hmsCache.set(k, v); if (hmsCache.size > 400) hmsCache.delete(hmsCache.keys().next().value); } return v; };
function renderTape(force = false) {
  const now = Date.now();
  if (!force && now - (state.tapeAt || 0) < 500) return;
  state.tapeAt = now;
  const st = state.feedStatus || {};
  const liveFeed = (n) => (n === 'Coinbase' ? isLive() : st[n]?.state === 'live' && now - (st[n].lastAt || 0) < 120000);
  const off = settings.multiFeeds === false;
  setHTML($('feedChips'), [...ALL_FEEDS_FOR().map((n) => {
    const s = n === 'Coinbase' ? (isLive() ? 'live' : 'down') : off ? 'off' : liveFeed(n) ? 'live' : st[n]?.state || 'connecting';
    return `<span class="${s}">${n}</span>`;
  }), `<span class="${state.kalshiTapeAt && now - state.kalshiTapeAt < 15000 ? 'live' : 'connecting'}">Kalshi</span>`].join(''));
  tape.rate = tape.rate.filter((t) => t > now - 60000);
  setText($('tapeRate'), `${tape.rate.length} ${MKT.key} trades/min`);
  const tab = state.tapeTab;
  // Per-exchange split of the round (BTC) or the Kalshi contract's taker flow
  setHidden($('tapeEx'), tab === 'kalshi'); setHidden($('kalshiFlow'), tab !== 'kalshi');
  if (tab !== 'kalshi') {
    const by = byExchange(tape.ex);
    setHTML($('tapeEx'), Object.entries(by).sort((a, b) => (b[1].buy + b[1].sell) - (a[1].buy + a[1].sell)).map(([n, e]) => {
      const tot = e.buy + e.sell, b = tot ? e.buy / tot : 0.5;
      return `<span>${n}</span><span class="bar" title="buy ${Math.round(b * 100)}%"><i style="width:${(b * 100).toFixed(0)}%"></i></span><em>${Math.round(b * 100)}% buy · ${cash(tot)}</em>`;
    }).join('') || `<span class="muted">No ${MKT.key} exchange trades yet this round</span>`);
  } else {
    const kf = kalshiFlow(tape.kalshi);
    setHTML($('kalshiFlow'), `<div>UP (YES) bought<b>${int(kf.YES.count)}</b>${cash(kf.YES.usd)}</div><div>DOWN (NO) bought<b>${int(kf.NO.count)}</b>${cash(kf.NO.usd)}</div>`);
  }
  tape.list.sort((a, b) => b.t - a.t); // feeds arrive a little out of order; the tape reads newest first
  const rows = tape.list.filter((x) => (tab === 'all' ? true : tab === 'kalshi' ? x.kalshi : !x.kalshi)).slice(0, 40);
  const seen = state.tapeTop;
  state.tapeTop = rows[0];
  setHTML($('tape'), rows.map((x, i) => {
    const fresh = seen && rows.indexOf(seen) > i ? ' new' : '';
    if (x.kalshi) return `<li class="kalshi ${x.side === 'YES' ? 'buy' : 'sell'}${fresh}"><time>${hms(x.t)}</time><span class="ex">Kalshi</span><span class="sd">${x.side === 'YES' ? 'UP' : 'DOWN'}</span><span>${int(x.count)} @ ${(x.price * 100).toFixed(0)}¢</span><span class="amt">${cash(x.usd)}</span></li>`;
    return `<li class="${x.side}${x.whale ? ' whale' : ''}${fresh}"><time>${hms(x.t)}</time><span class="ex">${x.ex.replace('.US', '')}</span><span class="sd">${x.side === 'buy' ? 'BUY' : 'SELL'}</span><span>${x.size >= 100 ? int(x.size) : x.size < 0.001 ? x.size.toFixed(5) : x.size.toFixed(4)} @${x.price >= 1000 ? int(x.price) : x.price.toFixed(MKT.digits)}</span><span class="amt">${x.whale ? '🐋 ' : ''}${cash(x.price * x.size)}</span></li>`;
  }).join('') || `<li class="empty">${tab === 'kalshi' ? 'No Kalshi trades on this contract yet.' : 'Waiting for trades…'}</li>`);
}

function setTile(id, text, cls = '', sub = null) {
  const el = $(id); setText(el, text); setClass(el, cls);
  if (sub != null) setText($(`${id}Sub`), sub);
}

function dataHealth(now) {
  const mAge = now - (state.marketsAt || 0), sAge = now - (state.spotAt || 0);
  if (!state.marketsAt || !state.spotAt) return ['STARTING', 'warn'];
  if (mAge > 30000 || sAge > 30000) return ['STALE', 'bad', mAge > 30000 && sAge > 30000 ? 'Kalshi prices and the live price' : mAge > 30000 ? 'Kalshi prices' : `the ${MKT.key} price`];
  return [isLive() ? 'LIVE' : 'CURRENT', 'ok'];
}

// Market stability (analysis.js): 👍 stable, 🤷 moderate, red 👎 unstable. On the call card and the Chart tab.
const STAB = { stable: ['👍', 'Stable', 'Calm, settled market: the bot\'s odds are on firm ground'], moderate: ['🤷', 'Moderate', 'Some chop: odds can wobble more than usual'], unstable: ['👎', 'Unstable', 'Jumpy market: expect big swings, size down'], unknown: ['…', 'Measuring…', 'Needs about 20 minutes of candles'] };
function renderStability(st, now) {
  const [icon, label, why] = STAB[st.level] || STAB.unknown;
  state.stabNow = st;
  const changed = state.stabLevel != null && state.stabLevel !== st.level;
  state.stabLevel = st.level;
  for (const id of ['stabThumb', 'pulseThumb']) { const el = $(id); setText(el, icon); setClass(el, `thumb ${st.level}${id === 'pulseThumb' ? ' big' : ''}`); if (changed) pop(el); }
  setHidden($('stabChip'), st.level === 'unknown');
  setClass($('stabChip'), `stab-chip ${st.level}`);
  setText($('stabLabel'), `Market ${label.toLowerCase()}`);
  setText($('stabScore'), st.score == null ? '' : `${st.score}/100`);
  setClass($('pulseStab'), `pulse-stab ${st.level}`);
  setText($('pulseLevel'), label);
  setText($('pulseWhy'), why);
  setText($('pulseScore'), st.score == null ? '—' : String(st.score));
  setStyle($('pulseStabFill'), 'width', `${st.score ?? 0}%`);
  setClass($('pulseStabFill'), st.level);
  setHTML($('pulseParts'), st.parts.length ? st.parts.map((p) => `<li><b>${p.pts}</b>${esc(p.label)}</li>`).join('') : st.score != null ? '<li class="calm"><b>✓</b>Nothing unsettling: steady volatility, no shock candles, no whipsaw</li>' : '');
  setText($('pulseWhen'), clock(now));
}
// ---------- round scan: the 5 exchanges, every trade this round (public/roundscan.js) ----------
// The phone scans its own live feeds; when they're not streaming it shows the server's scan (scanfeed.js). The learned
// weights and the graded record always come from the server, which scans and grades every round.
function renderScan(live, snap, now) {
  if (!live || now - (state.scanAt || 0) < 3000) return;
  state.scanAt = now;
  if (CRYPTO && now - (state.scanFetchAt || 0) > 10000) { state.scanFetchAt = now; getJSON(api('scan')).then((d) => { state.scanSrv = d; }).catch(() => {}); }
  const srv = state.scanSrv, open = Date.parse(live.m.open_time), tk = live.m.ticker;
  let sc = scanRound(tape.ex, { openTime: open, now, whaleMin: alerts.prefs().whaleMin, sigmaMin: snap.sigmaMin }), fromServer = false;
  if (!sc.ready && srv?.live?.ticker === tk && srv.live.sc?.ready) { sc = srv.live.sc; fromServer = true; }
  setText($('scanWhen'), `${int(sc.trades)} trades · ${fromServer ? 'server feeds' : clock(now)}`);
  if (!sc.ready) {
    setText($('scanLabel'), 'Reading the round…'); setText($('scanScore'), 'waiting for the exchange feeds');
    setClass($('scanVerdict'), 'scan-verdict'); setStyle($('scanFill'), 'width', '0%');
    for (const id of ['scanParts', 'scanTable', 'scanFacts', 'scanChance']) setHTML($(id), '');
  } else {
    const cls = sc.score >= 15 ? 'up' : sc.score <= -15 ? 'down' : 'mixed';
    if (setText($('scanLabel'), sc.verdict)) pop($('scanLabel'));
    setText($('scanScore'), `${sc.score > 0 ? '+' : ''}${sc.score} · ${sc.exchanges}/${SCAN_EXCHANGES.length} USD + ${sc.global?.live ?? 0}/${GLOBAL_SCAN.length} global exchanges · $${fmtK(sc.totalUsd + (sc.global?.usd ?? 0))} traded`);
    setClass($('scanVerdict'), `scan-verdict ${cls}`);
    // meter: centre is 0, left half sellers, right half buyers
    setStyle($('scanFill'), 'cssText', sc.score >= 0 ? `left:50%;width:${sc.score / 2}%;background:var(--yes)` : `left:${50 + sc.score / 2}%;width:${-sc.score / 2}%;background:var(--no)`);
    setHTML($('scanParts'), sc.parts.map((p) => `<li><b class="${p.pts > 0 ? 'pos' : p.pts < 0 ? 'neg' : ''}">${p.pts > 0 ? '+' : ''}${p.pts}</b><span>${esc(p.name)}</span><small>${esc(p.why)}</small></li>`).join(''));
    // the scan chance: the bot's odds (distance to the target, volatility, time left) nudged by what the scan has learned
    const ch = scanChance(live.ev.pYes, featureVector(sc, live.m.strike_type), srv?.models, live.ev.minutesLeft);
    const cp = srv?.models?.[checkpointFor(live.ev.minutesLeft)];
    if (ch) {
      const pct = (p) => `${Math.round(p * 100)}%`, side = ch.p >= 0.5 ? 'UP' : 'DOWN', pS = Math.max(ch.p, 1 - ch.p);
      const shift = ch.active ? Math.round((ch.p - ch.pModel) * 100) : 0;
      setHTML($('scanChance'), `<div class="sc-ch ${ch.p >= 0.5 ? 'up' : 'down'}"><label>Scan chance</label><b>${side} ${pct(pS)}</b>`
        + `<small>${ch.active ? `bot alone ${pct(ch.p >= 0.5 ? ch.pModel : 1 - ch.pModel)} · scan ${shift >= 0 ? '+' : '−'}${Math.abs(shift)} pts on UP` : `= the bot's odds: still learning (${int(cp?.n ?? 0)}/${MIN_SAMPLES} graded rounds at this point)`}</small></div>`);
    } else setHTML($('scanChance'), '');
    const rows = SCAN_EXCHANGES.map((ex) => sc.rows.find((r) => r.ex === ex)), grows = GLOBAL_SCAN.map((ex) => sc.global?.rows?.find((r) => r.ex === ex) ?? { ex, n: 0 });
    const scanRow = (r) => {
      if (!r || !r.n) return `<div class="sc-r off"><span>${esc(r?.ex ?? '')}</span><span class="muted">${GLOBAL_SCAN.includes(r?.ex) ? 'not streaming' : 'no trades yet'}</span><span></span><span></span></div>`;
      const b = Math.round((r.buyShare ?? 0.5) * 100);
      return `<div class="sc-r${sc.leader?.ex === r.ex ? ' lead' : ''}"><span>${esc(r.ex.replace('.US', ''))}${sc.leader?.ex === r.ex ? ' <i title="moves first">⚡</i>' : ''}${r.whales ? ' 🐋' : ''}</span>`
        + `<span class="sc-bar" title="${b}% buy"><i style="width:${b}%"></i><em>${b}%</em></span>`
        + `<span class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : '−'}$${fmtK(Math.abs(r.net))}</span>`
        + `<span class="${r.change > 0 ? 'pos' : r.change < 0 ? 'neg' : ''}">${r.change == null ? '—' : `${r.change >= 0 ? '+' : '−'}$${Math.abs(r.change).toFixed(0)}`}</span></div>`;
    };
    setHTML($('scanTable'), `<div class="sc-h"><span>Exchange</span><span>Buy / sell</span><span>Net</span><span>Since open</span></div>` + rows.map(scanRow).join('')
      + `<div class="sc-h sc-sub"><span>Global markets</span><span></span><span></span><span></span></div>` + grows.map(scanRow).join(''));
    const facts = [
      sc.leader ? `⚡ <b>${esc(sc.leader.ex)}</b> moves first: the others follow about ${sc.leader.lag}s later` : 'No clear leader yet: the exchanges move together',
      sc.dispersion != null ? `Prices <b>$${sc.dispersion.toFixed(0)}</b> apart across exchanges${sc.dispersion > 40 ? ' (wide: a fragmented, jumpy market)' : ''}` : null,
      sc.cbPremium != null && Math.abs(sc.cbPremium) >= 5 ? `Coinbase is <b class="${sc.cbPremium > 0 ? 'pos' : 'neg'}">$${Math.abs(sc.cbPremium).toFixed(0)} ${sc.cbPremium > 0 ? 'above' : 'below'}</b> the other exchanges (${sc.cbPremium > 0 ? 'US buyers keen' : 'US sellers heavier'})` : null,
      `Flow is <b>${esc(sc.momentum.state)}</b>`,
      sc.global?.edge != null ? `Global futures are <b class="${sc.global.edge > 0 ? 'pos' : sc.global.edge < 0 ? 'neg' : ''}">$${Math.abs(sc.global.edge).toFixed(0)} ${sc.global.edge >= 0 ? 'ahead up' : 'ahead down'}</b> of USD spot over 30 s${Math.abs(sc.global.lead) > 0.3 ? ' (spot usually follows)' : ''}` : null,
      sc.bigBuy + sc.bigSell > 0 ? `Big prints ($25k+): <b class="pos">$${fmtK(sc.bigBuy)}</b> buy · <b class="neg">$${fmtK(sc.bigSell)}</b> sell` : null,
      sc.futures ? `Futures (Hyperliquid): flow leans <b class="${sc.features.fFlow >= 0 ? 'pos' : 'neg'}">${sc.features.fFlow >= 0 ? 'buy' : 'sell'} ${Math.round(Math.abs(sc.features.fFlow) * 50 + 50)}%</b>${sc.futures.funding != null ? ` · funding ${(sc.futures.funding * 100).toFixed(4)}%/h` : ''}${sc.futures.oiChange != null ? ` · open interest ${sc.futures.oiChange >= 0 ? '+' : '−'}${Math.abs(sc.futures.oiChange * 100).toFixed(2)}% in 5 min` : ''}${Math.abs(sc.features.fLead) >= 0.15 ? ` · futures ${sc.features.fLead > 0 ? 'ahead up' : 'ahead down'}` : ''}` : null,
    ].filter(Boolean);
    setHTML($('scanFacts'), facts.map((f) => `<div>${f}</div>`).join(''));
  }
  setHTML($('scanRecord'), scanRecordHtml(srv));
}
// The server's honest record: each checkpoint's Brier score for the bot alone, the scan chance and Kalshi's price
// (lower is better), how often the lean matched, and what the scan has learned to trust
function scanRecordHtml(srv) {
  if (!srv?.record) return 'Record: the server grades the scan after every round.';
  const r6 = srv.record[6], br = (v) => (v == null ? '—' : v.toFixed(3));
  if (!r6?.n) return 'Record: the server grades the scan at 10, 6 and 3 minutes left in every round. The first results show after a round settles.';
  const lines = CHECKPOINTS.map((cp) => {
    const r = srv.record[cp];
    if (!r?.n) return '';
    const better = r.skill == null ? '' : r.skill > 0.005 ? ` <b class="pos">scan improves the bot ${Math.round(r.skill * 100)}%</b>` : r.skill < -0.005 ? ` <b class="neg">scan worse than the bot alone</b>` : ' no difference yet';
    return `<tr><td>${cp} min left</td><td>${int(r.n)}</td><td>${r.leaned ? `${Math.round(r.right / r.leaned * 100)}%` : '—'}</td><td>${br(r.bot)}</td><td>${br(r.scan)}</td><td>${br(r.kalshi)}</td></tr>${better ? `<tr class="sc-skill"><td colspan="6">${better}</td></tr>` : ''}`;
  }).join('');
  const m = srv.models?.[6];
  const learned = m?.active ? FEATURES.map((k, i) => ({ k, w: m.w[i] })).filter((f) => Math.abs(f.w) >= 0.05).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .map((f) => `${esc(FEATURE_NAMES[f.k])} ${f.w > 0 ? '✓' : '✕ (backwards)'}`).join(' · ') : '';
  return `<table class="sc-rec"><tr><th>Graded at</th><th>Rounds</th><th>Lean right</th><th>Bot</th><th>Scan</th><th>Kalshi</th></tr>${lines}</table>`
    + `<small>Brier score: lower is better (0.25 = a coin flip). Scan is scored with the weights it had before each result.${learned ? ` Trusts: ${learned}.` : m?.active ? ' Nothing in the scan has proven useful yet, so it leaves the bot\'s odds alone.' : ''}</small>`
    + `<div class="scan-past">${(srv.rounds || []).slice(0, 10).map((x) => `<span class="${!x.lean ? '' : (x.lean === 'YES') === (x.y === 1) ? 'ok' : 'bad'}" title="${esc(x.ticker)}: lean ${esc(x.lean || 'none')} at 6 min left → ${x.y ? 'YES' : 'NO'}">${!x.lean ? '·' : (x.lean === 'YES') === (x.y === 1) ? '✓' : '✕'}</span>`).join('')}</div>`;
}
function renderDeck(snap, live, sig, now) {
  // Status tiles
  const [health, hcls, staleWhat] = dataHealth(now);
  const ix = indexFresh() && state.index.used.length > 1 ? `index of ${state.index.used.length} exchanges` : 'Coinbase price';
  const feedsLive = ALL_FEEDS_FOR().filter((n) => (n === 'Coinbase' ? isLive() : state.feedStatus?.[n]?.state === 'live' && now - (state.feedStatus[n].lastAt || 0) < 120000)).length;
  setTile('stFeed', isLive() ? 'LIVE' : state.spotAt ? 'POLLING' : '…', isLive() ? 'ok' : 'warn', `${feedsLive}/${ALL_FEEDS_FOR().length} trade feeds · ${ix}`);
  setTile('stClock', clock(now - (state.skewMs || 0)), '',
    state.skewMs == null ? 'server-synced' : Math.abs(state.skewMs) > 5000 ? `phone is ${Math.round(state.skewMs / 1000)}s off` : 'server-synced ✓');
  setTile('stContract', live ? roundName(live.m.ticker) : 'none', live ? 'ok' : 'warn', live ? `closes in ${mmss(live.ev.minutesLeft)}` : 'between markets');
  const br = state.botRecord, st = br?.graded ? br : callStats(state.callLog);
  setTile('stRecord', st.graded ? `${st.wins}–${st.graded - st.wins}` : 'no calls yet', st.graded ? (st.wins / st.graded >= 0.8 ? 'ok' : 'warn') : '',
    st.graded ? `${Math.round((st.wins / st.graded) * 100)}% won${br?.graded ? ` · ${br.streak ? `${br.streak.kind}${br.streak.n} streak` : 'bot record'}` : ' on this phone'}` : 'graded at settlement');
  setTile('dataHealth', health, hcls);
  setText($('timeLeft'), live ? mmss(live.ev.minutesLeft) : '—');
  const lf = live?.learnedAdj;
  setText($('learnedNow'), !lf ? '—' : `vol ×${lf.volFactor.toFixed(2)}${lf.basis ? ` · basis ${lf.basis >= 0 ? '+' : '−'}$${Math.abs(lf.basis).toFixed(0)}` : ''}`);

  // Hold meter + Kalshi price boxes
  const q = live?.ev.quote;
  setText($('upAsk'), q?.yesAsk != null ? `${(q.yesAsk * 100).toFixed(0)}¢` : '—');
  setText($('downAsk'), q?.noAsk != null ? `${(q.noAsk * 100).toFixed(0)}¢` : '—');
  setText($('upBot'), live?.ev.pYes != null ? `bot ${Math.round(live.ev.pYes * 100)}%` : '');
  setText($('downBot'), live?.ev.pYes != null ? `bot ${Math.round((1 - live.ev.pYes) * 100)}%` : '');
  const conf = sig?.deep?.score ?? null, hold = sig?.hold ?? null;
  setHidden($('holdBox'), conf == null);
  if (conf != null) {
    const flipRisk = hold == null ? null : Math.round((1 - hold) * 100);
    setTile('confBig', `${conf}`, conf >= 85 ? 'ok' : conf >= 70 ? 'warn' : 'bad');
    setTile('holdBig', hold == null ? '—' : `${Math.round(hold * 100)}%`, hold == null ? '' : hold >= 0.8 ? 'ok' : hold >= 0.6 ? 'warn' : 'bad');
    setTile('flipBig', flipRisk == null ? '—' : `${flipRisk}/100`, flipRisk == null ? '' : flipRisk <= 20 ? 'ok' : flipRisk <= 40 ? 'warn' : 'bad');
    setStyle($('holdFill'), 'width', `${hold == null ? 0 : Math.round(hold * 100)}%`);
    setText($('holdNote'), `${sig.side === 'YES' ? 'UP' : 'DOWN'} side · hold odds = chance confidence stays above ${Math.round(settings.holdFloor * 100)} until the last minute (300 simulated paths)${sig.locked ? ' · call locked' : ''}`);
  }
  renderFlipCheck(live, now);
  renderLine(live, snap, now);
  renderBoard(live, sig, now);

  // Tug of war
  const fs = flowStats(flow, now);
  const pr = pressureUpdate(flow, now);
  const buy = fs.nowBuyShare;
  setText($('tugBuy'), buy == null ? '—' : `${(buy * 100).toFixed(1)}%`);
  setText($('tugSell'), buy == null ? '—' : `${((1 - buy) * 100).toFixed(1)}%`);
  setStyle($('tugFill'), 'width', `${buy == null ? 50 : (1 - buy) * 100}%`);
  setStyle($('tugMark'), 'left', `calc(${buy == null ? 50 : (1 - buy) * 100}% - 1px)`);
  setText($('tugLead'), buy == null ? '' : buy >= 0.6 ? 'BUYERS DOMINANT' : buy <= 0.4 ? 'SELLERS DOMINANT' : 'BALANCED');
  setClass($('tugLead'), buy == null ? '' : buy >= 0.6 ? 'pos' : buy <= 0.4 ? 'neg' : '');
  $('tugBull').classList.toggle('dom', buy != null && buy >= 0.55); // the winning side's animal steps up
  $('tugBear').classList.toggle('dom', buy != null && buy <= 0.45);
  // The same pressure on the Chart tab's Market pulse card
  setText($('pulseBuy'), buy == null ? '—' : `${Math.round(buy * 100)}%`);
  setText($('pulseSell'), buy == null ? '—' : `${Math.round((1 - buy) * 100)}%`);
  setStyle($('pulseTugFill'), 'width', `${buy == null ? 50 : (1 - buy) * 100}%`);
  setStyle($('pulseTugMark'), 'left', `calc(${buy == null ? 50 : (1 - buy) * 100}% - 1px)`);
  setText($('pulseLead'), buy == null ? 'Pressure' : buy >= 0.6 ? 'Buyers in control' : buy <= 0.4 ? 'Sellers in control' : 'Balanced');
  setClass($('pulseLead'), `pulse-lead ${buy == null ? '' : buy >= 0.6 ? 'pos' : buy <= 0.4 ? 'neg' : ''}`);
  setText($('pulseNow'), fs.nowUsd > 0 ? `Last 2 minutes: ${cash(fs.nowUsd)} traded across ${feedsLive} exchange${feedsLive === 1 ? '' : 's'}` : 'Buy vs sell pressure: needs the live feeds (open the app in front)');
  $('pulseBull').classList.toggle('dom', buy != null && buy >= 0.55);
  $('pulseBear').classList.toggle('dom', buy != null && buy <= 0.45);
  renderScan(live, snap, now);
  trackPredictions(snap, live, now);
  renderStability(sig?.stability ?? stability({ bars: snap.bars, sigmaMin: snap.sigmaMin, sigmaLong: snap.sigmaLong, now }), now);
  setText($('tugNow'), fs.nowUsd > 0 ? `Last 2 minutes: ${cash(fs.nowUsd)} traded across ${feedsLive} exchange${feedsLive === 1 ? '' : 's'}${flow.pressure ? ` · sustained ${flow.pressure} pressure` : ''}` : 'Needs the live feeds (they open when the app is in front).');
  setText($('tugRound'), fs.prints ? `${fs.net >= 0 ? '+' : '−'}${usd(Math.abs(fs.net), 0)}` : '—');
  setClass($('tugRound'), fs.net > 0 ? 'pos' : fs.net < 0 ? 'neg' : '');
  setText($('tugRoundSub'), fs.prints ? `buy ${cash(fs.buyUsd)} / sell ${cash(fs.sellUsd)} · ${fs.prints} prints` : 'since the round opened');
  setText($('tugWhales'), fs.whaleBuys + fs.whaleSells ? `${fs.whaleBuys} buy · ${fs.whaleSells} sell` : '—');
  setText($('tugWhaleSub'), `trades ≥ ${usd(alerts.prefs().whaleMin, 0)}`);
  const fc = live ? floorCeiling(snap.bars, Date.parse(live.m.open_time)) : null, ms = modelSpot();
  setText($('floorDist'), fc && ms ? usd(ms - fc.floor, 0) : '—');
  setText($('ceilDist'), fc && ms ? usd(fc.ceiling - ms, 0) : '—');
  if (pr.flipped) alerts.event('pressure', `Pressure flipped: ${pr.side === 'buy' ? 'buyers' : 'sellers'} took over`, '60%+ of the last 2 minutes, held 10s');

  // Market events: round change (sit out), BTC crossing the target, flip warnings, feed health
  if (live) {
    const tk = live.m.ticker;
    if (state.deckTicker && state.deckTicker !== tk) {
      const prev = state.deckTicker;
      if (!state.callLog.some((e) => e.ticker === prev)) alerts.event('sitout', 'No buy last round', `${prev}: the round call was a lean, not a buy`, `sit:${prev}`);
      addNote('info', `New round ${roundName(tk)} · target ${usd(live.strike, 0)}`);
    }
    state.deckTicker = tk;
    const above = ms && live.strike ? ms > live.strike : null;
    if (above != null && state.deckAbove != null && state.deckAbove.tk === tk && state.deckAbove.v !== above) alerts.event('cross', `${MKT.key} crossed ${above ? 'above' : 'below'} the target`, `${usd(ms, 0)} vs ${usd(live.strike, 0)}`, `cross:${tk}`);
    if (above != null) state.deckAbove = { tk, v: above };
    const lean = leanSide(live.ev), called = sig?.called;
    // v13.38: the flip check (chart history + buyers / sellers, proven only) says the called side is more likely than not to lose
    const fcLose = called ? flipCheckNow(tk)?.pLose?.[called] : null;
    if (sustained(watch, 'flipchk', fcLose != null && fcLose >= 0.5 && live.ev.minutesLeft > 0.5, now)) alerts.event('flip', `Flip warning: ${Math.round(fcLose * 100)}% the ${called === 'YES' ? 'UP' : 'DOWN'} call flips`, 'chart history and buyers / sellers · held 10s', `flipchk:${tk}`);
    if (sustained(watch, 'flip', !!called && !!lean && lean !== called && live.ev.minutesLeft > 0.5, now)) alerts.event('flip', `Flip warning: bot now leans ${lean === 'YES' ? 'UP' : 'DOWN'}`, `against the ${called === 'YES' ? 'UP' : 'DOWN'} call · held 10s`, `flip:${tk}`);
    const risky = !!called && hold != null && (1 - hold) * 100 >= alerts.prefs().flipRisk;
    if (sustained(watch, 'fliprisk', risky, now)) alerts.event('fliprisk', `High flip risk: ${Math.round((1 - hold) * 100)}/100`, `hold odds ${Math.round(hold * 100)}% on the ${called === 'YES' ? 'UP' : 'DOWN'} call`, `fliprisk:${tk}`);
  }
  // feed health: only a real outage alerts (alerts.js feedWatch), not the moment the app comes back from the background
  const fw = feedWatch(feedState, hcls === 'bad', now, { resumedAt: state.resumedAt || performance.timeOrigin });
  if (fw) alerts.event(fw === 'lost' ? 'feedDown' : 'feedUp', fw === 'lost' ? 'Live data lost' : 'Live data back', fw === 'lost' ? `${staleWhat || 'prices'} not updated for 45s; calls paused until they refresh` : 'prices are fresh again');

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
  const head = live && sig?.deep ? `${MKT.key} ${usd(Math.abs((ms || 0) - live.strike), 0)} ${(ms || 0) >= live.strike ? 'above' : 'below'} target · bot leans ${leanSide(live.ev) === 'YES' ? 'UP' : 'DOWN'} · confidence ${sig.deep.score}${hold != null ? ` · flip risk ${Math.round((1 - hold) * 100)}/100` : ''}${buy != null ? ` · ${buy >= 0.5 ? 'buyers' : 'sellers'} ${(Math.max(buy, 1 - buy) * 100).toFixed(0)}% of flow` : ''}` : '';
  setText($('notesWhen'), `updated ${clock(now)}`);
  setHTML($('notes'), (head ? `<li><time>now</time><span>${esc(head)}</span></li>` : '') +
    state.notes.slice(0, 12).map((n) => `<li class="${noteClass(n.key)}"><time>${clock(n.t)}</time><span>${esc(n.text)}</span></li>`).join(''));
  if ($('view-chart').classList.contains('active')) drawChartTab();
}

// ---------- suggestions: confident buys, buy light, sell high (public/suggest.js) ----------
function renderSuggestions(snap, live, sig, now) {
  const items = [];
  const e = live && live.ev.minutesLeft > 0 ? suggestEntry(sig, live.ev, settings) : { kind: 'none' };
  const el = $('suggest');
  el.hidden = !live || e.kind === 'none';
  if (!el.hidden) {
    setClass(el, `suggest ${e.kind}`);
    const size = e.contracts && e.price ? ` · ${dollars(e.contracts * e.price)}${e.kind === 'light' ? ' (light)' : ''}` : '';
    setText($('sugTitle'), `${e.title}${size}`); setText($('sugWhy'), e.why);
    if (e.kind === 'bail') items.push({ kind: 'bail', label: 'BAIL OUT', text: e.title.replace(/^BAIL OUT of /, ''), why: e.why });
    else if (e.kind !== 'wait') items.push({ kind: e.kind, label: e.kind === 'confident' ? 'CONFIDENT BUY' : e.kind === 'light' ? 'BUY LIGHT' : 'BUY', text: `${e.side === 'YES' ? 'UP' : 'DOWN'} at ${pc(e.price)}${size}`, why: e.why });
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
  setHidden($('sugCard'), !items.length);
  setText($('sugWhen'), items.length ? clock(now) : '');
  setHTML($('sugList'), items.map((i) => `<li class="${i.kind}"><b>${i.label}</b><span>${esc(i.text)}<small>${esc(i.why)}</small></span></li>`).join(''));
}

// ---------- Chart tab ----------
const chartState = { tf: store.get('chartTf', 'round'), show: { ...chartDefaults(), ...store.get('chartShow', {}) }, cache: {}, drawnAt: 0,
  height: store.get('chartH', 300), // S / M / L
};
const CHART_SIZES = { S: 240, M: 300, L: 420 };
function buildChartControls() {
  setHTML($('tfBtns'), Object.entries(TIMEFRAMES).map(([k, t]) => `<button data-tf="${k}" class="${chartState.tf === k ? 'on' : ''}">${t.label}</button>`).join(''));
  setHTML($('chartSize'), Object.entries(CHART_SIZES).map(([k, h]) => `<button type="button" data-h="${h}" class="${chartState.height === h ? 'on' : ''}">${k}</button>`).join(''));
  setHTML($('chartToggles'), CHART_TOGGLES.map(([k, label]) => `<label><input type="checkbox" data-show="${k}" ${chartState.show[k] ? 'checked' : ''}>${esc(label)}</label>`).join(''));
}
$('tfBtns').addEventListener('click', (e) => { const k = e.target.dataset.tf; if (!k) return; chartState.tf = k; store.set('chartTf', k); buildChartControls(); drawChartTab(true); });
$('chartSize').addEventListener('click', (e) => { const h = Number(e.target.dataset.h); if (!h) return; chartState.height = h; store.set('chartH', h); buildChartControls(); drawChartTab(true); });
$('chartToggles').addEventListener('change', (e) => { const k = e.target.dataset.show; if (!k) return; chartState.show[k] = e.target.checked; store.set('chartShow', chartState.show); drawChartTab(true); });
async function chartBars(tf) {
  const T = TIMEFRAMES[tf];
  if (T.gran === 60) return state.candles;
  const c = chartState.cache[tf];
  if (c && Date.now() - c.at < 60000) return c.bars;
  if (!chartState.loading) {
    chartState.loading = true;
    getJSON(CRYPTO ? `coinbase/products/${MKT.product}/candles?granularity=${T.gran}` : `price/${MKT.key}/candles?granularity=${T.gran}`).then((rows) => {
      const bars = parseCandles(rows);
      chartState.cache[tf] = { at: Date.now(), bars: T.combine > 1 ? aggregate(bars, (T.gran / 60) * T.combine) : bars };
      drawChartTab(true);
    }).catch(() => {}).finally(() => { chartState.loading = false; });
  }
  return c?.bars ?? [];
}
// The Chart tab: TradingView's Lightweight Charts (public/tvchart.js) does the drawing, the zoom, pan and crosshair
let tv = null;
async function drawChartTab(force = false) {
  const now = Date.now();
  if (!force && now - chartState.drawnAt < 1000) return;
  chartState.drawnAt = now;
  if (!$('tfBtns').children.length) buildChartControls();
  if (!tv) { if (!$('tvMain').clientWidth) return; tv = createTvChart({ main: $('tvMain'), rsiEl: $('tvRsi'), macdEl: $('tvMacd'), layer: $('orderLayer'), liveBtn: $('chartLive'), digits: MKT.digits, name: MKT.key }); force = true; }
  const tf = chartState.tf, T = TIMEFRAMES[tf];
  const snap = compute(), live = snap.live;
  let bars = await chartBars(tf);
  const open = live ? Date.parse(live.m.open_time) : null, close = live ? Date.parse(live.m.close_time) : null;
  if (T.gran === 60) bars = withLive(bars, now);
  if (!bars.length) return;
  const barMs = T.gran * 1000 * T.combine;
  // The round view starts 6 minutes before the open (v13.40: bigger candles); 1m shows the last hour, others the last 120 bars
  const viewFrom = tf === 'round' && open ? open - 6 * 60000 : bars[Math.max(0, bars.length - (tf === '1m' ? 60 : 120))]?.t;
  const sigma = live?.sigma ?? snap.sigmaMin, spot = modelSpot();
  const showCone = (tf === 'round' || tf === '1m') && live;
  const preds = showCone ? predictionsNow(live, snap, now) : [];
  const pcs = showCone ? pathNow(live, snap, now, preds) : { minutes: [], turns: [] };
  const markers = state.callLog.filter((e) => e.at).map((e) => ({ t: e.at, side: e.side, label: `${e.side === 'YES' ? 'UP' : 'DN'} ${e.conf ?? ''}`.trim() }));
  const fk = `${state.positions.length}|${state.trades.length}|${autopilot?.state()?.log?.[0]?.t ?? 0}`;
  if (fk !== chartState.fillsKey) { chartState.fillsKey = fk; chartState.fills = chartFills(); }
  // Redraw the layers when something on them changed (or every 5s for the indicators); trades move the live candle in between
  const lb = bars[bars.length - 1];
  const key = [tf, chartState.height, bars.length, lb.t, live?.strike, close, state.callLog.length, fk, state.whyLog[0]?.t, state.enNow?.call, JSON.stringify(chartState.show), Math.floor(now / 5000)].join('|');
  if (key === chartState.key && !force) return;
  const resetView = chartState.viewKey !== `${tf}|${chartState.height}`;
  chartState.key = key; chartState.viewKey = `${tf}|${chartState.height}`;
  // chart patterns on the closed candles of the timeframe on screen (a forming candle never confirms one), once a candle
  const pk = `${tf}|${bars.length}|${lb.t}`;
  if (pk !== chartState.patKey) { chartState.patKey = pk; try { chartState.pats = patternsNow(bars.slice(0, -1)); } catch { chartState.pats = null; } renderPatterns(tf); }
  tv.render({ patterns: chartState.show.patterns !== false ? chartState.pats : null, tf, bars, barMs, height: chartState.height, show: chartState.show, strike: live?.strike, openTime: open, closeTime: close, round: tf === 'round' || tf === '1m',
    cone: showCone ? coneNow(live, snap, now, pcs.path, horizonOf(live, now)).pts : [], predictions: pcs.lines || [], path: pcs.minutes, turns: pcs.turns, structure: T.gran === 60 && chartState.show.structure !== false ? structureRead(snap.bars, { now, price: spot, sigmaMin: snap.sigmaMin || 0.0008 }) : null, markers, fills: chartState.fills, orders: tape.big, notes: state.whyLog, viewFrom, resetView, forecast: state.enNow });
}
// ---------- Chart patterns (public/chartpatterns.js): what's on the chart, and how each kind has done ----------
function renderPatterns(tf) {
  const P = chartState.pats, card = $('cpCard');
  if (!card) return;
  const fams = new Map((state.tune?.report?.families || []).filter((f) => /^cp_/.test(f.family)).map((f) => [f.family.slice(3), f]));
  const hist = (key) => {
    const f = fams.get(key);
    if (!f) return 'graded once the server has 3 weeks of candles';
    const hit = f.test?.hit, n = f.test?.rounds;
    return `${f.proven ? '✓ proven, in the calls' : 'not proven, not used'} · on unseen rounds ${hit != null ? `${Math.round(hit * 100)}%` : '—'} right${n ? ` of ${int(n)}` : ''}${f.dir < 0 ? ' (works best faded)' : ''} · z ${(f.test?.z ?? 0).toFixed(1)}`;
  };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : `${m} min ago`; };
  setText($('cpWhen'), tf === 'round' || tf === '1m' ? '1-minute candles' : `${TIMEFRAMES[tf]?.label ?? tf} candles · graded on 1-minute`);
  setHTML($('cpForming'), P?.forming ? `<b>${esc(P.forming.name)} forming</b><small>A close above ${usd(P.forming.up, 0)} or below ${usd(P.forming.dn, 0)} confirms it (dashed lines on the chart).</small>` : '<small>No triangle, wedge or channel forming right now.</small>');
  setHTML($('cpList'), (P?.recent || []).map((e) => `<li class="${e.dir > 0 ? 'up' : 'dn'}"><span><b>${esc(e.name)}</b><small>${ago(e.t)} · says ${e.dir > 0 ? 'UP' : 'DOWN'}${e.target != null ? ` · measured target ${usd(e.target, 0)}` : ''}</small><small class="cp-hist">${esc(hist(e.key))}</small></span><i>${e.dir > 0 ? '▲' : '▼'}</i></li>`).join('') || '<li class="empty">No pattern confirmed in the last 30 minutes (candle patterns: the last 5).</li>');
}

// ---------- Market watch (server: marketwatch.js, public/watch.js): every detail, every second ----------
async function refreshWatch() {
  if (document.hidden) return;
  try { state.watch = await getJSON(api('watch')); state.watchAt = Date.now(); renderWatch(); } catch { /* next time */ }
}
setInterval(refreshWatch, 5000);
setTimeout(refreshWatch, 1500);
function renderWatch() {
  const w = state.watch;
  if (!w) return;
  const st = w.status, ico = { severe: '⛔', warn: '⚠️', info: '•' };
  setText($('watchWhen'), clock(state.watchAt));
  setHTML($('watchNow'), st.hold ? `<b class="neg">⛔ New calls on hold</b> until ${esc(clock(st.hold.until))}: ${esc(st.hold.why)}`
    : st.calm ? '<b class="pos">✓ All calm</b>: nothing unusual in the last minute' : `<b>${st.events60} notable thing${st.events60 === 1 ? '' : 's'}</b> in the last minute`);
  setHTML($('watchList'), (w.events || []).slice(0, 12).map((e) => `<li class="w-${e.sev}"><span>${esc(clock(e.t))}</span><i>${ico[e.sev] || '•'}</i><em>${esc(e.text)}</em></li>`).join('') || '<li class="calm">Nothing unusual yet.</li>');
}

// ---------- the micro model (server: microfeed.js, public/micro.js): small details' push on the next 5 minutes ----------
async function refreshMicro() {
  if (document.hidden) return;
  try { state.micro = await getJSON(api('micro')); renderMicro(); } catch { /* next time */ }
}
setInterval(refreshMicro, 5000);
setTimeout(refreshMicro, 1500);
function renderMicro() {
  const m = state.micro;
  if (!m) return;
  const h = m.read?.horizons, pct = (v) => `${(v * 100).toFixed(1)}%`, n = m.models;
  const on = h && [1, 3, 5].some((k) => h[k]?.active);
  const learning = [1, 3, 5].map((k) => `${k} min: ${int(n?.[k]?.n ?? 0)} graded, ${n?.[k]?.skill > 0 ? `${pct(n[k].skill)} better` : 'not better yet'} than "no change"`).join(' · ');
  setHTML($('microInfo'), on
    ? `<b>Small details:</b> next 5 min <b class="${h[5].move >= 0 ? 'pos' : 'neg'}">${h[5].move >= 0 ? '+' : '−'}$${Math.abs(h[5].move).toFixed(0)}</b> (1 min ${h[1].move >= 0 ? '+' : '−'}$${Math.abs(h[1].move).toFixed(0)}, 3 min ${h[3].move >= 0 ? '+' : '−'}$${Math.abs(h[3].move).toFixed(0)}), bending the prediction candles${m.inCalls ? ` and shifting the bot's odds ${Object.values(m.inCalls)[0] >= 0 ? '+' : '−'}${(Math.abs(Object.values(m.inCalls)[0]) * 100).toFixed(1)} pts on UP` : ''}${m.read.sway?.length ? `. Swaying it: ${m.read.sway.map((x) => `${esc(x.name)} ${x.push > 0 ? '↑' : '↓'}`).join(', ')}` : ''}. <small>${learning}</small>`
    : `<b>Small details:</b> the micro model is learning how buy/sell pressure, futures, the leading exchange, absorption, Kalshi's flow and jumps move the next 1–5 minutes. It bends the candles and shifts the bot's odds (±6 pts max) only once it beats "no change" (500+ graded, 0.5%+ better). <small>${learning}</small>`);
}

// ---------- the playbook check (server: playbookfeed.js, public/playbook.js) ----------
async function refreshPlaybook() {
  if (document.hidden) return;
  try { state.playbook = await getJSON(api('playbook')); state.playbookAt = Date.now(); renderPlaybook(); } catch { /* next time */ }
}
setInterval(refreshPlaybook, 5000); // the live forecast moves with the price (the checklist with each 15-minute candle)
setTimeout(refreshPlaybook, 2500);
function renderPlaybook() {
  const p = state.playbook, r = p?.report;
  if (!p) return;
  renderReversal(p); renderGuide(p); renderEngine(p);
  const card = (title, x) => !x ? '' : `<div class="pb-row"><b>${title}</b><span>${x.n ? `${x.n} trades · won ${Math.round(x.winRate * 100)}% · avg ${x.avgR >= 0 ? '+' : ''}${x.avgR.toFixed(2)}R · total ${x.totalR >= 0 ? '+' : ''}${x.totalR.toFixed(1)}R · worst drawdown ${x.maxDD.toFixed(1)}R · fees ${x.feesR.toFixed(1)}R${x.open ? ` · ${x.open} open` : ''}` : 'no trades yet'}${x.needs ? ` <small>(${x.needs} more to reach the playbook's 100)</small>` : ''}</span></div>`;
  setHTML($('pbReport'), !r ? (p.backfilling ? `Reading two weeks of ${MKT.key} history…` : 'Starting…')
    : `<small class="muted">${int(r.bars)} one-minute candles since ${new Date(r.from).toLocaleDateString([], { month: 'short', day: 'numeric' })}, rechecked every 15 minutes. The rules never change, so this is one walk-forward test: backtest plus live paper trades.</small>`
      + card("As written: yesterday's high/low, 2R target", r.day) + card('Same, 1.5R target', r.day15) + card("Variant: the last hour's high/low, 2R", r.hour) + card('Variant, 1.5R', r.hour15)
      + engineRecord(r.predictor, p.predictorLive)
      + guideRecord(r.guide, p.guideLive)
      + reversalReport(r.reversal)
      + `<small class="muted">Break-even win rate before costs: 33% at 2R, 40% at 1.5R. ${(() => { const best = [r.day, r.hour].filter((x) => x?.n >= 30).sort((a, b) => b.avgR - a.avgR)[0]; return best ? (best.avgR > 0 ? 'One version is positive after fees so far; it still needs 100+ trades to mean much.' : 'After fees, it isn\'t profitable on this data yet.') : 'Too few trades to judge yet.'; })()}</small>`);
}

// ---------- indicator tuning (server: tunefeed.js, public/tune.js): which settings have really predicted the rounds ----------
async function refreshTune() {
  if (document.hidden) return;
  try { state.tune = await getJSON(api('tune')); state.tuneAt = Date.now(); renderTune(); if (shownViews.has('learn')) renderLessons(); if (shownViews.has('chart') && chartState.pats) renderPatterns(chartState.tf); } catch { /* next time */ }
}
setInterval(refreshTune, 10000);
setTimeout(refreshTune, 3000);
function renderTune() {
  const t = state.tune, r = t?.report;
  if (!t) return;
  if (!r || !r.families.length) { setHTML($('tuneReport'), `Waiting for enough ${MKT.key} history (about 2,000 one-minute candles) to run the test…`); return; }
  const pctOr = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const rows = r.families.map((f) => `<tr class="${f.proven ? 'on' : ''}"><td><b>${esc(f.name)}</b><small>${esc(f.setting)} · ${f.dir > 0 ? 'with the signal' : 'against it (fade)'}</small></td>`
    + `<td>${pctOr(f.train.hit)}</td><td>${pctOr(f.test.hit)}<small>${int(f.test.rounds)} rounds</small></td><td>${f.test.z.toFixed(1)}</td><td>${f.proven ? '✓ in calls' : '—'}</td></tr>`).join('');
  const proven = r.families.filter((f) => f.proven), act = t.read?.active || [];
  setHTML($('tuneReport'), `<small class="muted">${int(r.rounds)} rounds tested (${int(r.bars)} one-minute candles), rechecked hourly. Each indicator family's best setting and direction were picked on the first ${int(r.trainRounds)} rounds, then tested on the last ${int(r.testRounds)}, which they never saw. Hit = how often BTC moved the way the signal said, from 10, 6 and 3 minutes out to the close (50% = a coin flip).</small>`
    + `<table class="sc-rec tune-tab"><tr><th>Indicator (best setting)</th><th>Hit (tuning)</th><th>Hit (unseen)</th><th>z</th><th></th></tr>${rows}</table>`
    + `<small class="muted">${proven.length ? `Proven: ${proven.map((f) => esc(f.setting)).join(', ')}. ${act.length ? `Right now: ${act.map((a) => `${esc(a.setting)} says ${a.push > 0 ? 'up' : 'down'}`).join(' · ')}${t.inCalls ? ` (${Object.values(t.inCalls).map((v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} pts on YES`).join(', ')})` : ''}.` : 'None is signalling right now.'}`
      : 'No indicator has predicted the rounds on data it wasn\'t tuned on yet (|z| 2.9+ on 150+ rounds), so none changes the bot\'s calls. That\'s normal for chart indicators at this speed.'}</small>`);
}

$('brRange')?.addEventListener('click', (e) => { const b = e.target.closest('button[data-r]'); if (!b) return; store.set('brRange', b.dataset.r); renderBotRecord(); });

// ---------- The line (public/settle.js): the lead, the cushion, history at this cushion, the last-60-seconds settlement,
// pressure vs the leader, the trading sessions ----------
function renderLine(live, snap, now) {
  const card = $('lineCard');
  if (!card) return;
  const ml = live?.ev.minutesLeft, open = live && ml > 0 && ml <= 14.5 && now >= Date.parse(live.m.open_time);
  setHidden(card, !open);
  if (!open) return;
  const price = modelSpot(), strike = live.strike, sigma = live.sigma ?? snap.sigmaMin, dg = Math.max(0, MKT.digits ?? 0);
  const below = /^less/.test(live.m.strike_type || ''), c = cushionRead({ price, strike, sigmaMin: sigma, minutesLeft: ml });
  if (!c) { setHidden(card, true); return; }
  const $$ = (v) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: Math.max(dg, Math.abs(v) < 100 ? 2 : 0) })}`;
  const leadSide = c.up !== below ? 'UP' : 'DOWN', mmssLeft = mmss(ml);
  setText($('lnWhen'), `${mmssLeft} left`);
  setHTML($('lnLead'), `<b class="${leadSide === 'UP' ? 'pos' : 'neg'}">${leadSide} is winning by ${$$(c.lead)}</b><small>target ${$$(strike)} · live ${$$(price)}</small>`);
  setHidden($('lnRazor'), !c.razor);
  if (c.razor) setText($('lnRazor'), `⚡ Razor: ${$$(c.lead)} from the line · coin-flip zone`);
  const fill = $('lnFill'); fill.style.width = `${Math.min(100, (c.ratio / 2) * 50 + (c.ratio > 2 ? 25 : 0)).toFixed(1)}%`; fill.className = c.word.replace(' ', '');
  const h = cushionHistory(state.tune?.report?.cushion, c.ratio, ml);
  setHTML($('lnSay'), `With ${mmssLeft} left, ${esc(MKT.key)} usually still moves about <b class="nw">±${$$(c.move)}</b>. That lead is <b>${c.ratio.toFixed(2)}×</b> the move left: a ${c.word} cushion.`
    + (h ? ` At this cushion and time left, rounds actually finished <b>${leadSide} ${Math.round(h.rate * 100)}%</b> of the time (n=${int(h.n)}, last 3 weeks).` : '')
    + ` To flip it, the other side needs ${$$(c.lead)} in ${mmssLeft}.`);
  // the last 60 seconds of a crypto round: the average Kalshi settles on, banked second by second
  const sw = MKT.settle === 'avg60' ? settlementWatch({ prints: snap.quoteLog?.[live.m.ticker], close: Date.parse(live.m.close_time), spot: price, strike, sigmaMin: sigma, now }) : null;
  setHidden($('lnSettle'), !sw);
  if (sw) {
    const projSide = (sw.lead >= 0) !== below ? 'UP' : 'DOWN';
    setHTML($('lnSettle'), `<b>⏱ Settlement watch</b> ${sw.banked}/60 s banked · average lands <b class="${projSide === 'UP' ? 'pos' : 'neg'}">${projSide} by ${$$(sw.lead)}</b> if price holds`
      + (sw.left ? ` · to flip, the last ${sw.left} s must average ${$$(sw.need)} (${sw.sigmas === Infinity ? '—' : sw.sigmas.toFixed(1)}σ away)${sw.locked ? ' · <b class="lock">🔒 locked by arithmetic</b>' : ''}` : ' · final'));
  }
  // buyers vs sellers against the leader, and how that has gone
  const ag = state.scanSrv?.agreement, tugBuy = flowStats(flow, now).nowBuyShare, pressSide = tugBuy == null ? null : tugBuy >= 0.5 ? 'UP' : 'DOWN';
  let press = '';
  if (pressSide && CRYPTO) {
    const share = Math.round(Math.max(tugBuy, 1 - tugBuy) * 100), disagree = pressSide !== leadSide, b = disagree ? ag?.disagree : ag?.agree;
    press = `Pressure leans <b class="${pressSide === 'UP' ? 'pos' : 'neg'}">${pressSide}</b> (${share}% of the last 2 minutes' trades)` + (disagree ? ', against the leader' : ', with the leader')
      + (b?.n >= 20 ? `. When pressure ${disagree ? 'disagreed with' : 'agreed with'} the leading side, it still won <b>${Math.round(b.won / b.n * 100)}%</b> (${int(b.n)} graded checkpoints)${disagree && b.won / b.n > 0.6 ? ': follow the line, not the pressure' : ''}.` : '.');
  }
  setHTML($('lnPress'), press);
  // the sessions, refreshed once a minute
  if (!state.sessAt || now - state.sessAt > 60000) { state.sessAt = now; state.sess = sessions(now); }
  setHTML($('lnSess'), (state.sess || []).map((x) => `<span class="${x.open ? 'on' : ''}" title="${x.open ? 'open' : 'closed'}">${x.flag} ${esc(x.name)} ${x.open ? `● closes ${span(x.closesIn)}` : `opens ${span(x.opensIn)}`}</span>`).join(''));
}

// ---------- Flip check (server: flipfeed.js, public/flipmodel.js): will the side that's ahead lose? ----------
async function refreshFlipCheck() {
  if (document.hidden) return;
  try { state.flipChk = await getJSON(api('flip')); state.flipChkAt = Date.now(); } catch { /* next time */ }
}
setInterval(refreshFlipCheck, 5000);
setTimeout(refreshFlipCheck, 2000);
// the live check the bot's flip calls read: only when a part is proven, fresh, and for this round
function flipCheckNow(ticker = null) {
  const l = state.flipChk?.live;
  return l && l.used && Date.now() - (state.flipChkAt || 0) < 20000 && (!ticker || l.ticker === ticker) ? l : null;
}
function renderFlipCheck(live, now) {
  const el = $('flipChk'), f = state.flipChk, l = f?.live;
  if (!el) return;
  if (!live || !l || l.ticker !== live.m.ticker || now - (state.flipChkAt || 0) > 20000) { setHidden(el, true); return; }
  const side = l.lead === 'YES' ? 'UP' : 'DOWN', pc = (x) => `${Math.round(x * 100)}%`;
  const learn = (e, what, need) => (!e ? `${what}: gathering` : e.proven ? `${what} ✓` : `${what}: learning (${int(e.nTest)}/${int(need)} test samples, z ${e.z.toFixed(1)})`);
  const why = l.parts.slice(0, 3).map((p) => `${p.name.toLowerCase()} ${p.push > 0 ? '↑' : '↓'}`).join(', ');
  setHTML(el, l.used
    ? `<b>Flip check:</b> ${side} leads; ${pc(l.p)} chance it loses by the close (bot's math ${pc(l.base)})${why ? ` · ${esc(why)}` : ''}`
    : `<b>Flip check:</b> ${side} leads; the bot's math gives it ${pc(l.base)} to lose. ${learn(f.chart, 'Chart history', f.need.chart)} · ${learn(f.flow, 'buyers / sellers', f.need.flow)}; used once proven.`);
  setHidden(el, false);
}

// ---------- Your notes, tested (public/lessons.js): each lesson's live read and its record on unseen rounds ----------
function renderLessons(now = Date.now()) {
  const el = $('lsList');
  if (!el) return;
  const r = state.tune?.report, L = lessonsNow(state.candles || [], now), px = (v) => (v == null ? '—' : usd(v, Math.max(2, MKT.digits ?? 2)));
  const pctOr = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`), up = (v) => (v > 0 ? '<b class="pos">up</b>' : v < 0 ? '<b class="neg">down</b>' : 'nothing');
  const fam = (id) => {
    const f = r?.families?.find((x) => x.family === id);
    if (!r) return `<li class="ls-test">Waiting for the first test on ${esc(MKT.key)} history…</li>`;
    if (!f) return '<li class="ls-test">Too few examples in the history yet to judge.</li>';
    return `<li class="ls-test ${f.proven ? 'on' : ''}"><b>${esc(f.setting)}</b>${f.dir < 0 ? ' (works best faded)' : ''}: hit ${pctOr(f.test.hit)} on ${int(f.test.rounds)} unseen rounds, z ${f.test.z.toFixed(1)} · ${f.proven ? '✓ proven, in the calls' : 'not proven, not used'}</li>`;
  };
  const block = (title, notes, now, tests, extra = '') => `<section class="ls"><h4>${title}</h4><p class="ls-notes">${notes}</p><p class="ls-now">${now}</p><ul class="ls-tests">${r ? tests : `<li class="ls-test">Waiting for the first test on ${esc(MKT.key)} history (it runs hourly once there are about 2,000 one-minute candles)…</li>`}</ul>${r ? extra : ''}</section>`;
  const m = L?.macd, e = L?.ema, s = L?.rsi, g = L?.range, w = L?.pattern;
  const lad = r?.lessons?.ladder, pat = r?.lessons?.patterns;
  const ladder = lad?.rounds ? `<table class="sc-rec ls-tab"><tr><th>At 10, 6, 3 min left, price…</th><th>Finished that way</th><th>Bot's math</th><th>Times</th></tr>${lad.zones.map((z) => `<tr><td>${esc(z.zone)} the ${z.zone.includes('below') ? 'floor' : z.zone === 'inside' ? 'range' : 'ceiling'}<small>${z.side === 'up' ? 'finished up' : 'finished down'}</small></td><td>${pctOr(z.hit)}</td><td>${pctOr(z.math)}</td><td>${int(z.n)}</td></tr>`).join('')}</table><small class="muted">${int(lad.rounds)} rounds, ceiling and floor from each round's first ${lad.k} minutes, "far" = more than one range-height past it. When history and the bot's math agree, the zone adds nothing the bot doesn't already know.</small>` : '';
  const pats = pat?.all?.n ? `<small class="muted">As drawn (buy the neckline break, take profit one pattern-height past it, stop 30% of the height back through it, an hour at most): ${int(pat.all.n)} trades, won ${pctOr(pat.all.win)} where the payoff needs ${pctOr(pat.all.need)} to break even, ${pat.all.avgR >= 0 ? '+' : '−'}${Math.abs(pat.all.avgR).toFixed(2)}R a trade before fees (W ${int(pat.W.n)}, M ${int(pat.M.n)}).</small>` : '';
  setText($('lsWhen'), r ? `${int(r.rounds)} rounds tested` : '');
  setHTML(el, !L ? 'Waiting for an hour of candles…' : [
    block('MACD', 'MACD line = EMA 12 − EMA 26; the signal line is its 9-period EMA; the histogram is the gap. Line crossing above the signal = upward momentum, below = downward; above zero = bullish.',
      `Now: the MACD line is ${m.hist >= 0 ? 'above' : 'below'} its signal (histogram ${m.hist >= 0 ? '+' : '−'}${Math.abs(m.hist).toPrecision(2)}, ${m.growing ? 'growing' : 'shrinking'}), ${m.zero >= 0 ? 'above' : 'below'} zero${m.crossAgo != null ? `; last cross ${m.crossAgo} min ago` : ''}. Says ${up(m.side)}.`,
      fam('macd') + fam('macdx') + '<li class="ls-test muted">The zero-line cross is the same thing as the EMA 12 / 26 cross, tested under EMA.</li>'),
    block('EMA', 'An average that weights recent prices more. Rising = uptrend, falling = downtrend; price often bounces near the line (support and resistance).',
      `Now: EMA 9 ${px(e.e9)} is ${e.trend >= 0 ? 'above' : 'below'} EMA 21 ${px(e.e21)}, a short-term ${e.trend >= 0 ? 'uptrend' : 'downtrend'}${e.bounce ? `; price just bounced off the EMA 21 (${e.bounce > 0 ? 'support' : 'resistance'})` : ''}.`,
      fam('ema') + fam('emasr')),
    block('RSI', '0 to 100. Above 70 = overbought, may pull back; below 30 = oversold, may bounce. Divergence (price and RSI disagreeing) can warn of a reversal.',
      `Now: RSI 14 is ${s.v == null ? '—' : s.v.toFixed(0)} (${s.zone})${s.divergence ? `, with a ${s.divergence > 0 ? 'bullish' : 'bearish'} divergence` : ''}.`,
      fam('rsi') + fam('div')),
    block('Ceiling / floor', 'A rejection at a level marks your ceiling or floor; a breakthrough means new ones can form. Past the ceiling = the 60%+ area, further = 70%+.',
      g ? `Now: this round's ceiling ${px(g.ceil)} and floor ${px(g.floor)} (its first 3 minutes); price ${px(L.price)} is <b>${esc(g.zone)}</b>${g.zone === 'inside' ? ' the range' : g.zone.includes('below') ? ' the floor' : ' the ceiling'}${g.rejected ? `, just rejected at the ${g.rejected < 0 ? 'ceiling' : 'floor'}` : ''}.` : 'Now: the round\'s first 3 minutes set the ceiling and floor; waiting for them.',
      fam('range'), ladder),
    block('Double bottom', 'Two similar lows (support) with a high between them (resistance, the neckline). A break above the neckline: take profit up from there, stop loss just under it. Upside down for a double top.',
      w ? `Now: a double ${w.type === 'W' ? 'bottom' : 'top'} broke its neckline ${px(w.neckline)} ${w.ago} min ago: take profit ${px(w.tp)}, stop ${px(w.sl)}.` : 'Now: no double bottom or top has broken out in the last 2 hours.',
      fam('pattern'), pats),
  ].join(''));
}
setInterval(() => { if (!document.hidden && $('view-learn')?.classList.contains('active')) renderLessons(); }, 15000);

// ---------- the prediction engine (server: playbookfeed.js, public/predictor.js): the live round's forecast ----------
// The call at the confidence you pick: UP/DOWN only when the model is that sure, that level has held up walk-forward
// at this point of the round (100+ past calls, right at least as often as it claims, within 2 pts), and Kalshi's price
// plus fee and slippage leaves an edge. Otherwise NO CALL, with the reason.
state.enThr = Number(store.get('enThr', 0.6)) || 0.6;
function engineCall(p, rep, thr) {
  if (!p) return null;
  const up = p.pUp >= 0.5, side = up ? 'UP' : 'DOWN', conf = up ? p.pUp : p.pDown, cp = rep?.byCheckpoint?.[p.checkpoint];
  const row = cp?.thresholds?.filter((x) => x.t <= thr + 1e-9).at(-1), k = p.kalshi?.[side];
  let reason = null;
  if (conf < thr) reason = `evidence too weak: ${Math.round(conf * 100)}% ${side}, under your ${Math.round(thr * 100)}%`;
  else if (!row || row.model.n < 100) reason = `not validated yet: too few past ${Math.round(thr * 100)}%+ calls at ${p.checkpoint} min left`;
  else if (row.model.accuracy < thr - 0.02) reason = `not validated: past ${Math.round(thr * 100)}%+ calls at ${p.checkpoint} min left were right ${Math.round(row.model.accuracy * 100)}%`;
  else if (k && k.edge <= 0) reason = `priced in: Kalshi ${k.contract} ${Math.round(k.ask * 100)}¢ + fees vs ${Math.round(conf * 100)}%`;
  return { call: reason ? 'NO CALL' : side, side, conf, reason, row, k };
}
function renderEngine(p) {
  const e = p.predictor, rep = p.report?.predictor, thr = state.enThr;
  setHTML($('enThr'), `Call at ${[0.6, 0.7, 0.8, 0.9].map((t) => `<button type="button" data-thr="${t}" class="${Math.abs(t - thr) < 1e-9 ? 'on' : ''}">${t * 100}%+</button>`).join('')}`);
  const badge = $('fcBadge');
  if (!e) { $('enCall').className = 'gd-call wait'; setText($('enCall'), !p.report ? `Reading ${MKT.key} history…` : 'Waiting for a live round with fresh candles (no stale data as a signal).'); setHTML($('enGrid'), ''); setHTML($('enEv'), ''); setHTML($('enKalshi'), ''); setHTML($('enHist'), ''); setHidden(badge, true); state.enNow = null; return; }
  const c = engineCall(e, rep, thr), t = (x) => new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), $$ = (x) => usd(x, 0);
  const left = Math.max(0, (e.closeTime - Date.now()) / 60000);
  setText($('enWhen'), `${left.toFixed(1)} min left · read at ${e.checkpoint}-min model`);
  const cls = c.call === 'UP' ? 'up' : c.call === 'DOWN' ? 'down' : 'none';
  setHTML($('enCall'), `<span>${c.call}</span><small>${c.call === 'NO CALL' ? `${esc(c.reason)} · leaning ${c.side}` : `${Math.round(c.conf * 100)}% ${c.side}, validated at this confidence and worth Kalshi's price`}</small>`);
  $('enCall').className = `gd-call ${cls}`;
  const timing = c.call === 'NO CALL' ? '—' : (c.side === 'UP' ? e.m1 <= 0 : e.m1 >= 0) ? 'now (1-min pullback)' : 'wait for a 1-min pullback';
  setHTML($('enGrid'), [
    ['P(UP) / P(DOWN)', `${(e.pUp * 100).toFixed(1)}% / ${(e.pDown * 100).toFixed(1)}%`],
    ['Distance odds alone', `${(e.base * 100).toFixed(1)}% UP`],
    ['Entry', c.call === 'NO CALL' ? '—' : `${$$(e.price)} · ${timing}`],
    ['Invalidation', `${c.side === 'UP' ? 'below' : 'above'} ${$$(e.invalidation)} (the target)`],
    ['Expiry', `${t(e.closeTime)} settlement`],
  ].map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join(''));
  const f = e.factors, sg = (v, a = 0.25) => (v > a ? '↑' : v < -a ? '↓' : '·');
  setHTML($('enEv'), [
    `<b>Trend:</b> 1-hour ${sg(f.trend1h)} · 15-min EMA 20/50 ${sg(f.ema15)} · VWAP ${sg(f.vwap)}`,
    `<b>Momentum:</b> 5-min RSI ${Math.round(50 + f.rsi5 * 25)} ${f.rsiRising > 0.2 ? 'rising' : f.rsiRising < -0.2 ? 'falling' : 'flat'} · 5-min move ${sg(f.mom5)} · 15-min move ${sg(f.mom15)}`,
    `<b>Volume:</b> buyers ${Math.round((f.signedVol + 1) * 50)}% of the last 15 minutes' volume${Math.abs(f.volTrend) > 0.3 ? ` · volume ${f.volTrend > 0 ? 'rising with' : 'fading against'} the move` : ''}`,
    `<b>Liquidity sweep:</b> ${f.sweep > 0 ? 'swept the hour\'s low and reclaimed it (bullish)' : f.sweep < 0 ? 'swept the hour\'s high and rejected (bearish)' : 'none'} · <b>Structure:</b> ${f.structure > 0 ? 'higher highs and lows' : f.structure < 0 ? 'lower highs and lows' : 'mixed'}`,
    `<b>Moving the model most:</b> ${e.push.slice(0, 3).filter((x) => Math.abs(x.push) > 0.005).map((x) => `${esc(x.name)} ${x.push > 0 ? '+' : '−'}`).join(' · ') || 'nothing beyond the distance to the target'}`,
  ].map((x) => `<li>${x}</li>`).join(''));
  const k = c.k;
  setHTML($('enKalshi'), k ? `Kalshi: ${c.side} = ${k.contract} at ${Math.round(k.ask * 100)}¢ + ${Math.round(k.fee * 100)}¢ fee + 1¢ slippage vs ${(k.p * 100).toFixed(1)}% → <b class="${k.edge > 0 ? 'pos' : 'neg'}">${k.edge >= 0 ? '+' : '−'}${Math.abs(k.edge * 100).toFixed(1)} pts</b>` : '');
  const r = c.row, d = r?.distance;
  setHTML($('enHist'), r ? `Tested: ${Math.round(thr * 100)}%+ calls at ${e.checkpoint} min left were right <b>${r.model.accuracy != null ? `${(r.model.accuracy * 100).toFixed(1)}%` : '—'}</b> of ${int(r.model.n)} (${Math.round(r.model.share * 100)}% of rounds)${d?.n ? `; the distance odds alone: ${(d.accuracy * 100).toFixed(1)}% of ${int(d.n)}` : ''}.${rep?.proven ? ' The model beats the distance odds overall.' : ' Overall the model hasn\'t beaten the distance odds yet, so it doesn\'t touch the bot\'s calls.'}` : '');
  // the chart badge
  setHidden(badge, false); badge.className = `fc-badge ${cls}`;
  setHTML(badge, `${c.call}${c.call !== 'NO CALL' ? ` ${Math.round(c.conf * 100)}%` : ''}<small>P(UP) ${Math.round(e.pUp * 100)}% · exp ${t(e.closeTime)}</small>`);
  state.enNow = { call: c.call, entry: e.price };
}
$('enThr').addEventListener('click', (ev) => { const v = Number(ev.target.closest('button[data-thr]')?.dataset.thr); if (!v) return; state.enThr = v; store.set('enThr', v); if (state.playbook) renderEngine(state.playbook); });
function engineRecord(r, live) {
  if (!r) return '';
  const pc = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const cp = (m) => { const c = r.byCheckpoint[m]; return `<tr><td>${m} min</td>${c.thresholds.map((x) => `<td>${x.model.n ? `${pc(x.model.accuracy)}<small>${Math.round(x.model.share * 100)}% of rounds${x.distance.n ? ` · dist ${pc(x.distance.accuracy)}` : ''}</small>` : '—'}</td>`).join('')}</tr>`; };
  const lv = live?.thresholds?.filter((x) => x.n).map((x) => `${Math.round(x.t * 100)}%+: ${pc(x.accuracy)} of ${x.n}${x.priced ? `, ${money(x.usd)}` : ''}`).join(' · ');
  return `<h4 class="rec-h">Prediction engine: walk-forward on ${int(r.rounds)} rounds</h4>`
    + `<div class="pb-row"><b>Probability quality (Brier, lower is better)</b><span>model ${r.brier?.toFixed(4) ?? '—'} · distance odds alone ${r.brierDistance?.toFixed(4) ?? '—'} · 50/50 guess 0.2500 · beats the distance odds: ${r.proven ? '✓ yes (z ' + r.z.toFixed(1) + ')' : `not yet (z ${r.z.toFixed(1)}, needs 2.5 over 1,000+ rounds)`}</span></div>`
    + `<div class="pb-row"><b>Simple momentum at the open</b><span>calling the last 15 minutes' direction: right ${pc(r.momentum.accuracy)} of ${int(r.momentum.n)} rounds</span></div>`
    + `<table class="sc-rec tune-tab"><tr><th>Minutes left</th>${r.thresholds.map((x) => `<th>${Math.round(x.t * 100)}%+</th>`).join('')}</tr>${[15, 10, 5, 2].map(cp).join('')}</table>`
    + `<small class="muted">Each cell: how often calls at that confidence were right, and how many rounds reached it. High accuracy comes late in the round and the distance odds get most of it, which is why Kalshi prices those calls high. Betting every disagreement with the distance odds (after fee + 1¢ slippage): ${int(r.trades.n)} bets, ${money(r.trades.usd)}.</small>`
    + `<div class="pb-row"><b>Live, at real Kalshi prices</b><span>${lv || 'builds up from the next round (a read at 15, 10, 5 and 2 minutes left)'}</span></div>`;
}

// ---------- the shot-caller guide's forecast (server: playbookfeed.js, public/guide.js) ----------
function renderGuide(p) {
  const g = p.guide;
  if (!g) { $('gdCall').className = 'gd-call wait'; setText($('gdCall'), p.backfilling ? `Reading ${MKT.key} history…` : 'Needs about 15 hours of candles first.'); return; }
  const t = (x) => new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), $$ = (x) => (x == null ? '—' : usd(x, 0));
  setText($('gdWhen'), `${t(g.at)} – ${t(g.expiry)} round`);
  const cls = g.call === 'UP' ? 'up' : g.call === 'DOWN' ? 'down' : 'none';
  setHTML($('gdCall'), `<span>${g.call}</span><small>${g.call === 'NO CALL' ? esc(g.reason) : `${g.candidate} candidate confirmed: all four signals agree and history backs it (${int(g.n)} past examples)`}</small>`);
  $('gdCall').className = `gd-call ${cls}`;
  setHTML($('gdGrid'), [
    ['Est. UP probability', g.pUp != null ? `${(g.pUp * 100).toFixed(1)}%` : '—'],
    ['Entry', g.call === 'NO CALL' ? '—' : `${$$(g.entry)} (candle close)`],
    ['Invalidation', g.invalidation != null && g.call !== 'NO CALL' ? `${g.call === 'UP' ? 'below' : 'above'} ${$$(g.invalidation)}` : '—'],
    ['Expiry', `${t(g.expiry)} settlement`],
  ].map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join(''));
  setHTML($('gdEv'), g.evidence.map((e) => { const [h, ...rest] = e.split(': '); return `<li><b>${esc(h)}:</b> ${esc(rest.join(': '))}</li>`; }).join(''));
  const k = g.kalshi;
  setHTML($('gdKalshi'), !k ? '' : g.call === 'NO CALL' ? `<span class="muted">Kalshi: ${k.side} at ${Math.round(k.ask * 100)}¢. No call, so no trade.</span>`
    : `Kalshi: ${k.side} at ${Math.round(k.ask * 100)}¢ + ${Math.round(k.fee * 100)}¢ fee vs a calibrated ${Math.round(k.p * 100)}% → <b class="${k.edge > 0 ? 'pos' : 'neg'}">${k.edge >= 0 ? '+' : '−'}${Math.abs(k.edge * 100).toFixed(1)} pts</b>${k.edge > 0 ? ` (worth it up to ${Math.round(k.maxPay * 100)}¢)` : ': priced in. A right call can still lose money at this price'}.`);
}
function guideRecord(r, live) {
  if (!r) return '';
  const pc = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const cal = r.calibration.map((b) => `<tr><td>${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%</td><td>${int(b.n)}</td><td>${pc(b.said)}</td><td>${pc(b.actual)}</td></tr>`).join('');
  const sk = Object.entries(r.skipped).map(([k, n]) => `${k} ${int(n)}`).join(' · ');
  return `<h4 class="rec-h">Shot-caller guide: every past round, walk-forward</h4>`
    + `<div class="pb-row"><b>Calls (UP/DOWN)</b><span>${r.calls ? `${int(r.calls)} calls of ${int(r.rounds)} rounds · right ${pc(r.accuracy)} (z ${r.z.toFixed(1)}) · UP ${r.up.wins}/${r.up.n} · DOWN ${r.down.wins}/${r.down.n} · $10 a call at 50¢ + fee: ${money(r.usd)} · worst drawdown $${r.maxDD.toFixed(0)}${r.proven ? ' · ✓ proven, nudges its round' : ''}` : 'no calls yet'}</span></div>`
    + `<div class="pb-row"><b>Skipped</b><span>${sk || 'none'}</span></div>`
    + `<div class="pb-row"><b>Calibration</b><span>Brier ${r.brier != null ? r.brier.toFixed(4) : '—'} vs 0.2500 for always saying 50% (lower is better)</span></div>`
    + (cal ? `<table class="sc-rec"><tr><th>Said UP</th><th>Rounds</th><th>Avg said</th><th>Really UP</th></tr>${cal}</table>` : '')
    + (live?.rounds ? `<div class="pb-row"><b>Live, at real Kalshi prices</b><span>${int(live.calls)} calls of ${int(live.rounds)} rounds · right ${pc(live.accuracy)} · $10 a call at the ask when the round opened, + fees: ${money(live.usd)}${live.priced < live.calls ? ` (${live.calls - live.priced} without a price)` : ''}</span></div>` : '<div class="pb-row"><b>Live, at real Kalshi prices</b><span>starts with the next round</span></div>')
    + `<small class="muted">A high win rate doesn't guarantee profit: a call is only worth buying when the calibrated chance beats Kalshi's price plus fees.</small>`;
}

// ---------- reversal watch (server: playbookfeed.js, public/reversal.js): the 15-minute flip checklist ----------
function renderReversal(p) {
  const v = p.reversal;
  if (!v) { setText($('revHead'), p.backfilling ? `Reading ${MKT.key} history…` : 'Needs about 8 hours of candles first.'); setHTML($('revList'), ''); return; }
  setText($('revWhen'), `as of ${clock(v.at)}`);
  const c = v.best || (v.down.score >= v.up.score ? v.down : v.up), other = c === v.down ? v.up : v.down;
  const label = { strong: 'strong confluence', developing: 'developing: wait for confirmation', insufficient: 'not enough confirmation' }[c.band];
  const inCalls = p.inCalls ? Object.values(p.inCalls)[0] : 0;
  setHTML($('revHead'), `<b class="${c.dir}">${c.dir === 'down' ? 'DOWN' : 'UP'} flip ${c.score}/${v.max}</b> · ${label} <small>(${other.dir} ${other.score}/${v.max})${c.macdDiv ? ' · MACD divergence too' : ''}${inCalls ? ` · ${inCalls >= 0 ? '+' : '−'}${Math.abs(Math.round(inCalls * 100))} pts on YES this round` : ''}</small>`);
  setHTML($('revList'), c.checks.map((x) => `<li class="${x.ok ? 'ok' : ''}"><i>${x.ok ? '✓' : '·'}</i><span>${esc(x.text)}</span><em>${x.ok ? `+${x.pts}` : `0/${{ sweep: 3, mss: 3, rsiDiv: 2 }[x.key] ?? 1}`}</em></li>`).join(''));
}
function reversalReport(rv) {
  if (!rv) return '';
  const pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const bandRow = (k, name) => { const s = rv.bands[k]; return `<div class="pb-row"><b>${name}</b><span>${s.n ? `${int(s.n)} signals · next round went that way ${pc(s.hit15)} · next hour ${pc(s.hit60)} · z ${s.z15.toFixed(1)}${s.n >= 100 && s.z15 >= 2.5 ? (k === 'insufficient' ? ' · beats a coin flip, but 0–4 is too little confirmation to use' : ' · ✓ beats a coin flip, used in calls') : ''}` : 'no signals yet'}</span></div>`; };
  const strat = (title, x) => `<div class="pb-row"><b>${title}</b><span>${x.n ? `${x.n} trades · won ${pc(x.winRate)} · avg ${x.avgR >= 0 ? '+' : ''}${x.avgR.toFixed(2)}R · total ${x.totalR >= 0 ? '+' : ''}${x.totalR.toFixed(1)}R · worst drawdown ${x.maxDD.toFixed(1)}R · costs ${x.feesR.toFixed(1)}R${x.open ? ` · ${x.open} open` : ''}${x.withTrend?.n || x.againstTrend?.n ? ` · with the 1-hour trend ${x.withTrend.n ? `${pc(x.withTrend.winRate)} of ${x.withTrend.n}` : '—'}, against it ${x.againstTrend.n ? `${pc(x.againstTrend.winRate)} of ${x.againstTrend.n}` : '—'}` : ''}` : 'no trades yet'}${x.needs ? ` <small>(${x.needs} more to reach the guide's 200)</small>` : ''}</span></div>`;
  return `<h4 class="rec-h">Reversal guide: does the checklist call the flip?</h4>`
    + bandRow('strong', 'Strong (8+)') + bandRow('developing', 'Developing (5–7)') + bandRow('insufficient', 'Insufficient (0–4)')
    + `<h4 class="rec-h">Reversal guide: the DOWN/UP flip strategy</h4>`
    + strat('Sweep + reclaim + RSI divergence + structure break + retest, 2R', rv.full) + strat('Same, 1.5R', rv.full15) + strat('Without RSI divergence (sweep + structure only), 2R', rv.noRsi)
    + `<small class="muted">Costs: 0.05% fee + 0.02% spread/slippage a side. 50% = a coin flip for the next round.</small>`;
}

// ---------- why it moved (public/why.js): every 2 seconds, explain any real move on the chart ----------
state.whyLog = savedList(LK('whyLog')).filter((n) => n.t > Date.now() - 6 * 3600000);
function runWhy() {
  if (document.hidden) return;
  const now = Date.now(), live = state.markets.find((m) => Date.parse(m.close_time) > now);
  const note = explainMove({ trades: tape.recent, impacts: tape.big, now, sigmaMin: state.sigmaNow || undefined, strike: live && state.strikeNow?.ticker === live.ticker ? state.strikeNow.strike : null, strikeType: live?.strike_type, last: state.whyLog[0] });
  if (note) {
    state.whyLog.unshift(note);
    if (state.whyLog.length > 40) state.whyLog.length = 40;
    store.set(LK('whyLog'), state.whyLog);
    drawChartTab(true);
  }
  renderWhy(now);
}
setInterval(runWhy, 2000);
function renderWhy(now = Date.now()) {
  const n = state.whyLog[0], on = chartState.show?.why !== false;
  const fresh = on && n && now - n.t < 30000 && !state.whyHidden?.[n.t];
  setHidden($('whyBox'), !fresh);
  if (fresh) setHTML($('whyBox'), `<div class="why-h ${n.dir}"><span>Why it moved · ${esc(clock(n.t))}</span><b>${esc(n.headline)}</b></div><ul>${n.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`);
  setHTML($('whyList'), state.whyLog.length ? state.whyLog.slice(0, 8).map((x) => `<li class="${x.dir}"><span>${esc(clock(x.t))}</span><b>${esc(x.headline)}</b><small>${x.reasons.map(esc).join(' · ')}</small></li>`).join('')
    : `<li class="calm">Explanations show up here (and on the chart) whenever ${MKT.key} makes a real move.</li>`);
}
$('whyBox').addEventListener('click', () => { const n = state.whyLog[0]; if (n) { (state.whyHidden ||= {})[n.t] = true; renderWhy(); } }); // tap to dismiss

// Trades: the live candle follows the latest Coinbase trade (the candles are Coinbase's), and new big trades pop as bubbles
let orderRaf = 0;
function orderFrame() {
  if (!tv || orderRaf || !$('view-chart').classList.contains('active') || document.hidden) return;
  orderRaf = requestAnimationFrame(() => {
    orderRaf = 0;
    const lastCb = tape.list.find((x) => x.ex === 'Coinbase');
    tv.live(lastCb && Date.now() - lastCb.t < 5000 ? lastCb.price : state.spot);
    tv.paint();
  });
}

// ---------- prediction lines (public/predict.js): Bot, Kalshi-implied, 5-exchange trend ----------
// The chart looks at least 15 minutes ahead, past the round's close if need be, so the cone and the predictions don't
// shrink away as the round runs out (they used to stop at the close)
const HORIZON = 15 * 60000;
const horizonOf = (live, now) => Math.max(Date.parse(live.m.close_time), Math.ceil((now + HORIZON) / 60000) * 60000);
function predictionsNow(live, snap, now) {
  if (!live) return [];
  const q = live.ev.quote, mid = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null;
  const pb = state.playbook, fresh = now - (state.playbookAt || 0) < 20000, open = Date.parse(live.m.open_time);
  return predictionLines({ spot: modelSpot(), sigmaMin: live.sigma ?? snap.sigmaMin, now, close: Date.parse(live.m.close_time),
    until: horizonOf(live, now), strike: live.strike, yesMid: mid, strikeType: live.m.strike_type, trades: tape.ex,
    pBot: live.ev.pYes, engine: engineFor(live, now),
    guide: fresh && pb?.guide?.at === open ? pb.guide : null, // the 15-minute forecast, for the round it was made for
    micro: state.micro?.read && now - state.micro.read.at < 20000 ? state.micro.read : null,
    cm: fresh ? pb?.candle?.live ?? null : null });
}
// The blend's fit (public/predict.js blendFit): weights and biases from the graded rounds (every logged minute), for the
// stretch of the round `mins` falls in (all minutes without it), refit when a round is graded
function blendNow(mins = null) {
  const n = state.predLog.filter((e) => e.actual != null).length, key = mins == null ? 'all' : blendBand(mins);
  if (state.blend?.n !== n) state.blend = { n, fits: {} };
  return (state.blend.fits[key] ||= blendFit(state.predLog, mins));
}
// the prediction engine's read (server), when it's fresh and for this round
function engineFor(live, now) {
  const e = state.playbook?.predictor;
  return e && now - (state.playbookAt || 0) < 20000 && e.closeTime === Date.parse(live.m.close_time) && e.strike === live.strike ? e : null;
}
// The prediction candles and the flip forecast behind them (public/predict.js, public/flip.js), for the chart and grading
function flipNow(live, snap, now) {
  if (chartState.show?.flips === false || !live) return null;
  const since = now - 60000, last = tape.ex.filter((x) => x.t >= since);
  const usdOf = (side) => last.reduce((a, x) => a + (x.side === side ? x.price * x.size : 0), 0), b = usdOf('buy'), tot = b + usdOf('sell');
  state.flipBase = turnBaseRate(snap.bars.slice(-150, -1), 0.5 * modelSpot() * (live.sigma ?? snap.sigmaMin));
  return flipForecast({ bars: snap.bars, spot: modelSpot(), sigmaMin: live.sigma ?? snap.sigmaMin, now, openTime: Date.parse(live.m.open_time), flowBuyShare: tot > 0 ? b / tot : null,
    amp: flipRecord(state.flipLog, state.flipBase).amp, reversal: state.playbook?.reversal && now - state.playbook.reversal.at < 16 * 60000 ? state.playbook.reversal : null });
}
// The expected path (public/predict.js): the cone's centre, its minute-by-minute points (graded each minute) and turns (↺)
function pathNow(live, snap, now, lines = predictionsNow(live, snap, now)) {
  if (!live) return { minutes: [], turns: [], flip: null, path: null };
  const flip = flipNow(live, snap, now), sigma = live.sigma ?? snap.sigmaMin, spot = modelSpot();
  const close = Date.parse(live.m.close_time), mins = Math.max(0, (close - now) / 60000), fit = blendNow(mins), weights = fit.weights, beta = pathRecord(state.pcLog).beta;
  const move = spot * sigma * Math.sqrt(mins); // a typical move to the close: the fit's biases are in these
  lines = correctLines(scaleLines(lines, fit.scale, spot), Object.fromEntries(Object.entries(fit.bias).map(([k, b]) => [k, b * move])), now, close); // each line's moves scaled to how far they really carry, minus its measured bias
  const final = fit.final, minutes = pathMinutes({ lines, spot, sigmaMin: sigma, now, close: horizonOf(live, now), weights, flip, beta, final });
  return { lines, minutes, turns: flip ? pathTurns(minutes, spot, now, flip.sd1, flip.v0) : [], flip, beta, path: expectedPath({ lines, spot, now, weights, flip, beta, final }) };
}
// The market radar (public/radar.js): calls about this round that hold 90%+ of the time, from the bot's own record
function radarNow(live, snap, now, pcs = pathNow(live, snap, now)) {
  if (!live || !pcs.path) return null;
  const close = Date.parse(live.m.close_time), mins = Math.max(0, (close - now) / 60000), spot = modelSpot(), sigma = live.sigma ?? snap.sigmaMin, m0 = pcs.minutes[0];
  return radarRead({ log: state.predLog, pcLog: state.pcLog, expected: pcs.path(close), sd: spot * sigma * Math.sqrt(mins), mins, target: live.strike, next: m0 ? { t: m0.t, c: m0.c, sd: spot * sigma } : null });
}
// The cone (public/predict.js marketCone): centred on the expected path, skewed by the last hour, calibrated on its record
function coneNow(live, snap, now, path, until = Date.parse(live.m.close_time)) {
  return marketCone({ path, spot: modelSpot(), sigmaMin: live.sigma ?? snap.sigmaMin, now, close: until, bars: snap.bars, strike: live.strike, strikeType: live.m.strike_type, fix: coneRecord(state.coneLog).fix });
}
// At every whole minute of the round (14 down to 1 minute left) keep each line's close prediction, the typical move to
// the close and the blend's own forecast (for the blend's fit and its scoreboard); with 5 minutes left also the card's
// record. After the close, grade them against where BTC closed (the close of Coinbase's last 1-minute candle of the
// round), next to "no change" as the baseline
function trackPredictions(snap, live, now) {
  const ml = live?.ev.minutesLeft, m = Math.round(ml ?? 0);
  let pe = live ? state.predLog.find((e) => e.ticker === live.m.ticker) : null;
  const cpDue = live && m >= 1 && m <= 14 && Math.abs(ml - m) < 0.25 && !pe?.cps?.[m], fiveDue = live && ml <= 5 && ml > 4 && pe?.at == null;
  const lines = cpDue || fiveDue ? predictionsNow(live, snap, now) : [];
  if (lines.length) {
    if (!pe) { pe = { ticker: live.m.ticker, closeTime: live.m.close_time, actual: null, cps: {} }; state.predLog.unshift(pe); if (state.predLog.length > 300) state.predLog.length = 300; }
    if (cpDue) {
      pe.off = Math.round((modelSpot() - state.spot) * 100) / 100; // the index offset the predictions are priced in (added to Coinbase's close when grading)
      const cents = (v) => Math.round(v * 100) / 100, c = { sd: cents(modelSpot() * (live.sigma ?? snap.sigmaMin) * Math.sqrt(ml)) };
      for (const l of lines) c[l.key] = cents(l.end);
      const pcs = pathNow(live, snap, now, lines), rd = radarNow(live, snap, now, pcs);
      c.blend = cents(pcs.path(Date.parse(live.m.close_time)));
      if (rd) c.r = { f: cents(rd.floor), c: cents(rd.ceil), l: cents(rd.lo), h: cents(rd.hi), d: rd.dir, tg: live.strike }; // the radar's calls, graded at the close
      (pe.cps ||= {})[m] = c;
    }
    if (fiveDue) {
      pe.at = now; pe.spot = modelSpot();
      for (const l of lines) pe[l.key] = l.end;
      // the cone's close band and its chance above the target, next to Kalshi's price for the same thing
      const cs = coneNow(live, snap, now, pathNow(live, snap, now, lines).path).summary, q = live.ev.quote;
      const mid = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null;
      if (cs) {
        state.coneLog.unshift({ ticker: live.m.ticker, closeTime: live.m.close_time, at: now, off: Math.round((modelSpot() - state.spot) * 100) / 100, mid: cs.mid, a: cs.a, b: cs.b, strike: live.strike, pAbove: cs.pAbove, kAbove: mid == null ? null : /^less/.test(live.m.strike_type || '') ? 1 - mid : mid, actual: null });
        if (state.coneLog.length > 300) state.coneLog.length = 300;
        store.set(LK('coneLog'), state.coneLog);
      }
    }
    store.set(LK('predLog'), state.predLog);
  }
  let coneChanged = false;
  for (const e of state.coneLog) {
    if (e.actual != null) continue;
    const close = Date.parse(e.closeTime);
    if (now < close + 70000) continue;
    const bar = snap.bars.find((b) => b.t === close - 60000);
    if (bar) { e.actual = bar.c + (e.off || 0); coneChanged = true; } else if (now > close + 3 * 3600000) { e.gone = true; coneChanged = true; }
  }
  if (coneChanged) { state.coneLog = state.coneLog.filter((e) => !e.gone); store.set(LK('coneLog'), state.coneLog); }
  let changed = false;
  for (const e of state.predLog) {
    if (e.actual != null) continue;
    const close = Date.parse(e.closeTime);
    if (now < close + 70000) continue;
    const bar = snap.bars.find((b) => b.t === close - 60000);
    if (bar) { e.actual = bar.c + (e.off || 0); changed = true; } else if (now > close + 3 * 3600000) { e.actual = undefined; e.gone = true; changed = true; }
  }
  if (changed) { state.predLog = state.predLog.filter((e) => !e.gone); store.set(LK('predLog'), state.predLog); }
  // the expected path: keep the next minute as it stands just before that minute begins; grade it at its close
  if (live) {
    const next = Math.floor(now / 60000) * 60000 + 60000;
    if (next < horizonOf(live, now) && next - now <= 15000) {
      const pcs = pathNow(live, snap, now), c = pcs.minutes[0];
      if (c && c.t === next) {
        const e = state.pcLog.find((x) => x.t === next), rn = radarNow(live, snap, now, pcs)?.next;
        const beta = pathRecord(state.pcLog).beta, rec = { o: c.o, c: c.c, beta, off: Math.round((modelSpot() - state.spot) * 100) / 100, sd: modelSpot() * (live.sigma ?? snap.sigmaMin), ...(rn && rn.t === next ? { lo: rn.lo, hi: rn.hi } : {}) };
        if (e) Object.assign(e, rec); else { state.pcLog.unshift({ t: next, ...rec, open: null, actual: null }); if (state.pcLog.length > 500) state.pcLog.length = 500; }
      }
    }
  }
  let pcChanged = false;
  for (const e of state.pcLog) {
    if (e.actual != null || now < e.t + 70000) continue;
    const bar = snap.bars.find((b) => b.t === e.t);
    if (bar) { e.open = bar.o + (e.off || 0); e.actual = bar.c + (e.off || 0); pcChanged = true; } // on the index scale the path is priced in else if (now > e.t + 3600000) { e.gone = true; pcChanged = true; }
  }
  if (pcChanged) { state.pcLog = state.pcLog.filter((e) => !e.gone); store.set(LK('pcLog'), state.pcLog); }
  // flips: keep each predicted turn until a minute before it (then it's frozen); grade it two minutes after
  if (live && now - (state.flipAt || 0) > 5000) {
    state.flipAt = now;
    const { turns, flip } = pathNow(live, snap, now);
    state.flipNow = flip;
    let changed = false;
    for (const e of state.flipLog) if (!e.frozen && now >= e.t - 60000) { e.frozen = true; changed = true; }
    const before = state.flipLog.length;
    state.flipLog = state.flipLog.filter((e) => e.frozen || turns.some((x) => x.t === e.t && x.dir === e.dir));
    if (state.flipLog.length !== before) changed = true;
    for (const x of turns) if (x.t - now >= 60000 && !state.flipLog.some((e) => e.t === x.t && e.dir === x.dir)) { state.flipLog.unshift({ t: x.t, dir: x.dir, at: now, need: 0.5 * flip.sd1, score: flip.score, frozen: false, hit: null }); changed = true; }
    for (const e of state.flipLog) if (e.frozen && e.hit == null && now > e.t + 190000) { const h = turnHappened(snap.bars, e.t, e.dir, e.need); if (h != null) { e.hit = h; changed = true; } else if (now > e.t + 3600000) { e.hit = 'gone'; changed = true; } }
    if (changed) { state.flipLog = state.flipLog.filter((e) => e.hit !== 'gone').slice(0, 400); store.set(LK('flipLog'), state.flipLog); }
  }
  const fr = flipRecord(state.flipLog, state.flipBase), f = state.flipNow;
  setHTML($('flipInfo'), (f ? `<b>Flip watch:</b> ${f.v0 >= 0 ? 'rising' : 'falling'} ${Math.abs(f.v0) < 1 ? '(barely)' : `$${Math.abs(f.v0).toFixed(0)}/min`} · ${f.dir === 'up' ? 'bounce' : 'pullback'} odds <b>${Math.round(f.score * 100)}%</b>${f.parts.length ? `: ${f.parts.map((p) => esc(p.why)).join(' · ')}` : ': no turn signs'}. ` : '')
    + (fr.n ? `Turns called: caught <b>${fr.hits} of ${fr.n}</b> (${Math.round(fr.rate * 100)}%)${fr.base != null ? ` vs <b>${Math.round(fr.base * 100)}%</b> for a random minute` : ''}${fr.n >= 20 ? ` · strength ×${fr.amp.toFixed(2)}` : ''}`
      : 'Each predicted turn (↺) is checked afterwards: did price really make a V there? The record shows up here next to how often a random minute looks like one.'));
  const cr = coneRecord(state.coneLog);
  if (!live) state.coneSum = null;
  else if (!(now - (state.coneSumAt || 0) < 5000)) { state.coneSumAt = now; state.coneSum = coneNow(live, snap, now, pathNow(live, snap, now).path, Date.parse(live.m.close_time)).summary; } // every 5 s
  if (!live) state.radar = null;
  else if (!(now - (state.radarAt || 0) < 5000)) { state.radarAt = now; state.radar = radarNow(live, snap, now); } // every 5 s
  renderRadar(state.radar, modelSpot());
  renderAccuracy(now);
  const cs = state.coneSum, $$ = (x) => usd(x, 0);
  setHTML($('coneRead'), (cs ? `Cone: most likely close <b>${$$(cs.lo50)}–${$$(cs.hi50)}</b> (50%) · 90%: ${$$(cs.lo90)}–${$$(cs.hi90)} · <b>${Math.round(cs.pAbove * 100)}%</b> chance of finishing above the target${Math.abs(cs.skew.up - cs.skew.dn) > 0.15 ? ` · ${cs.skew.dn > cs.skew.up ? 'downside' : 'upside'} wider (the last hour's ${cs.skew.dn > cs.skew.up ? 'drops' : 'rallies'} were sharper)` : ''}. ` : '')
    + (cr.n ? `Record (${int(cr.n)} rounds, at 5 min left): the 50% band held <b>${Math.round(cr.in50 * 100)}%</b> of closes, the 90% band <b>${Math.round(cr.in90 * 100)}%</b>${Math.abs(cr.fix - 1) > 0.02 ? ` (now ${cr.fix > 1 ? 'widened' : 'narrowed'} ×${cr.fix.toFixed(2)} to match)` : ''}${cr.nKalshi >= 5 ? ` · above-the-target chance scored ${cr.brierSame.toFixed(3)} vs Kalshi's price ${cr.brierKalshi.toFixed(3)} (Brier, lower is better)` : ''}.`
      : 'The cone is graded each round: does the close land inside its 50% and 90% bands, and is its above-the-target chance better than Kalshi\'s price? It recalibrates its width from that record.'));
  const pr = pathRecord(state.pcLog);
  const cmr = state.playbook?.report && state.playbook?.candle?.report, moveOn = cmr && Object.entries(cmr.move).filter(([, x]) => x.proven).map(([h]) => h);
  setHTML($('pcRecord'), pr.n ? `The expected path (the cone's centre), graded every minute (${int(pr.n)} minute${pr.n === 1 ? '' : 's'}): direction right <b>${pr.called ? Math.round(pr.right / pr.called * 100) : 0}%</b> of ${int(pr.called)} called · average miss at the minute's close <b>$${pr.miss.toFixed(0)}</b> vs <b>$${pr.still.toFixed(0)}</b> for "no change" · scaled <b>×${pr.beta.toFixed(2)}</b> by its own record`
      + `${cmr ? `. Move model (walk-forward on ${int(cmr.rows)} past minutes): ${moveOn.length ? `<b>on</b> at ${moveOn.join(', ')} min` : 'off (no horizon beats "no change")'}` : ''}`
    : 'The expected path (the cone\'s centre) is graded every minute: the direction and close it predicted vs what that minute really did.');
  const r = predictionRecord(state.predLog), fit = blendNow(), wsum = fit.known.reduce((a, k) => a + fit.weights[k], 0) || 1;
  const rows = Object.entries(r.lines).sort((a, b) => a[1].miss - b[1].miss);
  const cell = ([k, x]) => `${LINE_NAMES[k] || k} <b>$${x.miss.toFixed(0)}</b>${fit.known.includes(k) ? ` (${Math.round(fit.weights[k] / wsum * 100)}% of the blend${Math.abs((fit.scale[k] ?? 1) - 1) >= 0.05 ? `, moves ×${fit.scale[k].toFixed(2)}` : ''}${Math.abs(fit.bias[k]) >= 0.05 ? `, bias ${fit.bias[k] >= 0 ? '+' : '−'}${Math.round(Math.abs(fit.bias[k]) * 100)}% of a typical move removed` : ''})` : ''}`;
  const sc = blendScore(state.predLog), d = (x) => `$${x.toFixed(0)}`;
  setHTML($('predRecord'), (r.rounds ? `Prediction lines, average miss at the close (${r.rounds} round${r.rounds === 1 ? '' : 's'}, called with 5 min left): ${rows.map(cell).join(' · ')}. Each line's moves are scaled to how far they've really carried, then the lines are blended by their error covariance (lines that miss together share weight)${Math.abs(fit.final - 1) >= 0.05 ? ` and the blended move ×${fit.final.toFixed(2)}` : ''}, learned from every minute of every round and fitted separately for early, middle and late in the round. `
    : `Prediction lines are graded each round: what each one said at every minute vs where ${MKT.key} closed (keep the app open through a few rounds). `)
    + (sc.n ? `Blend scoreboard (${int(sc.n)} calls over ${int(sc.rounds)} round${sc.rounds === 1 ? '' : 's'}, every minute, out of sample): blend <b>${d(sc.blend)}</b> average miss`
      + `${sc.still != null ? ` vs <b>${d(sc.still)}</b> for "no change"` : ''}${sc.best ? ` · best single line ${LINE_NAMES[sc.best.key] || sc.best.key} <b>${d(sc.best.miss)}</b> vs the blend's ${d(sc.best.blend)} on the same calls` : ''}` : ''));
}
// The radar card: a radar screen (public/radar.js scopeSvg: the 90% range ring, floor and ceiling, the target, the price now,
// the next minute's band and every exchange's blip),
// the direction verdict, the calls and their record
// Every exchange right now (from the live trades, global markets' prices aligned to USD): its latest price (last 20 s)
// and its last minute's net taker flow, for the radar's blips
function venueRead(now = Date.now()) {
  const last = {}, net = {};
  for (let i = tape.recent.length - 1; i >= 0; i--) {
    const x = tape.recent[i];
    if (x.t < now - 60000) break;
    if (!(x.ex in last) && x.t >= now - 20000) last[x.ex] = x.price;
    net[x.ex] = (net[x.ex] || 0) + (x.side === 'buy' ? 1 : -1) * x.price * x.size;
  }
  return Object.entries(last).map(([ex, price]) => ({ ex, price, net: net[ex] || 0 }));
}
// Where the beam is in its sweep (ms into the 4 s period), so each blip flares as the beam passes it
function beamPhase() {
  try { const t = $('radarBeam')?.getAnimations?.()[0]?.currentTime; return Number.isFinite(t) ? t % SCOPE.period : null; } catch { return null; }
}
function renderRadar(rd, spot) {
  const $$ = (x) => usd(x, 0), rec = radarRecord(state.predLog, state.pcLog), ven = venueRead();
  if (!rd) {
    setHTML($('radarScope'), scopeIdle()); setText($('radarState'), ''); setHTML($('radarDir'), 'The radar starts with a live round.'); setHTML($('radarCalls'), ''); setHTML($('radarVenues'), '');
  } else {
    setHTML($('radarScope'), scopeSvg(rd, spot, ven, { phase: beamPhase() }));
    const wide = rd.levels ? Math.max(rd.levels.floor.level, rd.levels.ceil.level, rd.levels.range.level) : 0.9;
    setText($('radarState'), rd.sure ? `90%+ by its own record: ${int(rd.n)} past minutes${rd.stretch ? ' at this stage of the round' : ''}${wide > 0.9 + 1e-9 ? ` · bands set up to ${Math.round(wide * 100)}% so they still hold 90% when BTC's moods change` : ''}` : `Learning: normal-curve 90% until 9 graded minutes (${int(rd.n)} so far)`);
    setHTML($('radarDir'), !(rd.target > 0) ? '' : rd.dir ? `<b class="${rd.dir === 'UP' ? 'pos' : 'neg'}">${rd.dir}</b>, 90%+: even the 90% ${rd.dir === 'UP' ? `floor (${$$(rd.floor)}) is above` : `ceiling (${$$(rd.ceil)}) is below`} the target (${$$(rd.target)})`
      : `<b>No 90% direction call</b>: the expected close (${$$(rd.expected)}) is ${$$(rd.need)} short of a 90% margin from the target (${$$(rd.target)}). It comes when BTC moves further from the target or the time left runs down`);
    setHTML($('radarCalls'), [`Closes above <b>${$$(rd.floor)}</b>`, `Closes below <b>${$$(rd.ceil)}</b>`, `Closes between <b>${$$(rd.lo)}</b> and <b>${$$(rd.hi)}</b>`, rd.next ? `Next minute closes between <b>${$$(rd.next.lo)}</b> and <b>${$$(rd.next.hi)}</b>` : null]
      .filter(Boolean).map((t) => `<li>${t} <small>${rd.sure ? '90%+' : '≈90% (learning)'}</small></li>`).join(''));
    const above = rd.target > 0 ? ven.filter((v) => v.price > rd.target).length : 0, buyers = ven.filter((v) => v.net > 0).length;
    setHTML($('radarVenues'), ven.length ? `<b>${ven.length} exchange${ven.length === 1 ? '' : 's'}</b> on the scope right now${rd.target > 0 ? `: <b class="${above * 2 >= ven.length ? 'pos' : 'neg'}">${above} above</b> the target, ${ven.length - above} below` : ''} · buyers leading on <b>${buyers}</b>, sellers on <b>${ven.filter((v) => v.net < 0).length}</b> (last minute)` : 'Exchange blips show here once the live feeds are streaming.');
  }
  const pct = (x) => `<b>${Math.round(x.rate * 100)}%</b> (${int(x.n)})`, parts = [['floor held', rec.floor], ['ceiling', rec.ceil], ['range', rec.range], ['next minute', rec.next]].filter(([, x]) => x.n).map(([k, x]) => `${k} ${pct(x)}`);
  if (rec.dir.n) parts.push(`direction <b>${rec.dir.hit} of ${rec.dir.n}</b>`);
  setHTML($('radarRecord'), parts.length ? `Radar record (graded at each close): ${parts.join(' · ')}` : 'Every radar call is graded at the close; the record shows here whether 90% really held.');
}
// Why buys are paused right now, if they are (public/profitguard.js): today's trades past the daily loss limit, or the
// level's profit guard. The loss stop is synced to the server so its push alerts stop too.
// The early lane's proof so far (the server's record), for the call card
function earlyStatus() {
  const e = state.botRecord?.early;
  if (!e) return '';
  return e.n ? ` (${int(e.n)} graded: won ${Math.round(e.wins / e.n * 100)}%, break-even ${Math.round((e.need ?? 0) * 100)}%)` : '';
}
function levelCalls() {
  const lvl = riskLevelOf(settings);
  return lvl === OFFICIAL_LEVEL ? state.botRecord?.calls : lvl === 'certain' ? state.botRecord?.certain?.calls : state.callLog;
}
function buyBlock(now = Date.now()) {
  const dl = dailyLoss(state.trades, settings.dailyLossLimit, now), until = dl.hit ? dl.until : 0;
  if ((settings.lossStopUntil || 0) !== until && (dl.hit || settings.lossStopUntil > now)) { settings.lossStopUntil = until; store.set('settings', settings); pushSyncSoon(); }
  if (dl.hit) return { kind: 'loss', dl };
  const pg = profitGuard(levelCalls());
  return pg.paused ? { kind: 'profit', pg } : null;
}
// The accuracy card (public/accuracy.js): every predictor's record next to its baseline, and the report to copy
function accuracyNow() {
  const br = state.botRecord, bot = br?.graded != null ? br : callStats(state.callLog);
  return accuracyRows({ bot, predictor: state.playbook?.report?.predictor ?? null, blend: blendScore(state.predLog), path: pathRecord(state.pcLog), cone: coneRecord(state.coneLog),
    radar: radarRecord(state.predLog, state.pcLog), flip: flipRecord(state.flipLog, state.flipBase), tune: state.memory?.learned?.volTune ?? null,
    guard: { level: RISK_LEVELS[riskLevelOf(settings)]?.label ?? 'your settings', ...profitGuard(levelCalls()) }, flipStudy: state.tune?.report?.flipStudy ?? null,
    trades: { n: state.trades.length, total: state.trades.reduce((a, t) => a + (t.pnl || 0), 0), today: dailyLoss(state.trades, settings.dailyLossLimit) } });
}
function renderAccuracy(now = Date.now()) {
  if (now - (state.accAt || 0) < 5000) return;
  state.accAt = now;
  setHTML($('accList'), accuracyNow().map((r) => `<div class="acc-r ${r.verdict}"><b>${esc(r.name)}${r.verdict === 'wait' ? ` <small>(${int(r.n)} so far)</small>` : ''}</b><span>${esc(r.metric)}</span>${r.vs ? `<small>${esc(r.vs)}</small>` : ''}</div>`).join(''));
}
async function copyAccuracy() {
  const text = JSON.stringify(accuracyReport(accuracyNow(), { version: $('version')?.textContent ?? null, market: { series: settings.series, name: marketLabel(MKT) } }), null, 1);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch { /* no clipboard */ }
  }
  setText($('accNote'), ok ? 'Copied. Paste it into a message to whoever tunes the bot.' : 'Couldn\'t reach the clipboard on this device.');
}
// Buys and sells to flag on the chart: the server Auto-trader's fills (its log) and the positions you track
function chartFills() {
  const out = [];
  for (const x of autopilot?.state()?.log || []) {
    if (x.kind !== 'fill') continue;
    const m = /^(BUY|SELL HIGH|BAIL) (UP|DOWN) (\d+)/.exec(x.text) || /the (UP|DOWN) (buy|sell) went through \((\d+)/.exec(x.text);
    if (!m) continue;
    const kind = m[1] === 'BUY' || m[2] === 'buy' ? 'buy' : m[1] === 'BAIL' ? 'bail' : 'sell';
    const side = m[1] === 'UP' || m[1] === 'DOWN' ? m[1] : m[2];
    out.push({ t: x.t, kind, label: `🤖 ${side} ${m[3]}` });
  }
  for (const p of state.positions) out.push({ t: p.at, kind: 'buy', label: `${p.side === 'YES' ? 'UP' : 'DN'} ${+p.contracts.toFixed(0)}` });
  for (const tr of state.trades.slice(0, 50)) if (tr.how === 'sold' && tr.closedAt) out.push({ t: tr.closedAt, kind: 'sell', label: `${tr.side === 'YES' ? 'UP' : 'DN'} ${+tr.contracts.toFixed(0)}` });
  return out;
}
// 1-minute candles with the live price folded into the current minute
function withLive(bars, now) {
  if (!bars.length || !state.spot) return bars;
  const t = Math.floor(now / 60000) * 60000, last = bars[bars.length - 1], s = state.spot;
  if (last.t === t) return [...bars.slice(0, -1), { ...last, c: s, h: Math.max(last.h, s), l: Math.min(last.l, s) }];
  return [...bars, { t, o: last.c, h: Math.max(last.c, s), l: Math.min(last.c, s), c: s, v: 0 }];
}

// The Deck's draw, guarded (v13.42.2): one bad value (often something saved on the phone) used to throw on every tick and
// leave the whole Deck blank. Now the error shows on the card, and if it keeps happening the phone clears this market's
// saved logs and reloads, once a session.
let renderFails = 0, renderFailSince = 0; // the Deck redraws several times a second: a moment's glitch must not wipe anything
const MARKET_CACHES = ['calls', 'ruleLog', 'callLog', 'flipLog', 'coneLog', 'pcLog', 'predLog', 'whyLog', 'marketMemory', 'lastSpot'];
function render() {
  try { renderNow(); renderFails = 0; renderFailSince = 0; } catch (e) { renderFailed(e); }
}
function renderFailed(e) {
  console.error('render failed', e);
  renderFails++;
  renderFailSince ||= Date.now();
  const stuck = renderFails >= 3 && Date.now() - renderFailSince >= 10000; // failing for 10 s or more, not a one-off
  setClass($('status'), 'dot err');
  $('status').title = `Couldn't draw the Deck: ${e.message}`;
  const key = `scHealed:${settings.series}`;
  let healed = true; try { healed = !!sessionStorage.getItem(key); } catch { /* storage blocked */ }
  setText($('reason'), `Couldn't draw this round (${e.message}). ${!stuck ? 'Retrying…' : healed ? 'Still failing after clearing this market\'s saved data: send a screenshot of this.' : 'Clearing this market\'s saved data on the phone…'}`);
  if (!stuck || healed) return;
  try { sessionStorage.setItem(key, '1'); for (const k of MARKET_CACHES) localStorage.removeItem(LK(k)); } catch { /* storage blocked */ }
  location.reload();
}
function renderNow() {
  state.renderedAt = Date.now();
  state.clock = null;
  state.askRc = null;
  boardSide = null;
  const snap = compute();
  const { now, bars, sigmaMin, driftMin, rows, live } = snap;
  renderPositions(snap);
  const sig = live && state.spotAt ? buySignal(live, snap, withGuard(settings, state.botRecord?.guard?.floor), now, state.calls) : null; // never call off the cached price from last visit (90% target: the server's guard floor)
  if (sig?.fire) store.set(LK('calls'), state.calls);
  const block = buyBlock(now); // the daily loss limit or the profit guard: calls still show as paused, no buy alerts
  trackRule(snap, live, now);
  renderDeep(live, sig);
  state.liveCall = sig?.callSide ? { ...live, sig } : null;
  const showBuy = !!state.liveCall && !block && !state.positions.some((p) => p.ticker === live.m.ticker);
  setHidden($('boughtBtn'), !showBuy || !!state.kalshi.key); // linked: buys arrive from Kalshi on their own
  setHidden($('autoNote'), !showBuy || !state.kalshi.key);
  const card = $('callCard'), callEl = $('call'), entry = $('entry');
  const cardCls = ['card', 'call-card'], entryCls = ['entry'];
  let timing = null;

  if (!live) {
    setText($('marketTitle'), state.marketsAt ? `No open ${settings.series} markets` : 'Loading markets…');
    setText(callEl, '—'); setClass(callEl, 'call pass');
    ['countdown', 'reason', 'order', 'entry', 'callLabel', 'odds'].forEach((id) => setText($(id), ''));
    entry.hidden = true;
  } else if (!sig) {
    // v13.43.3 the round is loaded but there's no fresh price yet (only last visit's, marked DELAYED): the bot's own call waits
    // for one, the round call doesn't (the server's pick, or Kalshi's favourite). This used to throw and blank the Deck.
    const { m, ev } = live;
    setText($('marketTitle'), m.title || m.ticker);
    setText($('countdown'), `closes in ${mmss(ev.minutesLeft)}`);
    state.clock = { close: Date.parse(m.close_time), callsAt: null };
    roundBar(state.clock.close, now);
    const rcRaw = ev.minutesLeft <= 10 ? roundCallFor(live, snap, now) : null, locking = !!rcRaw?.locking, rc = locking ? null : rcRaw;
    boardSide = rc?.side ?? null;
    state.askRc = rc;
    if (setText(callEl, rc ? (rc.side === 'YES' ? 'UP' : 'DOWN') : locking ? '…' : 'SIT OUT')) pop(callEl);
    setClass(callEl, rc ? `call ${rc.side.toLowerCase()} round` : 'call pass');
    setText($('callLabel'), rc ? 'ROUND CALL · LEAN, NOT A BUY' : locking ? 'Locking the round call…' : 'Waiting for a live price');
    setText($('callSub'), rc ? `${MKT.key} ${rc.side === 'YES' ? 'above' : 'below'} ${usd(rc.strike ?? live.strike, 0)} at close${rc.p != null ? ` · ${Math.round(rc.p * 100)}%` : ''}` : '');
    setText($('reason'), rc ? `The round call for this round${rc.fallback ? ` (${rc.why})` : ''}. Buy calls wait for a live ${MKT.key} price.` : `Getting a live ${MKT.key} price. The round call comes at 10:00 left.`);
    ['order', 'odds'].forEach((id) => setText($(id), ''));
    entry.hidden = true;
    if (rc) cardCls.push(rc.side.toLowerCase(), 'round');
  } else {
    const { m, ev, strike } = live;
    const { side, buyNow } = sig;
    const call = sig.callSide; // a low price that passed the robust-edge and deep-dive checks (or a call it's sticking with)
    timing = sig.timing;
    const limit = side && timing.dipLevel ? dipLimit({ market: m, strike, spot: state.spot, dipLevel: timing.dipLevel, sigmaMin, driftMin, side, now, settings: { ...settings, volTails: snap.volTails ?? 0, momentumWeight: snap.momentumWeight ?? settings.momentumWeight } }) : null;

    setText($('marketTitle'), m.title || m.ticker);
    setText($('countdown'), `closes in ${mmss(ev.minutesLeft)}`);
    const waitingToCall = ev.callsAt && now < ev.callsAt;
    state.clock = { close: Date.parse(m.close_time), callsAt: waitingToCall ? ev.callsAt : null };
    roundBar(state.clock.close, now);
    if (waitingToCall && sig.deep) { // a read on the window, not a call yet
      setClass($('conf'), 'conf');
      setText($('conf'), `Preview · confidence ${sig.deep.score} · no call yet`);
    }
    const otherSide = sig.called === 'YES' ? 'NO' : 'YES';
    const sticking = sig.stance === 'holding' && now - (sig.calledAt ?? now) > 60000; // the first minute of a call is just the call
    setText($('reason'), call && sig.sticking && sig.locked ? `Steady: the call is locked for this round. Confidence now ${sig.deep?.score ?? '—'}${sig.hold != null ? `, stays above ${Math.round(settings.holdFloor * 100)} to the end in ${Math.round(sig.hold * 100)}% of paths` : ''}.${sig.flip?.why && sig.flip.why !== 'off' ? ` It flips only on clear evidence; not yet: ${sig.flip.why}.` : ''}`
      : call && sig.sticking ? `${sideName(otherSide)} looks a little better this tick, but not by enough to drop the call. Sticking with it.`
      : call && sticking ? 'Called earlier and still a buy: one tick of movement isn\'t a reason to change.'
      : call && sig.lane === 'flip' ? `FLIP: the round turned. The bot switched from its earlier ${sig.flip?.from ? sideName(sig.flip.from) : ''} call because it's now 90%+ sure of ${sideName(call)} even in its worst case, the other side cleared the full bar for a call, and it held steady. Half size; if you hold the earlier side, its bail alert says when to sell.`
      : call && sig.lane === 'early' ? `Early lane: called while Kalshi asked ${Math.round((sig.price ?? 0) * 100)}¢, with the bot clearly surer even in its worst case. Half size: earlier means more can still change, and wins here are bigger but losses more likely than at 90¢+.${earlyStatus()}`
      : call && sig.lane === 'late' ? `Late lane (last ${settings.lateMin ?? 5} min): even with ${settings.lateVol ?? 1.35}× volatility and fat tails it wins ${sig.late?.p != null ? (sig.late.p * 100).toFixed(1) : '97+'}% by the bot's math. Half size: a win this late pays a few cents, a loss costs the stake.`
      : call ? '' : waitingToCall ? `Calls start in ${mmss((ev.callsAt - now) / 60000)} (bot watches the first ${settings.waitMinutes} min)`
      : sig.cooldown ? `Just sold on this market. A fresh call can come in ${sig.cooldown}s if the gap is still there.`
      : sig.called && sig.stance === 'holding' ? `Called ${sideName(sig.called)} earlier. That edge has faded, so no new buy; if you're in, the position card says when to sell.`
      : sig.called && sig.stance === 'switching' && ev.side ? `Called ${sideName(sig.called)} earlier. ${sideName(ev.side)} looks cheap now, but switching needs a ${(sig.edgeNeed * 100).toFixed(0)}-pt gap and confidence ${sig.confNeed}.`
      : ev.side && settings.doubleRejRule !== false && live.rej?.double && live.rej.double.dir !== (ev.side === 'YES' ? 1 : -1) ? `${sideName(ev.side)} looks cheap, but not calling it: ${live.rej.double.label}`
      : sig.watchHold ? `Market watch has new calls on hold until ${clock(sig.watchHold.until)}: ${sig.watchHold.why}`
      : sig.gated?.lesson ? `Confidence ${sig.deep?.score ?? '—'}, but not buying: a lesson from past losses (${sig.gated.lesson.label.toLowerCase()}: ${sig.gated.lesson.why}) shows calls like this win less often than their price needs.`
      : sig.gated ? `Confidence ${sig.deep?.score ?? '—'}, but the call filter skipped it: calls like this have won ${Math.round(sig.gated.pWin * 100)}% in the bot's record, and at ${Math.round((sig.gated.side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk) * 100)}¢ it needs ${Math.round(sig.gated.need * 100)}% to pay.`
      : !sig.called && settings.noCallLastMin > 0 && ev.minutesLeft < settings.noCallLastMin ? `No new calls in the last ${settings.noCallLastMin} minutes: by now the outcome is mostly priced in, so a win pays only a few cents.`
      : sig.early?.would && !sig.early.live ? `Early read (paused, not a call): ${sideName(sig.early.would.side)} at ${Math.round(sig.early.would.price * 100)}¢, the bot's worst case ${Math.round(sig.early.would.p * 100)}%. Early calls are paused because their recent calls lost money after fees; they come back once their test calls are profitable again${earlyStatus()}.`
      : sig.late?.on && !sig.called && sig.late.why ? `Late lane (last ${settings.lateMin ?? 5} min): only stress-tested calls now. Not yet: ${sig.late.why}.`
      : ev.side && sig.robust && sig.deep && sig.deep.score >= sig.confNeed && !sig.holdOk ? `Confidence ${sig.deep.score}, but it stays above ${Math.round(settings.holdFloor * 100)} to the end in only ${sig.hold == null ? '—' : Math.round(sig.hold * 100)}% of simulated paths (Steady needs ${Math.round(settings.minHold * 100)}%). Waiting for a call that holds.`
      : ev.side && sig.robust && sig.deep && sig.deep.score >= sig.confNeed && !sig.steadyOk ? `Confidence ${sig.deep.score}: making sure it holds for ${sig.steadyNeed ?? settings.steadySec}s before calling (one good tick isn't enough${sig.stability?.level === 'stable' ? '; market 👍 so the wait is shorter' : sig.stability?.level === 'unstable' ? '; market unstable so the wait is longer' : ''}).`
      : ev.side && !sig.robust ? `Low price, but the gap drops to ${sig.robustEdge == null ? '—' : (sig.robustEdge * 100).toFixed(1)} pts if volatility is a bit off (need ${(sig.edgeNeed * 100).toFixed(0)})`
      : ev.side ? `Low price, but confidence ${sig.deep?.score ?? '—'} is below ${sig.confNeed}` : ev.reason);
    setHTML($('odds'), oddsRows(ev, settings.minEdge));

    // Call + entry timing
    const waiting = call && !buyNow && settings.waitForDip;
    setText($('callLabel'), call ? (waiting ? 'Low price, waiting for candle dip' : sig.lane === 'late' ? 'LATE CALL · BUY THE LOW' : sig.lane === 'early' ? 'EARLY CALL · BUY THE LOW' : sig.lane === 'flip' ? 'FLIP CALL · BUY THE LOW' : sig.stance === 'switching' ? 'SWITCH · BUY THE LOW' : sticking ? 'BUY THE LOW · sticking with it' : 'BUY THE LOW')
      : sig.called ? `Called ${sig.called} earlier · no new buy`
      : waitingToCall ? `Watching the first ${settings.waitMinutes} minutes` : !sig.called && settings.noCallLastMin > 0 && ev.minutesLeft < settings.noCallLastMin ? `Last ${settings.noCallLastMin} minutes · no new calls` : sig.early?.would && !sig.early.live ? 'Early read · paused, not a call' : sig.late?.on && sig.late.why ? 'Late lane · not safe enough yet' : sig.cooldown ? 'Just sold · re-entry soon' : ev.side && !sig.robust ? 'Low price, edge too thin'
      : ev.side && sig.deep && sig.deep.score >= sig.confNeed && !(sig.holdOk && sig.steadyOk) ? 'Low price, not steady yet' : ev.side ? 'Low price, not confident' : 'No low price');
    // v13.39 every round gets a call: from 10:00 left, no buy means the round call (the 10-minute pick), never SIT OUT
    const rcRaw = !call && !sig.bail && !waitingToCall && ev.minutesLeft <= 10 ? roundCallFor(live, snap, now) : null;
    const locking = !!rcRaw?.locking, rc = locking ? null : rcRaw; // the first seconds after 10:00 left: waiting for the server's pick
    state.askRc = rc;
    // the big word, set once a render so its pop plays only on a real change (bail and paused included)
    const paused = !!(block && call && !sig.bail);
    boardSide = call ?? rc?.side ?? (ev.pYes != null && ev.pYes !== 0.5 ? (ev.pYes > 0.5 ? 'YES' : 'NO') : null); // else the bot's lean
    if (setText(callEl, sig.bail ? 'BAIL OUT' : paused ? 'PAUSED' : call ? (call === 'YES' ? 'UP' : 'DOWN') : rc ? (rc.side === 'YES' ? 'UP' : 'DOWN') : locking ? '…' : 'SIT OUT')) pop(callEl);
    if (locking) { setText($('callLabel'), 'Locking the round call…'); setText($('reason'), 'The round call locks at 10:00 left; the side it locks is the side for the rest of the round.'); }
    setClass(callEl, sig.bail ? 'call bail' : paused ? 'call pass' : rc ? `call ${rc.side.toLowerCase()} round` : `call ${(call ?? 'pass').toLowerCase()}`);
    setText($('callSub'), call && strike ? `${MKT.key} ${call === 'YES' ? 'above' : 'below'} ${usd(strike, 0)} at close` : '');
    if (call) cardCls.push(call.toLowerCase());
    if (waiting) cardCls.push('waiting');
    if (rc) {
      const up = rc.side === 'YES', pcx = (x) => `${Math.round(x * 100)}%`;
      setText($('callLabel'), rc.buy ? 'ROUND CALL · BUY' : 'ROUND CALL · LEAN, NOT A BUY');
      setText($('callSub'), `${MKT.key} ${up ? 'above' : 'below'} ${usd(rc.strike ?? strike, 0)} at close · ${pcx(rc.p)}`);
      setText($('reason'), `Every round gets a call after the first 5 minutes: ${rc.fallback ? `${up ? 'UP' : 'DOWN'}, because ${rc.why.replace(/; a pick, not a buy$/, '')} (${pcx(rc.p)}). ` : `at 10:00 left the bot locked ${up ? 'UP' : 'DOWN'}, the likelier side by its odds and Kalshi's combined (${pcx(rc.p)}). `}${rc.buy ? `Worth buying at up to ${Math.round((rc.price ?? rc.ask) * 100)}¢.` : `Not a buy at this price${rc.why ? `: ${rc.why}` : ''}.`} ${/^(8|11|18)/.test(String(Math.round(rc.p * 100))) ? 'An' : 'A'} ${pcx(rc.p)} call still loses about ${1 - rc.p < 0.1 ? `${Math.max(1, Math.round((1 - rc.p) * 100))} in 100` : `${Math.round((1 - rc.p) * 10)} in 10`}.${rc.orig ? ` A lesson from past losses (${(rc.lessons || []).join(', ').toLowerCase()}) turned it from ${rc.orig.side === 'YES' ? 'UP' : 'DOWN'}.` : ''}${sig.lockedOut ? ` The bot leans ${up ? 'DOWN' : 'UP'} right now, but the round call is locked: it never switches.` : ''}`);
      cardCls.push(rc.side.toLowerCase(), 'round');
    }
    // The bot's call went bad: BAIL OUT (sig.bail, engine.js), shown for the rest of the round
    const bail = sig.bail;
    if (bail) {
      setText($('callSub'), `${bail.side === 'YES' ? 'UP' : 'DOWN'} call went bad${bail.bid ? ` · sell at ${Math.round(bail.bid * 100)}¢` : ''}`);
      setText($('reason'), `The bot's odds on its ${bail.side === 'YES' ? 'UP' : 'DOWN'} call fell to ${Math.round(bail.p * 100)}% (bail line ${Math.round((settings.bailBelow ?? 0.4) * 100)}%). If you bought it, sell now and keep ${bail.bid ? `about ${Math.round(bail.bid * 100)}¢ of each $1` : 'part of it'} instead of risking all of it.`);
      cardCls.length = 2; cardCls.push('bail');
      if (!state.alerted[`bail:${m.ticker}`]) {
        state.alerted[`bail:${m.ticker}`] = true;
        alerts.event('sell', `BAIL OUT: ${bail.side === 'YES' ? 'UP' : 'DOWN'}${bail.bid ? ` at ${Math.round(bail.bid * 100)}¢` : ''}`, `bot's odds fell to ${Math.round(bail.p * 100)}%`, `bail:${m.ticker}`);
      }
    }

    // Paused (daily loss limit or profit guard): the call is shown, but not as a buy
    if (block && call && !bail) {
      cardCls.length = 2;
      setText($('callLabel'), block.kind === 'loss' ? 'Daily loss limit hit · no buys today' : 'Profit guard · buys paused');
      setText($('callSub'), `The bot would call ${call === 'YES' ? 'UP' : 'DOWN'}, logged as a paper call`);
      setText($('reason'), block.kind === 'loss'
        ? `Your trades have lost ${money(block.dl.pnl)} today, past your ${dollars(block.dl.limit)} daily limit (Settings). Buy alerts are off until midnight so a bad day doesn't turn into chasing losses.`
        : `This level's last ${block.pg.n} calls lost ${money(block.pg.usd)} after fees ($10 a call, held to settlement), even if most of them won. Its buy alerts are paused; it keeps paper-calling, and the alerts come back on their own once those calls are making money again.`);
    }

    entry.hidden = !side;
    if (side) {
      const label = timing.state === 'NOW' ? `Candles: dip now, good timing for ${side}` : timing.state === 'CHASE' ? 'Candles: chasing, price just ran' : `Candles: no dip yet for ${side}`;
      entryCls.push(timing.state.toLowerCase());
      setHTML(entry, `<b>${label}</b><span>${esc(timing.reasons.slice(0, 4).join(' · '))}</span>` +
        (limit && timing.state !== 'NOW' ? `<span>Even lower: limit ${sideName(side)} at <b>${pc(limit.price)}</b> if ${MKT.key} hits ${usd(limit.dipLevel, 0)}</span>` : ''));
    }

    if (!call || block) setText($('order'), '');
    else if (buyNow || !settings.waitForDip) {
      const age = sig.calledAt ? Math.round((now - sig.calledAt) / 1000) : 0;
      setText($('order'), `Buy ${dollars(sig.contracts * sig.price)} at ${pc(sig.price)} ${sideName(call)}` +
        `${sig.limit ? ` · max ${pc(sig.limit)}, skip if higher` : ''} · +${(sig.edge * 100).toFixed(0)} pts edge${age >= 5 ? ` · called ${age}s ago` : ''}`);
    }
    else setText($('order'), limit ? `Limit ${dollars(sig.contracts * limit.price)} at ${pc(limit.price)} ${sideName(call)} (now ${pc(sig.price)})` : 'Hold off: no dip yet');

    // Record + alert: right away, or only on a confirmed low when waiting for the dip
    if (sig.fire) {
      if (logCall(state.callLog, { ticker: m.ticker, side: call, price: sig.price, conf: sig.deep?.score, at: now, closeTime: m.close_time, n: sig.callN, lane: sig.lane })) store.set(LK('callLog'), state.callLog);
      const key = `${m.ticker}:${call}:${sig.callN}`;
      if (!state.alerted[key] && !block) {
        state.alerted[key] = true;
        if (settings.notifyBuy) alert(buyMessage(live, sig, state.spot), 'buy', { ticker: m.ticker });
        if (alerts.prefs().lockAnim && !alerts.prefs().quiet) fx.lockIn({ side: call, conf: sig.deep?.score, hold: sig.hold, price: sig.price, confident: (sig.deep?.score ?? 0) >= 90 && (sig.hold ?? 0) >= 0.9 });
        alerts.event('call', `Call: ${call === 'YES' ? 'UP' : 'DOWN'} at ${pc(sig.price)}`, `confidence ${sig.deep?.score ?? '—'}${sig.hold != null ? ` · hold odds ${Math.round(sig.hold * 100)}%` : ''} · target ${usd(strike, 0)}`, key, Date.now(), callSound(call));
      }
    }
    // Aggressive scale-in: tell people who hold the call that the gap grew
    if (sig.add) {
      store.set(LK('calls'), state.calls);
      const key = `add:${m.ticker}:${sig.tier}`;
      if (state.positions.some((p) => p.ticker === m.ticker && p.side === call) && !state.alerted[key]) {
        state.alerted[key] = true;
        if (settings.notifyBuy) alert(addMessage(live, sig, state.spot), 'add', { ticker: m.ticker });
      }
    }

    setText($('strike'), usd(strike, 0));
    const d = modelSpot() && strike ? modelSpot() - strike : null;
    setText($('dist'), d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(Math.abs(strike) >= 1000 ? 0 : MKT.digits)} (${((d / strike) * 100).toFixed(2)}%)`);
    sign($('dist'), d);
    drawChart(bars, strike, Date.parse(m.open_time), timing, limit, live.rej);
  }
  setClass(card, cardCls.join(' ')); setClass(entry, entryCls.join(' '));
  state.askSnap = { snap, live, sig, block, now }; // what Ask reads (askFacts)
  renderDeck(snap, live, sig, now);

  setText($('spot'), usd(state.spot, 0)); // the coin's own precision under $1,000
  renderTicker(live?.strike ?? null);
  setText($('vol'), sigmaMin ? `${(sigmaMin * 100).toFixed(3)}%` : '—');
  const r = timing?.rsi;
  setText($('rsi'), r == null ? '—' : r.toFixed(0));
  setClass($('rsi'), r == null ? '' : r < 35 ? 'pos' : r > 65 ? 'neg' : '');
  setHTML($('levels'), timing?.support ? `<span class="neg">▲ ${int(timing.resistance)}</span><span class="pos">▼ ${int(timing.support)}</span>` : '—');

  setHTML($('others'), rows.filter((x) => x !== live && x.ev.minutesLeft > 0).slice(0, 6).map(({ m, ev }) =>
    `<div class="card mini"><span>${esc(m.yes_sub_title || m.ticker)}<br><small>${mmss(ev.minutesLeft)} · bot ${pct(ev.pYes)} YES</small></span>` +
    `<span class="pill ${ev.call.toLowerCase()}">${ev.call}</span></div>`).join(''));
  renderHistory();
}

// ---------- candlestick chart ----------
let chartKey = null;
function drawChart(allBars, strike, openTime, timing, limit, rej) {
  const cv = $('chart');
  const w = cv.clientWidth, h = 220, axis = 52;
  if (!w) return; // the Deck isn't showing: draw when it is
  // Redraw only when something on it changed (it used to redraw on every price tick)
  const lb = allBars[allBars.length - 1];
  const key = [w, allBars.length, lb?.t, lb?.o, lb?.h, lb?.l, lb?.c, strike, openTime, timing?.support, timing?.resistance, timing?.state, limit?.dipLevel, (rej?.events || []).length, Math.floor(Date.now() / 60000)].join('|');
  if (key === chartKey) return;
  chartKey = key;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
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

  const labels = []; // right-edge labels, spread apart below so they never print on top of each other
  const hline = (v, color, dash, text) => {
    if (v == null) return;
    ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(0, Y(v)); ctx.lineTo(w - axis, Y(v)); ctx.stroke(); ctx.setLineDash([]);
    labels.push({ y: Y(v) + 3, text, color, font: '10px system-ui' });
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

  // Last price tag, then every label, nudged apart
  const last = bars[bars.length - 1].c;
  labels.push({ y: Y(last) + 3, text: int(last), color: '#e6edf3', font: 'bold 10px system-ui', first: true });
  labels.sort((a, b) => a.y - b.y);
  for (let i = 0; i < labels.length; i++) labels[i].y = Math.max(10, labels[i].y, i ? labels[i - 1].y + 12 : 0);
  for (let i = labels.length - 1; i >= 0; i--) labels[i].y = Math.min(h - 4 - (labels.length - 1 - i) * 12, labels[i].y);
  for (const l of labels) { ctx.fillStyle = l.color; ctx.font = l.font; ctx.fillText(l.text, w - axis + 4, l.y); }
}

function renderHistory() {
  const tp = state.trades.reduce((a, t) => a + t.pnl, 0), tw = state.trades.filter((t) => t.pnl > 0).length;
  setText($('tPnl'), state.trades.length ? money(tp) : '—');
  sign($('tPnl'), tp);
  setText($('tWins'), state.trades.length ? `${tw}/${state.trades.length}` : '—');
  setHTML($('tradeList'), state.trades.slice(0, 50).map((t) =>
    `<li><span><b>${dollars(t.contracts * t.price)}</b> at ${pc(t.price)} ${sideName(t.side)} → ${t.how === 'settled' ? (t.exit ? 'won at close' : 'lost at close') : `sold at ${pc(t.exit)}`}` +
    `<small>bought ${clock(t.at)} → ${t.how === 'settled' ? 'settled' : 'sold'} ${clock(t.closedAt)} · ${esc(t.ticker)}</small></span><b class="${t.pnl >= 0 ? 'pos' : 'neg'}">${money(t.pnl)}</b></li>`).join('') ||
    '<li class="empty">Tap "I bought it" on a call to track a trade and get sell signals.</li>');
  renderRecord();
  renderMemory();
}

// What the bot has learned about the market (from the server, which watches every window around the clock)
function renderMemory() {
  const st = state.memory?.status;
  if (!st) { setText($('memSummary'), 'Not loaded yet. The server learns the market around the clock and shares it here.'); return; }
  const days = st.since ? Math.max(1, Math.round((Date.now() - st.since) / 86400000)) : 0;
  const lines = [];
  lines.push(st.minutes ? `Watched ${MKT.key} for ${days} day${days === 1 ? '' : 's'} (${st.minutes.toLocaleString()} one-minute moves)${st.backfilling ? ', still reading history' : ''}, graded ${st.windows.toLocaleString()} window${st.windows === 1 ? '' : 's'}.` : 'Just started watching the market.');
  if (st.busiest) lines.push(`Busiest half hour: ${slotLabel(st.busiest.slot)} (${st.busiest.x.toFixed(1)}× normal volatility). Quietest: ${slotLabel(st.quietest.slot)} (${st.quietest.x.toFixed(1)}×).`);
  if (st.nowFactor && Math.abs(st.nowFactor - 1) >= 0.05) lines.push(`Right now the coming minutes are usually ${st.nowFactor > 1 ? 'busier' : 'calmer'} than the last half hour (×${st.nowFactor.toFixed(2)}), and the odds account for it.`);
  if (indexFresh() && state.index.used.length > 1) lines.push(`Price: median of ${state.index.used.join(', ')} (Kalshi settles on a multi-exchange index; right now it's ${state.index.offset >= 0 ? '+' : '−'}$${Math.abs(state.index.offset).toFixed(2)} vs Coinbase).`);
  lines.push(st.basisN >= 10 ? `Kalshi's settlement index vs Coinbase: ${st.basis >= 0 ? '+' : '−'}$${Math.abs(st.basis).toFixed(2)} (middle of the last ${st.basisN} settlements), included in the odds.` : `Learning the gap between Coinbase and Kalshi's settlement index: ${st.basisN} of 10 settlements.`);
  if (settings.learn === false) lines.push('Off in Settings: the bot isn\'t using any of this right now.');
  setText($('memSummary'), lines.join(' '));
  setHTML($('memPulse'), pulseHtml(st.pulse));
  const fz = st.fees, ft = fz?.taker, fm = fz?.maker;
  const feeRow = { name: 'Kalshi\'s real fee', on: ft?.k != null, detail: ft?.k != null ? `${(ft.k * 100).toFixed(2)}% measured on ${ft.n} fills (Kalshi publishes 7%)${fm?.k != null ? ` · makers ${(fm.k * 100).toFixed(2)}% on ${fm.n}` : ''}` : `${ft?.n ?? 0}/8 fills from your linked Kalshi account or the Auto-trader` };
  if (st.using && !st.using.some((u) => u.name === feeRow.name)) st.using = [...st.using, feeRow];
  setHTML($('memUsing'), (st.using || []).length ? `<div class="mu-h">Used in the bot's calls</div>${st.using.map((u) => `<div class="mu-r ${u.on ? 'on' : ''}"><b>${u.on ? '✓' : '…'}</b><span>${esc(u.name)}</span><small>${esc(u.detail)}</small></div>`).join('')}<small class="muted">Each learner only shapes calls once its own graded record proves it helps; until then it keeps learning and changes nothing.</small>` : '');
  // Weekday volatility by half hour (New York time)
  const prof = st.profile;
  if (prof) {
    const day = [...Array(48).keys()].map((h) => { const xs = [1, 2, 3, 4, 5].map((d) => prof[d * 48 + h]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; });
    const max = Math.max(...day, 1e-9);
    setHTML($('memBars'), day.map((x, h) => `<i style="height:${Math.max(4, (x / max) * 100)}%" title="${slotLabel(48 + h).slice(4)}: ${x.toFixed(2)}×"></i>`).join(''));
    setHidden($('memBarsWrap'), false);
  }
  const rows = (st.calibration || []).filter((b) => b.n >= 20);
  setHTML($('memCal'), rows.map((b) => `<li><span><b>Said ${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%</b><small>${b.n} window${b.n === 1 ? '' : 's'} · won ${Math.round(b.won * 100)}%${b.shift ? ` · corrected ${b.shift > 0 ? '+' : '−'}${(Math.abs(b.shift) * 100).toFixed(1)} pts` : ' · no correction needed'}</small></span></li>`).join(''));
}

// Learning every second (public/pulse.js): what the server's per-second grading has found
function pulseHtml(p) {
  if (!p) return '';
  const n = (v) => Math.round(v).toLocaleString();
  const out = [`<b>Learning every second:</b> ${n(p.seconds)} seconds watched${p.since ? ` since ${new Date(p.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}, ${n(p.graded)} graded.`];
  const x = p.expected;
  if (p.graded >= 60) {
    const how = Math.abs(x - 1) < 0.05 ? 'right in line with' : `${x.toFixed(2)}× ${x > 1 ? 'more than' : 'of'}`;
    out.push(`Over the last half hour ${MKT.key} has moved ${how} what the bot expected a minute earlier.`);
    out.push(p.helping == null ? `The live correction switches on after an hour of grading (${n(p.needed)} seconds to go).`
      : p.helping ? (Math.abs(p.fix - 1) >= 0.01 ? `<b class="pos">Correction on:</b> the odds use ×${p.fix.toFixed(2)} volatility, because it's been predicting moves better than no correction.` : 'Correction on, but nothing to correct right now.')
      : '<b>Correction off:</b> lately it hasn\'t predicted moves better than leaving the volatility alone, so the bot ignores it.');
  }
  if (p.blendRounds) {
    const cur = Math.round((settings.marketWeight || 0) * 100), best = Math.round(p.blendBest * 100);
    out.push(`<b>Kalshi's price:</b> scored every second of ${n(p.blendRounds)} round${p.blendRounds === 1 ? '' : 's'}, the most accurate odds came from ${best === 0 ? 'the bot alone' : best === 100 ? 'Kalshi alone' : `${best}% Kalshi, ${100 - best}% bot`}${p.blendRounds < 100 ? ' (early: under 100 rounds)' : ''}. The bot uses ${cur}% (Settings → Respect the market).`);
  } else out.push('Kalshi\'s price: each round, every second of the bot\'s odds and Kalshi\'s price is scored after the result to learn how much Kalshi\'s price is worth. First result after a round settles.');
  return out.map((l) => `<p>${l}</p>`).join('');
}

// ---------- Near-certain (server: the strictest level's own graded record, next to the official one) ----------
function renderCertain(r) {
  const c = r.certain, pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  if (!c) { setText($('crSub'), 'The server will start keeping this record after its next update.'); return; }
  const losses = c.graded - c.wins, rate = c.graded ? c.wins / c.graded : null;
  setText($('crWL'), c.graded ? `${c.wins}–${losses}` : '0–0');
  setText($('crPct'), pctOf(c.wins, c.graded)); setClass($('crPct'), rate == null ? '' : rate >= 0.95 ? 'pos' : rate < 0.85 ? 'neg' : '');
  setText($('crUsd'), c.graded ? money(c.usd) : '—'); setClass($('crUsd'), !c.graded ? '' : c.usd >= 0 ? 'pos' : 'neg');
  const avgPrice = c.calls.length ? c.calls.reduce((a, e) => a + e.price, 0) / c.calls.length : null;
  setText($('crSub'), !c.calls.length ? 'No near-certain calls yet. They\'re rare by design: confidence 95+ for 2 minutes, very likely to hold all round, and Kalshi\'s own price at 85¢+. The bot looks for them around the clock; pick Near-certain under Settings → Risk level to get them as your calls.'
    : `Official calls (${r.level}): won ${pctOf(r.wins, r.graded)} of ${int(r.graded)}, ${money(r.usd)} at $10 a call. Near-certain: won ${pctOf(c.wins, c.graded)} of ${int(c.graded)}, ${money(c.usd)}. Near-certain calls cost about ${avgPrice != null ? `${Math.round(avgPrice * 100)}¢` : '—'}, so a win pays about ${avgPrice != null ? `$${((10 / avgPrice) * (1 - avgPrice)).toFixed(2)}` : '—'} on $10 before fees and a loss costs the $10.`
      + `${c.graded < 50 ? ' Under 50 graded calls says little: one loss changes the picture.' : ''}`);
  const now = Date.now();
  setHTML($('crCalls'), c.calls.slice(-8).reverse().map((e) => {
    const up = e.side === 'YES', graded = e.result === 'yes' || e.result === 'no', won = graded && e.side.toLowerCase() === e.result;
    const badge = graded ? (won ? '<span class="badge win">WIN</span>' : '<span class="badge loss">LOSS</span>') : e.result === 'unknown' ? '<span class="badge">VOID</span>' : Date.parse(e.closeTime) > now ? '<span class="badge live">LIVE</span>' : '<span class="badge">SETTLING</span>';
    const when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<li><img src="${up ? 'bull' : 'bear'}.svg" alt=""><span><b>${up ? 'UP' : 'DOWN'} at ${Math.round(e.price * 100)}¢</b><small>${when} · confidence ${e.conf ?? '—'}${e.hold != null ? ` · hold ${Math.round(e.hold * 100)}%` : ''}</small></span>${badge}</li>`;
  }).join(''));
}

// ---------- the 10-minute pick (server: bot.js, public/pick.js): every round's side, locked at 10:00 left ----------
async function refreshPick() {
  if (document.hidden) return;
  try { state.pick = await getJSON(api('pick')); state.pickAt = Date.now(); renderPick(); } catch { /* next time */ }
}
setInterval(refreshPick, 5000);
setTimeout(refreshPick, 1200);
function renderPick(now = Date.now()) {
  const k = state.pick, card = $('pickCard');
  if (!card) return;
  setHidden(card, !k || !k.closeTime);
  if (!k?.closeTime) return;
  const e = k.live, pc = (x) => `${Math.round(x * 100)}%`;
  if (!e) {
    const left = (k.locksAt ?? 0) - now;
    setText($('pickWhen'), left > 0 ? `locks in ${mmss(left / 60000)}` : 'locking…');
    setText($('pickSide'), '—'); setClass($('pickSide'), 'pick-side');
    setText($('pickOdds'), left > 0 ? 'The bot locks its side for this round at 10:00 left, by the math' : 'Locking this round\'s side…');
    setText($('pickWhy'), ''); setText($('pickBuy'), '');
  } else {
    const up = e.side === 'YES';
    setText($('pickWhen'), `locked · closes ${new Date(Date.parse(e.closeTime)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    setText($('pickSide'), up ? 'UP' : 'DOWN'); setClass($('pickSide'), `pick-side ${up ? 'up' : 'down'}`);
    setText($('pickOdds'), e.pb != null && e.kalshi != null && e.mix < 1 ? `Odds ${pc(e.p)} (bot ${pc(e.pb)} + Kalshi ${pc(e.kalshi)})${e.worst != null ? ` · worst case ${pc(e.worst)}` : ''}`
      : `Math ${pc(e.p)}${e.worst != null ? ` · worst case ${pc(e.worst)}` : ''} · Kalshi ${e.kalshi != null ? pc(e.kalshi) : `${Math.round(e.price * 100)}¢`}`);
    setText($('pickWhy'), e.why ? e.why.charAt(0).toUpperCase() + e.why.slice(1) : '');
    setText($('pickBuy'), e.buy ? 'BUY ✓' : 'PICK ONLY'); setClass($('pickBuy'), `pick-buy ${e.buy ? 'yes' : 'no'}`);
  }
  const st = k.stats, last = k.last;
  setText($('pickRecord'), [last ? `Last pick ${last.side.toLowerCase() === last.result ? 'won' : 'lost'}` : null,
    st?.graded ? `picks ${st.wins}–${st.graded - st.wins} (${Math.round(st.wins / st.graded * 100)}%), the math said ${st.avgP != null ? pc(st.avgP) : '—'} on average` : 'no graded picks yet',
    st?.buys?.graded ? `BUY picks ${st.buys.wins}–${st.buys.graded - st.buys.wins}, ${st.buys.usd >= 0 ? '+' : '−'}$${Math.abs(st.buys.usd).toFixed(2)} at $10 each` : null,
    st?.score?.vs >= 10 ? `odds ${st.score.brierPick <= st.score.brierKalshi ? 'match or beat' : st.score.brierPick <= st.score.brierKalshi + 0.002 ? 'level with' : 'behind'} Kalshi's (Brier ${st.score.brierPick.toFixed(3)} vs ${st.score.brierKalshi.toFixed(3)})` : null].filter(Boolean).join(' · '));
}

// The round call (v13.39): this round's 10-minute pick from the server, or, if the server's isn't in, the same math
// here, locked once for the round
// v13.45 one side a round: the first side shown for a round is the side for the rest of it (the server's pick when it has
// it, which the phone waits up to 15 s past 10:00 left for, so it never shows a side the server then contradicts)
function serverPickFor(live, now) {
  const k = state.pick?.live;
  return k && k.closeTime === live.m.close_time && now - (state.pickAt || 0) < 60000 ? k : null;
}
function lockedSideFor(live, now) {
  if (!live) return null;
  const k = serverPickFor(live, now) ?? state.roundShown?.[live.m.ticker];
  return k?.side ? { ticker: live.m.ticker, side: k.side } : null;
}
function roundCallFor(live, snap, now) {
  const t = live.m.ticker, server = serverPickFor(live, now), shown = (state.roundShown ||= {})[t];
  if (shown) return server && server.side === shown.side ? server : shown;
  if (server) return (state.roundShown[t] = server);
  const lockAt = Date.parse(live.m.close_time) - PICK.at * 60000;
  if (now < lockAt + 15000 && now - (state.pickAt || 0) < 30000) return { locking: true };
  for (const k of Object.keys(state.roundShown)) if (!state.markets.some((m) => m.ticker === k)) delete state.roundShown[k];
  const keep = (e) => (e?.side ? (state.roundShown[t] = e) : null);
  state.localPick ||= {};
  if (!state.localPick[live.m.ticker]) {
    try { const e = pickNow({ row: live, snap, settings }); if (e) state.localPick[live.m.ticker] = { ...e, price: e.ask, strike: live.strike, closeTime: live.m.close_time, local: true }; } catch { /* next tick */ }
  }
  // v13.43.3 guaranteed: the bot's own pick, else Kalshi's favourite (or the side price is on); kept once shown (v13.45)
  if (state.localPick[t]) return keep(state.localPick[t]);
  const fb = pickFallback({ row: live, snap });
  return keep(fb ? { ...fb, price: fb.ask, strike: live.strike, closeTime: live.m.close_time, local: true } : null);
}

// ---------- Signal board (public/signals.js): every factor, in calls / probation / context, with or against the card ----------
let boardSide = null; // the side on the card (set by render: the call, the round call or the bot's lean)
async function refreshBoardExtras() { // the two sources nothing else on the Deck fetches
  if (document.hidden || !shownViews.has('live')) return;
  const [vt, lab] = await Promise.all([getJSON(api('voltune')).catch(() => null), getJSON(api('lessons')).catch(() => null)]);
  if (vt) state.volTuneApi = vt;
  if (lab) state.lab = lab;
}
setInterval(refreshBoardExtras, 60000);
setTimeout(refreshBoardExtras, 4000);
function renderBoard(live, sig, now) {
  if (!$('boardCard')) return;
  const t = live?.m?.ticker ?? null, fresh = (at, ms) => now - (at || 0) < ms;
  const b = signalBoard({ ticker: t, side: boardSide, crypto: CRYPTO, scan: fresh(state.scanFetchAt, 60000) ? state.scanSrv : null, micro: state.micro, tune: state.tune, playbook: state.playbook,
    cross: state.cross, flip: fresh(state.flipChkAt, 30000) ? state.flipChk : null, volTune: state.volTuneApi, lab: state.lab });
  const c = b.counts, nm = (x) => (x === 'YES' ? 'UP' : 'DOWN');
  setText($('sbSum'), `${c.in} in calls · ${c.probation} on probation`);
  setHTML($('sbMeter'), b.side && c.with + c.against ? `${c.with ? `<i class="w" style="flex:${c.with}"></i>` : ''}${c.against ? `<i class="a" style="flex:${c.against}"></i>` : ''}` : '<i class="n" style="flex:1"></i>');
  setText($('sbSay'), !b.rows.length ? 'Reading every factor…'
    : !c.in ? `Nothing has proven itself yet: the call comes from the bot's own price math alone. ${c.probation} factor${c.probation === 1 ? ' is' : 's are'} still being tested.`
    : !b.side ? `${c.in} proven factor${c.in === 1 ? ' feeds' : 's feed'} the calls. No side on the card yet.`
    : !(c.with + c.against) ? `${c.in} proven factor${c.in === 1 ? ' feeds' : 's feed'} the calls; none has a read on this round right now.`
    : `${nm(b.side)}: ${c.with} proven factor${c.with === 1 ? '' : 's'} with it, ${c.against} against${c.against > c.with ? ' (the price math still outweighs them, but be careful)' : ''}.`);
  const chip = (r) => (r.status === 'in' ? '<em class="in">in calls</em>' : r.status === 'context' ? '<em class="ctx">context</em>' : `<em class="pr v-${r.verdict}">${esc(VERDICTS[r.verdict] ?? 'probation')}</em>`);
  const row = (r) => `<li class="sb-${r.status}${r.vs ? ` vs-${r.vs}` : ''}"><span class="sb-name"><b>${esc(r.name)}</b><small>${esc(r.note || '')}</small>`
    + `${r.why ? `<small class="sb-why">${esc(r.why)}</small>` : ''}${r.progress != null ? `<span class="sb-prog" aria-label="${Math.round(r.progress * 100)}% of the way to proven"><i style="width:${Math.round(r.progress * 100)}%"></i></span>` : ''}</span>`
    + `<span class="sb-right">${chip(r)}${r.lean ? `<b class="sb-lean ${r.lean === 'YES' ? 'up' : 'dn'}">${nm(r.lean)}${r.pts != null ? ` ${r.pts >= 0 ? '+' : '−'}${Math.abs(Math.round(r.pts * 1000) / 10)}` : ''}</b>` : '<b class="sb-lean">—</b>'}${r.vs ? `<small>${r.vs}</small>` : ''}</span></li>`;
  // the proven ones up front; the ones still being tested folded under them (there can be a dozen or more)
  const on = b.rows.filter((r) => r.status !== 'probation'), pr = b.rows.filter((r) => r.status === 'probation');
  setHTML($('sbList'), on.map(row).join('') + (pr.length ? `<li class="sb-fold"><details${state.sbOpen ? ' open' : ''}><summary>${pr.length} on probation · ${Object.entries(b.byVerdict).filter(([, n]) => n).map(([v, n]) => `${n} ${VERDICTS[v]}`).join(', ')}</summary><p class="sb-fold-note">Not used in the calls until each proves itself on data it never trained on. Switching on a factor with no edge would make the calls worse, not better: it adds noise to odds that are already priced.</p><ul class="sb-list">${pr.map(row).join('')}</ul></details></li>` : ''));
}

$('sbList').addEventListener('toggle', (e) => { state.sbOpen = e.target.open; }, true); // stays open across re-renders

// ---------- Ask the bot (public/ask.js, server askai.js): a question by voice or keyboard, answered from the live facts ----------
// Everything here is what the Deck already worked out (the last render) and what the cards fetched: nothing new is guessed.
function askFacts(now = Date.now()) {
  const a = state.askSnap, live = a?.live && Date.parse(a.live.m.close_time) > now ? a.live : null, sig = live ? a.sig : null, snap = a?.snap;
  const txt = (id) => ($(id)?.textContent || '').trim() || null;
  const f = { coin: MKT.key, name: MKT.name || MKT.key, series: settings.series, digits: Math.max(0, MKT.digits ?? 0), crypto: CRYPTO, at: now,
    card: { word: txt('call'), label: txt('callLabel'), sub: txt('callSub'), reason: txt('reason') } };
  if (!live) return f;
  const { m, ev } = live, ml = Math.max(0, (Date.parse(m.close_time) - now) / 60000), price = modelSpot(), strike = live.strike, below = /^less/.test(m.strike_type || '');
  const bars = snap?.bars || [], openT = Date.parse(m.open_time), firstBar = bars.find((b) => b.t >= openT);
  f.round = { ticker: m.ticker, title: m.title || m.ticker, minutesLeft: +ml.toFixed(2), strike, below, spot: price, change: firstBar && price ? price - firstBar.o : null };
  const q = ev.quote || {}, mid = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null;
  f.odds = { botUp: ev.pYes ?? null, kalshiUp: mid, yesAsk: q.yesAsk ?? null, noAsk: q.noAsk ?? null };
  if (sig) f.call = { side: sig.callSide ?? null, price: sig.price ?? null, limit: sig.limit ?? null, conf: sig.deep?.score ?? null, hold: sig.hold ?? null, lane: sig.lane ?? null,
    called: sig.called ?? null, bail: sig.bail ? { side: sig.bail.side, p: sig.bail.p, bid: sig.bail.bid ?? null } : null };
  f.lockedOut = !!sig?.lockedOut;
  const rc = state.askRc;
  if (rc?.side) f.roundCall = { side: rc.side, p: rc.p ?? null, buy: !!rc.buy, price: rc.price ?? rc.ask ?? null, fallback: !!rc.fallback, why: rc.why ?? null, worst: rc.worst ?? null };
  if (a.block) f.block = a.block.kind === 'loss' ? `Daily loss limit: your trades are down ${dollars(Math.abs(a.block.dl.pnl))} today, past your limit` : `Profit guard: this level's last ${a.block.pg.n} calls lost ${dollars(Math.abs(a.block.pg.usd))} after fees`;
  const c = price && strike ? cushionRead({ price, strike, sigmaMin: live.sigma ?? snap.sigmaMin, minutesLeft: ml }) : null;
  if (c) {
    const leadSide = c.up !== below ? 'UP' : 'DOWN', h = cushionHistory(state.tune?.report?.cushion, c.ratio, ml);
    const sw = MKT.settle === 'avg60' ? settlementWatch({ prints: snap.quoteLog?.[m.ticker], close: Date.parse(m.close_time), spot: price, strike, sigmaMin: live.sigma ?? snap.sigmaMin, now }) : null;
    f.line = { leadSide, lead: c.lead, move: c.move, ratio: c.ratio, word: c.word, razor: !!c.razor, hist: h ? { rate: h.rate, n: h.n } : null, settle: sw ? { banked: sw.banked, locked: !!sw.locked } : null };
  }
  const fl = state.flipChk?.live;
  if (fl && fl.ticker === m.ticker && now - (state.flipChkAt || 0) < 20000) f.flip = { lead: fl.lead, p: fl.p, base: fl.base, used: !!fl.used, parts: (fl.parts || []).slice(0, 4).map((x) => ({ name: x.name, push: x.push })) };
  f.moves = (state.whyLog || []).filter((x) => now - x.t < 30 * 60000).slice(0, 5).map((x) => ({ ago: +((now - x.t) / 60000).toFixed(1), dir: x.dir, headline: x.headline, reasons: x.reasons }));
  if (!CRYPTO && state.drv?.parts) { try { f.drivers = explainDrivers(state.drv, { name: MKT.name, w: state.drv.w, digits: Math.max(2, MKT.digits ?? 2), r2: state.drv.fit?.r2All }); } catch { /* skip */ } }
  const sc = state.scanSrv?.live?.ticker === m.ticker ? state.scanSrv.live.sc : null;
  if (sc?.ready) {
    const ch = scanChance(ev.pYes, featureVector(sc, m.strike_type), state.scanSrv?.models, ml);
    f.scan = { verdict: sc.verdict, score: sc.score, leader: sc.leader?.ex ?? null, bigBuy: sc.bigBuy ?? 0, bigSell: sc.bigSell ?? 0,
      chance: ch ? { active: !!ch.active, side: ch.p >= 0.5 ? 'UP' : 'DOWN', p: Math.max(ch.p, 1 - ch.p) } : null };
  }
  const tug = CRYPTO ? flowStats(flow, now).nowBuyShare : null;
  if (tug != null) {
    const side = tug >= 0.5 ? 'UP' : 'DOWN', ag = state.scanSrv?.agreement, b = f.line ? (side !== f.line.leadSide ? ag?.disagree : ag?.agree) : null;
    f.pressure = { side, share: Math.max(tug, 1 - tug), note: b?.n >= 20 ? `When pressure ${side !== f.line.leadSide ? 'disagreed with' : 'agreed with'} the leading side, that side still won ${Math.round(b.won / b.n * 100)}% of ${b.n} checks` : null };
  }
  const w = state.watch?.status;
  if (w && now - (state.watchAt || 0) < 30000) f.watch = { hold: w.hold ? w.hold.why : null, events: (state.watch.events || []).filter((e) => e.sev !== 'info' && now - e.t < 5 * 60000).slice(0, 3).map((e) => e.text) };
  let P = chartState.pats;
  if (!P) { try { P = patternsNow(bars.slice(0, -1)); } catch { P = null; } }
  if (P) {
    const fams = new Map((state.tune?.report?.families || []).filter((x) => /^cp_/.test(x.family)).map((x) => [x.family.slice(3), x]));
    f.patterns = { forming: P.forming ? { name: P.forming.name, up: P.forming.up, dn: P.forming.dn } : null,
      recent: (P.recent || []).map((e) => { const h = fams.get(e.key); return { name: e.name, dir: e.dir, ago: +((now - e.t) / 60000).toFixed(1), target: e.target ?? null, proven: !!h?.proven, hit: h?.test?.hit ?? null }; }) };
  }
  try {
    const b = signalBoard({ ticker: m.ticker, side: boardSide, crypto: CRYPTO, scan: now - (state.scanFetchAt || 0) < 60000 ? state.scanSrv : null, micro: state.micro, tune: state.tune, playbook: state.playbook,
      cross: state.cross, flip: now - (state.flipChkAt || 0) < 30000 ? state.flipChk : null, volTune: state.volTuneApi, lab: state.lab });
    f.board = { side: b.side, inCalls: b.counts.in, probation: b.counts.probation, with: b.counts.with, against: b.counts.against,
      rows: b.rows.filter((r) => r.status === 'in' && r.vs).map((r) => ({ name: r.name, lean: r.lean, vs: r.vs })),
      close: b.rows.filter((r) => r.verdict === 'close').map((r) => r.name) };
  } catch { /* the board needs its feeds; skip it */ }
  const st = state.stabNow;
  if (st) f.stability = { level: st.level, score: st.score ?? null, parts: (st.parts || []).map((x) => x.label) };
  f.vol = snap?.sigmaMin ?? null;
  const pk = state.pick?.stats, acc = (() => { try { return accuracyNow(); } catch { return []; } })(), off = acc.find((r) => r.key === 'calls')?.data;
  f.record = { picks: pk?.graded ? { wins: pk.wins, graded: pk.graded, avgP: pk.avgP ?? null, buys: pk.buys?.graded ? { wins: pk.buys.wins, graded: pk.buys.graded, usd: pk.buys.usd } : null } : null,
    official: off?.graded ? off : null, accuracy: acc.map((r) => ({ name: r.name, metric: r.metric, verdict: r.verdict })),
    trades: state.trades.length ? { n: state.trades.length, total: state.trades.reduce((x, t) => x + (t.pnl || 0), 0) } : null };
  if (!state.sessAt || now - state.sessAt > 60000) { state.sessAt = now; state.sess = sessions(now); }
  f.sessions = (state.sess || []).map((x) => ({ name: x.name, open: !!x.open }));
  f.positions = state.positions.map((p) => ({ ticker: p.ticker, side: p.side, price: p.price, contracts: p.contracts, bid: state.posChecks?.[p.id]?.bid ?? null }));
  return f;
}

const ask = { log: [], busy: false, ai: null, voice: null, free: false, freeVoice: null, rec: null, listening: false, audio: null, src: null, srcs: [], sayN: 0 };
let askSpeak = store.get('askSpeak', true);
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
// the sheet opened and the free voice will read: have the server load it now, not when the first answer is ready
function askWarm() {
  if (askSpeak && ask.free && (askVoicePref === '' || askVoicePref === 'free')) fetch(`${API}/ask/say`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"warm":true}' }).catch(() => {});
}
function askOpen(on = true) {
  setHidden($('askSheet'), !on);
  document.body.classList.toggle('asking', on);
  if (on) {
    if (ask.ai == null) getJSON('ask').then((d) => { ask.ai = !!d?.ai; ask.voice = !!d?.voice; ask.free = !!d?.free; ask.freeVoice = d?.freeVoice || null; askWarm(); renderVoicePicker(); renderAsk(); }).catch(() => { ask.ai = false; ask.voice = false; renderAsk(); });
    else askWarm();
    renderVoicePicker();
    renderAsk();
  } else { askStopListening(); askHush(); }
}
// The server's voice (voice.js, one chosen voice for every answer) when it's on, else the phone's own. Played through Web
// Audio, unlocked on the tap that asked (askUnlock), so phones that block sound outside a tap still play it when it arrives.
function askUnlock() {
  try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { ask.audio ||= new AC(); if (ask.audio.state === 'suspended') ask.audio.resume(); } } catch { /* no Web Audio */ }
}
function askHush() {
  ask.sayN++;
  for (const x of [ask.src, ...ask.srcs]) { try { x?.stop(); } catch { /* already done */ } }
  ask.src = null; ask.srcs = []; ask.speakEnd = 0;
  window.speechSynthesis?.cancel();
}
const sayable = (t) => t.replace(/¢/g, ' cents').replace(/(\d)%/g, '$1 percent').replace(/\s+/g, ' ').trim();
// The voice (v13.49): the server's free natural voice by default (Kokoro, freevoice.js: no credits), else the phone's own
// (the best British male voice it has, ask.js pickVoice), or Adam Stone through ElevenLabs when picked (uses credits)
let askVoicePref = store.get('askVoice', ''); // '' = auto (the server's free voice, else the phone's best), 'free', 'bot' = ElevenLabs, else a phone voice's name
const phoneVoices = () => { try { return window.speechSynthesis?.getVoices() || []; } catch { return []; } };
function askSayLocal(text) {
  if (!window.speechSynthesis) return null;
  try {
    const u = new SpeechSynthesisUtterance(text), v = pickVoice(phoneVoices(), askVoicePref === 'bot' ? '' : askVoicePref);
    let named = null;
    if (v) { try { u.voice = v; u.lang = v.lang; named = v.name; } catch { /* that voice can't be set here: the default reads it */ } }
    u.rate = 1; u.pitch = 0.95;
    window.speechSynthesis.speak(u);
    return named || 'the default voice';
  } catch { return null; } // no voice on this phone
}
// which voice spoke the last answer, and why when it wasn't the one picked: shown under the input, never a silent switch
function askVoiceNote(text, ok) { ask.voiceNote = { text, ok }; renderAsk(); }
async function askSay(text) {
  if (!askSpeak || !text) return;
  askHush();
  const n = ask.sayN, t = sayable(text);
  let why = null;
  if (askVoicePref === 'bot') {
    why = !ask.voice ? (ask.voiceWhy || 'the bot\'s voice isn\'t set up on the server') : !ask.audio ? 'this browser can\'t play the bot\'s voice' : null;
    if (!why) {
      try {
        if (ask.audio.state === 'suspended') await ask.audio.resume().catch(() => {});
        const r = await fetch(`${API}/ask/voice`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
        if (r.ok) {
          const buf = await ask.audio.decodeAudioData(await r.arrayBuffer());
          if (n !== ask.sayN || !askSpeak) return; // a newer answer, mute or close came first
          const src = ask.audio.createBufferSource();
          src.buffer = buf; src.connect(ask.audio.destination); src.start();
          ask.src = src; ask.speakEnd = ask.audio.currentTime + buf.duration;
          askVoiceNote('🔊 Adam Stone (ElevenLabs, uses credits)', true);
          return;
        }
        const d = await r.json().catch(() => ({}));
        why = `${d.error || `the voice service answered ${r.status}`}${d.detail ? ` (${d.detail})` : ''}`;
        // a refusal (plan, key, voice) won't fix itself this session: stop asking, so nothing is wasted on it
        if (r.status !== 429) { ask.voice = false; ask.voiceWhy = why; }
      } catch { why = 'the bot\'s voice didn\'t load or play on this phone'; }
      if (n !== ask.sayN) return;
    }
  }
  let rest = t, whose = 'Adam';
  if (askVoicePref === 'free' || (askVoicePref === '' && ask.free)) {
    whose = freeName();
    const out = await askSayFree(text, n);
    if (out === 'done' || n !== ask.sayN) return;
    why = out.why; rest = out.rest ? sayable(out.rest) : t;
  }
  const used = askSayLocal(rest);
  askVoiceNote(!used ? 'This browser has no voice to read with.' : why ? `Phone voice (${used}), not ${whose}: ${why}` : `🔊 ${used} · your phone's voice, free`, !why && !!used);
}
// the server's free voice: the answer a piece at a time, each fetched while the one before plays, queued back to back
const freeName = () => { const v = ask.freeVoice || 'bm_george'; return v.slice(3, 4).toUpperCase() + v.slice(4); };
async function askSayFree(text, n) {
  const parts = speechChunks(text);
  if (!ask.audio || !parts.length) return { why: 'this browser can\'t play the server\'s voice', rest: text };
  if (ask.audio.state === 'suspended') await ask.audio.resume().catch(() => {});
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    let why = null;
    try {
      const r = await fetch(`${API}/ask/say`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: parts[i] }) });
      if (r.ok) {
        const buf = await ask.audio.decodeAudioData(await r.arrayBuffer());
        if (n !== ask.sayN || !askSpeak) return 'done'; // a newer answer, mute or close came first
        const src = ask.audio.createBufferSource();
        src.buffer = buf; src.connect(ask.audio.destination);
        at = Math.max(at, ask.audio.currentTime + 0.05); src.start(at); at += buf.duration; ask.speakEnd = at;
        ask.srcs.push(src);
        if (i === 0) askVoiceNote(`🔊 ${freeName()} · natural voice, free`, true);
        continue;
      }
      const d = await r.json().catch(() => ({}));
      if (r.status === 501) ask.free = false;
      why = d.error || `the free voice answered ${r.status}`;
    } catch { why = 'the free voice didn\'t load on this phone'; }
    if (n !== ask.sayN) return 'done';
    // what's left is read by the phone, after what George already said
    const rest = parts.slice(i).join(' ');
    if (i && at > ask.audio.currentTime) await new Promise((res) => setTimeout(res, (at - ask.audio.currentTime) * 1000));
    return { why, rest };
  }
  return 'done';
}
// the voice picker: the best phone voice (auto), every English voice the phone has, and Adam when the server has him
function renderVoicePicker() {
  const sel = $('askVoiceSel');
  if (!sel) return;
  const vs = englishVoices(phoneVoices()), best = vs[0];
  const opts = [['', ask.free ? `Auto: ${freeName()}, natural (free)` : `Auto${best ? `: ${best.name}` : ''} (free)`], ...(ask.free ? [['free', `${freeName()} · natural voice (free)`]] : []),
    ...vs.map((v) => [v.name, `${v.name} · phone (${v.lang})`]), ...(ask.voice ? [['bot', 'Adam Stone · ElevenLabs (credits)']] : [])];
  const html = opts.map(([v, l]) => `<option value="${esc(v)}"${v === askVoicePref ? ' selected' : ''}>${esc(l)}</option>`).join('');
  setHTML(sel, html);
  sel.value = opts.some(([v]) => v === askVoicePref) ? askVoicePref : '';
}
window.speechSynthesis?.addEventListener?.('voiceschanged', () => renderVoicePicker());
$('askVoiceSel')?.addEventListener('change', (e) => { askVoicePref = e.target.value; store.set('askVoice', askVoicePref); askUnlock(); askSay('This is the voice your answers will be read in.'); });
async function askQuestion(q) {
  q = String(q || '').trim();
  if (!q || ask.busy) return;
  const facts = askFacts(), built = askAnswer(q, facts);
  const item = { q, at: Date.now(), built, ai: null, aiState: ask.ai === false ? 'off' : 'thinking', aiErr: null };
  ask.log.unshift(item); if (ask.log.length > 20) ask.log.length = 20;
  $('askInput').value = '';
  renderAsk();
  if (item.aiState === 'off') { askSay(built.speak); return; }
  ask.busy = true;
  try {
    const history = ask.log.slice(1, 4).reverse().filter((x) => x.ai).map((x) => ({ q: x.q, a: x.ai }));
    const r = await fetch(`${API}/ask`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, facts: factsForAI(facts), history }) });
    paywalled(r);
    const d = await r.json().catch(() => ({}));
    if (r.status === 501) { ask.ai = false; item.aiState = 'off'; askSay(built.speak); }
    else if (r.ok && d.answer) { item.ai = d.answer; item.aiState = 'done'; askSay(d.answer); }
    else { item.aiState = 'error'; item.aiErr = d.error || `The AI couldn't answer (${r.status}).`; askSay(built.speak); }
  } catch {
    item.aiState = 'error'; item.aiErr = 'Couldn\'t reach the server. Here\'s the built-in answer.'; askSay(built.speak);
  } finally { ask.busy = false; renderAsk(); }
}
function askListen() {
  if (!SpeechRec) { $('askInput').focus(); toast('Voice input isn\'t built into this browser: tap the mic on your keyboard to dictate.'); return; }
  if (ask.listening) { askStopListening(); return; }
  askHush();
  const rec = new SpeechRec();
  rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t; else interim += t; }
    $('askInput').value = (finalText + interim).trim();
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone blocked: allow it for this site in your browser settings, or type the question.'); else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Didn\'t catch that. Try again or type it.'); };
  rec.onend = () => { ask.listening = false; ask.rec = null; renderAsk(); const t = finalText.trim() || $('askInput').value.trim(); if (t) askQuestion(t); };
  try { rec.start(); ask.rec = rec; ask.listening = true; renderAsk(); } catch { ask.listening = false; }
}
function askStopListening() { try { ask.rec?.stop(); } catch { /* already stopped */ } }
function renderAsk() {
  if ($('askSheet').hidden) return;
  const mic = $('askMic');
  mic.classList.toggle('on', ask.listening);
  mic.setAttribute('aria-pressed', String(ask.listening));
  mic.setAttribute('aria-label', ask.listening ? 'Stop listening' : 'Ask by voice');
  setText($('askHint'), ask.listening ? 'Listening… ask about the round' : ask.voiceNote?.text ?? `Ask about ${MKT.key}'s live round: tap the mic or type`);
  setClass($('askHint'), `ask-hint${ask.voiceNote && !ask.voiceNote.ok ? ' warn' : ''}`);
  setText($('askMode'), ask.ai ? 'AI deep dive' : ask.ai === false ? 'Built-in answers' : '');
  $('askSpeak').setAttribute('aria-pressed', String(askSpeak));
  setText($('askSpeak'), askSpeak ? '🔊 Read aloud' : '🔇 Muted');
  $('askChips').classList.toggle('used', ask.log.length > 0); // after the first question only the voice test stays
  setHTML($('askLog'), ask.log.map((x) => {
    const b = x.built, ago = Math.round((Date.now() - x.at) / 60000);
    const ai = x.aiState === 'done' ? `<div class="ask-ai"><span class="ask-tag">AI deep dive</span>${x.ai.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
      : x.aiState === 'thinking' ? '<div class="ask-ai thinking"><span class="ask-tag">AI deep dive</span><p><i class="ask-dots"><b></b><b></b><b></b></i> Weighing everything…</p></div>'
      : x.aiState === 'error' ? `<div class="ask-ai err"><small>${esc(x.aiErr)}</small></div>` : '';
    const parts = b.parts.map((p) => `<li><b>${esc(p.title)}</b><span>${esc(p.text)}</span></li>`).join('');
    const nums = `${b.note ? `<p class="ask-note">${esc(b.note)}</p>` : ''}<p class="ask-bottom">${esc(b.bottom)}</p>${parts ? `<ul class="ask-parts">${parts}</ul>` : ''}${b.tail ? `<small class="ask-tail">${esc(b.tail)}</small>` : ''}`;
    return `<article class="ask-item"><header><b>${esc(x.q)}</b><small>${ago < 1 ? 'just now' : `${ago} min ago`}</small></header>${ai}`
      + (x.aiState === 'done' ? `<details class="ask-nums"><summary>The numbers behind it</summary>${nums}</details>` : `<div class="ask-nums">${nums}</div>`) + '</article>';
  }).join(''));
}
$('askBtn').addEventListener('click', () => { askUnlock(); askOpen($('askSheet').hidden); });
$('askClose').addEventListener('click', () => askOpen(false));
$('askMic').addEventListener('click', () => { askUnlock(); askListen(); });
$('askForm').addEventListener('submit', (e) => { e.preventDefault(); askUnlock(); askStopListening(); askQuestion($('askInput').value); });
$('askChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q], button[data-say]'); if (!b) return;
  askUnlock();
  if (b.dataset.say) { if (!askSpeak) { askSpeak = true; store.set('askSpeak', true); } askSay(b.dataset.say); } else askQuestion(b.dataset.q);
});
$('askSpeak').addEventListener('click', () => { askSpeak = !askSpeak; store.set('askSpeak', askSpeak); if (!askSpeak) askHush(); renderAsk(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('askSheet').hidden) askOpen(false); });

// ---------- "Hey Shot" (v13.50): hands-free, anywhere in the app ----------
// While it's on, the phone's speech recognition listens (only while the app is open and in front, and never while the
// bot is talking, so it doesn't hear itself). "Hey Shot, is the lead safe?" asks; a bare "Hey Shot" chimes and takes
// the next thing said as the question. Recognisers stop on their own after a pause, so a loop keeps it going.
const wake = { on: store.get('wakeOn', false), rec: null, running: false, armedUntil: 0, fails: 0 };
const speakingNow = () => !!window.speechSynthesis?.speaking || !!(ask.audio && (ask.speakEnd || 0) > ask.audio.currentTime);
const wakeWanted = () => wake.on && !!SpeechRec && !document.hidden && !ask.listening && !speakingNow();
function wakeStart() {
  if (wake.running || !wakeWanted()) return;
  const rec = new SpeechRec();
  rec.lang = navigator.language || 'en-US'; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) { wake.fails = 0; wakeHeard(e.results[i][0].transcript); } };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wakeSet(false); toast('Hey Shot needs the microphone: allow it for this site, then turn it on again in Ask.'); }
    else if (e.error !== 'no-speech' && e.error !== 'aborted') wake.fails++;
  };
  rec.onend = () => { if (wake.rec === rec) { wake.rec = null; wake.running = false; renderWake(); } };
  try { rec.start(); wake.rec = rec; wake.running = true; } catch { wake.fails++; }
  renderWake();
}
function wakeStop() { const r = wake.rec; wake.rec = null; wake.running = false; try { r?.abort(); } catch { /* already stopped */ } renderWake(); }
setInterval(() => {
  if (wakeWanted()) { if (!wake.running && wake.fails < 6) wakeStart(); }
  else if (wake.running) wakeStop();
  if (wake.on && wake.fails >= 6) { wakeSet(false); toast('Hey Shot stopped: speech recognition kept failing on this browser. Try again later, or tap the mic.'); }
}, 700);
function wakeChime() {
  try {
    const a = ask.audio, o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
    o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(990, t + 0.09);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.24);
  } catch { /* no sound: the sheet still shows it heard */ }
}
function wakeAsk(q) { if ($('askSheet').hidden) askOpen(true); askQuestion(q); }
function wakeHeard(text) {
  const now = Date.now(), w = parseWake(text);
  if (w.woke && w.question.length > 1) { wake.armedUntil = 0; wakeAsk(w.question); return; }
  if (w.woke) { // just the wake phrase: chime, and the next thing said is the question
    wake.armedUntil = now + 8000;
    if ($('askSheet').hidden) askOpen(true);
    wakeChime(); askVoiceNote('👂 Yes? Ask your question…', true);
    return;
  }
  if (now < wake.armedUntil && text.trim().length > 1) { wake.armedUntil = 0; wakeAsk(text.trim()); }
}
function wakeSet(on) {
  wake.on = !!on && !!SpeechRec; wake.fails = 0; wake.armedUntil = 0;
  store.set('wakeOn', wake.on);
  if (!wake.on) wakeStop();
  renderWake();
}
function renderWake() {
  const b = $('askWake'), btn = $('askBtn');
  btn?.classList.toggle('wake-on', wake.on); btn?.classList.toggle('wake-live', wake.running);
  if (!b) return;
  b.setAttribute('aria-pressed', String(wake.on));
  setText(b, !SpeechRec ? '👂 Hey Shot: not on this browser' : wake.on ? (wake.running ? '👂 Hey Shot: listening' : '👂 Hey Shot: on') : '👂 Hey Shot: off');
  b.disabled = !SpeechRec;
}
$('askWake')?.addEventListener('click', () => {
  askUnlock();
  const on = !wake.on;
  wakeSet(on);
  if (on) toast('Hey Shot is on: say "Hey Shot" and a question anywhere in the app. It listens only while the app is open (through your browser\'s speech service) and never while it\'s talking.');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) wakeStop(); });
renderWake();

// ---------- Simple mode ----------
function applyMode() {
  document.body.classList.toggle('simple', simpleMode);
  const b = $('modeBtn');
  setText(b, simpleMode ? 'Simple' : 'Pro');
  b.setAttribute('aria-pressed', String(!simpleMode));
  b.title = simpleMode ? 'Simple: just the call. Tap for Pro (everything)' : 'Pro: everything. Tap for Simple (just the call)';
  // a screen Simple hides can't stay open
  const hidden = [...document.querySelectorAll('nav button[data-pro]')].map((x) => x.dataset.view);
  if (simpleMode && [...shownViews].some((v) => hidden.includes(v))) split.show('live');
}
$('modeBtn').addEventListener('click', () => {
  simpleMode = !simpleMode;
  store.set('simpleMode', simpleMode);
  applyMode();
  toast(simpleMode ? 'Simple mode: just the call. Tap "Simple" up top for everything.' : 'Pro mode: every card and tab.');
  if (!simpleMode) requestAnimationFrame(() => { if (shownViews.has('chart')) drawChartTab(true); });
});

// ---------- Loss lab (server: bot.js, public/losslab.js): why each loss happened, the lessons the record proves ----------
async function refreshLab(force = false) {
  if (document.hidden || (!force && !shownViews.has('history'))) return;
  try { state.lab = await getJSON(api('lessons')); renderLab(); } catch { /* next time */ }
}
setInterval(refreshLab, 30000);
function renderLab() {
  const L = state.lab;
  if (!L || !$('labCard')) return;
  const pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`), side = (s) => (s === 'YES' ? 'UP' : 'DOWN');
  setText($('labWhen'), `${int(L.reviewed)} loss${L.reviewed === 1 ? '' : 'es'} reviewed`);
  const rows = (st, mode) => (st?.lessons || []).filter((x) => x.n > 0).slice(0, 5).map((x) => `<li class="${x.proven ? 'on' : ''}"><span><b>${esc(x.label)}</b><small>${esc(x.why)}</small></span>`
    + `<span>${int(x.n)} call${x.n === 1 ? '' : 's'}, won ${pc(x.rate)}<small>${mode === 'flip' ? 'the other side wins if under 50%' : `needs ${pc(x.need)}`} · z ${x.z.toFixed(1)}</small></span>`
    + `<b>${x.proven ? (mode === 'flip' ? '✓ takes the other side' : '✓ skips these') : 'watching'}</b></li>`).join('') || '<li class="empty">Not enough graded calls with context yet.</li>';
  setHTML($('labLessons'), `<h4>Round calls (every round)</h4><ul class="lab-rules">${rows(L.pick, 'flip')}</ul><h4>Calls worth buying</h4><ul class="lab-rules">${rows(L.official, 'skip')}</ul>`);
  setHTML($('labLosses'), (L.losses || []).map((e) => `<li><div><b>${esc(side(e.side))} ${esc(e.kind)}</b> <small>${clock(e.at)} · ${esc(roundName(e.ticker))}${e.p != null ? ` · said ${pc(e.p)}` : e.conf != null ? ` · confidence ${e.conf}` : ''}</small></div>`
    + `<div class="lab-chips">${(e.review?.causes || []).map((c) => `<span>${esc(c.label)}</span>`).join('')}</div><small>${esc(e.review?.summary || '')}</small></li>`).join('') || '<li class="empty">No losses reviewed yet. Each one is looked at as soon as Kalshi settles it.</li>');
  setText($('labTally'), L.tally?.length ? `Most common reasons: ${L.tally.slice(0, 4).map((t) => `${t.label} ×${t.n}`).join(' · ')}` : '');
}

// ---------- Related markets (server: crossfeed.js, public/cross.js): what moves this market ----------
async function refreshCross() {
  if (document.hidden) return;
  try { state.cross = await getJSON(api('cross')); renderCross(); } catch { /* next time */ }
}
setInterval(refreshCross, 15000);
setTimeout(refreshCross, 2500);
function renderCross() {
  const c = state.cross;
  if (!c) return;
  const pct = (v) => (v == null ? '—' : Math.abs(v) < 0.00005 ? '0.00%' : `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%`), cls = (v) => (v == null || Math.abs(v) < 0.00005 ? '' : v > 0 ? 'pos' : 'neg');
  setText($('crossTitle'), `Related markets · what moves ${MKT.key}`);
  setText($('crossWhen'), c.backfilled ? `${int(c.minutes)} minutes read` : 'reading history…');
  setHTML($('crossOwn'), `${esc(MKT.key)} itself: <b class="${cls(c.own?.m5)}">${pct(c.own?.m5)}</b> in 5 min · <b class="${cls(c.own?.m15)}">${pct(c.own?.m15)}</b> in 15`);
  setHTML($('crossList'), (c.related || []).slice(0, 8).map((r) => {
    const rho = r.rho == null ? null : Math.max(-1, Math.min(1, r.rho));
    return `<li><span class="cr-name"><b>${esc(r.name)}</b><small>${r.rho == null ? 'not enough overlap yet' : `ρ ${rho.toFixed(2)} · β ${r.beta.toFixed(2)}`}</small></span>`
      + `<span class="cr-bar" title="how closely it moves with ${esc(MKT.key)}"><i class="${rho != null && rho < 0 ? 'neg' : ''}" style="width:${rho == null ? 0 : Math.abs(rho) * 100}%"></i></span>`
      + `<span class="cr-move"><b class="${cls(r.m5)}">${pct(r.m5)}</b><small>5 min</small></span>`
      + `<span class="cr-move"><b class="${cls(r.catchup)}">${r.catchup == null ? '—' : pct(r.catchup)}</b><small>catch-up</small></span></li>`;
  }).join('') || '<li class="empty">Reading the other markets…</li>');
  const m = c.model;
  setText($('crossModel'), !m ? 'The model starts once the history is in.'
    : m.proven ? `Model proven: ${(m.gain * 100).toFixed(1)}% less error than "no change" on ${int(m.n)} test minutes (z ${m.z.toFixed(1)}). It expects ${pct(m.expected5)} in the next 5 minutes${c.inCalls ? ' and is nudging the odds now' : ''}.`
    : `Model learning: ${m.n ? `${m.gain == null ? '—' : `${(m.gain * 100).toFixed(1)}%`} vs "no change" on ${int(m.n)} test minutes (needs ${int(m.need.minTest)}+, ${(m.need.minGain * 100).toFixed(1)}%+ and z ${m.need.z}+)` : `${int(m.rows || 0)} minutes so far`}. Shown here, not used in calls until it proves itself.`);
}

// ---------- Why it's moving (server: crossfeed.js, public/drivers.js): gold, silver, oil and the indexes ----------
let drvW = DRV.windows.includes(+store.get('drvW', 60)) ? +store.get('drvW', 60) : 60;
async function refreshDrivers() {
  if (CRYPTO || document.hidden) return;
  try { state.drv = await getJSON(api(`drivers?w=${drvW}`)); renderDrivers(); } catch { /* next time */ }
}
if (!CRYPTO) { setInterval(refreshDrivers, 20000); setTimeout(refreshDrivers, 2000); }
$('drvTabs')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-w]'); if (!b) return;
  drvW = +b.dataset.w; store.set('drvW', drvW); state.drv = null; renderDrivers(); refreshDrivers();
});
if (!CRYPTO) renderDrivers();
function renderDrivers() {
  if (CRYPTO) return;
  for (const b of document.querySelectorAll('#drvTabs button')) { b.classList.toggle('on', +b.dataset.w === drvW); b.setAttribute('aria-selected', String(+b.dataset.w === drvW)); }
  const d = state.drv, dg = Math.max(2, MKT.digits ?? 2), usd = (v) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(dg)}`;
  setText($('drvTitle'), `Why ${MKT.name || MKT.key} is moving`);
  if (!d || !d.supported || !d.parts) {
    setText($('drvWhen'), d?.backfilled === false ? 'reading history…' : '');
    setText($('drvSay'), !d ? 'Reading the dollar, yields and the rest of its market…' : !d.supported ? 'Not available for this market.'
      : d.fit && !d.fit.ready ? `Learning how ${MKT.name} moves with its drivers: ${int(d.fit.n)} of ${int(d.fit.need)} minutes so far.` : 'Waiting for prices (the market may be closed).');
    setHTML($('drvSvg'), ''); setHTML($('drvParts'), ''); setText($('drvFit'), d?.drivers?.length ? `Drivers: ${d.drivers.map((x) => `${x.name}${x.minutes ? '' : ' (no data yet)'}`).join(', ')}.` : '');
    return;
  }
  setText($('drvWhen'), usd(d.move)); setClass($('drvWhen'), d.move > 0 ? 'pos' : d.move < 0 ? 'neg' : '');
  setText($('drvSay'), explainDrivers(d, { name: MKT.name, w: d.w, digits: dg, r2: d.fit?.r2All }));
  const c = chartSvg(d, { vol: d.vol, evs: d.events, digits: dg });
  state.drvXs = c.xs;
  setHTML($('drvSvg'), c.svg);
  const max = Math.max(...d.parts.map((p) => Math.abs(p.usd)), 1e-9);
  const head = { macro: 'Macro · dollar, rates, stocks', sector: 'Its market (beyond the macro)', own: 'Its own' };
  let last = null;
  setHTML($('drvParts'), d.parts.map((p) => {
    const w = (Math.abs(p.usd) / max * 50).toFixed(1), h = p.group !== last ? `<li class="drv-h">${head[p.group]}</li>` : ''; last = p.group;
    const sub = p.group === 'own' ? esc(p.name) : `${esc(p.short === p.name ? '' : `${p.name} `)}${moveText(p)}${p.per1 != null && p.unit !== 'yield' && p.group === 'macro' ? ` · ${esc(MKT.name)} ${p.per1 >= 0 ? '+' : '−'}${Math.abs(p.per1).toFixed(2)}% per +1%` : ''}`;
    return `${h}<li class="drv-row${p.group === 'own' ? ' own' : ''}" title="${esc(p.why || '')}"><span class="drv-name"><b>${esc(p.short)}</b><small>${sub}</small></span>`
      + `<span class="drv-bar"><i class="${p.usd < 0 ? 'neg' : 'pos'}" style="${p.usd < 0 ? `right:50%` : `left:50%`};width:${w}%"></i></span>`
      + `<b class="drv-usd ${p.usd > 0 ? 'pos' : p.usd < 0 ? 'neg' : ''}">${usd(p.usd)}</b></li>`;
  }).join(''));
  const f = d.fit;
  setText($('drvFit'), f?.ready ? `Fitted on ${int(f.n)} one-minute moves over the last 3 days: the macro explains ${Math.round(f.r2Macro * 100)}% of ${MKT.name}'s moves, macro plus its market ${Math.round(f.r2All * 100)}%. The rest is its own.` : '');
}
// the hover layer: the time, the actual move, the drivers' part and its own at the nearest point
(() => {
  const box = $('drvChart'), tip = $('drvTip');
  if (!box || !tip) return;
  const hide = () => { tip.hidden = true; box.querySelector('.dv-cross')?.setAttribute('visibility', 'hidden'); };
  box.addEventListener('pointermove', (e) => {
    const d = state.drv, xs = state.drvXs, svg = box.querySelector('svg');
    if (!d?.series?.length || !xs?.length || !svg) return hide();
    const r = svg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width;
    let i = 0; for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - fx) < Math.abs(xs[i] - fx)) i = k;
    const p = d.series[i], dg = Math.max(2, MKT.digits ?? 2), usd = (v) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(dg)}`, vb = svg.viewBox.baseVal;
    const ln = svg.querySelector('.dv-cross'); ln.setAttribute('x1', xs[i] * vb.width); ln.setAttribute('x2', xs[i] * vb.width); ln.setAttribute('visibility', 'visible');
    setHTML(tip, `<b>${new Date(p.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b><span>Actual <b>${usd(p.actual)}</b></span><span>Drivers <b>${usd(p.drivers)}</b></span><span>Its own <b>${usd(p.actual - p.drivers)}</b></span>`);
    tip.hidden = false;
    const bx = box.getBoundingClientRect(), left = Math.min(bx.width - tip.offsetWidth - 4, Math.max(4, e.clientX - bx.left + 10));
    tip.style.left = `${left}px`;
  });
  box.addEventListener('pointerleave', hide);
})();

// ---------- Map to success (public/success.js): live stats, the road with a tip per step, the coach ----------
function renderSuccess(now = Date.now()) {
  if (!$('view-success')?.classList.contains('active') && !shownViews.has('success')) return;
  const m = successMap({ trades: state.trades, positions: state.positions, settings, level: riskLevelOf(settings), pushOn: !!state.pushOn, seen: callStats(state.callLog), record: state.botRecord, pick: state.pick, now });
  const y = m.you, pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  setText($('mapPnl'), y.n ? money(y.pnl) : '$0.00'); setClass($('mapPnl'), y.n ? (y.pnl > 0 ? 'pos' : y.pnl < 0 ? 'neg' : '') : '');
  setText($('mapPnlSub'), y.n ? `over ${int(y.n)} tracked trade${y.n > 1 ? 's' : ''}${state.positions.length ? ` · ${state.positions.length} open` : ''}` : 'Tap "I bought it" on a call to start tracking');
  // running P&L: one line, the zero line dashed (no legend: the label above names it)
  const c = y.curve.length > 1 ? y.curve : null;
  if (c) {
    const lo = Math.min(0, ...c), hi = Math.max(0, ...c), span = hi - lo || 1, X = (i) => (i / (c.length - 1)) * 300, Y = (v) => 52 - ((v - lo) / span) * 48;
    setHTML($('mapSpark'), `<line x1="0" x2="300" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="z"/><polyline class="${c.at(-1) >= 0 ? 'up' : 'dn'}" points="${c.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/><circle r="3" cx="300" cy="${Y(c.at(-1)).toFixed(1)}" class="${c.at(-1) >= 0 ? 'up' : 'dn'}"/>`);
  } else setHTML($('mapSpark'), '<line x1="0" x2="300" y1="28" y2="28" class="z"/>');
  const t = y.today, lim = settings.dailyLossLimit > 0 ? settings.dailyLossLimit : 0, used = lim ? Math.min(1, Math.max(0, -t.pnl) / lim) : 0;
  setText($('mapToday'), t.trades ? money(t.pnl) : '$0.00'); setClass($('mapToday'), t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : '');
  const meter = $('mapTodayMeter'); if (meter) { meter.firstChild.style.width = `${(used * 100).toFixed(1)}%`; setClass(meter, `map-meter ${t.hit ? 'crit' : used >= 0.6 ? 'warn' : 'ok'}`); }
  setText($('mapTodaySub'), !lim ? 'no daily limit set' : t.hit ? '⛔ limit hit, done for today' : `${used >= 0.6 ? '⚠ ' : ''}$${Math.max(0, lim + Math.min(0, t.pnl)).toFixed(2)} left of $${lim.toFixed(2)}`);
  setText($('mapRate'), pct(y.rate)); setText($('mapRateSub'), y.breakEven != null ? `break-even ${pct(y.breakEven)}` : 'after your first trade');
  setClass($('mapRate'), y.n >= 15 && y.rate != null && y.breakEven != null ? (y.rate >= y.breakEven ? 'pos' : 'neg') : '');
  const b = m.bot;
  setText($('mapBot'), b ? `${b.wins}–${b.graded - b.wins}` : '—');
  setText($('mapBotSub'), b ? (b.graded ? `${money(b.usd)} at $10 a call${b.paused ? ' · paused' : ''}` : `${b.level}: no graded calls yet`) : 'loading…');
  const k = m.pick;
  setText($('mapPick'), !k ? '—' : k.locked ? `${k.side === 'YES' ? 'UP' : 'DOWN'}${k.buy ? ' ✓' : ''}` : k.locksAt > now ? mmss((k.locksAt - now) / 60000) : 'locking');
  setClass($('mapPick'), k?.locked ? (k.side === 'YES' ? 'pos' : 'neg') : '');
  setText($('mapPickSub'), !k ? 'waiting for the next round' : [k.locked ? (k.buy ? `BUY at ${Math.round(k.price * 100)}¢` : 'pick only') : 'until it locks', k.last ? `last ${k.last}` : null, k.graded ? `${pct(k.wins / k.graded)} of ${int(k.graded)}` : null].filter(Boolean).join(' · '));
  const icon = { warn: '⚠', good: '✓', info: 'ℹ', tip: '★' };
  setHTML($('mapCoach'), m.coach.map((x) => `<li class="${x.kind}"><i aria-hidden="true">${icon[x.kind]}</i><span><b>${esc(x.title)}</b><small>${esc(x.text)}</small></span></li>`).join(''));
  setText($('mapDone'), `${m.done} of ${m.steps.length} done`);
  const ov = $('mapOverall'); if (ov) ov.firstChild.style.width = `${((m.done / m.steps.length) * 100).toFixed(1)}%`;
  setHTML($('mapSteps'), m.steps.map((s, i) => {
    const st = s.done ? 'done' : i === m.at ? 'now' : 'todo';
    const tip = `<p class="map-tip"><b>Tip</b> ${esc(s.tip)}</p>`;
    return `<li class="${st}"><span class="map-node" aria-hidden="true">${s.done ? '✓' : i + 1}</span><div class="map-body">` +
      `<div class="map-title"><b>${esc(s.title)}</b><em>${s.done ? 'done' : i === m.at ? 'you are here' : ''}</em></div><small>${esc(s.goal)}</small>` +
      `<div class="map-meter ${s.done ? 'ok' : ''}"><i style="width:${(Math.max(0, Math.min(1, s.progress)) * 100).toFixed(1)}%"></i></div><small class="map-val">${esc(s.value)}</small>` +
      `${st === 'now' ? tip : `<details><summary>Tip</summary>${tip}</details>`}</div></li>`;
  }).join(''));
}
setInterval(() => { if (!document.hidden) renderSuccess(); }, 1000);

// ---------- the official bot record (server: every call it made, around the clock) ----------
async function refreshBotRecord() {
  try { state.botRecord = await getJSON(api('record')); state.botRecordAt = Date.now(); renderBotRecord(); } catch { /* next time */ }
}
setInterval(() => { if (!document.hidden) refreshBotRecord(); }, 60000);
function renderBotRecord() {
  const r = state.botRecord;
  if (!r) return;
  renderCertain(r);
  const losses = r.graded - r.wins, pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  setText($('brLevel'), `${r.level} settings`);
  setText($('brWL'), r.graded ? `${r.wins}–${losses}` : '0–0');
  setText($('brPct'), pctOf(r.wins, r.graded));
  setClass($('brPct'), !r.graded ? '' : r.wins / r.graded >= 0.8 ? 'pos' : r.wins / r.graded < 0.6 ? 'neg' : '');
  setText($('brStreak'), r.streak ? `${r.streak.kind}${r.streak.n}` : '—');
  setClass($('brStreak'), r.streak?.kind === 'W' ? 'pos' : r.streak?.kind === 'L' ? 'neg' : '');
  const since = r.since ? new Date(r.since).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;
  const g = r.guard, b = r.before;
  const guardLine = g ? ` Win-rate guard: ${g.n ? `the last ${g.n} graded calls won ${pctOf(g.wins, g.n)}${g.low != null && g.n >= 10 ? ` (at least ${Math.round(g.low * 100)}% with 95% confidence)` : ''}` : 'no graded calls yet'}; it only calls sides Kalshi prices at <b>${Math.round(g.floor * 100)}¢</b>+ right now${g.floor > 0.9 ? ' (raised because the record slipped below its 92% aim)' : ''}.` : '';
  // how early the calls come (minutes left at the call) and how the early ones (8+ minutes left) did
  const leftAt = (e) => (Date.parse(e.closeTime) - e.at) / 60000, timed = r.calls.filter((e) => e.at && e.closeTime);
  const early = timed.filter((e) => leftAt(e) >= 8 && (e.result === 'yes' || e.result === 'no')), earlyWon = early.filter((e) => e.side.toLowerCase() === e.result).length;
  const timeLine = timed.length ? ` Calls come with <b>${(timed.reduce((a, e) => a + leftAt(e), 0) / timed.length).toFixed(1)} min</b> left on average${early.length ? `; early calls (8+ min left) won <b>${earlyWon} of ${early.length}</b>` : ''}.` : '';
  const beforeLine = b?.graded ? ` Before the 90% target (Steady, to ${new Date(b.until).toLocaleDateString([], { month: 'short', day: 'numeric' })}): won ${pctOf(b.wins, b.graded)} of ${int(b.graded)}.` : '';
  setHTML($('brSub'), (!r.calls.length ? `No calls yet on the ${esc(r.level)} level. The bot calls on its own around the clock, and every call shows up here, win or lose.`
    : `Every call the bot made${since ? ` since ${since}` : ''}, around the clock, graded against Kalshi's result. It said ${r.said != null ? Math.round(r.said) : '—'}% on average and won ${pctOf(r.wins, r.graded)}. $10 on every call, held to settlement: ${money(r.usd)}. Best win streak: ${r.bestWin}.` +
      `${r.graded < 30 ? ' Under 30 graded calls is too early to judge: luck still dominates.' : ''}`) + timeLine + guardLine + beforeLine);
  // the record over a time window (v13.41): last hour to all time
  const RANGES = [['1h', 1], ['4h', 4], ['12h', 12], ['24h', 24], ['3d', 72], ['all', 0]], sel = store.get('brRange', 'all');
  const winCalls = sel === 'all' ? null : r.calls.filter((e) => e.at >= Date.now() - (RANGES.find((x) => x[0] === sel)?.[1] ?? 0) * 3600000);
  const ws = winCalls ? callStats(winCalls) : null;
  setHTML($('brRange'), RANGES.map(([k]) => `<button type="button" data-r="${k}" class="${k === sel ? 'on' : ''}">${k === 'all' ? 'all time' : `last ${k}`}</button>`).join('')
    + `<small>${ws ? `last ${sel}: ${ws.graded ? `<b>${ws.wins}–${ws.graded - ws.wins}</b> (${pctOf(ws.wins, ws.graded)}) · ${money(ws.usd)} at $10 a call` : 'no graded calls in this window'}` : `all time: <b>${r.wins}–${losses}</b> (${pctOf(r.wins, r.graded)}) · ${money(r.usd)} at $10 a call`}</small>`);
  const days = dailyRecord(r.calls, 14), top = Math.max(1, ...days.map((d) => d.w + d.l));
  setHTML($('brDays'), days.map((d) => `<div title="${d.day}: ${d.w} won, ${d.l} lost"><i class="w" style="height:${(d.w / top) * 100}%"></i><i class="l" style="height:${(d.l / top) * 100}%"></i></div>`).join(''));
  $('brDays').classList.toggle('empty', !days.some((d) => d.w + d.l));
  setHTML($('brBuckets'), ['90+', '80–89', '70–79', 'under 70'].filter((k) => r.buckets?.[k]).map((k) => {
    const b = r.buckets[k];
    return `<li><span><b>Confidence ${k}</b><small>${b.calls} call${b.calls > 1 ? 's' : ''} · said ${Math.round(b.said)}% · won ${pctOf(b.wins, b.calls)}</small></span><b class="${b.usd >= 0 ? 'pos' : 'neg'}">${money(b.usd)}</b></li>`;
  }).join(''));
  const now = Date.now();
  setHTML($('brCalls'), r.calls.slice(-12).reverse().map((e) => {
    const up = e.side === 'YES', graded = e.result === 'yes' || e.result === 'no', won = graded && e.side.toLowerCase() === e.result;
    const badge = graded ? (won ? '<span class="badge win">WIN</span>' : '<span class="badge loss">LOSS</span>') : e.result === 'unknown' ? '<span class="badge">VOID</span>' : Date.parse(e.closeTime) > now ? '<span class="badge live">LIVE</span>' : '<span class="badge">SETTLING</span>';
    const when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<li><img src="${up ? 'bull' : 'bear'}.svg" alt=""><span><b>${up ? 'UP' : 'DOWN'} at ${pc(e.price)}</b><small>${when} · confidence ${e.conf ?? '—'}${e.hold != null ? ` · hold ${Math.round(e.hold * 100)}%` : ''}${e.receipt ? ` · <span class="rcpt" title="Sealed: a hash of this call and the one before it. Editing or removing any call breaks every receipt after it.">🔒 ${esc(e.receipt.slice(0, 10))}</span>` : ''}</small></span>${badge}</li>`;
  }).join('') || '<li class="empty">The first call will show up here.</li>');
}

// The bot's call record: what it claimed (confidence = win odds) next to how often its calls really won
function renderRecord() {
  const st = callStats(state.callLog);
  const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  setText($('recSummary'), !st.calls ? 'No calls yet. Every BUY THE LOW call the bot makes while the app is open is logged here and graded when Kalshi settles it.'
    : !st.graded ? `${st.calls} call${st.calls > 1 ? 's' : ''} logged, waiting for Kalshi to settle them.`
    : `${st.graded} call${st.graded > 1 ? 's' : ''} graded${st.calls > st.graded ? ` (${st.calls - st.graded} waiting for Kalshi)` : ''}: won ${st.wins} (${pctOf(st.wins, st.graded)})${st.said != null ? `, the bot said ${Math.round(st.said)}% on average` : ''}. $10 on every call, held to settlement: ${money(st.usd)}.${st.graded < 30 ? ' Under 30 calls is too few to judge: luck still dominates.' : ''}`);
  const order = ['90+', '80–89', '70–79', 'under 70'];
  setHTML($('recBuckets'), order.filter((k) => st.buckets[k]).map((k) => {
    const b = st.buckets[k];
    return `<li><span><b>Confidence ${k}</b><small>${b.calls} call${b.calls > 1 ? 's' : ''} · said ${Math.round(b.said)}% · won ${pctOf(b.wins, b.calls)}</small></span><b class="${b.usd >= 0 ? 'pos' : 'neg'}">${money(b.usd)}</b></li>`;
  }).join(''));
}

// ---------- live BTC price ----------
// Streams every trade from Coinbase's public WebSocket. Falls back to polling if it drops.
const LIVE_WS = 'wss://ws-feed.exchange.coinbase.com';
let ws = null, wsRetry = 0, wsTimer = null, renderQueued = false, shownSpot = null, flashTimer = null;
const isLive = () => !!state.liveAt && Date.now() - state.liveAt < 10000;

function liveConnect() {
  if (!CRYPTO || ws || document.hidden || typeof WebSocket === 'undefined') return; // indexes, gold and oil: polled (prices.js)
  try { ws = new WebSocket(LIVE_WS); } catch { ws = null; return; }
  ws.onopen = () => {
    wsRetry = 0;
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: [MKT.product], channels: ['ticker', 'heartbeat', 'matches'] }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    // a heartbeat every second proves the stream is up: no trade since means the last price still stands (quiet coins
    // like XRP or DOGE can go 30s+ without a trade, which used to read as lost data)
    if (m.type === 'heartbeat') { state.liveAt = Date.now(); if (state.spot && state.spotFromWs) state.spotAt = Date.now(); return; }
    if (m.type === 'match') { handleTrades(parseCoinbase(m).filter(Boolean)); return; }
    if (m.type !== 'ticker' || !m.price) return;
    state.spot = Number(m.price); state.spotAt = Date.now(); state.spotFromWs = true;
    state.open24h = Number(m.open_24h) || state.open24h;
    state.liveAt = Date.now();
    queueRender();
  };
  ws.onclose = () => {
    ws = null; state.liveAt = 0; state.spotFromWs = false;
    clearTimeout(wsTimer);
    if (!document.hidden) wsTimer = setTimeout(liveConnect, Math.min(30000, 1000 * 2 ** wsRetry++));
  };
  ws.onerror = () => ws?.close();
}
function liveDisconnect() { clearTimeout(wsTimer); if (ws) { ws.onclose = null; ws.close(); ws = null; } state.liveAt = 0; state.spotFromWs = false; }

// Price ticks arrive many times a second; redraw at most 4 times a second.
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 250);
}

// The price rolls to its new value instead of jumping (skipped with reduce motion)
let priceTween = null;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function tweenPrice(el, from, to) {
  if (priceTween) cancelAnimationFrame(priceTween.raf);
  if (reduceMotion() || document.hidden) { priceTween = null; setText(el, `${MKT.key} ${usd(to, Math.max(2, MKT.digits))}`); return; }
  const start = performance.now(), dur = 450;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur), e = 1 - (1 - k) ** 3;
    setText(el, `${MKT.key} ${usd(from + (to - from) * e, Math.max(2, MKT.digits))}`);
    if (k < 1) priceTween.raf = requestAnimationFrame(step); else priceTween = null;
  };
  priceTween = { raf: requestAnimationFrame(step) };
}
function renderTicker(strike) {
  const live = isLive(), spot = state.spot;
  setText($('liveBadge'), live ? 'LIVE' : spot ? 'DELAYED' : '…');
  setClass($('liveBadge'), `tk-badge ${live ? 'live' : ''}`);
  if (!priceTween && !(spot && shownSpot && spot !== shownSpot)) setText($('livePrice'), spot ? `${MKT.key} ${usd(spot, Math.max(2, MKT.digits))}` : `${MKT.key} —`);
  if (spot && shownSpot && spot !== shownSpot) {
    const el = $('ticker'), up = spot > shownSpot;
    el.classList.remove('up', 'down');
    el.classList.add(up ? 'up' : 'down');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('up', 'down'), 600);
    tweenPrice($('livePrice'), shownSpot, spot);
  }
  shownSpot = spot;
  const day = spot && state.open24h ? spot - state.open24h : null;
  setText($('liveMove'), day == null ? '' : `24h ${day >= 0 ? '+' : '-'}${usd(Math.abs(day), 0)} (${((day / state.open24h) * 100).toFixed(2)}%)`);
  setClass($('liveMove'), `tk-move ${day > 0 ? 'pos' : day < 0 ? 'neg' : ''}`);
  const d = spot && strike ? modelSpot() - strike : null;
  setText($('liveTarget'), d == null ? '' : `${d >= 0 ? '▲' : '▼'} ${usd(Math.abs(d), 0)} ${d >= 0 ? 'above' : 'below'} target${indexFresh() && state.index.used.length > 1 ? ` · index of ${state.index.used.length} exchanges` : ''}`);
  setClass($('liveTarget'), `tk-target ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`);
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
  setText($('pushStatus'), text);
  $('pushStatus').classList.toggle('on', on && !msg);
  setHidden($('pushOn'), on || !pushSupported());
  setHidden($('pushTest'), !on);
  setHidden($('pushOff'), !on);
  setHidden($('pushNudge'), on || store.get('nudgeDismissed', false));
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
    setText($('accessLine'), st.role === 'admin' ? 'Admin (no expiry)'
      : st.access ? `Active until ${day(st.expires)} · code ${st.code} (use it to unlock your other devices)`
      : st.open ? 'Open: this server doesn\'t need a sign-in' : 'No access');
    setHidden($('signOut'), !!st.open && !st.access);
    setHidden($('adminCard'), st.role !== 'admin');
    setHidden($('adminLogin'), st.role === 'admin');
    if (st.role === 'admin') loadAdmin();
    loadDiscord();
  } catch { /* offline */ }
}

// ---------- Discord role (server: discordroles.js): link once, the members' role follows your access ----------
let discordNote = null; // what Discord's sign-in page sent back (?discord=linked|error&msg=), shown once
{
  const q = new URLSearchParams(location.search);
  if (q.get('discord')) {
    discordNote = q.get('discord') === 'linked' ? (q.get('msg') ? `Linked, but: ${q.get('msg')}` : 'Linked ✓ Your role is on its way.') : `Not linked: ${q.get('msg') || 'something went wrong'}`;
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => split.show('settings'), 300);
  }
}
async function loadDiscord() {
  try {
    const d = await getJSON('discord/status');
    // only members can link; when the server owner hasn't set it up, only admins hear about it (with what's missing)
    const admin = state.access?.role === 'admin';
    setHidden($('dscRow'), !(d.member && d.on) && !(admin && !d.on));
    setHidden($('dscLink'), !d.member || !d.on);
    setHidden($('dscUnlink'), !d.linked);
    setText($('dscLink'), d.linked ? 'Relink' : 'Link Discord');
    const l = d.linked;
    setText($('dscLine'), discordNote ?? (!d.on ? `Off: set ${d.missing.join(', ')} in Railway's Variables to give paying members their Discord role.`
      : !l ? 'Link your Discord account to get the members\' role while your access is active.'
      : l.error ? `${l.name}: ${l.error}` : `${l.name} · ${l.role ? 'members\' role on ✓' : l.role === false ? 'no role (access not active)' : 'checking…'}`));
    discordNote = null;
  } catch { setHidden($('dscRow'), true); }
}
$('dscLink').addEventListener('click', async () => {
  setText($('dscLink'), 'Opening Discord…');
  try { const { url } = await postJSON('discord/link', {}); location.assign(url); }
  catch (e) { setText($('dscLine'), e.message); setText($('dscLink'), 'Link Discord'); }
});
$('dscUnlink').addEventListener('click', async () => {
  if (!confirm('Unlink your Discord account? The members\' role comes off.')) return;
  try { await postJSON('discord/unlink', {}); } catch (e) { window.alert(e.message); }
  loadDiscord();
});

async function loadAdmin() {
  try {
    const { config, members } = await getJSON('admin/members');
    if (document.activeElement !== $('admPrice')) $('admPrice').value = config.price;
    if (document.activeElement !== $('admDays')) $('admDays').value = config.days;
    const now = Date.now();
    const pending = members.filter((m) => m.status === 'pending' || (m.paidAt && m.paidAt > (m.approvedAt || 0) && m.status !== 'denied' && m.status !== 'revoked'));
    const others = members.filter((m) => !pending.includes(m) && m.status !== 'pending');
    setHTML($('admPending'), pending.map((m) => `<li><span><b>${m.code}</b><small>${m.paidAt ? `says paid ${clock(m.paidAt)} · ${day(m.paidAt)}` : 'hasn\'t tapped "I\'ve paid" yet'}${m.expires > now ? ' · renewing' : ''}</small></span>
      <span class="adm-btns"><button data-adm="approve" data-code="${m.code}">Approve</button><button data-adm="deny" data-code="${m.code}" class="ghost">Deny</button></span></li>`).join('') ||
      '<li class="muted">Nobody waiting. You\'ll get a push when someone taps "I\'ve paid" (turn on notifications).</li>');
    setHTML($('admMembers'), others.map((m) => {
      const active = m.status === 'active' && m.expires > now;
      const label = active ? `active until ${day(m.expires)}` : m.status === 'active' ? `expired ${day(m.expires)}` : m.status;
      const dsc = m.discord ? ` · Discord ${esc(m.discord.name)} ${m.discord.error ? '⚠' : m.discord.role ? '✓ role' : 'no role'}` : '';
      return `<li><span><b>${m.code}</b><small>${label} · ${m.devices} device${m.devices === 1 ? '' : 's'}${dsc}</small></span>
        <span class="adm-btns">${active ? `<button data-adm="approve" data-code="${m.code}" class="ghost">+${state.access?.days ?? ''}d</button><button data-adm="revoke" data-code="${m.code}" class="ghost">Revoke</button>` : `<button data-adm="approve" data-code="${m.code}">Approve</button>`}</span></li>`;
    }).join('') || '<li class="muted">No members yet.</li>');
  } catch (e) { setText($('admErr'), e.message); }
}

async function adminAction(action, body) {
  setText($('admErr'), '');
  try { await postJSON(`admin/${action}`, body); await loadAdmin(); }
  catch (e) { setText($('admErr'), e.message); }
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
  setHTML($('settingsForm'), SETTINGS_META.map(([k, label, hint, kind]) => {
    if (kind === 'bool') return `<label><span>${label}<small>${hint}</small></span><input type="checkbox" name="${k}" ${settings[k] ? 'checked' : ''}></label>`;
    const v = kind === 'cents' ? Math.round(settings[k] * 1000) / 10 : settings[k];
    return `<label><span>${label}<small>${hint}</small></span><input name="${k}" ${kind === 'text' ? '' : 'inputmode="decimal"'} value="${esc(v)}"></label>`;
  }).join(''));
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
    if (k === 'refreshSec') schedule();
    if (k === 'multiFeeds') feedsOn();
    render();
  });
}

// ---------- the market picker (public/markets.js): which Kalshi 15-minute round the bot calls ----------
// The header's coin tag is the picker. Kalshi's open markets are checked by the server; one it hasn't listed or has paused
// shows as closed. Switching saves the choice (the server's alerts follow it) and reloads, so every price, chart and log
// starts clean on the new coin.
(function marketPicker() {
  const sel = $('mktPick');
  if (!sel) return;
  const draw = (list) => {
    const groups = new Map();
    for (const m of list) { const mk = marketOf(m.series, list); if (!groups.has(mk.name)) groups.set(mk.name, []); groups.get(mk.name).push({ ...m, mk }); }
    if (!list.some((m) => m.series === settings.series)) groups.set(MKT.name, [...(groups.get(MKT.name) || []), { series: settings.series, mk: MKT, state: 'unknown' }]);
    const order = ASSETS.map((a) => a.name);
    sel.innerHTML = [...groups.entries()].sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])).map(([name, ms]) => `<optgroup label="${esc(name)}">${ms.map((m) => {
      // never greyed out (v13.42.1): the server's last check can be wrong or stale, and a closed market just shows no round
      return `<option value="${m.series}"${m.series === settings.series ? ' selected' : ''}>${esc(marketLabel(m.mk))}${m.state === 'closed' ? ' (closed)' : m.state === 'later' ? ' (later)' : ''}</option>`;
    }).join('')}</optgroup>`).join('');
  };
  draw(marketList);
  getJSON('markets').then((d) => { const ms = (d?.markets || []).filter((m) => listed(m)); if (ms.length) { store.set('marketList', ms.map(({ series, asset, freq, title, state }) => ({ series, asset, freq, title, state }))); draw(ms); } }).catch(() => {});
  sel.addEventListener('change', async () => {
    const next = sel.value;
    if (next === settings.series || !/^[A-Z0-9]+$/.test(next)) return;
    settings.series = next; store.set('settings', settings);
    toast(`Switching to ${marketLabel(marketOf(next, store.get('marketList', SEEDS)))}…`);
    try { await Promise.race([pushSync(), new Promise((r) => setTimeout(r, 2500))]); } catch { /* the next sync carries it */ }
    location.reload();
  });
  document.body.classList.toggle('alt-market', !HOME);
  // the page's own labels and explanations say BTC; on another coin they say that coin (v13.42.3), once, at startup
  if (MKT.key !== 'BTC') {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/\bBTC\b/.test(n.nodeValue) && !n.parentElement?.closest('script, style, select')) n.nodeValue = n.nodeValue.replace(/\bBTC\b(?! Trader's)/g, MKT.key);
  }
  document.body.classList.toggle('no-feeds', !CRYPTO);
  const note = $('altNote'), why = [];
  if (!CRYPTO) why.push(`${MKT.name} has no public exchange trade feeds, so the tug of war, Round scan, live orders and futures aren't available here; its price comes from Yahoo's public charts, and the bot makes no calls while that price is delayed (over 90 seconds old) or the market is closed.`);
  if (MKT.freq !== '15m') why.push('A round with many strikes: the bot calls the one nearest even odds, locked once calls can start.');
  if (note) { setHidden(note, !why.length); if (why.length) setText(note, `${marketLabel(MKT)}: ${why.join(' ')}`); }
})();

// ---------- loop ----------
let timer;
async function tick() {
  try {
    const jobs = isLive() && state.spotFromWs ? [] : [refreshSpot()]; // polled until the stream has given a price
    if (Date.now() - state.candlesAt > 20000) jobs.push(refreshCandles());
    if (!(Date.now() - (state.memory?.at || 0) < 2 * 60000) && !state.memoryBusy) { state.memoryBusy = true; refreshMemory().catch(() => {}).finally(() => { state.memoryBusy = false; }); }
    const closed = state.markets.length && Date.parse(state.markets[0].close_time) < Date.now();
    if (Date.now() - state.marketsAt > settings.refreshSec * 1000 || closed) jobs.push(refreshMarkets());
    refreshIndex().catch(() => { state.index = null; }); // optional: without it the bot uses Coinbase alone
    await Promise.all(jobs);
    setClass($('status'), 'dot ok');
    $('status').title = 'connected';
    settlePositions();
  } catch (e) {
    console.warn(e);
    setClass($('status'), 'dot err');
    $('status').title = e.message;
  }
  render();
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(tick, Math.max(2, settings.refreshSec) * 1000);
}

// Screens: one at a time, or up to four side by side (public/split.js). The bottom bar changes the focused pane.
const shownViews = new Set();
const split = createSplit({ main: document.querySelector('main'), store, button: $('splitBtn'), menu: $('splitMenu'), onShow: (views, focused) => {
  for (const b of document.querySelectorAll('nav button')) { b.classList.toggle('active', b.dataset.view === focused); b.classList.toggle('shown', views.includes(b.dataset.view) && b.dataset.view !== focused); }
  for (const v of views) {
    if (shownViews.has(v)) continue; // only what just came into view needs a refresh
    if (v === 'settings') loadAccess();
    if (v === 'chart') requestAnimationFrame(() => drawChartTab(true)); // after the layout, so it has its width
    if (v === 'alerts') alerts.render();
    if (v === 'learn') renderLessons();
    if (v === 'history') refreshLab(true);
    if (v === 'history') refreshBotRecord();
    if (v === 'success') { refreshBotRecord(); requestAnimationFrame(() => renderSuccess()); }
  }
  shownViews.clear(); for (const v of views) shownViews.add(v);
  adminPolling(views.includes('settings'));
} });
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => split.show(b.dataset.view)));
{ // Settings: what this device was detected as, so a missing ⊞ button can be explained
  const d = split.device(), sys = d.platform || (d.ua.match(/\(([^;)]+)/)?.[1] ?? 'unknown system');
  setText($('splitInfo'), d.forced === '1' ? 'Split screen: on (turned on with ?split=1): use the ⊞ button at the top right.'
    : d.forced === '0' ? 'Split screen: off (turned off with ?split=0; open the app with ?split=1 to turn it back on).'
    : d.available ? `Split screen: on. This is a computer (${sys}): use the ⊞ button at the top right.`
    : `Split screen: computers only, and this looks like a ${d.kind === 'unknown' ? 'device it can\'t recognise' : 'phone or tablet'} (${sys}). If it's really a computer, open the app with ?split=1 at the end of the address.`);
}
$('status').addEventListener('click', () => window.alert($('status').title || 'connecting…'));
$('pushOn').addEventListener('click', () => pushEnable().catch((e) => renderPush(`Couldn't turn on push: ${e.message}`)));
$('pushOff').addEventListener('click', () => pushDisable());
$('pushTest').addEventListener('click', async () => {
  setText($('pushTest'), 'Sending…');
  try { await postJSON('push/test', { endpoint: pushSub.endpoint }); setText($('pushTest'), 'Sent ✓'); }
  catch (e) { setText($('pushTest'), 'Send test'); renderPush(`Test failed: ${e.message}`); }
  setTimeout(() => { setText($('pushTest'), 'Send test'); }, 3000);
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
  const pos = state.positions.find((p) => String(p.id ?? '') === btn.dataset.id);
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
  if (document.hidden) { liveDisconnect(); feedState.since = null; feedState.lost = false; } // an outage is only judged while you're looking
  else { state.resumedAt = Date.now(); liveConnect(); tick(); }
  feedsOn();
});
// Between polls only the clocks move, so update just those each second (a full redraw every second
// cost the most phone battery). Full redraw if no poll or price tick has rendered for ~3 seconds,
// and when the opening wait ends so the call appears right on time.
// The thin bar under the countdown: how much of the 15-minute round is gone (moves smoothly, 1s steps)
function roundBar(close, now = Date.now()) {
  const el = $('roundBar');
  if (!el) return;
  const k = close ? Math.min(1, Math.max(0, 1 - (close - now) / 900000)) : 0;
  const v = `scaleX(${k.toFixed(4)})`;
  if (el.style.transform !== v) el.style.transform = v;
  el.parentElement.classList.toggle('late', close != null && close - now < 120000);
}
function tickClocks() {
  if (state.pick && !state.pick.live) renderPick(); // the countdown to the 10-minute pick
  const now = Date.now(), c = state.clock;
  if (!document.hidden && now - bootAt > 20000 && healthDue(state.health?.at, now)) runHealth();
  if (now - (state.renderedAt || 0) > 2900 || (c?.callsAt && now >= c.callsAt) || (c && now >= c.close)) return render();
  if (c) {
    setText($('countdown'), `closes in ${mmss((c.close - now) / 60000)}`);
    roundBar(c.close, now);
    if (c.callsAt) setText($('reason'), `Calls start in ${mmss((c.callsAt - now) / 60000)} (bot watches the first ${settings.waitMinutes} min)`);
  }
  for (const el of document.querySelectorAll('.pos-clock')) {
    const left = (Number(el.dataset.close) - now) / 60000;
    setText(el, left > 0 ? mmss(left) : 'closed');
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
    // the real fee on each new fill (any market) teaches the bot Kalshi's actual rate (public/fees.js, feebook.js)
    const feeFills = fills.filter((f) => !seen.has(f.id) && f.fee != null && f.price != null && f.count > 0).map((f) => ({ id: `f-${f.id}`, count: f.count, price: f.price, fee: f.fee, taker: f.taker !== false }));
    if (feeFills.length) postJSON('fees', { samples: feeFills.slice(0, 300) }).catch(() => {});
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
  setHidden($('kForm'), linked);
  setHidden($('kLinked'), !linked);
  setText($('kErr'), k.error || '');
  if (!linked) return;
  const bal = k.balance != null ? ` · balance ${dollars(k.balance)}` : '';
  const last = k.lastSync ? ` · synced ${clock(k.lastSync)}` : ' · syncing…';
  const v = k.verify;
  const check = !v ? '' : v.error ? ` · couldn't check against Kalshi (${v.error})`
    : v.fixes.length ? ` · corrected from Kalshi at ${clock(v.at)}: ${v.fixes.join('; ')}`
    : ` · ✓ matches Kalshi (${v.positions} open position${v.positions === 1 ? '' : 's'}, checked ${clock(v.at)})${k.lastFix && Date.now() - k.lastFix.at < 3600000 ? ` · last correction ${clock(k.lastFix.at)}: ${k.lastFix.fixes.join('; ')}` : ''}`;
  setText($('kStatus'), `Linked (key ${k.keyId.slice(0, 8)}…)${bal}${last}${check}. Your ${settings.series} buys and sells show up on their own.`);
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
  setText($('kErr'), '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(keyId)) { state.kalshi.error = 'Enter the API key ID from Kalshi'; return renderKalshi(); }
  setText($('kLink'), 'Linking…');
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
    setText($('kLink'), 'Link account');
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
  setHTML($('riskBtns'), Object.entries(RISK_LEVELS).map(([k, r]) => `<button type="button" data-risk="${k}" class="${cur === k ? 'on' : ''}">${r.label}</button>`).join(''));
  setText($('riskHint'), cur === 'custom'
    ? `Custom: min gap ${(settings.minEdge * 100).toFixed(0)} pts, confidence ${settings.minConfidence}. Tap a level to reset.`
    : `${RISK_LEVELS[cur].hint}. Calls need a gap of ${(RISK_LEVELS[cur].minEdge * 100).toFixed(0)} pts and confidence ${RISK_LEVELS[cur].minConfidence}${RISK_LEVELS[cur].bigEdgeOverride ? ` (or a ${Math.round(RISK_LEVELS[cur].bigEdgeOverride * 100)}-pt worst-case gap)` : ''}; bets up to $${RISK_LEVELS[cur].maxStake}.`);
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
    store.set(LK('ruleLog'), log);
  }
  let changed = false;
  for (const e of log) if (e.spot5 == null && snap.spot && now - e.seenAt >= 5 * 60000 && now - e.seenAt < 7 * 60000) { e.spot5 = snap.spot; changed = true; }
  if (changed) store.set(LK('ruleLog'), log);
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
      store.set(LK('ruleLog'), state.ruleLog); store.set(LK('callLog'), state.callLog);
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
  setText($('ruleScore'), rs.fired ? `Two-rejections rule scorecard: fired ${rs.fired} time${rs.fired > 1 ? 's' : ''} · price went the expected way 5 min later ${rs.right5} of ${rs.five} · the side it favored won ${rs.won} of ${rs.settled} settled` : 'Two-rejections rule scorecard: hasn\'t fired yet (it\'s scored on every market while the app is open)');
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
  setText($('healthStatus'), `${bad.length ? `${bad.length} problem${bad.length > 1 ? 's' : ''}` : 'All good'} · checked ${clock(h.at)} · next ${clock(next)} (every 2 rounds)`);
  setHTML($('healthList'), [...bad, ...h.items.filter((r) => r.level === 'ok')].map((r) =>
    `<li class="${r.level}"><b>${r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✕'}</b><span>${esc(coinText(r.label))}${r.fix ? `<small>${esc(coinText(r.fix))}</small>` : ''}</span></li>`).join(''));
  renderRuleScore();
}
$('healthRun').addEventListener('click', () => runHealth(true));
// Fold any card by tapping its title (remembered per card). Live notes start folded so the Deck stays short.
{
  const folded = store.get('folded', { 'Live notes': true });
  // v9.2: Live orders start open again (v8.7 folded them by default, which looked like they were gone)
  if (!store.get('liveOrdersOpen', false)) { delete folded['Live orders · all markets']; store.set('folded', folded); store.set('liveOrdersOpen', true); }
  for (const card of document.querySelectorAll('.card')) {
    if (card.tagName === 'DETAILS') continue; // already folds
    const head = card.firstElementChild;
    if (!head || !head.matches('.deep-head, .chart-head, h3')) continue;
    const key = (head.querySelector('span') || head).textContent.trim();
    if (!key) continue;
    card.classList.add('foldable');
    card.classList.toggle('folded', !!folded[key]);
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, label')) return;
      const now = !card.classList.contains('folded');
      card.classList.toggle('folded', now);
      folded[key] = now; store.set('folded', folded);
      if (!now) { chartState.key = null; render(); } // canvases inside need a redraw at their real size
    });
  }
}
buildSettings(); // (v5.0 cleanup dropped these two: the settings form and risk buttons were blank)
renderRisk();
if (store.get('steadyNote', false)) { store.set('steadyNote', false); setTimeout(() => toast('New default: Steady. Calls only when confidence is 85+ and likely to hold all round. Change it in Settings → Risk level.'), 1500); }
// Show the last price from the previous visit right away (marked DELAYED until a fresh one lands a moment later)
{ const last = store.get(LK('lastSpot'), null); // this market's own last price (v13.42.2: it used to be shared, so a switch showed BTC's price on DOGE)
  if (last && Date.now() - last.t < 15 * 60000 && !state.spot) { state.spot = last.p; renderTicker(null); } }
loadKalshi();
autopilot = createAutopilot({ $, esc, API, toast, paywalled });
try { sessionStorage.removeItem('sc_restore'); } catch { /* the app loaded, so any restore worked: re-arm the paywall's auto sign-in */ }
loadAccess();
liveConnect();
feedsOn();
refreshBotRecord();
pushInit();
tick();
schedule();

// Last: the saved split-screen layout (its screens' refreshes need everything above set up first)
split.start();
applyMode();
