// Alert center in the browser: phone notifications (v13.35, they replaced the pop-up banners), sounds (Web Audio: recorded clips for the big moments, tones
// for the rest), the Alerts tab and its history. The rules live in alerts.js.
import { ALERT_DEFAULTS, ALERT_EVENTS, ALERT_GROUPS, SOUND_FILES, TONES, alertPrefs, routeAlert } from './alerts.js';

const KIND = { sellHigh: 'good', light: 'warn', win: 'good', whaleBuy: 'good', feedUp: 'good', loss: 'bad', whaleSell: 'bad', feedDown: 'bad', flip: 'warn', fliprisk: 'warn', sell: 'warn', cross: 'warn', pressure: 'warn' };

// The sound slots you can replace with your own file (kept on this phone in IndexedDB)
export const SOUND_SLOTS = [['bull', 'UP call (bull)'], ['bear', 'DOWN call (bear)'], ['wait', 'Sit out ("Wait.")'], ['bail', 'Bail ("Bail!")'], ['register', 'Win / sell high (cash register)']];

export function createAlertCenter({ $, store, esc, clock, onNote, custom = null }) {
  let prefs = alertPrefs(store.get('alertPrefs', {}));
  const log = { last: {}, history: store.get('alertHistory', []) };
  let audio = null;
  let previewFlip = false, unread = 0;

  const save = () => store.set('alertPrefs', prefs);
  const clips = {}; // name -> Promise<AudioBuffer | null>
  function load(name) {
    if (!audio) return Promise.resolve(null);
    const decode = (b) => b && new Promise((ok, fail) => audio.decodeAudioData(b, ok, fail)); // Safari wants callbacks
    const builtIn = () => fetch(`sounds/${name}.mp3`).then((r) => (r.ok ? r.arrayBuffer() : null)).then(decode);
    // your own sound for this slot wins; if it won't play, fall back to the built-in one
    return (clips[name] ||= Promise.resolve(custom?.get(name)).then((c) => (c?.blob ? c.blob.arrayBuffer().then(decode) : builtIn()))
      .catch(() => builtIn()).catch(() => null));
  }
  function unlock() {
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch { audio = null; }
    if (audio) for (const n of ['bull', 'bear', 'wait', 'bail', 'register']) load(n); // decode ahead so they play instantly
    return !!audio;
  }
  // key: the event; clip: a sound file to use instead of the event's own (e.g. bull / bear for a call)
  function play(key, clip = SOUND_FILES[key]) {
    if (!audio || audio.state !== 'running') return;
    const vol = Math.max(0, Math.min(1, prefs.volume / 100));
    if (clip) {
      load(clip).then((buf) => {
        if (!buf) return tones(key, vol);
        const src = audio.createBufferSource(), g = audio.createGain();
        src.buffer = buf; g.gain.value = Math.min(1, vol * 1.6);
        src.connect(g).connect(audio.destination); src.start();
      });
      return;
    }
    tones(key, vol);
  }
  function tones(key, volume) {
    const vol = volume * 0.3;
    let t = audio.currentTime + 0.02;
    for (const [f, ms] of TONES[key] || [[660, 120]]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
      t += ms / 1000 + 0.04;
    }
  }
  // ---------- notifications (nothing pops up over the app) ----------
  const canNotify = () => 'Notification' in window && Notification.permission === 'granted';
  // A phone notification. One per kind of alert: a new whale replaces the last whale's notification instead of
  // stacking. silent when the app already played its sound. Without permission it only counts on the Alerts tab.
  async function notify(key, title, text, { silent = false } = {}) {
    if (canNotify()) {
      try {
        const opts = { body: text || '', tag: `alert-${key}`, renotify: true, silent, icon: 'icon-192.png', badge: 'icon-192.png' };
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
        return true;
      } catch { /* falls through to the counter */ }
    }
    if (!$('view-alerts')?.classList.contains('active')) { unread++; renderBadge(); }
    return false;
  }
  function renderBadge() {
    const b = document.querySelector('nav button[data-view="alerts"]');
    if (!b) return;
    let dot = b.querySelector('.nav-badge');
    if (!dot) { dot = document.createElement('i'); dot.className = 'nav-badge'; b.appendChild(dot); }
    dot.textContent = unread > 9 ? '9+' : String(unread);
    dot.hidden = !unread;
  }
  document.querySelector('nav button[data-view="alerts"]')?.addEventListener('click', () => { unread = 0; renderBadge(); });
  function renderNotify(msg) {
    const st = $('alNotifyStatus'), btn = $('alNotify');
    if (!st) return;
    const has = 'Notification' in window, perm = has ? Notification.permission : 'unsupported';
    st.textContent = msg || (perm === 'granted' ? 'Notifications are on: alerts arrive as phone notifications, never pop-ups over the app.'
      : perm === 'denied' ? 'Notifications are blocked for Shot Caller. Allow them in your phone\'s Settings → Notifications, then come back.'
      : !has ? 'This browser can\'t show notifications. On iPhone: Share → Add to Home Screen, then open Shot Caller from the Home Screen and turn them on here.'
      : 'Turn on notifications to get alerts as phone notifications. Until then they only go to the history below (and the count on the Alerts tab).');
    if (btn) btn.hidden = perm !== 'default';
  }
  async function askNotify() {
    if (!('Notification' in window)) return renderNotify();
    try { await Notification.requestPermission(); } catch { /* old Safari: callback form */ }
    renderNotify();
    if (canNotify()) notify('feedUp', 'Notifications are on', 'Alerts will show up here instead of popping up over the app.');
  }

  // Fire an event: history always, then sound and/or banner if allowed. dedupe narrows the cooldown key.
  function event(key, title, text = '', dedupe = key, now = Date.now(), clip) {
    const r = routeAlert(prefs, log, key, `${title}${text ? ` · ${text}` : ''}`, now, dedupe);
    store.set('alertHistory', log.history.slice(0, 60));
    if (r.sound) play(key, clip);
    if (r.visual) notify(key, title, text, { silent: !!r.sound });
    onNote?.(key, title, text);
    renderHistory();
  }

  function renderHistory() {
    const el = $('alertHistory');
    if (!el) return;
    el.innerHTML = log.history.slice(0, 40).map((h) => `<li class="${KIND[h.key] || (h.key === 'call' ? 'call' : '')}"><time>${clock(h.t)}</time><span>${esc(h.text)}</span></li>`).join('') ||
      '<li class="empty">Nothing yet. Alerts appear here as they happen.</li>';
  }

  function render() {
    $('alSounds').checked = prefs.sounds; $('alVisuals').checked = prefs.visuals; $('alQuiet').checked = prefs.quiet;
    $('alLockAnim').checked = prefs.lockAnim; $('alTrendAnim').checked = prefs.trendAnim;
    $('alVolume').value = prefs.volume; $('alCooldown').value = prefs.cooldownSec;
    $('alWhale').value = prefs.whaleMin; $('alFlip').value = prefs.flipRisk;
    $('alUnlock').textContent = audio?.state === 'running' ? 'Sound is on for this visit ✓' : 'Tap to enable sound on this phone';
    renderSlots();
    $('alertGroups').innerHTML = ALERT_GROUPS.map((g) => `<div class="card ev-card"><h3>${esc(g.title)}</h3>${g.events.map(([k]) => {
      const e = prefs.events[k];
      return `<div class="ev-row"><span>${esc(ALERT_EVENTS[k].label)}</span><label><input type="checkbox" data-ev="${k}" data-f="sound" ${e.sound ? 'checked' : ''}>Sound</label><label><input type="checkbox" data-ev="${k}" data-f="visual" ${e.visual ? 'checked' : ''}>Notify</label><button data-preview="${k}">Preview</button></div>`;
    }).join('')}</div>`).join('');
    renderHistory(); renderNotify(); renderBadge();
  }

  // ---------- your own sounds ----------
  async function renderSlots() {
    const el = $('soundSlots');
    if (!el) return;
    const mine = await Promise.all(SOUND_SLOTS.map(([n]) => Promise.resolve(custom?.get(n)).catch(() => null)));
    el.innerHTML = SOUND_SLOTS.map(([n, label], i) => `<div class="ev-row slot"><span>${esc(label)}<small>${mine[i]?.name ? `yours: ${esc(mine[i].name)}` : 'built-in'}</small></span>
      <button data-slot-play="${n}">Play</button><label class="file-btn mini">Choose<input type="file" accept="audio/*" data-slot="${n}" hidden></label>${mine[i] ? `<button data-slot-reset="${n}">Reset</button>` : '<span></span>'}</div>`).join('');
  }
  $('soundSlots')?.addEventListener('click', async (e) => {
    const p = e.target.dataset.slotPlay, r = e.target.dataset.slotReset;
    if (p) { unlock(); play('preview', p); }
    if (r && custom) { await custom.set(r, null); delete clips[r]; renderSlots(); }
  });
  $('soundSlots')?.addEventListener('change', async (e) => {
    const n = e.target.dataset.slot, f = e.target.files?.[0];
    if (!n || !f || !custom) return;
    if (f.size > 3e6) { window.alert('That file is over 3 MB: pick a shorter clip.'); return; }
    await custom.set(n, { blob: f, name: f.name }); delete clips[n];
    unlock(); play('preview', n); renderSlots();
  });

  // ---------- controls ----------
  const num = (id, key, min, max) => $(id).addEventListener('change', () => { const n = Number($(id).value); if (Number.isFinite(n)) { prefs[key] = Math.min(max, Math.max(min, n)); save(); } render(); });
  num('alVolume', 'volume', 0, 100); num('alCooldown', 'cooldownSec', 0, 3600); num('alWhale', 'whaleMin', 1000, 1e8); num('alFlip', 'flipRisk', 1, 99);
  $('alSounds').addEventListener('change', () => { prefs.sounds = $('alSounds').checked; if (prefs.sounds) unlock(); save(); render(); });
  $('alVisuals').addEventListener('change', () => { prefs.visuals = $('alVisuals').checked; save(); });
  $('alLockAnim').addEventListener('change', () => { prefs.lockAnim = $('alLockAnim').checked; save(); });
  $('alTrendAnim').addEventListener('change', () => { prefs.trendAnim = $('alTrendAnim').checked; save(); });
  // Quiet mode keeps your switches as they are and only mutes; turning it off restores everything
  $('alQuiet').addEventListener('change', () => { prefs.quiet = $('alQuiet').checked; save(); });
  $('alNotify')?.addEventListener('click', askNotify);
  $('alUnlock').addEventListener('click', () => { if (unlock()) { prefs.sounds = true; save(); play('call'); } render(); });
  $('alReset').addEventListener('click', () => { if (confirm('Reset all alert settings?')) { prefs = alertPrefs({}); save(); render(); } });
  $('alClear').addEventListener('click', () => { log.history = []; store.set('alertHistory', []); renderHistory(); });
  $('alertGroups').addEventListener('change', (e) => {
    const k = e.target.dataset.ev, f = e.target.dataset.f;
    if (!k) return;
    prefs.events[k] = { ...prefs.events[k], [f]: e.target.checked };
    save();
  });
  // Preview sends the notification and plays the tone even when that event's switches are off
  $('alertGroups').addEventListener('click', (e) => {
    const k = e.target.dataset.preview;
    if (!k) return;
    unlock();
    const clip = k === 'call' ? (previewFlip = !previewFlip) ? 'bull' : 'bear' : undefined; // UP and DOWN take turns
    play(k, clip);
    notify(k, `Preview: ${ALERT_EVENTS[k].label}`, clip ? `${clip === 'bull' ? 'UP call: the bull' : 'DOWN call: the bear'}` : 'This is how it will look.', { silent: true })
      .then((ok) => { if (!ok) renderNotify('Notifications aren\'t on yet, so nothing was shown. Turn them on above.'); });
  });
  // Any first tap unlocks audio if sounds are on (phones need a gesture)
  document.addEventListener('click', () => { if (prefs.sounds && !audio) unlock(); }, { once: true });

  return { event, render, play, prefs: () => prefs, defaults: ALERT_DEFAULTS };
}
