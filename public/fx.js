// Big moments, animated: the call lock-in (the bull or bear slams in and the padlock snaps shut) and the trend
// charge (the bull charges across when the chart turns bullish; the bear when it turns bearish).
// Overlays never block the app for long: the lock-in is tap-to-dismiss and both clear themselves.
// With "reduce motion" on in the phone's settings they become a short fade.

const LOCK_SVG = `<svg class="lock" viewBox="0 0 48 56"><path class="shackle" d="M14 24 V16 a10 10 0 0 1 20 0 V24" /><rect x="7" y="24" width="34" height="26" rx="6" /><circle cx="24" cy="35" r="3.5" /><path d="M24 38 v5" /></svg>`;

export function createFx($) {
  let timer = null;
  const fx = () => $('fx');
  function clear() { clearTimeout(timer); const el = fx(); el.hidden = true; el.className = 'fx'; el.innerHTML = ''; }

  // side: 'YES' | 'NO'
  function lockIn({ side, conf, hold, price, confident = false }) {
    const up = side === 'YES', el = fx();
    clearTimeout(timer);
    el.className = `fx lockin ${up ? 'up' : 'down'}`;
    el.innerHTML = `<div class="lk-card" role="status">
      <div class="lk-ring"></div><div class="lk-ring r2"></div>
      <img src="${up ? 'bull' : 'bear'}.svg" alt="" class="lk-beast">
      <div class="lk-call">${up ? 'UP' : 'DOWN'}</div>
      <div class="lk-row">${LOCK_SVG}<span>${confident ? 'CONFIDENT · LOCKED' : 'CALL LOCKED'}</span></div>
      <div class="lk-sub">${conf != null ? `confidence ${conf}` : ''}${hold != null ? ` · hold odds ${Math.round(hold * 100)}%` : ''}${price != null ? ` · buy at ${Math.round(price * 100)}¢` : ''}</div>
    </div>`;
    el.hidden = false;
    el.onclick = clear;
    timer = setTimeout(clear, 3200);
  }

  // kind: 'bull' | 'bear'
  function charge(kind) {
    const el = fx();
    if (el.classList.contains('lockin')) return; // a call lock-in is showing: it wins
    clearTimeout(timer);
    el.className = `fx charge ${kind}`;
    el.innerHTML = `<div class="ch-lane"><div class="ch-runner"><span class="dust d1"></span><span class="dust d2"></span><span class="dust d3"></span><img src="${kind}.svg" alt=""></div></div>
      <div class="ch-text">${kind === 'bull' ? 'BULLS TAKING OVER' : 'BEARS TAKING OVER'}<small>${kind === 'bull' ? 'EMA 9 crossed above EMA 21 on the 1-minute chart' : 'EMA 9 crossed below EMA 21 on the 1-minute chart'}</small></div>`;
    el.hidden = false;
    el.onclick = null;
    timer = setTimeout(clear, 2800);
  }
  return { lockIn, charge, clear };
}

// Trend from the 1-minute closes, confirmed only after it has held `holdMs` (one wiggle across isn't a turn).
// Returns 'bull' | 'bear' when a confirmed trend flips to the other side, else null. `st` keeps state between calls.
export function trendTurn(st, trend, now = Date.now(), holdMs = 15000) {
  if (!trend) return null;
  if (trend !== st.candidate) { st.candidate = trend; st.since = now; }
  if (now - st.since < holdMs || st.confirmed === trend) return null;
  const flipped = st.confirmed != null;
  st.confirmed = trend;
  return flipped ? trend : null;
}
