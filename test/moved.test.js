import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMovedServer, movedTarget } from '../moved.js';

test('MOVED_TO must be an https address', () => {
  assert.equal(movedTarget({ MOVED_TO: 'https://shotcaller.example.com/' }), 'https://shotcaller.example.com');
  assert.equal(movedTarget({ MOVED_TO: 'http://shotcaller.example.com' }), null);
  assert.equal(movedTarget({ MOVED_TO: 'https://example.com/path' }), null);
  assert.equal(movedTarget({}), null);
});

test('the moved server redirects everything but the health check, and retires the old service worker', async () => {
  const srv = createMovedServer('https://new.example.com');
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const page = await fetch(`${base}/paywall.html?x=1`, { redirect: 'manual' });
    assert.equal(page.status, 301);
    assert.equal(page.headers.get('location'), 'https://new.example.com/paywall.html?x=1');
    const post = await fetch(`${base}/api/access/redeem`, { method: 'POST', body: '{}', redirect: 'manual' });
    assert.equal(post.status, 308);
    const health = await fetch(`${base}/healthz`);
    assert.deepEqual(await health.json(), { ok: true, movedTo: 'https://new.example.com' });
    const sw = await (await fetch(`${base}/sw.js`)).text();
    assert.match(sw, /unregister/);
    assert.match(sw, /new\.example\.com/);
  } finally {
    srv.close();
  }
});
