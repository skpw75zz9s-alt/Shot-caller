// Screens for the v13.45 update video (video/ad3.html): the real app against sample market data (mock.mjs + sample API
// replies), never real prices
import { start } from './lib.mjs';
import { tuneIndicators } from '../public/tune.js';
const OUT = 'ad3';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));
// a sample 3-week walk so the indicator table (and the signal board) has rows; one family shown as proven
let s = 7; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; const bars = []; let p = 100000;
for (let i = 0; i < 30240; i++) { const o = p; p *= Math.exp(0.0008 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())); bars.push({ t: Date.UTC(2026, 9, 1) + i * 60000, o, h: Math.max(o, p) * 1.0002, l: Math.min(o, p) * 0.9998, c: p, v: 1 + r() }); }
const report = { ...tuneIndicators(bars), bars: bars.length, ranAt: Date.now() };
for (const f of report.families) delete f.sig;
report.families[0].proven = true;

const { page, ctx, stop, errs, url, set } = await start();
await page.route(/\/api\/tune/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ report, read: { drift: 0.2, active: [{ setting: report.families[0].setting, push: 0.3 }] }, inCalls: null }) }));
await page.route(/\/api\/discord\/status/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ on: true, member: true, linked: { name: 'Trader Joe', role: true, error: null, syncedAt: Date.now() } }) }));
await ctx.addInitScript(() => { localStorage.setItem('nudgeDismissed', 'true'); localStorage.setItem('pushNudgeX', 'true'); });
await set({ yb: 55, ya: 60 });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const toEl = async (sel, off = 70) => { await page.evaluate(([q, o]) => { const el = document.querySelector(q); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }, [sel, off]); await page.waitForTimeout(700); };
const open = async (wait = 12000) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(wait); await page.addStyleTag({ content: '.toast{display:none!important}' }); };
await open();
// the locked round call, and the line under it
await toEl('.call-card', 150); await page.waitForTimeout(1500); await shot('deck-locked');
await toEl('#lineCard', 90); await shot('line');
await toEl('#boardCard', 90); await page.click('.sb-fold summary').catch(() => {}); await page.waitForTimeout(500); await shot('board');
// the chart with its patterns, then the patterns card
await page.click('nav button[data-view="chart"]'); await page.waitForTimeout(2500);
await page.click('#tfBtns button:nth-child(2)').catch(() => {}); await page.waitForTimeout(3000);
await toEl('.chart-pro', 60); await shot('chart-patterns');
await toEl('#cpCard', 90); await shot('patterns-card');
// Discord role in Settings
await page.click('nav button[data-view="settings"]'); await page.waitForTimeout(2000);
await toEl('.access-card', 90); await shot('discord');
// Simple mode
await page.evaluate(() => localStorage.setItem('simpleMode', 'true'));
await open(9000); await shot('simple');
// DOGE at its own precision
await page.evaluate(() => { localStorage.setItem('simpleMode', 'false'); const st = JSON.parse(localStorage.getItem('settings') || '{}'); st.series = 'KXDOGE15M'; localStorage.setItem('settings', JSON.stringify(st)); });
await open(12000); await toEl('.call-card', 150); await shot('doge');
console.log(JSON.stringify({ errs }));
await stop();
