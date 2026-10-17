// Screens for the v13.39 ad (video/ad2.html): the real app against sample market data (mock.mjs + sample API replies), never real prices
import { start } from './lib.mjs';
import { tuneIndicators } from '../public/tune.js';
import { patternStats, rangeLadder } from '../public/lessons.js';
const OUT = 'ad2';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));
// a sample 3-week walk for the tested-notes card
let s = 7; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; const bars = []; let p = 100000;
for (let i = 0; i < 30240; i++) { const o = p; p *= Math.exp(0.0008 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())); bars.push({ t: Date.UTC(2026, 9, 1) + i * 60000, o, h: Math.max(o, p) * 1.0002, l: Math.min(o, p) * 0.9998, c: p, v: 1 + r() }); }
const report = { ...tuneIndicators(bars), lessons: { ladder: rangeLadder(bars), patterns: patternStats(bars) }, bars: bars.length, ranAt: Date.now() };
for (const f of report.families) delete f.sig;
const now = Date.now(), H = 3600000;
const losses = [
  { kind: 'round call', ticker: 'KXBTC15M-26OCT171445-45', side: 'YES', p: 0.71, at: now - 0.6 * H, review: { causes: [{ key: 'lateTurn', label: 'Late turn' }, { key: 'market', label: 'Kalshi disagreed' }], summary: 'Late turn: it was winning by 1.4 typical moves and turned in the last 2 minutes; Kalshi disagreed: Kalshi priced the side at 46%' } },
  { kind: 'official call', ticker: 'KXBTC15M-26OCT171230-30', side: 'NO', conf: 92, at: now - 2.4 * H, review: { causes: [{ key: 'spike', label: 'Volatility spike' }], summary: 'Volatility spike: price moved 2.3× faster than the bot expected' } },
  { kind: 'round call', ticker: 'KXBTC15M-26OCT171015-15', side: 'NO', p: 0.58, at: now - 4.7 * H, review: { causes: [{ key: 'tooClose', label: 'Too close to call' }], summary: 'Too close to call: price was only 0.14 typical moves from the target when it was called' } },
];
const lessonRows = (mode) => [['marketAgainst', 'Kalshi disagreed', 'Kalshi priced the side under 45%', 64, 0.36, 3.1, true], ['jumpy', 'Jumpy market', 'volatility 40%+ over its 2-hour norm', 88, 0.47, 0.7, false], ['flowAgainst', 'Sellers against it', 'the exchanges\' buyers and sellers leaned 25+ the other way', 51, 0.43, 1.0, false]]
  .map(([id, label, why, n, rate, z, proven]) => ({ id, label, why, n, wins: Math.round(n * rate), rate, need: mode === 'flip' ? 0.5 : 0.88, z, proven: mode === 'flip' && proven }));
const lab = { pick: { mode: 'flip', n: 612, lessons: lessonRows('flip'), active: ['marketAgainst'] }, official: { mode: 'skip', n: 140, lessons: lessonRows('skip'), active: [] }, losses, tally: [{ key: 'lateTurn', label: 'Late turn', n: 9 }, { key: 'market', label: 'Kalshi disagreed', n: 7 }, { key: 'spike', label: 'Volatility spike', n: 5 }], reviewed: 31 };

const { page, ctx, stop, errs, url, set } = await start();
await page.route(/\/api\/tune/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ report, read: { drift: 0, active: [] }, inCalls: null }) }));
await page.route(/\/api\/lessons/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify(lab) }));
await page.route(/\/api\/flip/, async (rt) => {
  const live = { ticker: 'KXBTC15M-26OCT131715-15', lead: 'YES', minutesLeft: 9, base: 0.09, p: 0.14, used: true, pLose: { YES: 0.14, NO: 0.86 }, parts: [{ name: 'Momentum against it', push: 0.31 }, { name: 'Candle flow (buyers vs sellers)', push: 0.22 }, { name: 'Absorption', push: -0.12 }] };
  rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ chart: { proven: true, nTest: 2013, z: 3.2 }, flow: { proven: false, nTest: 140, z: 1.1 }, live, inCalls: null, need: { chart: 600, flow: 200, z: 2.5 } }) });
});
await ctx.addInitScript(() => { localStorage.setItem('nudgeDismissed', 'true'); localStorage.setItem('pushNudgeX', 'true'); });
await set({ yb: 55, ya: 60 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
await page.addStyleTag({ content: '.toast{display:none!important}' });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const toEl = async (sel, off = 70) => { await page.evaluate(([q, o]) => { const el = document.querySelector(q); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }, [sel, off]); await page.waitForTimeout(600); };
await toEl('.call-card', 150); await page.waitForTimeout(2500); await shot('deck-round');
await toEl('#holdBox', 300); await shot('deck-flip');
await page.click('nav button[data-view=history]'); await page.waitForTimeout(2500);
await toEl('#labCard'); await shot('losslab');
await page.click('nav button[data-view=learn]'); await page.waitForTimeout(2000);
await toEl('#lessonsCard'); await shot('lessons');
await page.click('nav button[data-view=live]'); await page.waitForTimeout(1000);
await toEl('#crossCard'); await shot('cross');
// gold: the why-it's-moving card (mock Yahoo data)
await page.evaluate(() => { const st = JSON.parse(localStorage.getItem('settings') || '{}'); st.series = 'KXGOLD15M'; localStorage.setItem('settings', JSON.stringify(st)); });
await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(14000);
await page.addStyleTag({ content: '.toast{display:none!important}' });
await toEl('#drvCard'); await shot('drv-gold');
console.log(JSON.stringify({ errs }));
await stop();
