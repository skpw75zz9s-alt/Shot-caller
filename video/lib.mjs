const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { riskSettings } = await import(ROOT + '/public/model.js');
export const MOCK = 8811, APP = 8812;
export async function start({ paywall = false } = {}) {
  const mock = spawn('node', ['mock.mjs', String(MOCK)], { cwd: process.cwd(), stdio: 'ignore' });
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(APP), PAYWALL: paywall ? '' : 'off', KALSHI_API: `http://127.0.0.1:${MOCK}`, COINBASE_API: `http://127.0.0.1:${MOCK}`, YAHOO_API: `http://127.0.0.1:${MOCK}`, DATA_DIR: mkdtempSync(join(tmpdir(), 'tut-')), LEARN: process.env.TUT_LEARN || 'off' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('settingsVersion')) { localStorage.setItem('settings', JSON.stringify(s)); localStorage.setItem('settingsVersion', '17'); localStorage.setItem('pushNudgeX', 'true'); } }, { ...riskSettings('profit'), dailyLossLimit: 25 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.routeWebSocket(/.*/, (ws) => {
    if (!/ws-feed\.exchange\.coinbase\.com/.test(ws.url())) { ws.close(); return; }
    let timer = null;
    let product = 'BTC-USD';
    ws.onMessage((m) => {
      try { product = JSON.parse(m).product_ids?.[0] || product; } catch { /* */ }
      if (timer) return;
      timer = setInterval(async () => {
        try { const t = await (await fetch(`http://127.0.0.1:${MOCK}/products/${product}/ticker`)).json(); ws.send(JSON.stringify({ type: 'ticker', product_id: product, price: t.price, time: t.time, side: Math.random() > 0.45 ? 'buy' : 'sell', last_size: (Math.random() * 0.2).toFixed(4) })); } catch { /* */ }
      }, 1000);
    });
  });
  const set = (q) => fetch(`http://127.0.0.1:${MOCK}/__set?${new URLSearchParams(q)}`);
  const stop = async () => { srv.kill(); mock.kill(); await Promise.race([b.close(), new Promise((r) => setTimeout(r, 3000))]); process.exit(0); };
  return { page, ctx, set, stop, errs, url: `http://127.0.0.1:${APP}/` };
}
