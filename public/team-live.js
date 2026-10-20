// The admin's live window on the bot team (v13.66): the nine teammates as little robots on a snaking line, read fresh
// every second from /api/admin/team (team.js live()). Each robot's light, eyes and motion follow its state (ok, busy,
// warn, idle, off); a teammate changing position pops a speech bubble and sends a packet down the wire to the next one;
// a faint packet runs the whole line on every reading. The server serves this page and its data to the admin only.
import { ROLES, TEAM_ICON } from './team.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const STATE_WORD = { ok: 'on it', busy: 'acting', warn: 'warning', idle: 'waiting', off: 'off' };
const STATE_COLOR = { ok: '#2ee6a6', busy: '#22d3ee', warn: '#fbbf24', idle: '#6b7a90', off: '#3a4352' };
const still = matchMedia('(prefers-reduced-motion: reduce)');
// the snake: left to right, then back, then left to right again, so each teammate sits next to the one it hands off to
const SPOT = [[1, 1], [2, 1], [3, 1], [3, 2], [2, 2], [1, 2], [1, 3], [2, 3], [3, 3]];
const order = ROLES.map(([role]) => role);

const params = new URLSearchParams(location.search);
let market = params.get('m') || '', last = null, lastAt = 0, seen = null, events = 0, timer = null, busy = false;

// ---------- the robots ----------
$('grid').innerHTML = ROLES.map(([role, name, job], i) => `
  <div class="bot idle col${SPOT[i][0]}" id="bot-${role}" style="grid-column:${SPOT[i][0]};grid-row:${SPOT[i][1]}">
    <div class="bubble" id="bub-${role}"></div>
    <div class="rig" aria-hidden="true">
      <div class="ant"></div><div class="halo"></div>
      <div class="head"><div class="visor"><span class="eye"></span><span class="eye"></span></div><span class="mouth"></span></div>
      <div class="badge">${TEAM_ICON[role]}</div><span class="zz">z</span>
    </div>
    <div class="name">${esc(name)}</div>
    <div class="tag" id="tag-${role}">waiting</div>
    <div class="job">${esc(job)}</div>
    <p class="status" id="st-${role}">…</p>
  </div>`).join('');

// ---------- the wires and the packets ----------
const NS = 'http://www.w3.org/2000/svg', svg = $('wires');
let wires = [], packets = [];
// a head's resting center in the stage, from the layout (offsets ignore the bobbing and the desktop scale-up)
function center(role) {
  const g = $('grid'), b = $(`bot-${role}`), rig = b.querySelector('.rig'), head = rig.querySelector('.head');
  return [g.offsetLeft + b.offsetLeft + rig.offsetLeft + rig.offsetWidth / 2, g.offsetTop + b.offsetTop + rig.offsetTop + head.offsetTop + head.offsetHeight / 2];
}
function drawWires() {
  svg.innerHTML = '';
  wires = order.slice(0, -1).map((role, i) => {
    const [x1, y1] = center(role), [x2, y2] = center(order[i + 1]);
    // same row: a gentle arc; a turn to the next row: out past the edge, down the margin and back in, clear of the text
    const e = x1 > svg.clientWidth / 2 ? svg.clientWidth + 8 : -8, k = Math.sign(e - x1) * 14, r = 14;
    const d = SPOT[i][1] === SPOT[i + 1][1] ? `M${x1},${y1} C${x1 + (x2 - x1) / 3},${y1 - 26} ${x2 - (x2 - x1) / 3},${y2 - 26} ${x2},${y2}`
      : `M${x1},${y1} H${e - k} Q${e},${y1} ${e},${y1 + r} V${y2 - r} Q${e},${y2} ${e - k},${y2} H${x2}`;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('class', 'wire flow'); svg.append(p);
    return p;
  });
}
// a packet: from teammate `from`, along `hops` wires, `color`, `big` for a handoff, faint for the reading's heartbeat
function launch(from, hops, color, big) {
  if (still.matches || !wires.length || document.hidden) return;
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', big ? 5 : 2.5); dot.setAttribute('fill', color); dot.setAttribute('class', 'pk');
  dot.style.color = color; dot.style.opacity = big ? 1 : 0.55;
  svg.append(dot);
  packets.push({ dot, wire: from, end: Math.min(from + hops, wires.length), t0: performance.now(), ms: big ? 700 : 420, big });
}
function frame(now) {
  packets = packets.filter((k) => {
    const w = wires[k.wire];
    if (!w || !w.isConnected) { k.dot.remove(); return false; }
    let f = (now - k.t0) / k.ms;
    while (f >= 1 && k.wire < k.end - 1) { k.wire++; k.t0 += k.ms; f -= 1; if (k.big) arrive(order[k.wire]); }
    if (f >= 1) { if (k.big) arrive(order[k.wire + 1]); k.dot.remove(); return false; }
    const ease = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2, path = wires[k.wire], pt = path.getPointAtLength(ease * path.getTotalLength());
    k.dot.setAttribute('cx', pt.x); k.dot.setAttribute('cy', pt.y);
    return true;
  });
  requestAnimationFrame(frame);
}
function arrive(role) {
  const b = $(`bot-${role}`); if (!b) return;
  b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
}
const bubbles = {};
function say(role, text) {
  const el = $(`bub-${role}`); if (!el) return;
  el.textContent = text; el.classList.add('show');
  clearTimeout(bubbles[role]); bubbles[role] = setTimeout(() => el.classList.remove('show'), 4500);
}

// ---------- the readings ----------
function render(t) {
  for (const r of t.roster) {
    const b = $(`bot-${r.role}`); if (!b) continue;
    for (const st of Object.keys(STATE_WORD)) b.classList.toggle(st, st === r.state);
    $(`tag-${r.role}`).textContent = STATE_WORD[r.state] || r.state;
    const st = $(`st-${r.role}`);
    if (st.textContent !== r.status) {
      const moved = st.textContent !== '…' && last?.roster.find((x) => x.role === r.role)?.key !== r.key;
      st.textContent = r.status;
      if (moved) { st.classList.add('changed'); setTimeout(() => st.classList.remove('changed'), 60); }
    }
  }
  // the round
  const p = t.pulse;
  $('pName').textContent = t.markets.find((m) => m.series === t.series)?.name ?? t.series;
  $('pUp').textContent = `UP ${p?.pYes != null ? Math.round(p.pYes * 100) + '%' : '—'}`;
  $('pDn').textContent = `DOWN ${p?.pYes != null ? Math.round((1 - p.pYes) * 100) + '%' : '—'}`;
  $('pBar').style.width = `${p?.pYes != null ? p.pYes * 100 : 50}%`;
  $('pGap').textContent = p?.spot > 0 && p?.strike > 0 ? `${p.spot >= p.strike ? '+' : '−'}${(Math.abs(p.spot / p.strike - 1) * 100).toFixed(3)}%` : '—';
  // the feed: everything the server has, newest first; lines that are new since the last reading slide in and act out
  const key = (e) => `${e.t}|${e.role}|${e.text}`, fresh = seen ? t.feed.filter((e) => !seen.has(key(e))) : [];
  seen = new Set(t.feed.map(key)); events += fresh.length;
  for (const e of fresh.slice().reverse()) {
    say(e.role, e.text);
    const i = order.indexOf(e.role);
    if (i >= 0 && i < order.length - 1) launch(i, 1, STATE_COLOR[e.state] || STATE_COLOR.ok, true); else arrive(e.role);
  }
  const newKeys = new Set(fresh.map(key));
  $('feed').innerHTML = t.feed.length ? t.feed.slice(0, 40).map((e) => `<li class="s-${e.state}${newKeys.has(key(e)) ? ' new' : ''}"><time>${clock(e.t)}</time><span aria-hidden="true">${TEAM_ICON[e.role] || '•'}</span><span><b>${esc(e.name)}</b> ${esc(e.text)}</span></li>`).join('')
    : '<li><span class="empty">Nothing has changed since the server started watching this market. Lines appear here the moment a teammate changes position.</span></li>';
  $('count').textContent = events ? `${events} while you watched` : '';
  launch(0, wires.length, '#22d3ee', false); // this reading, down the line
}
function markets(t) {
  const sel = $('market'), want = t.markets.map((m) => m.series).join();
  if (sel.dataset.list !== want) { sel.dataset.list = want; sel.innerHTML = t.markets.map((m) => `<option value="${esc(m.series)}">${esc(m.name)}</option>`).join(''); }
  sel.value = t.series;
}
async function read() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const r = await fetch(`/api/admin/team${market ? `?m=${encodeURIComponent(market)}` : ''}`, { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return gate('This window is for the admin only. Sign in with the admin code in the app (Settings), then open it again.');
    if (!r.ok) throw new Error(r.status);
    const t = await r.json();
    $('gate').hidden = true;
    if ($('app').hidden) { $('app').hidden = false; requestAnimationFrame(drawWires); }
    markets(t); render(t); last = t; lastAt = Date.now();
  } catch { /* the next second tries again; the LIVE tag goes grey meanwhile */ } finally { busy = false; }
}
function gate(text) { $('app').hidden = true; $('gate').hidden = false; $('gate').textContent = text; clearInterval(timer); }
function tick() {
  $('clock').textContent = clock(Date.now());
  $('live').classList.toggle('stale', !lastAt || Date.now() - lastAt > 4000);
  const p = last?.pulse;
  if (p) { const s = Math.max(0, p.minutesLeft * 60 - (Date.now() - lastAt) / 1000); $('pLeft').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
  else $('pLeft').textContent = '—';
}

$('market').addEventListener('change', (e) => {
  market = e.target.value; seen = null; last = null;
  history.replaceState(null, '', `?m=${encodeURIComponent(market)}`);
  read();
});
addEventListener('resize', () => requestAnimationFrame(drawWires));
document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
timer = setInterval(read, 1000);
setInterval(tick, 250);
requestAnimationFrame(frame);
read(); tick();
