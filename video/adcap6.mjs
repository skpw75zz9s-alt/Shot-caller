// Screens for the whole-bot ad (video/ad6.html): the real app and the admin's live window against sample market data
// (mock.mjs, its stand-in news), never real prices. Needs ADMIN_CODE set to a throwaway code for this run.
import { start } from './lib.mjs';
const OUT = 'ad6';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));
const { page, ctx, stop, errs, url, set } = await start();
const wait = (ms) => page.waitForTimeout(ms);
await ctx.addInitScript(() => { localStorage.setItem('nudgeDismissed', 'true'); localStorage.setItem('pushNudgeX', 'true'); });
await page.request.post(`${url}api/access/admin`, { data: { code: process.env.ADMIN_CODE, device: 'ad6' } });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const toEl = async (p, sel, off = 70) => { await p.evaluate(([q, o]) => { const el = document.querySelector(q); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }, [sel, off]); await p.waitForTimeout(800); };
const view = async (v, ms = 3500) => { await page.evaluate((x) => document.querySelector(`nav [data-view="${x}"]`)?.click(), v); await wait(ms); await page.evaluate(() => window.scrollTo(0, 0)); await wait(500); };
const open = async (ms = 12000) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); await wait(ms); await page.addStyleTag({ content: '.toast{display:none!important}' }); };

// the call: Kalshi's price lags the bot's odds, so the official call fires
await set({ yb: 78, ya: 80 });
await open(16000);
await shot('deck');
await toEl(page, '#teamCard', 70); await shot('deck-team');
// see it coming: the chart and the radar
await view('chart', 5000); await shot('chart');
await view('radar', 4000); await shot('radar');
// the X-ray: Kalshi's quote swings away from the bot's odds
await set({ yb: 50, ya: 62 });
await view('xray', 9000); await shot('xray');
await toEl(page, '#xrBreaks', 70); await shot('xray-breaks');
// the proof: the record and the strength meter
await view('history', 4000); await shot('record');
await toEl(page, '#strCard', 70); await shot('strength');
// ask anything (the free answers: no AI, no credits)
await set({ yb: 96, ya: 97 });
await open(9000);
await page.click('#askBtn').catch(() => {}); await wait(700);
await page.fill('#askInput', 'what is the best market right now?').catch(() => {}); await page.click('.ask-go').catch(() => {}); await wait(3500);
await shot('ask');
await page.evaluate(() => document.getElementById('askClose')?.click()); await wait(500);
// the auto-trader on this phone (Test)
await page.evaluate(() => document.querySelector('[data-view="settings"]')?.click()); await wait(1500);
await page.click('#atWhere [data-where="phone"]'); await wait(600);
await page.click('#atModes [data-mode="test"]'); await wait(5000);
await toEl(page, '#atCard', 20); await shot('trader');
await page.click('#atModes [data-mode="off"]'); await wait(600);

// the team, on a desktop
const desk = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await desk.addCookies(await ctx.cookies());
const d = await desk.newPage();
await d.goto(`${url}team-live`); await d.waitForTimeout(14000);
await set({ yb: 30, ya: 33 }); await d.waitForTimeout(7000);
await d.evaluate(() => window.scrollTo(0, 0)); await d.waitForTimeout(600);
await d.screenshot({ path: `${OUT}/office.png` });
await d.locator('.road').scrollIntoViewIfNeeded(); await d.waitForTimeout(1000);
await d.locator('.road').screenshot({ path: `${OUT}/road.png` });
console.log(JSON.stringify({ errs }));
await desk.close();
await stop();
