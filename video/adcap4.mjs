// Screens for the v13.59 update video (video/ad4.html): the real app against sample market data (mock.mjs + sample API
// replies), never real prices. Kalshi's sample quote is moved mid-round so the X-ray has breaks to find.
import { start } from './lib.mjs';
const OUT = 'ad4';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));
// sample money flows: all three on probation, with their unseen-day records so far
const flows = {
  etf: { on: true, read: { date: '2026-10-18', value: 412, lean: 1 }, test: { n: 140, dir: 1, test: { n: 42, hit: 0.57, z: 0.93 }, proven: false, need: 60, zNeed: 2.5 }, recent: [], err: null },
  stables: { on: true, read: { date: '2026-10-18', value: 0.84, lean: 1 }, test: { n: 400, dir: 1, test: { n: 120, hit: 0.53, z: 0.66 }, proven: false, need: 60, zNeed: 2.5 }, recent: [], err: null },
  whale: { on: true, read: { value: -2.4e7, n: 6, lean: 1 }, test: { n: 126, dir: 1, test: { n: 38, hit: 0.55, z: 0.62 }, proven: false, need: 100, zNeed: 2.5 }, recent: [], err: null },
  inCalls: null,
};
const { page, ctx, stop, errs, url, set } = await start();
await page.route(/\/api\/flows/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify(flows) }));
await page.route(/\/api\/xray/, (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ liqs: { n: 14, long: 3.1e6, short: 0.9e6, minutes: 30 }, futures: { funding: 0.000012, fundingYear: 0.105, oiChange5: 0.002, live: true }, at: Date.now() }) }));
await ctx.addInitScript(() => { localStorage.setItem('nudgeDismissed', 'true'); localStorage.setItem('pushNudgeX', 'true'); });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const toEl = async (sel, off = 70) => { await page.evaluate(([q, o]) => { const el = document.querySelector(q); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }, [sel, off]); await page.waitForTimeout(700); };
const open = async (wait = 12000) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(wait); await page.addStyleTag({ content: '.toast{display:none!important}' }); };
await open();

// the X-ray: open it on the calm round, then Kalshi's quote drops away from the bot's odds (a swing, a disagreement)
await page.click('nav button[data-view="xray"]'); await page.waitForTimeout(6000);
await set({ yb: 50, ya: 62 }); await page.waitForTimeout(9000);
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600); await shot('xray-film');
await toEl('#xrBreaks', 70); await shot('xray-breaks');
await toEl('#xrStats', 80); await page.waitForTimeout(2500); await shot('xray-stats');

// Ask the bot: a deep dive (the AI's reply stubbed: there's no key here)
await page.route(/\/api\/ask$/, async (rt) => {
  if (rt.request().method() === 'GET') return rt.fulfill({ contentType: 'application/json', body: '{"ai":true,"model":"auto"}' });
  await new Promise((r) => setTimeout(r, 800));
  rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ answer: 'UP is ahead by about $250, several times the move left, so the bot gives it 97%.\nKalshi only prices UP at 62 cents: that gap is wide, and Kalshi may know something the price doesn\'t show yet. Treat it with care, not as free money.' }) });
});
await set({ yb: 97, ya: 98 });
await open(9000);
await page.click('#askBtn'); await page.waitForTimeout(700);
await page.fill('#askInput', 'give me a deep dive'); await page.click('.ask-go'); await page.waitForTimeout(3500);
await shot('ask');
await page.evaluate(() => document.getElementById('askClose').click()); await page.waitForTimeout(500);

// the signal board's money flows, each on probation and saying why
await toEl('#boardCard', 90); await page.click('.sb-fold summary').catch(() => {}); await page.waitForTimeout(1200);
await page.evaluate(() => { const el = [...document.querySelectorAll('#boardCard *')].find((e) => e.children.length === 0 && /Spot-ETF flows/.test(e.textContent)); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 260); });
await page.waitForTimeout(800); await shot('flows');
console.log(JSON.stringify({ errs }));
await stop();
