import { DEFAULTS, evaluate, momentum, realizedVol, settlePnl } from './model.js';

const API = './api';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SETTINGS_META = [
  ['series', 'Kalshi series', 'Series ticker for 15-min BTC markets', 'text'],
  ['minEdge', 'Min edge (¢)', 'EV per contract after fees needed to call', 'cents'],
  ['maxSpread', 'Max spread (¢)', 'Skip markets with a wider yes spread', 'cents'],
  ['minMinutesLeft', 'Min minutes left', 'Stop calling this close to settlement', 'num'],
  ['maxMinutesLeft', 'Max minutes left', 'Don\'t call this early in the window', 'num'],
  ['volMultiplier', 'Vol multiplier', 'Above 1 means more conservative', 'num'],
  ['momentumWeight', 'Momentum weight', 'How much of the 10-min drift to carry forward (0 to 1)', 'num'],
  ['bankroll', 'Bankroll ($)', 'Used for position sizing', 'num'],
  ['kellyFraction', 'Kelly fraction', '0.25 means quarter Kelly', 'num'],
  ['maxStake', 'Max stake ($)', 'Cap per call', 'num'],
  ['refreshSec', 'Refresh (sec)', 'How often to poll', 'num'],
];
const settings = { series: 'KXBTC15M', refreshSec: 5, ...DEFAULTS, ...store.get('settings', {}) };

const state = { markets: [], spot: null, candles: [], candlesAt: 0, marketsAt: 0, strikes: {}, lastCall: {}, history: store.get('history', []) };

async function getJSON(path) {
  const r = await fetch(`${API}/${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------- data ----------
async function refreshCandles() {
  // [time, low, high, open, close, volume], newest first
  const rows = await getJSON('coinbase/products/BTC-USD/candles?granularity=60');
  state.candles = rows.map((r) => ({ t: r[0] * 1000, o: r[3], c: r[4] })).sort((a, b) => a.t - b.t);
  state.candlesAt = Date.now();
}

async function refreshMarkets() {
  const data = await getJSON(`kalshi/markets?series_ticker=${encodeURIComponent(settings.series)}&status=open&limit=50`);
  state.markets = (data.markets || []).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  state.marketsAt = Date.now();
}

async function refreshSpot() {
  const t = await getJSON('coinbase/products/BTC-USD/ticker');
  state.spot = Number(t.price);
}

// Kalshi lists the strike as floor_strike. If it's missing, use the BTC price at the window open.
function strikeFor(m) {
  if (m.floor_strike != null || m.cap_strike != null) return Number(m.floor_strike ?? m.cap_strike);
  if (state.strikes[m.ticker]) return state.strikes[m.ticker];
  const open = Date.parse(m.open_time);
  const c = state.candles.find((k) => k.t >= open - 30000);
  if (c && Date.now() > open) state.strikes[m.ticker] = c.o;
  return state.strikes[m.ticker] ?? null;
}

// ---------- history ----------
function recordCall(m, ev) {
  if (state.history.some((h) => h.ticker === m.ticker)) return false; // first call per market only
  state.history.unshift({
    ticker: m.ticker, title: m.title, side: ev.side, price: ev.price, contracts: ev.contracts,
    pModel: ev.side === 'YES' ? ev.pYes : 1 - ev.pYes, at: Date.now(), closeTime: m.close_time, result: null,
  });
  state.history = state.history.slice(0, 500);
  store.set('history', state.history);
  return true;
}

async function settleHistory() {
  const pending = state.history.filter((h) => !h.result && Date.parse(h.closeTime) < Date.now() - 60000).slice(0, 5);
  for (const h of pending) {
    try {
      const { market } = await getJSON(`kalshi/markets/${encodeURIComponent(h.ticker)}`);
      if (market && (market.result === 'yes' || market.result === 'no')) {
        Object.assign(h, { result: market.result }, settlePnl(h, market.result));
      }
    } catch { /* retry next cycle */ }
  }
  if (pending.length) store.set('history', state.history);
}

// ---------- alerts ----------
async function alertCall(m, ev) {
  navigator.vibrate?.([200, 100, 200]);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = `${ev.side} @ ${(ev.price * 100).toFixed(0)}¢ ×${ev.contracts}: ${ev.reason}`;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(`Shot: ${ev.side}`, { body, tag: m.ticker, icon: 'icon.svg' });
  else new Notification(`Shot: ${ev.side}`, { body, tag: m.ticker });
}

// ---------- render ----------
const usd = (v) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const cents = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}¢`;
const sign = (el, v) => { el.classList.toggle('pos', v > 0); el.classList.toggle('neg', v < 0); };
const mmss = (min) => { const s = Math.max(0, Math.round(min * 60)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function compute() {
  const closes = state.candles.map((c) => c.c);
  if (state.spot) closes.push(state.spot);
  const sigmaMin = realizedVol(closes.slice(-121));
  const driftMin = momentum(closes, 10);
  return { sigmaMin, rows: state.markets.map((m) => {
    const strike = strikeFor(m);
    return { m, strike, ev: evaluate({ market: m, strike, spot: state.spot, sigmaMin, driftMin, settings }) };
  }) };
}

function render() {
  const { sigmaMin, rows } = compute();
  const live = rows.find((r) => r.ev.minutesLeft > 0);
  const card = $('callCard'), call = $('call');
  card.className = 'card call-card';
  if (!live) {
    $('marketTitle').textContent = state.marketsAt ? `No open ${settings.series} markets` : 'Loading markets…';
    call.textContent = '—'; call.className = 'call pass';
    ['countdown', 'reason', 'order'].forEach((id) => { $(id).textContent = ''; });
  } else {
    const { m, ev, strike } = live;
    $('marketTitle').textContent = m.title || m.ticker;
    $('countdown').textContent = `closes in ${mmss(ev.minutesLeft)}`;
    call.textContent = ev.call;
    call.className = `call ${ev.call.toLowerCase()}`;
    if (ev.side) card.classList.add(ev.side.toLowerCase());
    $('reason').textContent = ev.reason;
    $('order').textContent = ev.side ? `Buy ${ev.contracts} ${ev.side} @ ${(ev.price * 100).toFixed(0)}¢` : '';
    $('strike').textContent = usd(strike);
    const d = state.spot && strike ? state.spot - strike : null;
    $('dist').textContent = d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)} (${((d / strike) * 100).toFixed(2)}%)`;
    sign($('dist'), d);
    $('pModel').textContent = pct(ev.pYes);
    const q = ev.quote;
    $('pMarket').textContent = q.yesBid != null && q.yesAsk != null ? `${(q.yesBid * 100).toFixed(0)}/${(q.yesAsk * 100).toFixed(0)}¢` : '—';
    $('evYes').textContent = cents(ev.evYes); sign($('evYes'), ev.evYes);
    $('evNo').textContent = cents(ev.evNo); sign($('evNo'), ev.evNo);

    const prev = state.lastCall[m.ticker];
    if (ev.side && prev !== ev.side && recordCall(m, ev)) alertCall(m, ev);
    state.lastCall[m.ticker] = ev.side;
    drawChart(strike, Date.parse(m.open_time));
  }
  $('spot').textContent = usd(state.spot);
  $('vol').textContent = sigmaMin ? `${(sigmaMin * 100).toFixed(3)}%` : '—';

  $('others').innerHTML = rows.filter((r) => r !== live && r.ev.minutesLeft > 0).slice(0, 6).map(({ m, ev }) =>
    `<div class="card mini"><span>${esc(m.yes_sub_title || m.ticker)}<br><small>${mmss(ev.minutesLeft)} · model ${pct(ev.pYes)}</small></span>` +
    `<span class="pill ${ev.call.toLowerCase()}">${ev.call}</span></div>`).join('');
  renderHistory();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function drawChart(strike, openTime) {
  const cv = $('chart'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 140;
  cv.width = w * dpr; cv.height = h * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pts = state.candles.filter((c) => c.t >= openTime - 30 * 60000).map((c) => [c.t, c.c]);
  if (state.spot) pts.push([Date.now(), state.spot]);
  if (pts.length < 2) return;
  const ys = pts.map((p) => p[1]).concat(strike ? [strike] : []);
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.1 || 1;
  const t0 = pts[0][0], t1 = Math.max(pts[pts.length - 1][0], openTime + 15 * 60000);
  const X = (t) => ((t - t0) / (t1 - t0)) * w, Y = (v) => h - ((v - lo + pad) / (hi - lo + 2 * pad)) * h;
  ctx.fillStyle = '#38bdf811'; ctx.fillRect(X(openTime), 0, w - X(openTime), h);
  if (strike) {
    ctx.strokeStyle = '#8b98a8'; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, Y(strike)); ctx.lineTo(w, Y(strike)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = state.spot >= strike ? '#22c55e' : '#ef4444'; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
  ctx.stroke();
}

function renderHistory() {
  const done = state.history.filter((h) => h.result);
  const wins = done.filter((h) => h.won).length;
  const pnl = done.reduce((a, h) => a + h.pnl, 0);
  $('hCount').textContent = state.history.length;
  $('hRate').textContent = done.length ? `${((wins / done.length) * 100).toFixed(0)}% (${wins}/${done.length})` : '—';
  $('hPnl').textContent = done.length ? `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : '—';
  sign($('hPnl'), pnl);
  $('hPending').textContent = state.history.length - done.length;
  $('historyList').innerHTML = state.history.slice(0, 100).map((h) => {
    const res = h.result ? `<b class="${h.won ? 'pos' : 'neg'}">${h.won ? 'WIN' : 'LOSS'} ${h.pnl >= 0 ? '+' : '-'}$${Math.abs(h.pnl).toFixed(2)}</b>` : '<b>pending</b>';
    return `<li><span><b>${h.side}</b> @ ${(h.price * 100).toFixed(0)}¢ ×${h.contracts}<small>${esc(h.ticker)} · ${new Date(h.at).toLocaleTimeString()} · model ${(h.pModel * 100).toFixed(0)}%</small></span>${res}</li>`;
  }).join('');
}

// ---------- settings ----------
function buildSettings() {
  $('settingsForm').innerHTML = SETTINGS_META.map(([k, label, hint, kind]) => {
    const v = kind === 'cents' ? Math.round(settings[k] * 1000) / 10 : settings[k];
    return `<label><span>${label}<small>${hint}</small></span><input name="${k}" ${kind === 'text' ? '' : 'inputmode="decimal"'} value="${esc(v)}"></label>`;
  }).join('');
  $('settingsForm').addEventListener('change', (e) => {
    const meta = SETTINGS_META.find((x) => x[0] === e.target.name);
    if (!meta) return;
    const [k, , , kind] = meta;
    if (kind === 'text') settings[k] = e.target.value.trim().toUpperCase();
    else {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) return;
      settings[k] = kind === 'cents' ? n / 100 : n;
    }
    store.set('settings', settings);
    if (k === 'series') { state.marketsAt = 0; state.markets = []; }
    if (k === 'refreshSec') schedule();
    render();
  });
}

// ---------- loop ----------
let timer;
async function tick() {
  try {
    const jobs = [refreshSpot()];
    if (Date.now() - state.candlesAt > 30000) jobs.push(refreshCandles());
    const closed = state.markets.length && Date.parse(state.markets[0].close_time) < Date.now();
    if (Date.now() - state.marketsAt > settings.refreshSec * 1000 || closed) jobs.push(refreshMarkets());
    await Promise.all(jobs);
    $('status').className = 'dot ok';
    settleHistory();
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
}));
$('enableAlerts').addEventListener('click', async () => {
  if (!('Notification' in window)) return alert('Notifications are not supported here. On iOS, add the app to your Home Screen first.');
  const p = await Notification.requestPermission();
  $('enableAlerts').textContent = p === 'granted' ? 'Alerts enabled ✓' : 'Alerts blocked';
});
$('clearHistory').addEventListener('click', () => {
  if (confirm('Clear all call history?')) { state.history = []; store.set('history', []); render(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(render, 1000); // keep the countdown ticking between polls

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
buildSettings();
tick();
schedule();
