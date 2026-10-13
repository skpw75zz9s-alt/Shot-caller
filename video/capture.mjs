// Real-app screenshots for the tutorial (sample market data from mock.mjs), plus each highlight's box
import { start } from './lib.mjs';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const PHASE = process.argv[2] || 'app';
const boxes = existsSync('shots/boxes.json') ? JSON.parse(readFileSync('shots/boxes.json', 'utf8')) : {};
const { page, set, stop, errs, url } = await start({ paywall: PHASE === 'site' });
const wait = (ms) => page.waitForTimeout(ms);
async function shot(name, scrollSel, hl = [], offset = 120) {
  await page.evaluate(([sel, off]) => { if (!sel) { window.scrollTo(0, 0); return; } const el = document.querySelector(sel); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off); }, [scrollSel, offset]);
  await wait(700);
  await page.screenshot({ path: `shots/${name}.jpg`, type: 'jpeg', quality: 80 });
  boxes[name] = await page.evaluate((sels) => Object.fromEntries(sels.map((s) => { const el = document.querySelector(s); if (!el || el.hidden) return [s, null]; const r = el.getBoundingClientRect(); return [s, r.width ? [r.left * 3, r.top * 3, r.width * 3, r.height * 3] : null]; })), hl);
  console.log('shot', name, JSON.stringify(boxes[name]));
}
const tab = async (v) => { await page.click(`nav [data-view="${v}"], [data-view="${v}"]`); await wait(2500); };
if (PHASE === 'site') {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await wait(3000);
  await shot('site-hero', null, ['.hero h1', '.ctas .btn.primary']);
  await shot('site-record', '#record', ['.stats', '#rNote'], 80);
  await shot('site-install', '#install', ['.install'], 80);
  await page.goto(url + 'paywall.html', { waitUntil: 'domcontentloaded' }); await wait(2500);
  await shot('paywall', null, ['#buy', 'details']);
} else if (PHASE === 'buy') {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await wait(8000);
  await set({ yb: 84, ya: 85 });
  for (let i = 0; i < 14; i++) { await wait(6000); if ((await page.textContent('#call')) !== 'SIT OUT') break; }
  await wait(2000);
  await shot('deck-call-2', '#order', ['#order', '#boughtBtn'], 420);
} else if (PHASE === 'loss') {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await wait(5000);
  await tab('settings');
  await page.evaluate(() => { for (const d of document.querySelectorAll('#view-settings details')) d.open = true; });
  await wait(800);
  await shot('settings-loss', 'input[name="dailyLossLimit"]', ['input[name="dailyLossLimit"]'], 380);
} else {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await wait(16000);
  await shot('deck-top', null, ['#ticker', '#callCard']);
  await shot('deck-sitout', '#callCard', ['#call', '#reason', '#callLabel']);
  await set({ yb: 84, ya: 85 });
  for (let i = 0; i < 12; i++) { await wait(6000); if ((await page.textContent('#call')) !== 'SIT OUT') break; }
  await wait(3000);
  await shot('deck-call', '#callCard', ['#call', '#callLabel', '#callSub', '#conf']);
  await shot('deck-call-2', '#entry', ['#entry', '#boughtBtn', '#odds'], 300);
  await page.click('#boughtBtn'); await wait(2500);
  await shot('bought', '#positions', ['#positions'], 140);
  await set({ lead: -70 });
  await wait(26000);
  await shot('bail', '#positions', ['#positions', '#callCard'], 140);
  await shot('bail-card', '#callCard', ['#callLabel', '#reason']);
  await set({ lead: 250 });
  await tab('chart'); await wait(3000);
  await shot('chart', null, ['#tvMain']);
  await shot('radar', '.card.radar', ['#radarScope', '#radarCalls'], 90);
  await tab('alerts');
  await shot('alerts', null, ['.alerts-card']);
  await tab('history');
  await shot('record', '#accList', ['#accList'], 200);
  await tab('settings');
  await shot('settings-risk', '#riskBtns', ['#riskBtns'], 300);
  await shot('settings-push', '#pushStatus', ['#pushOn', '#pushStatus'], 260);
  await page.evaluate(() => { for (const d of document.querySelectorAll('#view-settings details')) d.open = true; document.querySelector('#settingsForm')?.closest('details')?.setAttribute('open', ''); });
  await wait(800);
  await shot('settings-loss', 'input[name="dailyLossLimit"]', ['input[name="dailyLossLimit"]'], 380);
}
writeFileSync('shots/boxes.json', JSON.stringify(boxes, null, 1));
console.log('errors', errs.slice(0, 3));
await stop();
