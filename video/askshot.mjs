// Screenshot check of v13.47: the Ask sheet, a built-in answer (no AI key), then an AI answer (stubbed reply)
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, stop, errs, url } = await start();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !/Loading/.test(document.getElementById('marketTitle')?.textContent || ''), null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(5000);
await page.addStyleTag({ content: '.toast{display:none!important}' });
await page.click('#askBtn'); await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/ask-open.png` });
await page.click('#askChips button[data-q^="Should I buy"]'); await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/ask-builtin.png` });
const builtin = await page.$eval('#askLog', (e) => e.innerText);
// the AI path: the server's answer stubbed (no key in this sandbox)
let sent = null;
await page.route(/\/api\/ask$/, async (rt) => {
  if (rt.request().method() === 'GET') return rt.fulfill({ contentType: 'application/json', body: '{"ai":true,"model":"auto"}' });
  sent = JSON.parse(rt.request().postData());
  await new Promise((r) => setTimeout(r, 1500));
  rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ answer: 'UP is ahead by about $250 with the round call locked UP, but at 98 cents there is almost nothing left to win.\nThe lead is several times the move left, so a flip is unlikely, not impossible.' }) });
});
await page.evaluate(() => { document.getElementById('askClose').click(); });
await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
await page.addStyleTag({ content: '.toast{display:none!important}' });
await page.click('#askBtn'); await page.waitForTimeout(600);
await page.fill('#askInput', 'give me a deep dive'); await page.click('.ask-go'); await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/ask-thinking.png` });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/ask-ai.png` });
const ai = await page.$eval('#askLog', (e) => e.innerText);
console.log(JSON.stringify({ errs, builtin: builtin.slice(0, 900), ai: ai.slice(0, 400), sentKeys: sent && Object.keys(sent.facts), q: sent?.q, mode: await page.$eval('#askMode', (e) => e.textContent) }, null, 1));
await stop();
