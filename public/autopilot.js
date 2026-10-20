// The Auto-trader card: a remote control for the Auto-trader the SERVER runs around the clock (autotrade.js), so it
// keeps trading with your phone closed: it shows what the server is doing and sends your settings, mode changes and
// STOP. Or (v13.68) for the one that runs ON THIS PHONE (phonetrade.js), on the Kalshi key linked here, which never
// leaves the phone: the same card, the same actions, answered by the phone itself. Only one place runs at a time.
//   Test  simulator on Kalshi's live order book: nothing is sent (each mode keeps its own history)
//   Demo  real orders on Kalshi's demo exchange with a demo key (fake money)
//   Live  real orders with your Kalshi key. Locked until Test has run clean (10 settled trades, no errors)
import { LIMITS, LIVE_UNLOCK, MODES, TRADER_DEFAULTS, liveUnlocked } from './trader.js';
import { PHONE_LIMITS } from './phonetrade.js';

export { LIVE_UNLOCK, MODES, liveUnlocked };

export function createAutopilot({ $, esc, API, toast, paywalled, fetchImpl = (...a) => fetch(...a), phone = null, storage = globalThis.localStorage }) {
  let s = null, busy = false, lastSeen = 0, timer = null, err = '';
  // where it runs: 'server' or 'phone' (a phone trader that's on wins, so the card always shows the one trading)
  let where = phone?.running() ? 'phone' : (() => { try { return storage?.getItem('sc_auto_where') === 'phone' && phone ? 'phone' : 'server'; } catch { return 'server'; } })();
  const onPhone = () => where === 'phone';

  async function call(path, body) {
    if (onPhone()) return phone.handle(path, body);
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
    timer = setTimeout(async () => { await refresh(); schedule(); }, onPhone() ? 2000 : s?.cfg?.mode && s.cfg.mode !== 'off' ? 5000 : 20000);
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
    html($('atWhere'), [['server', 'On the server'], ['phone', 'On this phone']].map(([k, label]) => `<button type="button" data-where="${k}" class="${where === k ? 'on' : ''}">${label}</button>`).join(''));
    text($('atWhereNote'), onPhone()
      ? 'On this phone: your Kalshi key stays on this phone and signs each order here; the server only passes it on, after checking it. It trades only while the app is open: with the app closed or the screen locked, nothing is bought or sold. It keeps the screen awake while it runs, where the phone allows it.'
      : 'On the server: it trades around the clock, app open or closed, with a key you give the server (encrypted with your KEY_SECRET).');
    if (!s) { text($('atStatus'), err ? 'Couldn\'t reach the server.' : 'Loading…'); return; }
    const mode = s.cfg.mode, unlock = s.unlock, modes = s.modes || MODES, place = onPhone() ? 'on this phone (keep the app open)' : 'running on the server (phone can be closed)';
    html($('atModes'), Object.entries(modes).map(([k, label]) => `<button type="button" data-mode="${k}" class="${mode === k ? 'on' : ''}${k === 'live' && !unlock.ok ? ' locked' : ''}">${k === 'live' && !unlock.ok ? '🔒 ' : ''}${label}</button>`).join(''));
    const why = s.why || 'Watching for the bot\'s next call…';
    text($('atStatus'), mode === 'off'
      ? `Off.${unlock.ok ? '' : ` Live unlocks after ${LIVE_UNLOCK} clean Test trades (${unlock.settled} so far${unlock.serious ? ', but Test hit an error: reset Test and run it again' : ''}).`} ${onPhone() ? 'When it\'s on, it runs on this phone while the app is open.' : 'When it\'s on, it runs on the server: you can close the app.'}`
      : `${modes[mode]} · ${place} · ${why}`);
    $('atStop').hidden = mode === 'off';
    $('atResume').hidden = !(s.stopped || s.paused);
    if (s.today && s.stats) {
      const t = s.today, st = s.stats;
      if (html($('atToday'), `<div><label>Today</label><b class="${t.realized > 0 ? 'pos' : t.realized < 0 ? 'neg' : ''}">${signed$(t.realized)}</b></div>
        <div><label>Open</label><b>${usd(t.open)}</b></div><div><label>Buys today</label><b>${t.buys}/${s.cfg.maxTrades}</b></div>
        <div><label>All ${modes[mode]}</label><b class="${st.pnl > 0 ? 'pos' : st.pnl < 0 ? 'neg' : ''}">${signed$(st.pnl)}</b></div>
        <div><label>Won</label><b>${st.wins}/${st.closed}</b></div><div><label>${mode === 'test' ? 'Test cash' : 'Errors'}</label><b>${mode === 'test' ? usd(s.testCash) : st.errors}</b></div>`)) pop($('atToday'));
    } else html($('atToday'), '');
    html($('atLog'), (s.log || []).slice(0, 20).map((x) => `<li class="at-${esc(x.kind)}"><span>${time(x.t)}</span> ${esc(x.text)}</li>`).join('') || '<li class="calm">Nothing yet</li>');
    $('atResetTest').hidden = mode !== 'test' && mode !== 'off';
    // the keys: the server's (encrypted there), or the one linked on this phone
    const k = s.keys || {};
    text($('atKeyH'), onPhone() ? 'Key on this phone' : 'Keys on the server');
    text($('atKeyStatus'), onPhone()
      ? (k.live ? `Kalshi key: linked on this phone (${k.live.keyId}). It never leaves the phone. For Live it needs trading permission.` : 'No Kalshi key on this phone yet: link one in Kalshi account (above). Test needs no key.')
      : !s.canHoldKeys ? 'The server can\'t hold keys yet: it needs a KEY_SECRET variable in Railway (see the README).'
        : `Kalshi key: ${k.live ? `on the server (${k.live.keyId})` : 'not given'} · Demo key: ${k.demo ? `on the server (${k.demo.keyId})` : 'not given'}`);
    $('atKeyForm').hidden = onPhone() || !s.canHoldKeys;
    $('atKeyDelLive').hidden = onPhone() || !k.live; $('atKeyDelDemo').hidden = onPhone() || !k.demo;
    // limits (not while you're typing in one)
    for (const [key] of (onPhone() ? PHONE_LIMITS : LIMITS)) { const el = $('atLimits').elements?.[key] || $('atLimits').querySelector?.(`[name="${key}"]`); if (el && document.activeElement !== el) el.value = s.cfg[key]; }
    const strip = $('atStrip');
    strip.hidden = mode === 'off';
    if (mode !== 'off') { strip.className = `at-strip ${mode}`; text($('atStripText'), `🤖 Auto-trader ${modes[mode].toUpperCase()}${mode === 'live' ? ' · REAL MONEY' : ''} · ${onPhone() ? 'on this phone: keep the app open' : 'on the server'} · ${s.stopped ? 'stopped' : s.why || 'watching'}`); }
  }

  function buildLimits() {
    $('atLimits').innerHTML = (onPhone() ? PHONE_LIMITS : LIMITS).map(([k, label, min, max]) => `<label>${label}<input type="number" inputmode="decimal" name="${k}" min="${min}" max="${max}" step="1" value="${TRADER_DEFAULTS[k]}"></label>`).join('');
  }
  async function send(path, body, done) {
    try { apply(await call(path, body)); err = ''; if (done) toast(done); } catch (e) { err = e.message; toast(e.message); renderCard(); }
    schedule();
  }
  $('atLimits').addEventListener('change', (e) => {
    const el = e.target;
    if (!LIMITS.some(([k]) => k === el.name)) return;
    send('config', { [el.name]: Number(el.value) }, el.name === 'testCash' ? 'Test balance applies the next time you reset Test' : onPhone() ? 'Saved on this phone' : 'Saved on the server');
  });
  $('atModes').addEventListener('click', (e) => {
    const m = e.target.closest('button[data-mode]')?.dataset.mode;
    if (!m || !s || m === s.cfg.mode) return;
    const body = { mode: m };
    if (m === 'live') {
      if (!s.unlock.ok) return toast(s.unlock.serious ? 'Test hit an error: reset Test and let it run clean first' : `Run Test first: Live unlocks after ${LIVE_UNLOCK} clean Test trades (${s.unlock.settled} so far)`);
      if (!s.keys?.live) return toast(onPhone() ? 'Link your Kalshi key on this phone first (Kalshi account, above)' : 'Give the server your Kalshi key first (below)');
      if (!confirm(onPhone()
        ? `Turn on LIVE auto-trading on this phone?\n\nThis phone will place real orders with real money on your Kalshi account, signed with the key linked here: up to $${s.cfg.perTrade} a trade, ${s.cfg.maxTrades} buys a day, stopping for the day at a $${s.cfg.dailyLoss} loss.\n\nIt only trades while the app is open: if you close it or the screen locks, open positions are NOT sold by it until you come back (they still settle on Kalshi).\n\nTap STOP any time.`
        : `Turn on LIVE auto-trading?\n\nThe server will place real orders with real money on your Kalshi account, around the clock, even with your phone off: up to $${s.cfg.perTrade} a trade, ${s.cfg.maxTrades} buys a day, stopping for the day at a $${s.cfg.dailyLoss} loss.\n\nTap STOP any time.`)) return;
      body.confirm = true;
    }
    if (m === 'demo' && !s.keys?.demo) return toast('Give the server a Kalshi demo key first (below)');
    send('config', body, m === 'off' ? 'Auto-trader off' : `${(s.modes || MODES)[m]} is on, running ${onPhone() ? 'on this phone: keep the app open' : 'on the server'}`);
  });
  $('atWhere').addEventListener('click', (e) => {
    const w = e.target.closest('button[data-where]')?.dataset.where;
    if (!w || w === where) return;
    if (w === 'phone' && !phone) return toast('This phone can\'t run the Auto-trader');
    if (s && s.cfg.mode !== 'off') return toast(`Turn the Auto-trader ${onPhone() ? 'on this phone' : 'on the server'} off first: only one place trades at a time`);
    where = w; s = null; err = '';
    try { storage?.setItem('sc_auto_where', w); } catch { /* remembered for this visit */ }
    buildLimits(); renderCard(); refresh().then(schedule);
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
