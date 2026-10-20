// The admin's live window on the bot team (v13.66; the whole staff talking, v13.67): every teammate (public/team.js) as a
// little robot at a desk in its department's room, read fresh every second from /api/admin/team (team.js live()). Each
// robot's light, eyes and motion follow its state (ok, busy, warn, idle, off). The talking: the server sends who tells whom
// what right now (teamTalk: along the real handoffs in the code); this plays it as conversations, a few at a time: the
// speaker talks with its words in a bubble, a dot flies to the listener, who turns to hear it. A teammate whose situation
// just changed speaks first, marked CHANGED in the conversation log. The server serves this page and its data to the admin only.
import { DEPTS, TEAM_ICON } from './team.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const STATE_WORD = { ok: 'on it', busy: 'acting', warn: 'warning', idle: 'waiting', off: 'off' };
const STATE_COLOR = { ok: '#2ee6a6', busy: '#22d3ee', warn: '#fbbf24', idle: '#6b7a90', off: '#3a4352' };
const still = matchMedia('(prefers-reduced-motion: reduce)');
const NS = 'http://www.w3.org/2000/svg', svg = $('wires');

const params = new URLSearchParams(location.search);
let market = params.get('m') || '', last = null, lastAt = 0, seen = null, events = 0, timer = null, reading = false;
let byRole = {}, talk = [], turn = 0, built = '', open = null;
const keys = {}, queue = [], chat = [];

// ---------- the office ----------
function build(roster) {
  const sig = roster.map((r) => r.role).join();
  if (sig === built) return;
  built = sig;
  $('rooms').innerHTML = DEPTS.map(([d, name]) => {
    const team = roster.filter((r) => r.dept === d);
    if (!team.length) return '';
    return `<section class="room ${team.length >= 8 ? 'wide' : team.length <= 3 ? 'half' : ''}" data-dept="${d}">
      <h2><span>${esc(name)}</span><em id="rw-${d}"></em></h2>
      <div class="desks">${team.map((r) => `
        <button class="emp idle${r.lead ? ' lead' : ''}" id="e-${r.role}" data-role="${r.role}" aria-label="${esc(r.name)}">
          <div class="bubble" id="b-${r.role}"></div>
          <div class="rig" aria-hidden="true">
            <div class="ant"></div>
            <div class="head"><div class="visor"><span class="eye"></span><span class="eye"></span></div><span class="mouth"></span></div>
            <div class="badge">${TEAM_ICON[r.role] || '•'}</div><span class="zz">z</span>
          </div>
          <span class="nm">${esc(r.name)}</span>
        </button>`).join('')}</div></section>`;
  }).join('');
}

// ---------- a conversation: speaker talks, a dot flies, the listener turns to hear ----------
function rigCenter(role) {
  const f = $('rooms').getBoundingClientRect(), r = $(`e-${role}`)?.querySelector('.head')?.getBoundingClientRect();
  return r ? [r.left + r.width / 2 - f.left, r.top + r.height / 2 - f.top] : null;
}
function bubbleSide(el) {
  const r = el.getBoundingClientRect(), w = innerWidth;
  return r.left < 90 ? 'l' : r.right > w - 90 ? 'r' : '';
}
const timers = new Map();
function later(key, ms, f) { clearTimeout(timers.get(key)); timers.set(key, setTimeout(f, ms)); }
function speak(m) {
  const from = byRole[m.from], to = byRole[m.to], a = $(`e-${m.from}`), b = $(`e-${m.to}`);
  if (!from || !to || !a || !b) return;
  const bub = $(`b-${m.from}`);
  bub.className = `bubble ${bubbleSide(a)}`;
  bub.innerHTML = `<b>→ ${esc(to.name)}:</b> ${esc(m.text)}`;
  requestAnimationFrame(() => bub.classList.add('show'));
  a.classList.add('talking');
  later(`t-${m.from}`, 1700, () => a.classList.remove('talking'));
  later(`b-${m.from}`, 2600, () => bub.classList.remove('show'));
  log(m, from, to);
  const hear = () => { b.classList.add('listening'); b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit'); later(`l-${m.to}`, 1100, () => b.classList.remove('listening')); };
  if (still.matches || document.hidden) return hear();
  const p1 = rigCenter(m.from), p2 = rigCenter(m.to);
  if (!p1 || !p2) return hear();
  const color = STATE_COLOR[from.state] || STATE_COLOR.ok, [x1, y1] = p1, [x2, y2] = p2;
  const bend = Math.max(30, Math.hypot(x2 - x1, y2 - y1) * 0.25), cx = (x1 + x2) / 2 + (y2 - y1 >= 0 ? -bend : bend) * 0.4, cy = (y1 + y2) / 2 - bend;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`); path.setAttribute('class', 'talk-line'); path.setAttribute('stroke', color); path.style.opacity = 0.7;
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', m.news ? 5 : 3.5); dot.setAttribute('fill', color); dot.setAttribute('class', 'pk'); dot.style.color = color;
  svg.append(path, dot);
  const len = path.getTotalLength(), t0 = performance.now(), ms = 650 + Math.min(700, len * 0.9);
  (function step(now) {
    const f = Math.min(1, (now - t0) / ms), e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2, pt = path.getPointAtLength(e * len);
    dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
    if (f < 1) return requestAnimationFrame(step);
    dot.remove(); hear(); path.style.opacity = 0; setTimeout(() => path.remove(), 450);
  })(t0);
}
// every 0.7 s: the next thing to say. What just changed goes first; otherwise the team takes turns, so everyone talks.
function next() {
  if (document.hidden || !talk.length) return;
  for (let k = 0; k < 2; k++) {
    const m = queue.shift() ?? (turn = (turn + 1) % talk.length, talk[turn]);
    if (!m) return;
    if ($(`e-${m.from}`)?.classList.contains('talking')) { if (m.news) queue.unshift(m); return; } // one thing at a time per mouth
    speak(m);
    if (!queue.length) return;
  }
}
function log(m, from, to) {
  if ($('onlyNews').checked && !m.news) return;
  chat.unshift({ ...m, t: Date.now(), state: from.state, fromName: from.name, toName: to.name });
  if (chat.length > 60) chat.length = 60;
  const c = chat[0], li = document.createElement('li');
  li.className = `new s-${c.state}${c.news ? ' news' : ''}`;
  li.innerHTML = `<div class="who"><span>${TEAM_ICON[c.from] || '•'} ${esc(c.fromName)}</span><span class="to">→ ${TEAM_ICON[c.to] || '•'} ${esc(c.toName)}</span>${c.news ? '<span class="tag">CHANGED</span>' : ''}<time>${clock(c.t)}</time></div><div class="say">${esc(c.text)}</div>`;
  const ol = $('chat');
  ol.querySelector('.empty')?.parentElement.remove();
  ol.prepend(li);
  while (ol.children.length > 60) ol.lastChild.remove();
}

// ---------- the readings ----------
function render(t) {
  build(t.roster);
  byRole = Object.fromEntries(t.roster.map((r) => [r.role, r]));
  // a teammate whose situation changed speaks first, to everyone it reports to
  const changed = new Set();
  for (const r of t.roster) { if (keys[r.role] !== undefined && keys[r.role] !== r.key) changed.add(r.role); keys[r.role] = r.key; }
  talk = t.talk || [];
  for (const m of talk) if (changed.has(m.from)) queue.push({ ...m, news: true });
  if (queue.length > 12) queue.splice(0, queue.length - 12);
  for (const r of t.roster) {
    const e = $(`e-${r.role}`); if (!e) continue;
    for (const st of Object.keys(STATE_WORD)) e.classList.toggle(st, st === r.state);
    e.title = `${r.name} (${STATE_WORD[r.state]}): ${r.status}`;
  }
  for (const [d] of DEPTS) { const w = t.roster.filter((r) => r.dept === d && r.state === 'warn').length, el = $(`rw-${d}`); if (el) el.textContent = w ? `${w} ⚠` : ''; }
  const n = (st) => t.roster.filter((r) => r.state === st).length;
  $('counts').innerHTML = `<span><b>${t.roster.length}</b> on the team</span><span class="a"><b>${n('busy')}</b> acting</span><span class="w"><b>${n('warn')}</b> warning</span><span><b>${n('idle')}</b> waiting</span><span><b>${n('off')}</b> off</span><span><b>${talk.length}</b> lines of talk</span>`;
  // the round
  const p = t.pulse;
  $('pName').textContent = t.markets.find((m) => m.series === t.series)?.name ?? t.series;
  $('pUp').textContent = `UP ${p?.pYes != null ? Math.round(p.pYes * 100) + '%' : '—'}`;
  $('pDn').textContent = `DOWN ${p?.pYes != null ? Math.round((1 - p.pYes) * 100) + '%' : '—'}`;
  $('pBar').style.width = `${p?.pYes != null ? p.pYes * 100 : 50}%`;
  $('pGap').textContent = p?.spot > 0 && p?.strike > 0 ? `${p.spot >= p.strike ? '+' : '−'}${(Math.abs(p.spot / p.strike - 1) * 100).toFixed(3)}%` : '—';
  // what changed: everything the server has logged, newest first
  const key = (e) => `${e.t}|${e.role}|${e.text}`, fresh = seen ? t.feed.filter((e) => !seen.has(key(e))) : [];
  seen = new Set(t.feed.map(key)); events += fresh.length;
  const newKeys = new Set(fresh.map(key));
  $('feed').innerHTML = t.feed.length ? t.feed.slice(0, 40).map((e) => `<li class="s-${e.state}${newKeys.has(key(e)) ? ' new' : ''}"><div class="who"><span>${TEAM_ICON[e.role] || '•'} ${esc(e.name)}</span><time>${clock(e.t)}</time></div><div class="say">${esc(e.text)}</div></li>`).join('')
    : '<li><span class="empty">Nothing has changed since the server started watching this market. Lines appear here the moment a teammate changes position.</span></li>';
  if (!$('chat').children.length) $('chat').innerHTML = '<li><span class="empty">The team starts talking in a moment…</span></li>';
  $('count').textContent = events ? `${events} while you watched` : '';
  if (open) sheet(open);
}
function markets(t) {
  const sel = $('market'), want = t.markets.map((m) => m.series).join();
  if (sel.dataset.list !== want) { sel.dataset.list = want; sel.innerHTML = t.markets.map((m) => `<option value="${esc(m.series)}">${esc(m.name)}</option>`).join(''); }
  sel.value = t.series;
}
async function read() {
  if (reading || document.hidden) return;
  reading = true;
  try {
    const r = await fetch(`/api/admin/team${market ? `?m=${encodeURIComponent(market)}` : ''}`, { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return gate('This window is for the admin only. Sign in with the admin code in the app (Settings), then open it again.');
    if (!r.ok) throw new Error(r.status);
    const t = await r.json();
    $('gate').hidden = true; $('app').hidden = false;
    markets(t); render(t); last = t; lastAt = Date.now();
  } catch { /* the next second tries again; the LIVE tag goes grey meanwhile */ } finally { reading = false; }
}
function gate(text) { $('app').hidden = true; $('gate').hidden = false; $('gate').textContent = text; clearInterval(timer); }
function tick() {
  $('clock').textContent = clock(Date.now());
  $('live').classList.toggle('stale', !lastAt || Date.now() - lastAt > 4000);
  const p = last?.pulse;
  if (p) { const s = Math.max(0, p.minutesLeft * 60 - (Date.now() - lastAt) / 1000); $('pLeft').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
  else $('pLeft').textContent = '—';
}

// ---------- tap a teammate ----------
function sheet(role) {
  const r = byRole[role]; if (!r) return;
  open = role;
  const dept = DEPTS.find(([d]) => d === r.dept)?.[1] ?? '', names = (xs) => [...new Set(xs)].map((x) => `${TEAM_ICON[x] || ''} ${esc(byRole[x]?.name ?? x)}`).join(', ') || 'nobody right now';
  $('shName').innerHTML = `${TEAM_ICON[role] || ''} ${esc(r.name)}<span class="chip" style="color:${STATE_COLOR[r.state]}">${STATE_WORD[r.state]}</span>`;
  $('shSub').textContent = `${r.lead ? 'Lead · ' : ''}${dept} · ${r.job}`;
  $('shSt').textContent = r.status;
  $('shRel').innerHTML = `<div><b>Tells:</b> ${names(talk.filter((m) => m.from === role).map((m) => m.to))}</div><div><b>Hears from:</b> ${names(talk.filter((m) => m.to === role).map((m) => m.from))}</div>`;
  $('sheet').classList.add('open');
}
$('rooms').addEventListener('click', (e) => { const b = e.target.closest('.emp'); if (b) sheet(b.dataset.role); });
$('shX').addEventListener('click', () => { open = null; $('sheet').classList.remove('open'); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { open = null; $('sheet').classList.remove('open'); } });

$('market').addEventListener('change', (e) => {
  market = e.target.value; seen = null; last = null; built = ''; queue.length = 0; for (const k of Object.keys(keys)) delete keys[k];
  history.replaceState(null, '', `?m=${encodeURIComponent(market)}`);
  read();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
timer = setInterval(read, 1000);
setInterval(tick, 250);
setInterval(next, 700);
read(); tick();
