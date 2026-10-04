import { DEFAULTS, EXIT_DEFAULTS, dipLimit, evaluate, exitSignal, kalshiFee, momentum, quote, realizedVol, settlePnl } from './model.js';
import { entrySignal, flipSigns, patterns, withLiveBar } from './candles.js';

const API = './api';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SETTINGS_META = [
  ['series', 'Kalshi series', 'Series ticker for 15-min BTC markets', 'text'],
  ['minEdge', 'Min gap (pts)', 'How far Kalshi\'s price must be below the bot\'s odds, after fees, to call BUY THE LOW', 'cents'],
  ['waitForDip', 'Also wait for candle dip', 'Only alert when the candles also show a dip', 'bool'],
  ['maxSpread', 'Max spread (pts)', 'Skip markets where buy and sell % are further apart', 'cents'],
  ['minMinutesLeft', 'Min minutes left', 'Stop calling this close to settlement', 'num'],
  ['maxMinutesLeft', 'Max minutes left', 'Don\'t call this early in the window', 'num'],
  ['volMultiplier', 'Vol multiplier', 'Above 1 means more conservative', 'num'],
  ['momentumWeight', 'Momentum weight', 'How much of the 10-min drift to carry forward (0 to 1)', 'num'],
  ['minProfit', 'Min profit to lock (pts)', 'How far up (after fees) before flip signs trigger a sell', 'cents'],
  ['trail', 'Trailing drop (pts)', 'Sell if the sell % falls this far from its peak while in profit', 'cents'],
  ['oddsDrop', 'Odds drop (pts)', 'Sell if the bot\'s odds fall this far from their peak while in profit', 'cents'],
  ['bankroll', 'Bankroll ($)', 'Used for position sizing', 'num'],
  ['kellyFraction', 'Kelly fraction', '0.25 means quarter Kelly', 'num'],
  ['maxStake', 'Max stake ($)', 'Cap per call', 'num'],
  ['refreshSec', 'Refresh (sec)', 'How often to poll', 'num'],
];
const settings = { series: 'KXBTC15M', refreshSec: 5, waitForDip: false, ...DEFAULTS, ...EXIT_DEFAULTS, ...store.get('settings', {}) };
// v1.2: "buy the low" means Kalshi below the bot's odds, so candle-dip gating is off unless re-enabled.
if (store.get('settingsVersion', 1) < 2) { settings.waitForDip = false; store.set('settings', settings); store.set('settingsVersion', 2); }

const state = { markets: [], spot: null, candles: [], candlesAt: 0, marketsAt: 0, strikes: {}, alerted: {}, history: store.get('history', []),
  positions: store.get('positions', []), trades: store.get('trades', []) };

async function getJSON(path) {
  const r = await fetch(`${API}/${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------- data ----------
async function refreshCandles() {
  // Coinbase rows: [time, low, high, open, close, volume], newest first
  const rows = await getJSON('coinbase/products/BTC-USD/candles?granularity=60');
  state.candles = rows.map((r) => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4] })).sort((a, b) => a.t - b.t);
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
function recordCall(m, ev, entry) {
  if (state.history.some((h) => h.ticker === m.ticker)) return false; // first call per market only
  state.history.unshift({
    ticker: m.ticker, title: m.title, side: ev.side, price: ev.price, contracts: ev.contracts, entry,
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

  // Positions still open when their market settled
  for (const pos of state.positions.filter((p) => Date.parse(p.closeTime) < Date.now() - 60000).slice(0, 3)) {
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
const entryCost = (pos) => pos.price + kalshiFee(pos.price);
function savePositions() { store.set('positions', state.positions); }

function openPosition(m, side, price, contracts) {
  state.positions.push({ id: String(Date.now()), ticker: m.ticker, title: m.title, closeTime: m.close_time, side, price, contracts, at: Date.now(), peakBid: null, peakP: null });
  savePositions();
}

// exit = sale price in dollars, or 1/0 when it settled
function closePosition(pos, exit, how) {
  const proceeds = how === 'settled' ? exit : exit - kalshiFee(exit);
  state.trades.unshift({ ...pos, exit, how, closedAt: Date.now(), pnl: (proceeds - entryCost(pos)) * pos.contracts });
  state.trades = state.trades.slice(0, 500);
  state.positions = state.positions.filter((p) => p.id !== pos.id);
  store.set('trades', state.trades);
  savePositions();
}

function renderPositions(rows, bars, now) {
  const html = state.positions.map((pos) => {
    const row = rows.find((r) => r.m.ticker === pos.ticker);
    const minutesLeft = (Date.parse(pos.closeTime) - now) / 60000;
    const pYes = row?.ev.pYes ?? null;
    const pSide = pYes == null ? null : pos.side === 'YES' ? pYes : 1 - pYes;
    const bid = row ? (pos.side === 'YES' ? row.ev.quote.yesBid : row.ev.quote.noBid) : null;
    const flips = flipSigns(bars, pos.side, now);
    const ex = exitSignal({ pos, bid, pSide, flips, minutesLeft, settings });

    // Peaks update after the check, so a drop is measured from earlier highs
    let changed = false;
    if (bid != null && (pos.peakBid == null || bid > pos.peakBid)) { pos.peakBid = bid; changed = true; }
    if (pSide != null && (pos.peakP == null || pSide > pos.peakP)) { pos.peakP = pSide; changed = true; }
    if (changed) savePositions();

    if (ex.action === 'SELL') {
      const key = `${pos.id}:${ex.kind}`;
      if (!state.alerted[key]) {
        state.alerted[key] = true;
        alert(`sell-${pos.id}`, `SELL NOW: ${sideName(pos.side)} at ${pc(bid)} (${money(ex.pnl)})`, ex.why);
      }
    }

    const head = ex.action === 'SELL' ? `SELL NOW at ${pc(bid)}` : ex.action === 'WAIT' ? 'SETTLING' : 'HOLD';
    const worth = ex.net != null ? ex.net * pos.contracts : null;
    const where = row?.strike ? ` ${pos.side === 'YES' ? 'above' : 'below'} ${usd(row.strike, 0)}` : '';
    const signs = ex.signs?.length ? ex.signs.map((x) => `<li>${esc(x)}</li>`).join('') : '<li class="calm">No flip signs</li>';
    return `<div class="card pos-card ${ex.action.toLowerCase()} ${ex.kind}">
      <div class="pos-top"><span><b>${dollars(pos.contracts * pos.price)}</b> at <b>${pc(pos.price)}</b> <b class="side-tag ${pos.side.toLowerCase()}">${sideName(pos.side)}</b></span><span>${minutesLeft > 0 ? mmss(minutesLeft) : 'closed'}</span></div>
      <div class="pos-action">${head}</div>
      <div class="pos-why">${esc(ex.why)}</div>
      <div class="pos-grid">
        <div><label>Sell at</label><b>${pc(bid)}</b></div>
        <div><label>Worth now</label><b>${worth == null ? '—' : dollars(worth)}</b></div>
        <div><label>P&amp;L</label><b class="${ex.pnl > 0 ? 'pos' : ex.pnl < 0 ? 'neg' : ''}">${ex.pnl == null ? '—' : money(ex.pnl)}</b></div>
        <div><label>Bot odds</label><b>${pc(pSide)}</b></div>
        <div><label>Target sell</label><b>${ex.action === 'SELL' ? 'now' : pc(ex.target)}</b></div>
        <div><label>Pays if right</label><b>${dollars(pos.contracts)}</b></div>
      </div>
      <div class="pos-where">Wins if BTC is${where || (pos.side === 'YES' ? ' above the target' : ' below the target')} at close</div>
      <ul class="flips"><span>Flip watch</span>${signs}</ul>
      <div class="pos-btns"><button data-act="sell" data-id="${pos.id}">I sold</button><button data-act="remove" data-id="${pos.id}" class="ghost">Remove</button></div>
    </div>`;
  }).join('');
  $('positions').innerHTML = html;
}

// ---------- bottom sheet for entering fills ----------
// Trades are entered the way Kalshi shows them: "$20 at 40% YES".
let sheet = null;
function openSheet({ title, side, sideLocked, amount, pct, amtLabel = 'Amount ($)', hint, onOk }) {
  sheet = { side, hint, onOk };
  $('sheetTitle').textContent = title;
  $('amtLabel').textContent = amtLabel;
  $('sheetAmt').value = amount.toFixed(2);
  $('sheetPct').value = Math.round(pct);
  $('sheetSide').classList.toggle('locked', !!sideLocked);
  sheetSync();
  $('sheet').hidden = false;
}
function sheetRead() {
  return { side: sheet.side, amount: Number($('sheetAmt').value), price: Number($('sheetPct').value) / 100 };
}
function sheetSync() {
  $('sheetSide').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.side === sheet.side));
  const v = sheetRead();
  $('sheetHint').textContent = v.amount > 0 && v.price > 0 && v.price < 1 ? sheet.hint(v) : 'Enter an amount and a % between 1 and 99';
}
$('sheetSide').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-side]');
  if (b && !$('sheetSide').classList.contains('locked')) { sheet.side = b.dataset.side; sheetSync(); }
});
$('sheetAmt').addEventListener('input', sheetSync);
$('sheetPct').addEventListener('input', sheetSync);
$('sheetCancel').addEventListener('click', () => { $('sheet').hidden = true; });
$('sheetOk').addEventListener('click', () => {
  const v = sheetRead();
  if (!(v.amount > 0) || !(v.price > 0 && v.price < 1)) return window.alert('Enter a dollar amount and a % between 1 and 99.');
  $('sheet').hidden = true;
  sheet.onOk(v);
  render();
});

// ---------- alerts ----------
async function alert(tag, title, body) {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* needs a tap first */ }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(title, { body, tag, icon: 'icon.svg' });
  else new Notification(title, { body, tag });
}

// ---------- render helpers ----------
const usd = (v, d = 2) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })}`;
const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const pc = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const dollars = (v) => `$${v.toFixed(2)}`;
const sideName = (side) => (side === 'YES' ? 'YES · Above' : 'NO · Below');
const money = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const sign = (el, v) => { el.classList.toggle('pos', v > 0); el.classList.toggle('neg', v < 0); };
const mmss = (min) => { const s = Math.max(0, Math.round(min * 60)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function compute() {
  const now = Date.now();
  const bars = withLiveBar(state.candles, state.spot, now);
  const closes = bars.map((c) => c.c);
  const sigmaMin = realizedVol(closes.slice(-121));
  const driftMin = momentum(closes, 10);
  const rows = state.markets.map((m) => {
    const strike = strikeFor(m);
    return { m, strike, ev: evaluate({ market: m, strike, spot: state.spot, sigmaMin, driftMin, now, settings }) };
  });
  return { now, bars, sigmaMin, driftMin, rows };
}

// Kalshi % vs bot % for each side. "Low" = Kalshi's price is below the bot's odds by the min gap after fees.
function oddsRows(ev, minEdge) {
  if (ev.pYes == null) return '';
  const row = (side, kalshi, bot, edge) => {
    if (kalshi == null) return `<div class="odds-row"><span class="side">${side}</span><span class="muted">no offers</span></div>`;
    const gap = (bot - kalshi) * 100;
    const status = edge != null && edge >= minEdge ? ['low', `LOW by ${gap.toFixed(0)} pts`] : gap > 0 ? ['near', `${gap.toFixed(0)} pts low, not enough after fees`] : ['high', `${Math.abs(gap).toFixed(0)} pts high`];
    const a = Math.min(kalshi, bot) * 100, b = Math.max(kalshi, bot) * 100;
    return `<div class="odds-row ${status[0]}"><span class="side">${side}</span>` +
      `<span class="nums">Kalshi <b>${(kalshi * 100).toFixed(0)}%</b> · Bot <b>${(bot * 100).toFixed(0)}%</b></span>` +
      `<span class="track"><i class="fill" style="left:${a}%;width:${b - a}%"></i><i class="mk kalshi" style="left:${kalshi * 100}%"></i><i class="mk bot" style="left:${bot * 100}%"></i></span>` +
      `<span class="status">${status[1]}</span></div>`;
  };
  return row('YES<small>Above</small>', ev.quote.yesAsk, ev.pYes, ev.evYes) + row('NO<small>Below</small>', ev.quote.noAsk, 1 - ev.pYes, ev.evNo) +
    '<div class="odds-legend"><i class="mk kalshi"></i> Kalshi price <i class="mk bot"></i> Bot odds</div>';
}

// The side the model leans to, even below the edge threshold, so timing has something to read.
const leanSide = (ev) => ev.side ?? (ev.evYes == null && ev.evNo == null ? null : (ev.evYes ?? -1) >= (ev.evNo ?? -1) ? 'YES' : 'NO');

function render() {
  const { now, bars, sigmaMin, driftMin, rows } = compute();
  const live = rows.find((r) => r.ev.minutesLeft > 0);
  renderPositions(rows, bars, now);
  state.liveCall = live?.ev.side ? live : null;
  $('boughtBtn').hidden = !state.liveCall || state.positions.some((p) => p.ticker === live.m.ticker);
  const card = $('callCard'), call = $('call'), entry = $('entry');
  card.className = 'card call-card';
  entry.className = 'entry';
  let timing = null;

  if (!live) {
    $('marketTitle').textContent = state.marketsAt ? `No open ${settings.series} markets` : 'Loading markets…';
    call.textContent = '—'; call.className = 'call pass';
    ['countdown', 'reason', 'order', 'entry', 'callLabel', 'odds'].forEach((id) => { $(id).textContent = ''; });
    entry.hidden = true;
  } else {
    const { m, ev, strike } = live;
    const side = leanSide(ev);
    timing = entrySignal(bars, side, now);
    const limit = side && timing.dipLevel ? dipLimit({ market: m, strike, spot: state.spot, dipLevel: timing.dipLevel, sigmaMin, driftMin, side, now, settings }) : null;

    $('marketTitle').textContent = m.title || m.ticker;
    $('countdown').textContent = `closes in ${mmss(ev.minutesLeft)}`;
    $('reason').textContent = ev.side ? '' : ev.reason;
    $('odds').innerHTML = oddsRows(ev, settings.minEdge);

    // Call + entry timing
    const buyNow = ev.side && timing.state === 'NOW';
    const waiting = ev.side && !buyNow && settings.waitForDip;
    $('callLabel').textContent = ev.side ? (waiting ? 'Low price, waiting for candle dip' : 'BUY THE LOW') : 'No low price';
    call.textContent = ev.call;
    call.className = `call ${ev.call.toLowerCase()}`;
    $('callSub').textContent = ev.side && strike ? `BTC ${ev.side === 'YES' ? 'above' : 'below'} ${usd(strike, 0)} at close` : '';
    if (ev.side) card.classList.add(ev.side.toLowerCase());
    if (waiting) card.classList.add('waiting');

    entry.hidden = !side;
    if (side) {
      const label = timing.state === 'NOW' ? `Candles: dip now, good timing for ${side}` : timing.state === 'CHASE' ? 'Candles: chasing, price just ran' : `Candles: no dip yet for ${side}`;
      entry.classList.add(timing.state.toLowerCase());
      entry.innerHTML = `<b>${label}</b><span>${esc(timing.reasons.slice(0, 4).join(' · '))}</span>` +
        (limit && timing.state !== 'NOW' ? `<span>Even lower: limit ${sideName(side)} at <b>${pc(limit.price)}</b> if BTC hits ${usd(limit.dipLevel, 0)}</span>` : '');
    }

    if (!ev.side) $('order').textContent = '';
    else if (buyNow || !settings.waitForDip) $('order').textContent = `Buy ${dollars(ev.contracts * ev.price)} at ${pc(ev.price)} ${sideName(ev.side)} · +${(ev.edge * 100).toFixed(0)} pts edge`;
    else $('order').textContent = limit ? `Limit ${dollars(ev.contracts * limit.price)} at ${pc(limit.price)} ${sideName(ev.side)} (now ${pc(ev.price)})` : 'Hold off: no dip yet';

    // Record + alert: right away, or only on a confirmed low when waiting for the dip
    if (ev.side && (buyNow || !settings.waitForDip)) {
      const key = `${m.ticker}:${ev.side}:${buyNow ? 'low' : 'call'}`;
      if (!state.alerted[key]) {
        state.alerted[key] = true;
        recordCall(m, ev, buyNow ? 'low' : 'ask');
        const bot = ev.side === 'YES' ? ev.pYes : 1 - ev.pYes;
        alert(m.ticker, `Buy the low: ${sideName(ev.side)} at ${pc(ev.price)}`,
          `Kalshi ${pc(ev.price)} vs bot ${pc(bot)} · buy ${dollars(ev.contracts * ev.price)}${buyNow ? ' · candle dip too' : ''}`);
      }
    }

    $('strike').textContent = usd(strike);
    const d = state.spot && strike ? state.spot - strike : null;
    $('dist').textContent = d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)} (${((d / strike) * 100).toFixed(2)}%)`;
    sign($('dist'), d);
    drawChart(bars, strike, Date.parse(m.open_time), timing, limit);
  }

  $('spot').textContent = usd(state.spot);
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
function drawChart(allBars, strike, openTime, timing, limit) {
  const cv = $('chart'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 220, axis = 52;
  cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  ctx.textAlign = 'start';

  // Last price tag
  const last = bars[bars.length - 1].c;
  ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 10px system-ui';
  ctx.fillText(Math.round(last).toLocaleString(), w - axis + 4, Math.min(h - 4, Math.max(10, Y(last) + 3)));
}

function renderHistory() {
  const done = state.history.filter((h) => h.result);
  const wins = done.filter((h) => h.won).length;
  const pnl = done.reduce((a, h) => a + h.pnl, 0);
  const lows = done.filter((h) => h.entry === 'low');
  const lowWins = lows.filter((h) => h.won).length;
  $('hCount').textContent = state.history.length;
  $('hRate').textContent = done.length ? `${((wins / done.length) * 100).toFixed(0)}% (${wins}/${done.length})` : '—';
  $('hPnl').textContent = done.length ? `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : '—';
  sign($('hPnl'), pnl);
  $('hLow').textContent = lows.length ? `${((lowWins / lows.length) * 100).toFixed(0)}% (${lowWins}/${lows.length})` : '—';
  $('hPending').textContent = state.history.length - done.length;
  const tp = state.trades.reduce((a, t) => a + t.pnl, 0), tw = state.trades.filter((t) => t.pnl > 0).length;
  $('tPnl').textContent = state.trades.length ? money(tp) : '—';
  sign($('tPnl'), tp);
  $('tWins').textContent = state.trades.length ? `${tw}/${state.trades.length}` : '—';
  $('tradeList').innerHTML = state.trades.slice(0, 50).map((t) =>
    `<li><span><b>${dollars(t.contracts * t.price)}</b> at ${pc(t.price)} ${sideName(t.side)} → ${t.how === 'settled' ? (t.exit ? 'won at close' : 'lost at close') : `sold at ${pc(t.exit)}`}` +
    `<small>${esc(t.ticker)} · ${new Date(t.closedAt).toLocaleTimeString()}</small></span><b class="${t.pnl >= 0 ? 'pos' : 'neg'}">${money(t.pnl)}</b></li>`).join('') ||
    '<li><span class="muted">Tap "I bought it" on a call to track a trade and get sell signals.</span></li>';
  $('historyList').innerHTML = state.history.slice(0, 100).map((h) => {
    const res = h.result ? `<b class="${h.won ? 'pos' : 'neg'}">${h.won ? 'WIN' : 'LOSS'} ${h.pnl >= 0 ? '+' : '-'}$${Math.abs(h.pnl).toFixed(2)}</b>` : '<b>pending</b>';
    const tag = h.entry === 'low' ? ' · candle dip' : '';
    return `<li><span><b>${dollars(h.contracts * h.price)}</b> at ${pc(h.price)} ${sideName(h.side)}<small>${esc(h.ticker)} · ${new Date(h.at).toLocaleTimeString()} · Kalshi ${(h.price * 100).toFixed(0)}% vs bot ${(h.pModel * 100).toFixed(0)}%${tag}</small></span>${res}</li>`;
  }).join('');
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
    if (Date.now() - state.candlesAt > 20000) jobs.push(refreshCandles());
    const closed = state.markets.length && Date.parse(state.markets[0].close_time) < Date.now();
    if (Date.now() - state.marketsAt > settings.refreshSec * 1000 || closed) jobs.push(refreshMarkets());
    await Promise.all(jobs);
    $('status').className = 'dot ok';
    $('status').title = 'connected';
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
$('status').addEventListener('click', () => window.alert($('status').title || 'connecting…'));
$('enableAlerts').addEventListener('click', async () => {
  if (!('Notification' in window)) return window.alert('Notifications are not supported here. On iOS, add the app to your Home Screen first.');
  const p = await Notification.requestPermission();
  $('enableAlerts').textContent = p === 'granted' ? 'Alerts enabled ✓' : 'Alerts blocked';
});
$('boughtBtn').addEventListener('click', () => {
  const live = state.liveCall;
  if (!live) return;
  const { m, ev } = live;
  const strike = live.strike;
  openSheet({
    title: 'What did you buy?', side: ev.side, amount: ev.contracts * ev.price, pct: ev.price * 100,
    hint: ({ side, amount, price }) => `${(amount / price).toFixed(1)} contracts · pays ${dollars(amount / price)} if BTC is ${side === 'YES' ? 'above' : 'below'} ${strike ? usd(strike, 0) : 'the target'} at close`,
    onOk: ({ side, amount, price }) => openPosition(m, side, price, amount / price),
  });
});
$('positions').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const pos = state.positions.find((p) => p.id === btn.dataset.id);
  if (!pos) return;
  if (btn.dataset.act === 'remove') {
    if (confirm('Stop tracking this position? It won\'t be added to your trades.')) { state.positions = state.positions.filter((p) => p !== pos); savePositions(); render(); }
    return;
  }
  const m = state.markets.find((x) => x.ticker === pos.ticker);
  const q = m ? quote(m) : {};
  const bid = (pos.side === 'YES' ? q.yesBid : q.noBid) ?? pos.price;
  const stake = pos.contracts * pos.price;
  openSheet({
    title: `Sold ${sideName(pos.side)}`, side: pos.side, sideLocked: true, amount: stake, pct: bid * 100,
    amtLabel: `How much of your ${dollars(stake)}`,
    hint: ({ amount, price }) => {
      const qty = Math.min(amount, stake) / pos.price;
      return `Cashes out ≈ ${dollars(qty * (price - kalshiFee(price)))} · ${money((price - kalshiFee(price) - entryCost(pos)) * qty)}`;
    },
    onOk: ({ amount, price }) => sellPosition(pos, Math.min(amount, stake) / pos.price, price),
  });
});
function sellPosition(pos, qty, price) {
  if (qty < pos.contracts - 1e-9) {
    // Partial sale: book the sold part, keep the rest open
    const sold = { ...pos, id: `${pos.id}-p${Date.now()}`, contracts: qty };
    state.positions.push(sold);
    pos.contracts -= qty;
    closePosition(sold, price, 'sold');
  } else closePosition(pos, price, 'sold');
}
$('clearHistory').addEventListener('click', () => {
  if (confirm('Clear all call history?')) { state.history = []; store.set('history', []); render(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(render, 1000); // keep the countdown ticking between polls

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
buildSettings();
tick();
schedule();
