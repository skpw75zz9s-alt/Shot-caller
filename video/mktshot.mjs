// Screenshot check of the market picker: the app on Bitcoin, then switched to Ethereum through the header picker (mock market)
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, stop, errs, url } = await start();
const reqs = []; page.on('request', (r) => { if (/api\/coinbase/.test(r.url())) reqs.push(r.url().replace(/^.*api\/coinbase\//, '')); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const opts = await page.$$eval('#mktPick option', (os) => os.map((o) => [o.value, o.textContent, o.disabled]));
await page.screenshot({ path: `${OUT}/mkt-btc.png`, clip: { x: 0, y: 0, width: 390, height: 700 } });
await page.selectOption('#mktPick', 'KXETH15M');
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(7000);
const eth = await page.evaluate(() => ({ price: document.getElementById('livePrice')?.textContent, pick: document.getElementById('mktPick')?.value, alt: document.body.classList.contains('alt-market'),
  hidden: ['pickCard', 'watchCard', 'scanCard', 'guideCard'].map((id) => getComputedStyle(document.getElementById(id)).display), note: document.getElementById('altNote')?.textContent?.slice(0, 60),
  logs: Object.keys(localStorage).filter((k) => /:ETH$/.test(k)) }));
await page.screenshot({ path: `${OUT}/mkt-eth.png`, clip: { x: 0, y: 0, width: 390, height: 900 } });
console.log(JSON.stringify({ errs, opts, eth, coinbase: [...new Set(reqs.map((r) => r.split('/')[1]))] }, null, 1));
await stop();
