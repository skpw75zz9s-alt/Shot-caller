// Check: alerts arrive as notifications (none pop up over the app); without permission they count on the Alerts tab
import { start } from './lib.mjs';
const OUT = process.argv[2] || '.';
const { page, ctx, stop, errs, url } = await start();
await page.addInitScript(() => {
  window.__notes = [];
  const spy = function (title, o) { window.__notes.push([title, o?.body, o?.tag]); return Promise.resolve(); };
  ServiceWorkerRegistration.prototype.showNotification = spy;
  window.Notification = class { static permission = 'default'; static requestPermission() { window.Notification.permission = 'granted'; return Promise.resolve('granted'); } constructor(t, o) { spy(t, o); } };
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.click('nav button[data-view="alerts"]'); await page.waitForTimeout(500);
const before = await page.evaluate(() => ({ status: document.getElementById('alNotifyStatus').textContent, btn: !document.getElementById('alNotify').hidden, banner: !!document.getElementById('banner') }));
await page.click('#alertGroups button[data-preview]'); await page.waitForTimeout(300);
const noPerm = await page.evaluate(() => ({ notes: window.__notes.length, status: document.getElementById('alNotifyStatus').textContent }));
await page.click('#alNotify'); await page.waitForTimeout(500);
await page.click('#alertGroups button[data-preview]'); await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ notes: window.__notes, status: document.getElementById('alNotifyStatus').textContent, btn: !document.getElementById('alNotify').hidden }));
await page.screenshot({ path: `${OUT}/alerts-tab.png`, clip: { x: 0, y: 0, width: 390, height: 640 } });
console.log(JSON.stringify({ errs, before, noPerm, after }, null, 1));
await stop();
