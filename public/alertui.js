// Alert center in the browser: banners (one at a time), tones (Web Audio, no sound files), the Alerts tab and
// its history. The rules live in alerts.js.
import { ALERT_DEFAULTS, ALERT_EVENTS, ALERT_GROUPS, TONES, alertPrefs, routeAlert } from './alerts.js';

const KIND = { win: 'good', whaleBuy: 'good', feedUp: 'good', loss: 'bad', whaleSell: 'bad', feedDown: 'bad', flip: 'warn', fliprisk: 'warn', sell: 'warn', cross: 'warn', pressure: 'warn' };

export function createAlertCenter({ $, store, esc, clock, onNote }) {
  let prefs = alertPrefs(store.get('alertPrefs', {}));
  const log = { last: {}, history: store.get('alertHistory', []) };
  let audio = null;
  const queue = [];
  let showing = false;

  const save = () => store.set('alertPrefs', prefs);
  function unlock() {
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch { audio = null; }
    return !!audio;
  }
  function play(key) {
    if (!audio || audio.state !== 'running') return;
    const vol = Math.max(0, Math.min(1, prefs.volume / 100)) * 0.3;
    let t = audio.currentTime + 0.02;
    for (const [f, ms] of TONES[key] || [[660, 120]]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
      t += ms / 1000 + 0.04;
    }
  }
  function banner(key, title, text) {
    queue.push({ key, title, text });
    if (!showing) next();
  }
  function next() {
    const b = queue.shift();
    if (!b) { showing = false; $('banner').hidden = true; return; }
    showing = true;
    $('banner').className = `banner ${KIND[b.key] || ''}`;
    $('bannerTitle').textContent = b.title; $('bannerText').textContent = b.text || '';
    $('banner').hidden = false;
    setTimeout(next, Math.max(1, prefs.bannerSec) * 1000);
  }

  // Fire an event: history always, then sound and/or banner if allowed. dedupe narrows the cooldown key.
  function event(key, title, text = '', dedupe = key, now = Date.now()) {
    const r = routeAlert(prefs, log, key, `${title}${text ? ` · ${text}` : ''}`, now, dedupe);
    store.set('alertHistory', log.history.slice(0, 60));
    if (r.sound) play(key);
    if (r.visual) banner(key, title, text);
    onNote?.(key, title, text);
    renderHistory();
  }

  function renderHistory() {
    const el = $('alertHistory');
    if (!el) return;
    el.innerHTML = log.history.slice(0, 40).map((h) => `<li class="${KIND[h.key] || (h.key === 'call' ? 'call' : '')}"><time>${clock(h.t)}</time><span>${esc(h.text)}</span></li>`).join('') ||
      '<li><time></time><span class="muted">Nothing yet. Alerts appear here as they happen.</span></li>';
  }

  function render() {
    $('alSounds').checked = prefs.sounds; $('alVisuals').checked = prefs.visuals; $('alQuiet').checked = prefs.quiet;
    $('alVolume').value = prefs.volume; $('alBanner').value = prefs.bannerSec; $('alCooldown').value = prefs.cooldownSec;
    $('alWhale').value = prefs.whaleMin; $('alFlip').value = prefs.flipRisk;
    $('alUnlock').textContent = audio?.state === 'running' ? 'Sound is on for this visit ✓' : 'Tap to enable sound on this phone';
    $('alertGroups').innerHTML = ALERT_GROUPS.map((g) => `<div class="card ev-card"><h3>${esc(g.title)}</h3>${g.events.map(([k]) => {
      const e = prefs.events[k];
      return `<div class="ev-row"><span>${esc(ALERT_EVENTS[k].label)}</span><label><input type="checkbox" data-ev="${k}" data-f="sound" ${e.sound ? 'checked' : ''}>Sound</label><label><input type="checkbox" data-ev="${k}" data-f="visual" ${e.visual ? 'checked' : ''}>Banner</label><button data-preview="${k}">Preview</button></div>`;
    }).join('')}</div>`).join('');
    renderHistory();
  }

  // ---------- controls ----------
  const num = (id, key, min, max) => $(id).addEventListener('change', () => { const n = Number($(id).value); if (Number.isFinite(n)) { prefs[key] = Math.min(max, Math.max(min, n)); save(); } render(); });
  num('alVolume', 'volume', 0, 100); num('alBanner', 'bannerSec', 1, 30); num('alCooldown', 'cooldownSec', 0, 3600); num('alWhale', 'whaleMin', 1000, 1e8); num('alFlip', 'flipRisk', 1, 99);
  $('alSounds').addEventListener('change', () => { prefs.sounds = $('alSounds').checked; if (prefs.sounds) unlock(); save(); render(); });
  $('alVisuals').addEventListener('change', () => { prefs.visuals = $('alVisuals').checked; save(); });
  // Quiet mode keeps your switches as they are and only mutes; turning it off restores everything
  $('alQuiet').addEventListener('change', () => { prefs.quiet = $('alQuiet').checked; save(); });
  $('alUnlock').addEventListener('click', () => { if (unlock()) { prefs.sounds = true; save(); play('call'); } render(); });
  $('alReset').addEventListener('click', () => { if (confirm('Reset all alert settings?')) { prefs = alertPrefs({}); save(); render(); } });
  $('alClear').addEventListener('click', () => { log.history = []; store.set('alertHistory', []); renderHistory(); });
  $('alertGroups').addEventListener('change', (e) => {
    const k = e.target.dataset.ev, f = e.target.dataset.f;
    if (!k) return;
    prefs.events[k] = { ...prefs.events[k], [f]: e.target.checked };
    save();
  });
  // Preview shows the banner and plays the tone even when that event's switches are off
  $('alertGroups').addEventListener('click', (e) => {
    const k = e.target.dataset.preview;
    if (!k) return;
    unlock(); play(k); banner(k, `Preview: ${ALERT_EVENTS[k].label}`, 'This is how it will look.');
  });
  // Any first tap unlocks audio if sounds are on (phones need a gesture)
  document.addEventListener('click', () => { if (prefs.sounds && !audio) unlock(); }, { once: true });

  return { event, render, prefs: () => prefs, defaults: ALERT_DEFAULTS };
}
