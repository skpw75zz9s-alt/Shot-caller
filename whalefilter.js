// The Whale filter on the server (v13.82; the math: public/whales.js). Fed every USD exchange trade (the Round scan's
// onTrade), it samples the price every 5 seconds (the last 2 hours: the typical minute's move), opens a case for every
// whale, grades it a minute later, and keeps the graded cases (the last 5,000 per market, in DATA_DIR/whales.json) and
// each group's record. api(): { minUsd, groups, recent (the last 20, newest first, each with what was expected of it),
// pressure (the likely movers' dollars in the last 15 minutes) }; verdict(trade): what to expect of a whale right now.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WHALE, grade, groupStats, predict, sigmaOf } from './public/whales.js';

const MAX_CASES = 5000, RING_MS = 2 * 3600000, SAMPLE_MS = 5000;
export function createWhaleFilter({ file, clock = () => Date.now(), minUsd = Number(process.env.WHALE_FILTER_MIN) || WHALE.minUsd, log = console } = {}) {
  let cases = [], groups = {}, open = [], ring = [], last = null, saveTimer = null;
  async function load() {
    try { const d = JSON.parse(await readFile(file, 'utf8')); cases = (d.cases || []).slice(-MAX_CASES); groups = groupStats(cases); } catch { /* first run */ }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify({ cases })); await rename(`${file}.tmp`, file); } catch (e) { log.error?.('saving the whale filter failed', e.message); }
    }, 5000);
    saveTimer.unref?.();
  }
  // the price a horizon after t: the first sample at or after it
  const priceAt = (t) => ring.find((s) => s.t >= t)?.p ?? null;
  function gradeDue(now) {
    let graded = 0;
    // graded once a price sample past its minute exists; a case the feed never got past in 5 minutes is dropped
    while (open.length && ((ring.length && ring.at(-1).t >= open[0].t + WHALE.horizonMs) || now - open[0].t > WHALE.horizonMs + 5 * 60000)) {
      const c = open.shift(), p1 = priceAt(c.t + WHALE.horizonMs), sigma = sigmaOf(ring);
      if (!(p1 > 0) || !(sigma > 0)) continue; // no price after it, or not enough history yet: dropped, never guessed
      cases.push(grade(c, p1, sigma)); graded++;
    }
    if (graded) { if (cases.length > MAX_CASES) cases.splice(0, cases.length - MAX_CASES); groups = groupStats(cases); save(); }
  }
  // each trade: { ex, price, size, side, t }
  function add(x, now = clock()) {
    if (!(x?.price > 0) || !(x.size > 0)) return;
    last = x.price;
    if (!ring.length || now - ring.at(-1).t >= SAMPLE_MS) { ring.push({ t: now, p: last }); while (ring.length && ring[0].t < now - RING_MS) ring.shift(); }
    gradeDue(now);
    const usd = x.price * x.size;
    if (usd < minUsd) return;
    // a sweep: another whale the same way within 30 seconds (both are marked)
    const mate = open.filter((c) => c.side === x.side && now - c.t <= WHALE.sweepMs);
    for (const m of mate) m.sweep = true;
    const c = { t: now, ex: x.ex, side: x.side, usd: Math.round(usd), p0: x.price, sweep: mate.length > 0 };
    c.expected = predict(c, groups).label;
    open.push(c);
  }
  function api() {
    const now = clock();
    gradeDue(now);
    const recent = [...open.slice().reverse(), ...cases.slice(-20).reverse()].slice(0, 20).map((c) => ({ t: c.t, ex: c.ex, side: c.side, usd: c.usd, sweep: !!c.sweep, expected: c.expected ?? null, out: c.out ?? null, z: c.z ?? null }));
    const fresh = [...open, ...cases].filter((c) => c.t > now - 15 * 60000 && predict(c, groups).label === 'likely mover');
    return { minUsd, horizonMs: WHALE.horizonMs, groups, recent, pressure: { n: fresh.length, buy: fresh.filter((c) => c.side === 'buy').reduce((a, c) => a + c.usd, 0), sell: fresh.filter((c) => c.side === 'sell').reduce((a, c) => a + c.usd, 0) }, graded: cases.length, at: now };
  }
  return { load, add, api, verdict: (x) => predict({ ex: x.ex, side: x.side, usd: x.price * x.size, sweep: open.some((c) => c.side === x.side && clock() - c.t <= WHALE.sweepMs) }, groups) };
}
