// Records video/ad2.html (or $AD.html: AD=ad3 for the v13.45 update) frame by frame at 1920x1080. Motion blur: 120 frames a second are rendered and blended in
// pairs to 60 (make.sh ad2). Usage:
//   node adrender2.mjs preview OUTDIR t1,t2,...       stills
//   node adrender2.mjs worker I N                     renders the I-th of N slices to ad2-seg-I.mp4 (run N at once)
const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, a1, a2] = process.argv.slice(2), SUB = 120, AD = process.env.AD || 'ad2';
const b = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(`http://127.0.0.1:8820/video/${AD}.html`);
await p.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
const DUR = await p.evaluate(() => window.DURATION);
if (mode === 'preview') {
  for (const t of a2.split(',').map(Number)) { await p.evaluate((x) => window.render(x), t); await p.screenshot({ path: `${a1}/g${String(t).replace('.', '_')}.png` }); }
} else {
  const I = Number(a1), N = Number(a2), FR = Math.round(DUR * SUB), per = Math.ceil(FR / N / 2) * 2, from = I * per, to = Math.min(FR, from + per);
  if (I === 0) writeFileSync(`${AD}-cuts.json`, JSON.stringify({ duration: DUR, cuts: await p.evaluate(() => window.CUTS) }));
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(SUB), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'fast', '-crf', '10', '-pix_fmt', 'yuv420p', `${AD}-seg-${I}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = from; f < to; f++) {
    await p.evaluate((t) => window.render(t), f / SUB);
    const jpg = await p.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if ((f - from) % 600 === 0) console.log(`worker ${I}: ${f - from}/${to - from} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
}
console.log('errors', JSON.stringify(errs));
await Promise.race([b.close(), new Promise((r) => setTimeout(r, 3000))]); process.exit(0);
