// Screenshot check of the related-markets card (mock market) on Bitcoin and Ethereum
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, stop, errs, url } = await start();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(25000);
const el = await page.$('#crossCard'); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
await el.screenshot({ path: `${OUT}/cross-btc.png` });
const txt = await page.evaluate(() => ({ title: document.getElementById('crossTitle').textContent, rows: document.querySelectorAll('#crossList li').length, model: document.getElementById('crossModel').textContent.slice(0, 120) }));
console.log(JSON.stringify({ errs, txt }));
await stop();
