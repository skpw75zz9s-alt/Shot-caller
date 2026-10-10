import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// v6.6 shipped an empty sw.js by accident (no offline shell, no push notifications): never again
test('service worker: caches every app file and shows pushes', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('fetch'/);
  const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const f of shell) if (f !== './') assert.ok(existsSync(new URL(`../public/${f}`, import.meta.url)), `${f} exists`);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const imports = [...app.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
  for (const f of imports) assert.ok(shell.includes(f), `${f} is cached`);
});

test('index.html preloads every module (so the browser fetches them in parallel, not one import at a time)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const f of shell.filter((x) => x.endsWith('.js'))) assert.ok(html.includes(`<link rel="modulepreload" href="${f}">`), `${f} is preloaded`);
});
