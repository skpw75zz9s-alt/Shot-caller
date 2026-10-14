// Screenshot of the Map to success tab against the mock market, with sample trades seeded (scratch check)
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, ctx, stop, errs, url } = await start();
const now = Date.now(), H = 3600000;
const trades = Array.from({ length: 18 }, (_, i) => {
  const won = ![1, 5, 9, 14].includes(i), price = [0.72, 0.81, 0.66, 0.78, 0.93, 0.7][i % 6], contracts = i < 2 ? 10 : 6;
  const closedAt = now - (i < 3 ? i * 0.4 * H : (i - 2) * 9 * H);
  return { ticker: 'KXBTC15M-SAMPLE', side: i % 3 ? 'YES' : 'NO', price, contracts, at: closedAt - 600000, closedAt, how: 'settled', exit: won ? 1 : 0, pnl: won ? (1 - price) * contracts - 0.1 : -price * contracts - 0.1 };
});
await ctx.addInitScript((t) => { if (!localStorage.getItem('trades')) localStorage.setItem('trades', JSON.stringify(t)); }, trades);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.click('nav button[data-view=success]');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/map-top.png` });
await page.screenshot({ path: `${OUT}/map-full.png`, fullPage: true });
await (await page.$('nav')).screenshot({ path: `${OUT}/nav.png` });
const cs = await page.$eval('nav button[data-view=settings]', (b) => { const c = getComputedStyle(b); return [c.fontSize, c.letterSpacing, c.textTransform, c.fontFamily]; });
console.log(JSON.stringify(cs));
const nav = await page.$eval('nav', (n) => [...n.querySelectorAll('button')].map((b) => [b.textContent.trim(), b.scrollWidth, b.clientWidth]));
console.log(JSON.stringify({ errs, nav }));
await stop();
