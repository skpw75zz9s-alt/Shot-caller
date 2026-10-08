// The Auto-trader card: a remote control for the Auto-trader the SERVER runs around the clock (autotrade.js), so it
// keeps trading with your phone closed. The phone never trades by itself: it shows what the server is doing and
// sends your settings, mode changes and STOP.
//   Test  simulator on Kalshi's live order book: nothing is sent (each mode keeps its own history)
//   Demo  real orders on Kalshi's demo exchange with a demo key (fake money)
//   Live  real orders with your Kalshi key. Locked until Test has run clean (10 settled trades, no errors)
import { LIMITS, LIVE_UNLOCK, MODES, TRADER_DEFAULTS, liveUnlocked } from './trader.js';

export { LIVE_UNLOCK, MODES, liveUnlocked };

export function createAutopilot({ $, esc, API, toast, paywalled, fetchImpl = (...a) => fetch(...a) }) {
  let s = null, busy = false, lastSeen = 0, timer = null, err = '';

  async function call(path, body) {
    const r = await fetchImpl(`${API}/auto/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    paywalled?.(r);
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    return out;
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try { apply(await call('state')); err = ''; } catch (e) { err = e.message; renderCard(); } finally { busy = false; }
  }
  function apply(next) {
    // a toast for fills and sells that happened since the last look (they happen on the server, phone open or not)
    const fresh = (next.log || []).filter((x) => x.t > lastSeen && (x.kind === 'fill' || x.kind === 'win' || x.kind === 'loss'));
    if (s && fresh.length) toast(`Auto-trader: ${fresh[0].text}`);
    if (next.log?.[0]) lastSeen = Math.max(lastSeen, next.log[0].t);
    s = next;
    renderCard();
  }
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return; // the server keeps trading; the phone just stops asking
    timer = setTimeout(async () => { await refresh(); schedule(); }, s?.cfg?.mode && s.cfg.mode !== 'off' ? 5000 : 20000);
    timer?.unref?.(); // (tests: don't keep Node alive)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); schedule(); } });

  // ---------- the card ----------
  const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
  const signed$ = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
  // Writes that skip when nothing changed (no re-layout, and new log lines animate in only when they're new)
  const html = (el, v) => { if (el.__h === v) return false; const first = el.__h === undefined; el.innerHTML = v; el.__h = v; return !first; };
  const text = (el, v) => { if (el.__t === v) return false; el.textContent = v; el.__t = v; return true; };
  const pop = (el) => { if (!el?.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return; for (const b of el.querySelectorAll?.('b') || []) b.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 350, easing: 'ease-out' }); };
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  function renderCard() {
    text($('atErr'), err);
    if (!s) { text($('atStatus'), err ? 'Couldn\'t reach the server.' : 'Loading…'); return; }
    const mode = s.cfg.mode, unlock = s.unlock;
    html($('atModes'), Object.entries(MODES).map(([k, label]) => `<button type="button" data-mode="${k}" class="${mode === k ? 'on' : ''}${k === 'live' && !unlock.ok ? ' locked' : ''}">${k === 'live' && !unlock.ok ? '🔒 ' : ''}${label}</button>`).join(''));
    const why = s.why || 'Watching for the bot\'s next call…';
    text($('atStatus'), mode === 'off'
      ? `Off.${unlock.ok ? '' : ` Live unlocks after ${LIVE_UNLOCK} clean Test trades (${unlock.settled} so far${unlock.serious ? ', but Test hit an error: reset Test and run it again' : ''}).`} When it's on, it runs on the server: you can close the app.`
      : `${MODES[mode]} · running on the server (phone can be closed) · ${why}`);
    $('atStop').hidden = mode === 'off';
    $('atResume').hidden = !(s.stopped || s.paused);
    if (s.today && s.stats) {
      const t = s.today, st = s.stats;
      if (html($('atToday'), `<div><label>Today</label><b class="${t.realized > 0 ? 'pos' : t.realized < 0 ? 'neg' : ''}">${signed$(t.realized)}</b></div>
        <div><label>Open</label><b>${usd(t.open)}</b></div><div><label>Buys today</label><b>${t.buys}/${s.cfg.maxTrades}</b></div>
        <div><label>All ${MODES[mode]}</label><b class="${st.pnl > 0 ? 'pos' : st.pnl < 0 ? 'neg' : ''}">${signed$(st.pnl)}</b></div>
        <div><label>Won</label><b>${st.wins}/${st.closed}</b></div><div><label>${mode === 'test' ? 'Test cash' : 'Errors'}</label><b>${mode === 'test' ? usd(s.testCash) : st.errors}</b></div>`)) pop($('atToday'));
    } else html($('atToday'), '');
    html($('atLog'), (s.log || []).slice(0, 20).map((x) => `<li class="at-${esc(x.kind)}"><span>${time(x.t)}</span> ${esc(x.text)}</li>`).join('') || '<li class="calm">Nothing yet</li>');
    $('atResetTest').hidden = mode !== 'test' && mode !== 'off';
    // keys the server holds
    const k = s.keys || {};
    text($('atKeyStatus'), !s.canHoldKeys ? 'The server can\'t hold keys yet: it needs a KEY_SECRET variable in Railway (see the README).'
      : `Kalshi key: ${k.live ? `on the server (${k.live.keyId})` : 'not given'} · Demo key: ${k.demo ? `on the server (${k.demo.keyId})` : 'not given'}`);
    $('atKeyForm').hidden = !s.canHoldKeys;
    $('atKeyDelLive').hidden = !k.live; $('atKeyDelDemo').hidden = !k.demo;
    // limits (not while you're typing in one)
    for (const [key] of LIMITS) { const el = $('atLimits').elements?.[key] || $('atLimits').querySelector?.(`[name="${key}"]`); if (el && document.activeElement !== el) el.value = s.cfg[key]; }
    const strip = $('atStrip');
    strip.hidden = mode === 'off';
    if (mode !== 'off') { strip.className = `at-strip ${mode}`; text($('atStripText'), `🤖 Auto-trader ${MODES[mode].toUpperCase()}${mode === 'live' ? ' · REAL MONEY' : ''} · on the server · ${s.stopped ? 'stopped' : s.why || 'watching'}`); }
  }

  function buildLimits() {
    $('atLimits').innerHTML = LIMITS.map(([k, label, min, max]) => `<label>${label}<input type="number" inputmode="decimal" name="${k}" min="${min}" max="${max}" step="1" value="${TRADER_DEFAULTS[k]}"></label>`).join('');
  }
  async function send(path, body, done) {
    try { apply(await call(path, body)); err = ''; if (done) toast(done); } catch (e) { err = e.message; toast(e.message); renderCard(); }
    schedule();
  }
  $('atLimits').addEventListener('change', (e) => {
    const el = e.target;
    if (!LIMITS.some(([k]) => k === el.name)) return;
    send('config', { [el.name]: Number(el.value) }, el.name === 'testCash' ? 'Test balance applies the next time you reset Test' : 'Saved on the server');
  });
  $('atModes').addEventListener('click', (e) => {
    const m = e.target.closest('button[data-mode]')?.dataset.mode;
    if (!m || !s || m === s.cfg.mode) return;
    const body = { mode: m };
    if (m === 'live') {
      if (!s.unlock.ok) return toast(s.unlock.serious ? 'Test hit an error: reset Test and let it run clean first' : `Run Test first: Live unlocks after ${LIVE_UNLOCK} clean Test trades (${s.unlock.settled} so far)`);
      if (!s.keys?.live) return toast('Give the server your Kalshi key first (below)');
      if (!confirm(`Turn on LIVE auto-trading?\n\nThe server will place real orders with real money on your Kalshi account, around the clock, even with your phone off: up to $${s.cfg.perTrade} a trade, ${s.cfg.maxTrades} buys a day, stopping for the day at a $${s.cfg.dailyLoss} loss.\n\nTap STOP any time.`)) return;
      body.confirm = true;
    }
    if (m === 'demo' && !s.keys?.demo) return toast('Give the server a Kalshi demo key first (below)');
    send('config', body, m === 'off' ? 'Auto-trader off' : `${MODES[m]} is on, running on the server`);
  });
  const stop = () => send('stop', {}, 'Auto-trader stopped');
  $('atStop').addEventListener('click', stop);
  $('atStripStop').addEventListener('click', stop);
  $('atResume').addEventListener('click', () => send('resume', {}, 'Resumed'));
  $('atResetTest').addEventListener('click', () => {
    if (!confirm(`Reset Test? Its history and simulated positions are cleared and the balance goes back to $${s?.cfg?.testCash ?? 100}.`)) return;
    send('reset-test', {}, 'Test reset');
  });
  $('atKeyFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) $('atKeyPem').value = await f.text();
    e.target.value = '';
  });
  $('atKeySend').addEventListener('click', async () => {
    const env = $('atKeyEnv').value, keyId = $('atKeyId').value.trim(), pem = $('atKeyPem').value;
    $('atKeySend').textContent = 'Checking with Kalshi…';
    try {
      const out = await call('key', { env, keyId, pem });
      $('atKeyId').value = ''; $('atKeyPem').value = '';
      toast(`${env === 'demo' ? 'Demo key' : 'Kalshi key'} is on the server${out.balance != null ? ` (balance $${out.balance.toFixed(2)})` : ''}`);
      err = '';
    } catch (e2) { err = e2.message; }
    $('atKeySend').textContent = 'Give the server this key';
    refresh();
  });
  for (const [id, env] of [['atKeyDelLive', 'live'], ['atKeyDelDemo', 'demo']]) {
    $(id).addEventListener('click', () => {
      if (!confirm(`Delete the ${env === 'demo' ? 'demo' : 'Kalshi'} key from the server? ${env === 'live' ? 'Live trading stops.' : ''}`)) return;
      send('key-delete', { env }, 'Key deleted from the server');
    });
  }

  buildLimits(); renderCard(); refresh().then(schedule);
  return { refresh, renderCard, state: () => s, tick() {} };
}
