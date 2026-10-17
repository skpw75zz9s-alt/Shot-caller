// Screenshot check: from 10:00 left, no buy shows the round call (never SIT OUT); the loss lab card on Record
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, stop, errs, url, set } = await start();
await set({ yb: 55, ya: 60 }); // Kalshi far less sure than the bot: no buy
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
const card = await page.$('.call-card');
await card.screenshot({ path: `${OUT}/roundcall.png` });
const deck = await page.evaluate(() => ({ call: document.getElementById('call')?.textContent, label: document.getElementById('callLabel')?.textContent, reason: document.getElementById('reason')?.textContent.slice(0, 200) }));
await page.click('nav button[data-view="history"]'); await page.waitForTimeout(2500);
const lab = await page.$('#labCard'); await lab.scrollIntoViewIfNeeded(); await lab.screenshot({ path: `${OUT}/losslab.png` });
console.log(JSON.stringify({ errs, deck }, null, 1));
await stop();
