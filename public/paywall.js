// Paywall: get a code, pay on Cash App with the code in the note, tap "I've paid", and the page
// unlocks once an admin approves the payment.
const $ = (id) => document.getElementById(id);
let st = null, poll = null;

// The phone remembers its code and signed pass so a paid user never has to re-enter anything:
// if the cookie is gone or the server forgot them, the pass gets them straight back in.
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const device = ls.get('sc_device') || (() => {
  const d = (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
  ls.set('sc_device', d);
  return d;
})();
function remember(s) {
  if (s?.code) ls.set('sc_code', s.code);
  if (s?.pass) ls.set('sc_pass', s.pass);
}

async function api(path, body) {
  const r = await fetch(`./api/access/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const err = (m) => { $('err').textContent = m || ''; };
const cashLink = () => `https://cash.app/$${encodeURIComponent(st.cashtag)}/${st.price}`;
const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function render() {
  $('price').textContent = `$${st.price}`;
  $('days').textContent = `/ ${st.days} days`;
  const s = $('stage');
  remember(st);
  if (st.access) { location.reload(); return; }

  const pay = (label) => `
    <div class="step">1 · Your payment code</div>
    <div class="code"><b>${esc(st.code)}</b><button id="copyBtn" class="ghost">Copy</button></div>
    <div class="step">2 · Pay $${st.price} to $${esc(st.cashtag)}</div>
    <button id="payBtn" class="cashapp">${label}</button>
    <p class="muted-sm">Paste <b>${esc(st.code)}</b> in the Cash App note so we can match your payment.</p>
    <div class="step">3 · Done?</div>
    <button id="paidBtn">I've paid</button>`;

  if (!st.code || st.state === 'denied' || st.state === 'revoked') {
    s.innerHTML = (st.state === 'denied' ? `<p class="muted-sm">Your last code was declined. If you think that's a mistake, message $${esc(st.cashtag)} on Cash App.</p>` : '') +
      '<button id="startBtn">Get started</button>';
    $('startBtn').onclick = () => run(async () => { st = await api('request', { device }); render(); });
    return;
  }
  // Waiting = they've said they paid since the last approval (covers renewals with the same code)
  const waiting = st.paidAt && st.paidAt > (st.approvedAt || 0) && (st.state === 'pending' || st.state === 'expired');
  if (waiting) {
    s.innerHTML = `<div class="wait"><div class="spin"></div><b>Checking your payment…</b>
      <p class="muted-sm">This page unlocks by itself once your Cash App payment with note <b>${esc(st.code)}</b> is confirmed. You can close it and come back.</p>
      <p class="muted-sm">Keep your code: it unlocks Shot Caller on your other devices too.</p></div>
      <details><summary>Haven't paid yet?</summary>${pay(`Pay $${st.price} on Cash App`)}</details>`;
  } else {
    s.innerHTML = (st.state === 'expired' ? `<p class="muted-sm">Your access ended ${st.expires ? day(st.expires) : ''}. Renew with the same code.</p>` : '') +
      pay(st.state === 'expired' ? `Renew: $${st.price} on Cash App` : `Pay $${st.price} on Cash App`);
  }
  const copyBtn = $('copyBtn'), payBtn = $('payBtn'), paidBtn = $('paidBtn');
  if (copyBtn) copyBtn.onclick = async () => { copyBtn.textContent = (await copy(st.code)) ? 'Copied ✓' : st.code; };
  if (payBtn) payBtn.onclick = async () => { await copy(st.code); location.href = cashLink(); };
  if (paidBtn) paidBtn.onclick = () => run(async () => { st = await api('paid', {}); render(); });
  if (waiting && !poll) poll = setInterval(refresh, 10000);
}

async function run(fn) {
  err();
  try { await fn(); } catch (e) { err(e.message); }
}
async function refresh() {
  try { st = await api('status'); render(); } catch { /* try again next tick */ }
}

$('redeemBtn').onclick = () => run(async () => { st = await api('redeem', { code: $('redeemCode').value, device }); remember(st); if (!st.access) render(); else location.reload(); });
$('adminBtn').onclick = () => run(async () => { remember(await api('admin', { code: $('adminCode').value, device })); location.reload(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// Sign back in automatically with what this phone remembers. The app clears the flag when it loads;
// if we land back here without the app ever loading, the browser isn't keeping the cookie, so stop
// for 30 seconds instead of looping.
const justRestored = () => { try { return Number(sessionStorage.getItem('sc_restore') || 0) > Date.now() - 30000; } catch { return false; } };
const reloadAfterRestore = (r) => {
  remember(r);
  try { sessionStorage.setItem('sc_restore', String(Date.now())); } catch { /* no storage */ }
  location.reload();
};
async function boot() {
  try { st = await api('status'); } catch { st = null; }
  if (st?.access) { remember(st); location.reload(); return; }
  if (!justRestored()) {
    const pass = ls.get('sc_pass'), code = ls.get('sc_code');
    if (pass) {
      try { const r = await api('restore', { pass, device }); if (r.access) return reloadAfterRestore(r); }
      catch (e) { if (/revoked|no longer valid|changed/i.test(e.message)) ls.set('sc_pass', null); }
    }
    if (code && !st?.code) {
      try { st = await api('redeem', { code, device }); if (st.access) return reloadAfterRestore(st); }
      catch { try { st = await api('request', { code, device }); } catch { /* render the plain paywall */ } }
    }
  }
  if (st) render(); else refresh();
}
boot();
