// Screens for the v13.77 update video (video/ad5.html): the real app and the admin's live window against sample market
// data (mock.mjs, its stand-in news), never real prices. Needs ADMIN_CODE set to a throwaway code for this run.
import { start, APP } from './lib.mjs';
const OUT = 'ad5';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));
const { page, ctx, stop, errs, url, set } = await start();
const wait = (ms) => page.waitForTimeout(ms);
await ctx.addInitScript(() => { localStorage.setItem('nudgeDismissed', 'true'); localStorage.setItem('pushNudgeX', 'true'); });
await page.request.post(`${url}api/access/admin`, { data: { code: process.env.ADMIN_CODE, device: 'ad5' } });
const shot = (name, el) => (el ? page.locator(el).screenshot({ path: `${OUT}/${name}.png` }) : page.screenshot({ path: `${OUT}/${name}.png` }));
const toEl = async (p, sel, off = 70) => { await p.evaluate(([q, o]) => { const el = document.querySelector(q); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }, [sel, off]); await p.waitForTimeout(700); };

// the phone: the Auto-trader on this phone (Test), and the hiring center's applications
await page.goto(url, { waitUntil: 'domcontentloaded' }); await wait(9000);
await page.addStyleTag({ content: '.toast{display:none!important}' });
await page.evaluate(() => document.querySelector('[data-view="settings"]')?.click()); await wait(1500);
await page.click('#hireSearch'); await wait(1800);
await toEl(page, '#hireApps', 140); await shot('phone-hiring');
await page.click('#atWhere [data-where="phone"]'); await wait(600);
await page.click('#atModes [data-mode="test"]'); await wait(6000);
await toEl(page, '#atCard', 20); await shot('phone-trader');
await page.click('#atModes [data-mode="off"]'); await wait(600);
// approve the Restart watcher so the office shows a new hire on probation, with its trainer
const apps = await page.evaluate(() => [...document.querySelectorAll('button[data-decision="approve"]')].map((b) => b.dataset.hire));
const restarts = apps.find((a) => a.startsWith('restarts'));
if (restarts) await page.request.post(`${url}api/admin/hiring`, { data: { id: restarts, decision: 'approve' } });

// the live window on a desktop, after Kalshi's quote moves so the team has something to talk about
const desk = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await desk.addCookies((await ctx.cookies()).map((c) => ({ ...c })));
const d = await desk.newPage();
await d.goto(`${url}team-live`); await d.waitForTimeout(14000);
await set({ yb: 30, ya: 33 }); await d.waitForTimeout(7000);
await d.evaluate(() => window.scrollTo(0, 0)); await d.waitForTimeout(600);
await d.screenshot({ path: `${OUT}/office-top.png` });
await toEl(d, '[data-floor="f1"]', 20); await d.waitForTimeout(1500); await d.screenshot({ path: `${OUT}/office-ground.png` });
await toEl(d, '[data-floor="f2"]', 20); await d.waitForTimeout(1500); await d.screenshot({ path: `${OUT}/office-lab.png` });
await d.locator('[data-dept="train"]').screenshot({ path: `${OUT}/training.png` });
await toEl(d, '#chat', 60); await d.waitForTimeout(4000);
await d.locator('#chat').evaluate((el) => { el.style.maxHeight = 'none'; });
await d.locator('.bottom .panel:first-child').screenshot({ path: `${OUT}/chat.png` });
await d.locator('#news').evaluate((el) => el.closest('.panel').scrollIntoView());
await d.locator('#news').evaluate((el) => el.closest('.panel').id = 'newsPanel');
await d.locator('#newsPanel').screenshot({ path: `${OUT}/news.png` });
await d.locator('#mgr').screenshot({ path: `${OUT}/manager.png` });
console.log(JSON.stringify({ errs, restarts: !!restarts }));
await desk.close();
await stop();
