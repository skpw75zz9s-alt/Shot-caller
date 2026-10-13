const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
const [kind, ...times] = process.argv.slice(2);
const b = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:8820/video/video.html?kind=${kind}`);
await p.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
console.log('duration', await p.evaluate(() => window.DURATION));
for (const t of times) { await p.evaluate((x) => window.render(x), +t); await p.waitForTimeout(150); await p.screenshot({ path: `prev-${kind}-${t}.png` }); }
console.log('errors', errs);
await b.close();
