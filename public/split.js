// Split screen (computers only: Windows, Mac, Linux or ChromeOS, touchscreen laptops included; phones and tablets
// always get one screen and don't see the button. ?split=1 in the address forces it on, ?split=0 off): show up to four of the app's screens at once (Deck, Chart, Alerts, Record, Learn, Settings).
// Each pane has its own picker and scrolls on its own; tapping a pane focuses it, and the bottom bar then changes what
// the focused pane shows. Picking a screen another pane already shows swaps the two. On a narrow screen the panes'
// contents shrink to fit (CSS zoom), so every card still lays out as it does full screen. The layout is remembered.
export const SPLIT_VIEWS = [['live', 'Deck'], ['chart', 'Chart'], ['alerts', 'Alerts'], ['history', 'Record'], ['learn', 'Learn'], ['settings', 'Settings']];
const DEFAULT_PANES = ['live', 'chart', 'alerts', 'history'];
// A computer: a desktop system (Windows, Mac, Linux, ChromeOS), whatever its screen size, touchscreen or trackpad.
// Phones and tablets say so in their user agent; iPads in desktop mode say "Macintosh" but have touch points.
export function deviceKind({ ua = '', platform = '', maxTouchPoints = 0, mobile = null } = {}) {
  if (mobile === true || /iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone/i.test(ua)) return 'phone';
  if (/iPad|Android|Silk|Kindle|Tablet/i.test(ua)) return 'tablet';
  if (/Mac/i.test(platform || ua) && maxTouchPoints > 1) return 'tablet'; // iPadOS asking for the desktop site
  if (/Windows|Win32|Win64|Macintosh|Mac OS X|MacIntel|CrOS|Linux|X11/i.test(`${platform} ${ua}`)) return 'computer';
  return 'unknown';
}
export const isComputer = (nav) => deviceKind(nav) === 'computer';
const DESIGN_WIDTH = 380;
const MIN_PANE = 380; // px: the shortest a pane gets (more than this and the page scrolls between rows) // the width the screens are laid out for: narrower panes shrink their contents to match

// Which screens n panes show: keep the ones already chosen (no repeats), fill the rest from the defaults
export function panesFor(n, current = []) {
  const out = [];
  for (const v of [...current, ...DEFAULT_PANES, ...SPLIT_VIEWS.map(([k]) => k)]) if (out.length < n && !out.includes(v) && SPLIT_VIEWS.some(([k]) => k === v)) out.push(v);
  return out;
}
// Put `view` in pane `i`; if another pane shows it, the two swap
export function assignView(panes, i, view) {
  const next = [...panes], j = next.indexOf(view);
  if (j >= 0) next[j] = next[i];
  next[i] = view;
  return next;
}

// main: the <main> holding the .view sections. onShow(views): called with every screen now visible.
export function createSplit({ main, store, onShow, button, menu }) {
  let cfg = store.get('split', { n: 1, panes: DEFAULT_PANES, focus: 0 });
  cfg = { n: Math.min(4, Math.max(1, cfg.n | 0)), panes: panesFor(4, cfg.panes), focus: cfg.focus | 0 };
  const sections = Object.fromEntries(SPLIT_VIEWS.map(([k]) => [k, document.getElementById(`view-${k}`)]));
  const order = SPLIT_VIEWS.map(([k]) => sections[k]); // where they go back to in single mode
  let single = 'live';
  const nav = typeof navigator !== 'undefined' ? { ua: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform, maxTouchPoints: navigator.maxTouchPoints, mobile: navigator.userAgentData?.mobile ?? null } : {};
  const force = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('split') : null;
  if (force === '1' || force === '0') store.set('splitForce', force);
  const forced = store.get('splitForce', null);
  const kind = deviceKind(nav);
  const pc = { matches: forced === '1' ? true : forced === '0' ? false : kind === 'computer' };
  const count = () => (pc.matches ? cfg.n : 1); // what's on screen: the saved layout on a computer, one screen elsewhere
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null;

  function save() { store.set('split', cfg); }
  function fit() { // the panes fill the screen below the header and ticker; each one's contents shrink to fit its width
    if (count() > 1) {
      // fill the screen between the top bar and the bottom bar, but never squash a pane below MIN_PANE: on a short
      // screen the rows keep their height and the page scrolls between them instead
      const nav = document.querySelector('nav'), avail = innerHeight - main.offsetTop - (nav?.offsetHeight || 0) - 4;
      const rows = (getComputedStyle(main).gridTemplateRows || '').split(' ').filter(Boolean).length || 1;
      main.style.height = `${Math.max(avail, rows * MIN_PANE + (rows - 1) * 6 + 6)}px`;
    } else main.style.height = '';
    for (const pane of main.querySelectorAll('.pane')) {
      const body = pane.querySelector('.pane-body'), w = pane.clientWidth;
      if (!body || !w) continue;
      const z = Math.min(1, Math.max(0.45, (w - 2) / DESIGN_WIDTH));
      body.style.zoom = z < 0.99 ? String(Math.round(z * 100) / 100) : '';
    }
  }
  function layout() {
    const n = count();
    button.hidden = !pc.matches; menu.hidden ||= !pc.matches;
    document.body.classList.toggle('split', n > 1);
    for (let k = 1; k <= 4; k++) document.body.classList.toggle(`split-${k}`, n === k);
    // take the sections out of any panes first
    for (const s of order) main.appendChild(s);
    for (const p of [...main.querySelectorAll('.pane')]) p.remove();
    for (const s of order) s.classList.remove('active');
    if (n === 1) {
      document.documentElement.style.removeProperty('--split-top');
      sections[single].classList.add('active');
      onShow([single], single);
      return;
    }
    if (cfg.focus >= n) cfg.focus = 0;
    window.scrollTo(0, 0);
    const shown = cfg.panes.slice(0, n);
    shown.forEach((v, i) => {
      const pane = document.createElement('div');
      pane.className = `pane${i === cfg.focus ? ' focus' : ''}`;
      pane.dataset.i = i;
      pane.innerHTML = `<div class="pane-bar"><select aria-label="Screen in pane ${i + 1}">${SPLIT_VIEWS.map(([k, label]) => `<option value="${k}"${k === v ? ' selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="pane-full" title="Full screen" aria-label="Show this screen full screen">⤢</button></div><div class="pane-body"></div>`;
      pane.querySelector('.pane-body').appendChild(sections[v]);
      sections[v].classList.add('active');
      main.appendChild(pane);
      ro?.observe(pane);
    });
    fit(); requestAnimationFrame(fit);
    onShow(shown, shown[cfg.focus]);
  }
  function focus(i) {
    if (i === cfg.focus) return;
    cfg.focus = i; save();
    for (const p of main.querySelectorAll('.pane')) p.classList.toggle('focus', Number(p.dataset.i) === i);
    onShow(cfg.panes.slice(0, count()), cfg.panes[i]);
  }
  main.addEventListener('pointerdown', (e) => { const p = e.target.closest?.('.pane'); if (p && count() > 1) focus(Number(p.dataset.i)); });
  main.addEventListener('change', (e) => {
    const sel = e.target.closest?.('.pane-bar select');
    if (!sel) return;
    const i = Number(sel.closest('.pane').dataset.i);
    cfg.panes = assignView(cfg.panes, i, sel.value); cfg.focus = i; save(); layout();
  });
  main.addEventListener('click', (e) => {
    const b = e.target.closest?.('.pane-full');
    if (!b) return;
    single = cfg.panes[Number(b.closest('.pane').dataset.i)];
    setCount(1);
  });

  function setCount(n) { cfg.n = n; save(); layout(); renderMenu(); }
  // The bottom bar: in split mode it changes the focused pane's screen
  function show(view) {
    if (count() === 1) { single = view; layout(); return; }
    cfg.panes = assignView(cfg.panes, cfg.focus, view); save(); layout();
  }
  function renderMenu() {
    menu.innerHTML = `<div class="split-title">Split screen</div><div class="split-opts">${[1, 2, 3, 4].map((n) => `<button type="button" data-n="${n}" class="${cfg.n === n ? 'on' : ''}" aria-label="${n} screen${n > 1 ? 's' : ''}"><i class="sl sl-${n}">${'<b></b>'.repeat(n)}</i>${n === 1 ? 'Single' : `${n} screens`}</button>`).join('')}</div><small>Tap a pane to focus it: the bottom bar then changes that pane. Each pane's menu picks its screen; ⤢ shows it full screen.</small>`;
    button.classList.toggle('on', cfg.n > 1);
  }
  button.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-n]'); if (b) { setCount(Number(b.dataset.n)); menu.hidden = true; } });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== button) menu.hidden = true; });

  addEventListener('resize', () => fit());
  renderMenu();
  return { start: layout, show, setCount, state: () => ({ ...cfg, single }), device: () => ({ kind, available: pc.matches, forced, ...nav }) };
}
