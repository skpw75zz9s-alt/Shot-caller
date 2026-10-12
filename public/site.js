// The official website (public/site.html): fills in the public record (settled calls only), the price, and the Discord
// invite when the server has one. Opened from the home-screen icon (installed app), it goes straight to sign-in.
(() => {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) { location.replace('paywall.html'); return; }
  const $ = (id) => document.getElementById(id);
  const set = (id, text, cls) => { const el = $(id); if (el) { el.textContent = text; if (cls) el.className = cls; } };
  const usd = (v) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`;
  const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  set('year', String(new Date().getFullYear()));

  fetch('api/public/record').then((r) => (r.ok ? r.json() : null)).then((rec) => {
    if (!rec) throw new Error('no record');
    const g = rec.graded || 0, rate = g ? `${Math.round((rec.wins / g) * 100)}%` : '—';
    set('pWin', rate); set('pN', g.toLocaleString()); set('rWin', rate);
    set('rWL', g ? `${rec.wins}–${g - rec.wins}` : '—');
    set('rUsd', g ? usd(rec.usd) : '—', g ? (rec.usd >= 0 ? 'pos' : 'neg') : '');
    set('rStreak', rec.streak ? `${rec.streak.n} ${rec.streak.kind === 'W' ? (rec.streak.n === 1 ? 'win' : 'wins') : (rec.streak.n === 1 ? 'loss' : 'losses')}` : '—', rec.streak ? (rec.streak.kind === 'W' ? 'pos' : 'neg') : '');
    const body = $('rCalls');
    body.replaceChildren();
    if (!rec.recent?.length) {
      const tr = body.insertRow(), td = tr.insertCell(); td.colSpan = 4; td.className = 'note'; td.textContent = 'No settled calls yet. They show here as soon as the first round settles.';
    }
    for (const c of rec.recent || []) {
      const tr = body.insertRow();
      tr.insertCell().textContent = when(c.at);
      const side = tr.insertCell(); side.textContent = c.side === 'UP' ? '▲ UP' : '▼ DOWN'; side.className = c.side === 'UP' ? 'pos' : 'neg';
      tr.insertCell().textContent = `${Math.round(c.price * 100)}¢`;
      const res = tr.insertCell(), pill = document.createElement('span'); pill.className = `pill ${c.won ? 'w' : 'l'}`; pill.textContent = c.won ? 'WIN' : 'LOSS'; res.append(pill);
    }
    if (rec.since) set('rNote', `${rec.level ? `${rec.level} level, ` : ''}graded since ${new Date(rec.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. Calls are priced high (around 90¢), so each win pays a little and a loss costs a lot: that's why profit after fees is shown next to the win rate.`);
  }).catch(() => {
    const body = $('rCalls');
    if (body) body.innerHTML = '<tr><td colspan="4" class="note">The record couldn\'t load right now. Try again in a minute.</td></tr>';
  });

  fetch('api/public/info').then((r) => (r.ok ? r.json() : null)).then((info) => {
    if (!info?.discord) return;
    for (const a of document.querySelectorAll('.js-discord')) { a.href = info.discord; a.target = '_blank'; a.rel = 'noopener'; a.hidden = false; }
    for (const d of document.querySelectorAll('.js-discord-faq')) d.hidden = false;
  }).catch(() => {});

  fetch('api/access/status', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((st) => {
    if (st?.access) { for (const a of document.querySelectorAll('a[href="paywall.html"]')) { a.href = './'; if (a.classList.contains('primary')) a.firstChild.textContent = 'Open the app'; else a.textContent = 'Open the app'; } return; }
    if (!(st?.price > 0)) return;
    for (const s of document.querySelectorAll('.js-price')) s.textContent = ` · $${st.price}${st.days ? ` / ${st.days} days` : ''}`;
  }).catch(() => {});
})();
