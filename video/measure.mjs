// How jumpy is the Chart tab? 30 frames a second apart against the sample market; the price axis strip's change
import { start } from './lib.mjs';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const { page, set, stop, url } = await start();
await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(8000);
await set({ yb: 84, ya: 85 });
await page.click('nav [data-view="chart"]'); await page.waitForTimeout(20000);
const el = await page.$('#tvMain');
for (let i = 0; i < 30; i++) { await el.screenshot({ path: `${out}/f${String(i).padStart(2, '0')}.png` }); await page.waitForTimeout(1000); }
await page.click('nav [data-view="radar"]').catch(() => {}); await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/radar-tab.png` });
await stop();
