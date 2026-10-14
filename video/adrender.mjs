// Records video/ad.html frame by frame (1280x720, 30 fps). preview: node adrender.mjs preview OUTDIR t1,t2,...
const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, outDir, times] = process.argv.slice(2), FPS = 30;
const b = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:8820/video/ad.html');
await p.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
const DUR = await p.evaluate(() => window.DURATION);
if (mode === 'preview') {
  for (const t of times.split(',').map(Number)) { await p.evaluate((x) => window.render(x), t); await p.screenshot({ path: `${outDir}/f${String(t).replace('.', '_')}.png` }); }
} else {
  writeFileSync('ad-cuts.json', JSON.stringify({ duration: DUR, cuts: await p.evaluate(() => window.CUTS) }));
  const FR = Math.round(DUR * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), 'ad-silent.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = 0; f < FR; f++) {
    await p.evaluate((t) => window.render(t), f / FPS);
    const jpg = await p.screenshot({ type: 'jpeg', quality: 94 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 300 === 0) console.log(`frame ${f}/${FR} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
}
console.log('errors', JSON.stringify(errs));
await Promise.race([b.close(), new Promise((r) => setTimeout(r, 3000))]); process.exit(0);
