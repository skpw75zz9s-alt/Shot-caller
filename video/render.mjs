const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const kind = process.argv[2], FPS = 30, OUT = `${kind}-silent.mp4`;
const b = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:8820/video/video.html?kind=${kind}`);
await p.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
const DUR = await p.evaluate(() => window.DURATION), FR = Math.round(DUR * FPS);
writeFileSync(`${kind}-audio.json`, JSON.stringify({ duration: DUR, audio: await p.evaluate(() => window.AUDIO) }));
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
const t0 = Date.now();
for (let f = 0; f < FR; f++) {
  await p.evaluate((t) => window.render(t), f / FPS);
  const jpg = await p.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
  if (f % 600 === 0) console.log(`${kind} frame ${f}/${FR} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end(); await new Promise((r) => ff.on('close', r));
console.log(kind, 'frames', FR, 'in', ((Date.now() - t0) / 1000).toFixed(0), 's; errors', errs);
await Promise.race([b.close(), new Promise((r) => setTimeout(r, 3000))]); process.exit(0);
