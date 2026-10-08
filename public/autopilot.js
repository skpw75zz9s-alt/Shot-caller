// The Auto-trader card: picks the exchange for the mode (Test / Demo / Live), feeds trader.js the bot's Steady calls
// and sell signals, settles from Kalshi's results, and shows what it's doing.
//   Test  simulator on Kalshi's live order book: nothing is sent (each mode keeps its own history)
//   Demo  real orders on Kalshi's demo exchange with a demo key (fake money)
//   Live  real orders with the linked Kalshi key. Locked until Test has run clean (10+ settled trades, no errors)
import { TRADER_DEFAULTS, createTestExchange, createTrader, parseBook } from './trader.js';
import { buySignal, positionCheck } from './engine.js';
import { riskLevelOf, riskSettings } from './model.js';
import { balanceDollars, importKey, parsePosition, signHeaders } from './kalshi.js';

export const MODES = { off: 'Off', test: 'Test', demo: 'Demo', live: 'Live' };
export const LIVE_UNLOCK = 10; // settled Test trades with no errors before Live can be turned on
const LIMITS = [
  ['perTrade', 'Max per trade ($)', 1, 100],
  ['dailyLoss', 'Daily loss stop ($)', 1, 1000],
  ['maxTrades', 'Max buys a day', 1, 200],
  ['maxOpen', 'Max open at once ($)', 1, 1000],
  ['testCash', 'Test balance ($)', 5, 100000],
];
// Errors that mean something is wrong with the trader itself (not Kalshi having a hiccup)
const SERIOUS = new Set(['cash', 'bad', 'key']);

// Live is unlocked once Test has settled enough trades without one serious error
export function liveUnlocked(testState) {
  const settled = (testState?.ledger || []).filter((e) => e.closed).length;
  const serious = (testState?.log || []).some((x) => x.kind === 'error' && SERIOUS.has(x.err));
  return { ok: settled >= LIVE_UNLOCK && !serious, settled, serious };
}

export function createAutopilot({ $, esc, store, API, idb, toast, getJSON, paywalled, liveCred, render }) {
  const cfg = { ...TRADER_DEFAULTS, ...store.get('traderCfg', {}) };
  if (cfg.mode === 'live' || cfg.mode === 'demo') cfg.mode = 'off'; // real orders never restart on their own after a reload
  const saveCfg = () => store.set('traderCfg', cfg);
  let demoCred = null, info = null, lastStep = 0, lastWhy = '', steadyCalls = {};
  const results = {}, asked = {}, pseudo = {};

  // ---------- signed Kalshi requests (the key never leaves the phone; the server forwards the signature) ----------
  async function signed(cred, env, method, endpoint, { params = null, body = null } = {}) {
    if (!cred?.key) throw { status: 403, message: env === 'demo' ? 'No demo key linked' : 'Kalshi not linked' };
    info ||= await getJSON('kalshi-auth/info');
    const headers = { ...(await signHeaders(cred.key, cred.keyId, method, info.pathPrefix + (endpoint === 'orders' ? info.orderPath || 'events/orders' : endpoint))),
      ...(env === 'demo' ? { 'x-kalshi-env': 'demo' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const q = params ? `?${new URLSearchParams(params)}` : '';
    let r;
    try { r = await fetch(`${API}/kalshi-auth/${endpoint}${q}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) }); }
    catch (e) { throw { status: 0, message: e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error' }; }
    paywalled(r);
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const er = out.error;
      throw { status: r.status, code: (typeof er === 'object' ? er?.code : null) ?? out.code ?? null, message: (typeof er === 'object' ? er?.message : er) || out.message || `HTTP ${r.status}` };
    }
    return out;
  }
  const n = (v) => (v == null || v === '' ? null : Number(v));
  function kalshiExchange(cred, env) {
    return {
      async cash() { return { balance: balanceDollars(await signed(cred(), env, 'GET', 'balance')) ?? 0, held: 0 }; }, // Kalshi's balance is already net of open orders
      async book(t) { return parseBook(await getJSON(`kalshi${env === 'demo' ? '-demo' : ''}/markets/${encodeURIComponent(t)}/orderbook`)); },
      async positions(ticker) {
        const b = await signed(cred(), env, 'GET', 'positions', { params: { count_filter: 'position', limit: '200', ...(ticker ? { ticker } : {}) } });
        return (b.market_positions || []).map(parsePosition).map((p) => ({ ticker: p.ticker, side: p.side, count: p.contracts }));
      },
      async place(o) {
        const out = await signed(cred(), env, 'POST', 'orders', { body: o });
        const x = out.order || out;
        const filled = n(x.fill_count_fp) ?? n(x.fill_count) ?? n(x.taker_fill_count);
        if (filled == null || Number.isNaN(filled)) throw { status: 0, message: 'Kalshi answered without a fill count' }; // unknown: checked by position
        return { filled, avgPrice: null, fees: null }; // booked at the max price (the worst case); Kalshi's own fills sync in the Positions tab
      },
    };
  }
  const testEx = createTestExchange({
    getBook: async (t) => parseBook(await getJSON(`kalshi/markets/${encodeURIComponent(t)}/orderbook`)),
    startCash: cfg.testCash,
    store: { load: () => store.get('traderTestEx', null), save: (x) => store.set('traderTestEx', x) },
  });
  const exchanges = { test: testEx, demo: kalshiExchange(() => demoCred, 'demo'), live: kalshiExchange(liveCred, 'live') };
  const traders = Object.fromEntries(['test', 'demo', 'live'].map((m) => [m, createTrader({
    exchange: exchanges[m],
    settings: () => ({ ...cfg, mode: cfg.mode === m ? m : 'off' }),
    store: { load: () => store.get(`trader:${m}`, null), save: (x) => store.set(`trader:${m}`, x) },
  })]));
  const active = () => traders[cfg.mode] || null;

  // Results for markets the trader holds, once they close (from Kalshi's public market data; demo from the demo exchange)
  function resolver(mode) {
    return (ticker) => {
      if (results[ticker]) return results[ticker];
      if (!asked[ticker] || Date.now() - asked[ticker] > 20000) {
        asked[ticker] = Date.now();
        getJSON(`kalshi${mode === 'demo' ? '-demo' : ''}/markets/${encodeURIComponent(ticker)}`).then(({ market }) => {
          if (market?.result === 'yes' || market?.result === 'no') results[ticker] = market.result;
        }).catch(() => {});
      }
      return null;
    };
  }

  // ---------- each render: one step (at most every 2s) ----------
  function tick({ live, snap, sig, settings }) {
    const tr = active();
    if (!tr || Date.now() - lastStep < 2000) return;
    lastStep = Date.now();
    // The bot's Steady calls, whatever risk level the screen shows
    let call = sig;
    if (live && riskLevelOf(settings) !== 'steady') call = buySignal(live, snap, { ...settings, ...riskSettings('steady') }, snap.now, steadyCalls);
    // sell signals for what the trader holds
    const checks = {};
    for (const e of tr.state().ledger.filter((x) => !x.closed)) {
      const id = `${cfg.mode}:${e.ticker}:${e.at}`;
      const pos = (pseudo[id] ||= { id, ticker: e.ticker, side: e.side, price: e.price, contracts: e.count, closeTime: e.closeTime, at: e.at, fees: e.fees, peakBid: null, peakP: null });
      pos.contracts = e.count;
      const c = positionCheck(pos, snap, settings);
      checks[e.ticker] = { bid: c.bid, ex: c.ex };
    }
    tr.step({ live, sig: call, checks, resolve: resolver(cfg.mode) }).then((r) => {
      const why = r?.did ? (r.did === 'buy' ? `Bought ${r.filled}` : `Sold ${r.filled}`) : r?.why || '';
      if (r?.did) toast(`Auto-trader (${MODES[cfg.mode]}): ${why}`);
      if (why !== lastWhy || r?.did) { lastWhy = why; renderCard(); }
    }).catch((e) => { lastWhy = `Error: ${e?.message || e}`; renderCard(); });
  }

  // ---------- the card ----------
  const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
  const signed$ = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  function renderCard() {
    const tr = active(), st = tr?.state(), unlock = liveUnlocked(traders.test.state());
    $('atModes').innerHTML = Object.entries(MODES).map(([k, label]) => `<button type="button" data-mode="${k}" class="${cfg.mode === k ? 'on' : ''}${k === 'live' && !unlock.ok ? ' locked' : ''}">${k === 'live' && !unlock.ok ? '🔒 ' : ''}${label}</button>`).join('');
    $('atDemo').hidden = cfg.mode !== 'demo' && !(cfg.mode === 'off' && $('atDemo').dataset.show);
    $('atDemoStatus').textContent = demoCred ? `Demo key linked (${demoCred.keyId.slice(0, 8)}…)` : 'Link a key from demo.kalshi.co (a demo account, fake money). It stays on this phone like your real key.';
    $('atDemoForm').hidden = !!demoCred;
    $('atDemoUnlink').hidden = !demoCred;
    const why = cfg.mode === 'off' ? 'Off: it isn\'t trading.' : st?.stopped ? `Stopped: ${st.stopped}` : lastWhy || 'Watching for the bot\'s next call…';
    $('atStatus').textContent = cfg.mode === 'off' ? `Off.${unlock.ok ? '' : ` Live unlocks after ${LIVE_UNLOCK} clean Test trades (${unlock.settled} so far${unlock.serious ? ', but Test hit an error: reset Test and run it again' : ''}).`}` : `${MODES[cfg.mode]}: ${why}`;
    $('atStop').hidden = cfg.mode === 'off';
    $('atResume').hidden = !st || !(st.stopped || st.pausedUntil > Date.now());
    if (tr) {
      const t = tr.today(), s = tr.stats();
      $('atToday').innerHTML = `<div><label>Today</label><b class="${t.realized > 0 ? 'pos' : t.realized < 0 ? 'neg' : ''}">${signed$(t.realized)}</b></div>
        <div><label>Open</label><b>${usd(t.open)}</b></div><div><label>Buys today</label><b>${t.buys}/${cfg.maxTrades}</b></div>
        <div><label>All ${MODES[cfg.mode]}</label><b class="${s.pnl > 0 ? 'pos' : s.pnl < 0 ? 'neg' : ''}">${signed$(s.pnl)}</b></div>
        <div><label>Won</label><b>${s.wins}/${s.closed}</b></div><div><label>${cfg.mode === 'test' ? 'Test cash' : 'Errors'}</label><b>${cfg.mode === 'test' ? usd(testEx.balance()) : s.errors}</b></div>`;
    } else $('atToday').innerHTML = '';
    $('atLog').innerHTML = (st?.log || []).slice(0, 20).map((x) => `<li class="at-${esc(x.kind)}"><span>${time(x.t)}</span> ${esc(x.text)}</li>`).join('') || '<li class="calm">Nothing yet</li>';
    $('atResetTest').hidden = cfg.mode !== 'test' && cfg.mode !== 'off';
    const strip = $('atStrip');
    strip.hidden = cfg.mode === 'off';
    if (cfg.mode !== 'off') { strip.className = `at-strip ${cfg.mode}`; $('atStripText').textContent = `🤖 Auto-trader ${MODES[cfg.mode].toUpperCase()}${cfg.mode === 'live' ? ' · REAL MONEY' : ''} · ${st?.stopped ? 'stopped' : lastWhy || 'watching'}`; }
  }

  function buildLimits() {
    $('atLimits').innerHTML = LIMITS.map(([k, label, min, max]) => `<label>${label}<input type="number" inputmode="decimal" name="${k}" min="${min}" max="${max}" step="1" value="${cfg[k]}"></label>`).join('');
  }
  $('atLimits').addEventListener('change', (e) => {
    const el = e.target, lim = LIMITS.find(([k]) => k === el.name);
    if (!lim) return;
    const v = Math.min(lim[3], Math.max(lim[2], Math.floor(Number(el.value) || TRADER_DEFAULTS[el.name])));
    cfg[el.name] = v; el.value = v; saveCfg();
    if (el.name === 'testCash') toast('Test balance applies the next time you reset Test');
    renderCard();
  });
  $('atModes').addEventListener('click', async (e) => {
    const m = e.target.closest('button[data-mode]')?.dataset.mode;
    if (!m || m === cfg.mode) return;
    if (m === 'live') {
      const u = liveUnlocked(traders.test.state());
      if (!u.ok) return toast(u.serious ? 'Test hit an error: reset Test and let it run clean first' : `Run Test first: Live unlocks after ${LIVE_UNLOCK} clean Test trades (${u.settled} so far)`);
      if (!liveCred()?.key) return toast('Link your Kalshi account first (it needs a key with trading permission)');
      if (!confirm(`Turn on LIVE auto-trading?\n\nIt will place real orders with real money on your Kalshi account: up to $${cfg.perTrade} a trade, ${cfg.maxTrades} buys a day, stopping for the day at a $${cfg.dailyLoss} loss.\n\nKeep the app open; tap STOP any time.`)) return;
    }
    if (m === 'demo' && !demoCred) { $('atDemo').dataset.show = '1'; cfg.mode = 'off'; renderCard(); $('atDemo').hidden = false; return toast('Link a Kalshi demo key first'); }
    cfg.mode = m; saveCfg(); lastWhy = ''; lastStep = 0;
    renderCard(); render?.();
  });
  const stop = () => { cfg.mode = 'off'; saveCfg(); lastWhy = ''; toast('Auto-trader stopped'); renderCard(); };
  $('atStop').addEventListener('click', stop);
  $('atStripStop').addEventListener('click', stop);
  $('atResume').addEventListener('click', () => { active()?.resume(); lastWhy = ''; renderCard(); });
  $('atResetTest').addEventListener('click', () => {
    if (!confirm(`Reset Test? Its history and simulated positions are cleared and the balance goes back to $${cfg.testCash}.`)) return;
    traders.test.reset(); testEx.reset(cfg.testCash); renderCard();
  });
  $('atDemoLink').addEventListener('click', async () => {
    const keyId = $('atDemoKeyId').value.trim(), pem = $('atDemoPem').value;
    $('atErr').textContent = '';
    try {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(keyId)) throw new Error('Enter the demo API key ID');
      const key = await importKey(pem);
      await signed({ key, keyId }, 'demo', 'GET', 'balance'); // proves the key works on the demo exchange
      demoCred = { key, keyId };
      await idb('readwrite', (s) => s.put(demoCred, 'kalshiDemo'));
      $('atDemoKeyId').value = ''; $('atDemoPem').value = '';
      toast('Demo key linked');
    } catch (e) { $('atErr').textContent = e?.message || 'Demo key refused'; }
    renderCard();
  });
  $('atDemoUnlink').addEventListener('click', async () => {
    await idb('readwrite', (s) => s.delete('kalshiDemo')).catch(() => {});
    demoCred = null; if (cfg.mode === 'demo') cfg.mode = 'off'; saveCfg(); renderCard();
  });

  async function load() {
    try { const d = await idb('readonly', (s) => s.get('kalshiDemo')); if (d?.key && d?.keyId) demoCred = d; } catch { /* no IndexedDB */ }
    buildLimits(); renderCard();
  }
  load();
  return { tick, renderCard, mode: () => cfg.mode, traders };
}
