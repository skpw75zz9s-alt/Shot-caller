import { DEFAULTS, EXIT_DEFAULTS, dipLimit, kalshiFee, quote } from './model.js';
import { patterns } from './candles.js';
import { buyMessage, buySignal, parseCandles, positionCheck, sellMessage, sideName, snapshot } from './engine.js';
import { confTier } from './analysis.js';
import { balanceDollars, foldFills, importKey, parseFill, signHeaders } from './kalshi.js';

const API = './api';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SETTINGS_META = [
  ['series', 'Kalshi series', 'Series ticker for 15-min BTC markets', 'text'],
  ['minEdge', 'Min gap (pts)', 'How far Kalshi\'s price must be below the bot\'s odds, after fees, even if volatility is 20% off either way, to call BUY THE LOW', 'cents'],
  ['minConfidence', 'Min confidence (0-100)', 'Deep-dive score a call needs before BUY THE LOW fires', 'num'],
  ['rejectionWeight', 'Rejection weight', 'How much rejection trends move the bot\'s odds (0 = off, 1 = up to ±5 pts)', 'num'],
  ['waitForDip', 'Also wait for candle dip', 'Only alert when the candles also show a dip', 'bool'],
  ['notifyBuy', 'Notify: buy the low', 'Alert when Kalshi is below the bot\'s odds', 'bool'],
  ['notifySell', 'Notify: sell now', 'Alert when a tracked position should be sold', 'bool'],
  ['notifyUpdates', 'Notify: 15-minute updates', 'Each new window: last window\'s result and the bot\'s read on the new one', 'bool'],
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
const settings = { series: 'KXBTC15M', refreshSec: 3, waitForDip: false, notifyBuy: true, notifySell: true, notifyUpdates: true, tradeAmount: 0, ...DEFAULTS, ...EXIT_DEFAULTS, ...store.get('settings', {}) };
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

const state = { markets: [], spot: null, candles: [], candlesAt: 0, marketsAt: 0, strikes: {}, quoteLog: {}, alerted: {},
  positions: store.get('positions', []), trades: store.get('trades', []), kalshi: { key: null, keyId: null },
  calls: store.get('calls', {}) }; // what the bot has called per window, so it sticks with its calls
for (const [k, c] of Object.entries(state.calls)) if (!(c.at > Date.now() - 2 * 3600000)) delete state.calls[k];
try { localStorage.removeItem('tracker'); } catch { /* report cards were removed in v2.9 */ }

// Access lapsed (paywall): reload so the server shows the paywall page.
function paywalled(r) {
  if (r.status === 401) { location.reload(); throw new Error('payment required'); }
}

async function getJSON(path) {
  const r = await fetch(`${API}/${path}`);
  paywalled(r);
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

async function refreshSpot() {
  const t = await getJSON('coinbase/products/BTC-USD/ticker');
  state.spot = Number(t.price);
}

// ---------- settlement ----------
async function settlePositions() {
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

function openPosition(m, side, price, contracts, at = Date.now()) {
  const pos = { id: String(at), ticker: m.ticker, title: m.title, closeTime: m.close_time, side, price, contracts, at, peakBid: null, peakP: null };
  state.positions.push(pos);
  savePositions();
  pushSyncSoon();
  return pos;
}

// exit = sale price in dollars, or 1/0 when it settled. `contracts` < pos.contracts closes part of it.
function closePosition(pos, exit, how, at = Date.now(), contracts = pos.contracts) {
  const proceeds = how === 'settled' ? exit : exit - kalshiFee(exit);
  const trade = { ...pos, contracts, exit, how, closedAt: at, pnl: (proceeds - entryCost(pos)) * contracts };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 500);
  if (contracts < pos.contracts - 1e-9) pos.contracts -= contracts;
  else state.positions = state.positions.filter((p) => p.id !== pos.id);
  store.set('trades', state.trades);
  savePositions();
  pushSyncSoon();
  return trade;
}

function renderPositions(snap) {
  const html = state.positions.map((pos) => {
    const check = positionCheck(pos, snap, settings);
    const { row, minutesLeft, pSide, bid, ex } = check;
    if (check.changed) savePositions();

    if (ex.action === 'SELL') {
      const key = `${pos.id}:${ex.kind}`;
      if (!state.alerted[key]) {
        state.alerted[key] = true;
        if (settings.notifySell) alert(sellMessage(pos, check, state.spot));
      }
    }

    const head = ex.action === 'SELL' ? `SELL NOW at ${pc(bid)}` : ex.action === 'WAIT' ? 'SETTLING' : 'HOLD';
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
async function alert({ tag, title, body }) {
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

const compute = () => snapshot({ markets: state.markets, candles: state.candles, spot: state.spot, settings, strikes: state.strikes, quoteLog: state.quoteLog });

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
      `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'meh'}"><i>${c.ok === true ? '✓' : c.ok === false ? '✕' : '•'}</i><span>${esc(c.label)}</span><b>${c.pts > 0 ? '+' : ''}${c.pts || ''}</b></li>`).join('');
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

function render() {
  state.renderedAt = Date.now();
  state.clock = null;
  const snap = compute();
  const { now, bars, sigmaMin, driftMin, rows, live } = snap;
  renderPositions(snap);
  const sig = live ? buySignal(live, snap, settings, now, state.calls) : null;
  if (sig?.fire) store.set('calls', state.calls);
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
    $('reason').textContent = call && sig.sticking ? `${sideName(otherSide)} looks a little better this tick, but not by enough to drop the call. Sticking with it.`
      : call && sticking ? 'Called earlier and still a buy: one tick of movement isn\'t a reason to change.'
      : call ? '' : waitingToCall ? `Calls start in ${mmss((ev.callsAt - now) / 60000)} (bot watches the first ${settings.waitMinutes} min)`
      : sig.called && sig.stance === 'holding' ? `Called ${sideName(sig.called)} earlier. That edge has faded, so no new buy; if you're in, the position card says when to sell.`
      : sig.called && sig.stance === 'switching' && ev.side ? `Called ${sideName(sig.called)} earlier. ${sideName(ev.side)} looks cheap now, but switching needs a ${(sig.edgeNeed * 100).toFixed(0)}-pt gap and confidence ${sig.confNeed}.`
      : ev.side && !sig.robust ? `Low price, but the gap drops to ${sig.robustEdge == null ? '—' : (sig.robustEdge * 100).toFixed(1)} pts if volatility is a bit off (need ${(sig.edgeNeed * 100).toFixed(0)})`
      : ev.side ? `Low price, but confidence ${sig.deep?.score ?? '—'} is below ${sig.confNeed}` : ev.reason;
    $('odds').innerHTML = oddsRows(ev, settings.minEdge);

    // Call + entry timing
    const waiting = call && !buyNow && settings.waitForDip;
    $('callLabel').textContent = call ? (waiting ? 'Low price, waiting for candle dip' : sig.stance === 'switching' ? 'SWITCH · BUY THE LOW' : sticking ? 'BUY THE LOW · sticking with it' : 'BUY THE LOW')
      : sig.called ? `Called ${sig.called} earlier · no new buy`
      : waitingToCall ? `Watching the first ${settings.waitMinutes} minutes` : ev.side && !sig.robust ? 'Low price, edge too thin' : ev.side ? 'Low price, not confident' : 'No low price';
    callEl.textContent = call ?? 'PASS';
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
    else if (buyNow || !settings.waitForDip) $('order').textContent = `Buy ${dollars(sig.contracts * sig.price)} at ${pc(sig.price)} ${sideName(call)} · +${(sig.edge * 100).toFixed(0)} pts edge`;
    else $('order').textContent = limit ? `Limit ${dollars(sig.contracts * limit.price)} at ${pc(limit.price)} ${sideName(call)} (now ${pc(sig.price)})` : 'Hold off: no dip yet';

    // Record + alert: right away, or only on a confirmed low when waiting for the dip
    if (sig.fire) {
      const key = `${m.ticker}:${call}:${buyNow ? 'low' : 'call'}`;
      if (!state.alerted[key]) {
        state.alerted[key] = true;
        if (settings.notifyBuy) alert(buyMessage(live, sig, state.spot));
      }
    }

    $('strike').textContent = usd(strike);
    const d = state.spot && strike ? state.spot - strike : null;
    $('dist').textContent = d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)} (${((d / strike) * 100).toFixed(2)}%)`;
    sign($('dist'), d);
    drawChart(bars, strike, Date.parse(m.open_time), timing, limit, live.rej);
  }

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
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'heartbeat') { state.liveAt = Date.now(); return; }
    if (m.type !== 'ticker' || !m.price) return;
    state.spot = Number(m.price);
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
  const d = spot && strike ? spot - strike : null;
  $('liveTarget').textContent = d == null ? '' : `${d >= 0 ? '▲' : '▼'} ${usd(Math.abs(d), 0)} ${d >= 0 ? 'above' : 'below'} target`;
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
    render();
  });
}

// ---------- loop ----------
let timer;
async function tick() {
  try {
    const jobs = isLive() ? [] : [refreshSpot()];
    if (Date.now() - state.candlesAt > 20000) jobs.push(refreshCandles());
    const closed = state.markets.length && Date.parse(state.markets[0].close_time) < Date.now();
    if (Date.now() - state.marketsAt > settings.refreshSec * 1000 || closed) jobs.push(refreshMarkets());
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
});
// Between polls only the clocks move, so update just those each second (a full redraw every second
// cost the most phone battery). Full redraw if no poll or price tick has rendered for ~3 seconds,
// and when the opening wait ends so the call appears right on time.
function tickClocks() {
  const now = Date.now(), c = state.clock;
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
    do {
      const page = await kalshiGet('fills', { min_ts: since, limit: 200, cursor });
      fills.push(...(page.fills || []).map(parseFill));
      cursor = page.cursor || null;
    } while (cursor && ++pages < 5);
    const mine = fills.filter((f) => f.ticker.startsWith(`${settings.series}-`) && !seen.has(f.id) && f.at);
    if (mine.length) {
      const linked = state.positions.filter((p) => p.source === 'kalshi');
      const holdings = Object.fromEntries(linked.map((p) => [p.ticker, { side: p.side, contracts: p.contracts, price: p.price, at: p.at }]));
      const { holdings: next, closes } = foldFills(holdings, mine);
      for (const c of closes) {
        const pos = state.positions.find((p) => p.source === 'kalshi' && p.ticker === c.ticker);
        if (pos) closePosition({ ...pos, price: c.entry }, c.exit, 'sold', c.at, Math.min(c.contracts, pos.contracts)); // contracts left are set from `next` below
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
        Object.assign(pos, { side: h.side, contracts: h.contracts, price: h.price, at: h.at });
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
    if (newest) store.set('kalshiSince', Math.max(since, Math.floor(newest / 1000) - 5));
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

function renderKalshi() {
  const k = state.kalshi, linked = !!k.key;
  $('kForm').hidden = linked;
  $('kLinked').hidden = !linked;
  $('kErr').textContent = k.error || '';
  if (!linked) return;
  const bal = k.balance != null ? ` · balance ${dollars(k.balance)}` : '';
  const last = k.lastSync ? ` · synced ${clock(k.lastSync)}` : ' · syncing…';
  $('kStatus').textContent = `Linked (key ${k.keyId.slice(0, 8)}…)${bal}${last}. Your ${settings.series} buys and sells show up on their own.`;
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

buildSettings();
loadKalshi();
try { sessionStorage.removeItem('sc_restore'); } catch { /* the app loaded, so any restore worked: re-arm the paywall's auto sign-in */ }
loadAccess();
liveConnect();
pushInit();
tick();
schedule();
