// Screenshot check of "Your notes, tested" on the Learn tab (mock market; the tune report from a synthetic 3-week walk)
import { start } from './lib.mjs';
import { tuneIndicators } from '../public/tune.js';
import { patternStats, rangeLadder } from '../public/lessons.js';
const OUT = process.argv[2] || '.';
let s = 7; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; const bars = []; let p = 100000;
for (let i = 0; i < 30240; i++) { const o = p; p *= Math.exp(0.0008 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())); bars.push({ t: Date.UTC(2026, 9, 1) + i * 60000, o, h: Math.max(o, p) * 1.0002, l: Math.min(o, p) * 0.9998, c: p, v: 1 + r() }); }
const report = { ...tuneIndicators(bars), lessons: { ladder: rangeLadder(bars), patterns: patternStats(bars) }, bars: bars.length, ranAt: Date.now() };
for (const f of report.families) delete f.sig;
const { page, stop, errs, url } = await start();
await page.route(/\/api\/tune/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ report, read: { drift: 0, active: [] }, inCalls: null }) }));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.click('nav button[data-view="learn"]'); await page.waitForTimeout(1500);
const el = await page.$('#lessonsCard');
await el.screenshot({ path: `${OUT}/lessons.png` });
console.log(JSON.stringify({ errs, n: report.families.length }));
await stop();
