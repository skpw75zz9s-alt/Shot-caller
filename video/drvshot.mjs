// Screenshot check of "Why it's moving" on gold and oil (mock Yahoo data)
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, stop, errs, url } = await start();
const out = {};
for (const [series, name] of [['KXGOLD15M', 'gold'], ['KXWTI15M', 'oil']]) {
  await page.addInitScript((s) => { const st = JSON.parse(localStorage.getItem('settings') || '{}'); st.series = s; localStorage.setItem('settings', JSON.stringify(st)); }, series);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(name === 'gold' ? 14000 : 8000);
  if (name === 'oil') { await page.click('#drvTabs button[data-w="240"]'); await page.waitForTimeout(2500); }
  const el = await page.$('#drvCard'); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
  const box = await page.$('#drvSvg svg');
  if (box) { const b = await box.boundingBox(); await page.mouse.move(b.x + b.width * 0.7, b.y + 40); await page.waitForTimeout(200); }
  await el.screenshot({ path: `${OUT}/drv-${name}.png` });
  out[name] = await page.evaluate(() => ({ vis: getComputedStyle(document.getElementById('drvCard')).display, say: document.getElementById('drvSay').textContent, rows: document.querySelectorAll('#drvParts .drv-row').length, fit: document.getElementById('drvFit').textContent, tip: !document.getElementById('drvTip').hidden, crossHidden: getComputedStyle(document.getElementById('scanCard')).display }));
}
console.log(JSON.stringify({ errs, out }, null, 1));
await stop();
