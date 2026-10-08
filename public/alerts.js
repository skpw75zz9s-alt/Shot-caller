// Alert center: what can alert, whether it beeps and/or shows a banner, and the rules that keep it calm.
// Pure logic here (tested); app.js plays the sounds and shows the banners.
//   - only one banner at a time; routine events go to the alert history without a banner
//   - the same event can't repeat inside the cooldown
//   - quiet mode silences everything (history still records), and turning it off restores your choices

export const ALERT_GROUPS = [
  { title: 'Calls & results', events: [
    ['call', 'New call (locked for the round)', true, true],
    ['win', 'Call won at settlement', true, true],
    ['loss', 'Call lost at settlement', false, true],
    ['sitout', 'Round ended with no call (sat out)', false, false],
  ] },
  { title: 'Market warnings', events: [
    ['flip', 'Flip warning: the bot now leans against your call', true, true],
    ['fliprisk', 'High flip risk: hold odds fell below your threshold', false, true],
    ['cross', 'BTC crossed the target', false, true],
    ['pressure', 'Buy/sell pressure flipped', false, false],
  ] },
  { title: 'Whale trades', events: [
    ['whaleBuy', 'Whale buy', false, true],
    ['whaleSell', 'Whale sell', false, true],
  ] },
  { title: 'Your positions', events: [
    ['sell', 'Sell signal on a position', true, true],
  ] },
  { title: 'Feed health', events: [
    ['feedDown', 'Live data lost', true, true],
    ['feedUp', 'Live data back', false, true],
  ] },
];
export const ALERT_EVENTS = Object.fromEntries(ALERT_GROUPS.flatMap((g) => g.events.map(([key, label, sound, visual]) => [key, { label, sound, visual, group: g.title }])));

export const ALERT_DEFAULTS = {
  sounds: false,     // needs a tap to unlock audio on phones anyway
  visuals: true,
  quiet: false,
  volume: 35,        // %
  bannerSec: 4,
  cooldownSec: 30,
  whaleMin: 100000,  // dollars in one Coinbase trade
  flipRisk: 35,      // out of 100: flip risk (100 - hold odds) above this, held 10s, is "high"
  events: Object.fromEntries(Object.entries(ALERT_EVENTS).map(([k, e]) => [k, { sound: e.sound, visual: e.visual }])),
};

export function alertPrefs(saved = {}) {
  const p = { ...ALERT_DEFAULTS, ...saved, events: { ...ALERT_DEFAULTS.events } };
  for (const [k, v] of Object.entries(saved.events || {})) if (p.events[k]) p.events[k] = { ...p.events[k], ...v };
  return p;
}

// Decide what one event does. Mutates `log` ({ last: { key: t }, history: [] }).
// Returns { sound, visual } (either may be false); the event is always added to the history.
export function routeAlert(prefs, log, key, text, now = Date.now(), dedupe = key) {
  log.last ||= {}; log.history ||= [];
  const ev = prefs.events[key];
  if (!ev) return { sound: false, visual: false };
  log.history.unshift({ t: now, key, text });
  if (log.history.length > 60) log.history.length = 60;
  if (prefs.quiet) return { sound: false, visual: false };
  if (log.last[dedupe] != null && now - log.last[dedupe] < prefs.cooldownSec * 1000) return { sound: false, visual: false };
  log.last[dedupe] = now;
  return { sound: prefs.sounds && ev.sound, visual: prefs.visuals && ev.visual };
}

// A condition that must hold for `ms` before it counts (flip warnings, high flip risk): returns true once, when it
// has held long enough; resets when the condition goes away.
export function sustained(state, key, on, now = Date.now(), ms = 10000) {
  state[key] ||= { since: null, fired: false };
  const s = state[key];
  if (!on) { s.since = null; s.fired = false; return false; }
  if (s.since == null) s.since = now;
  if (!s.fired && now - s.since >= ms) { s.fired = true; return true; }
  return false;
}

// Tone patterns per event: [frequency Hz, duration ms] notes; rising for good news, falling for bad
export const TONES = {
  call: [[660, 90], [880, 140]], win: [[523, 90], [659, 90], [784, 160]], loss: [[392, 140], [311, 200]], sitout: [[440, 80]],
  flip: [[880, 90], [660, 90], [880, 90]], fliprisk: [[600, 120], [600, 120]], cross: [[740, 100]], pressure: [[500, 80], [700, 80]],
  whaleBuy: [[300, 70], [450, 120]], whaleSell: [[450, 70], [300, 120]], sell: [[988, 100], [988, 100], [784, 160]],
  feedDown: [[330, 250]], feedUp: [[523, 80], [659, 120]],
};
