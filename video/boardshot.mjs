// Screenshot check of v13.42: the Deck in Simple mode, the signal board in Pro, and the Discord row in Settings
// (mock market; a synthetic tune report so the board has proven and probation rows; Discord's status faked)
import { start } from './lib.mjs';
import { tuneIndicators } from '../public/tune.js';
const OUT = process.argv[2] || '.';
let s = 7; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; const bars = []; let p = 100000;
for (let i = 0; i < 30240; i++) { const o = p; p *= Math.exp(0.0008 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())); bars.push({ t: Date.UTC(2026, 9, 1) + i * 60000, o, h: Math.max(o, p) * 1.0002, l: Math.min(o, p) * 0.9998, c: p, v: 1 + r() }); }
const report = { ...tuneIndicators(bars), bars: bars.length, ranAt: Date.now() };
for (const f of report.families) delete f.sig;
report.families[0].proven = true; // one proven family, so the board shows a row in the calls
const { page, stop, errs, url } = await start();
await page.route(/\/api\/tune/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ report, read: { drift: 0.2, active: [{ setting: report.families[0].setting, push: 0.3 }] }, inCalls: null }) }));
await page.route(/\/api\/discord\/status/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ on: true, member: true, linked: { name: 'Trader Joe', role: true, error: null, syncedAt: Date.now() } }) }));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !/Loading/.test(document.getElementById("marketTitle")?.textContent || ""), null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(4000);
await page.click('#modeBtn'); await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/simple.png`, fullPage: true });
const navSimple = await page.$$eval('nav button', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.dataset.view));
await page.click('#modeBtn'); await page.waitForTimeout(1500);
await page.click('.sb-fold summary').catch(() => {}); await page.waitForTimeout(800); await page.addStyleTag({ content: '.toast{display:none!important}' });
await (await page.$('#boardCard')).screenshot({ path: `${OUT}/board.png` });
await page.click('nav button[data-view="settings"]'); await page.waitForTimeout(1500);
await (await page.$('.access-card')).screenshot({ path: `${OUT}/discord.png` });
console.log(JSON.stringify({ errs, navSimple }));
await stop();
