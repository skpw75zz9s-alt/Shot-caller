import test from 'node:test';
import assert from 'node:assert/strict';
import { appUrl, callMessage, createDiscord, resultMessage, validWebhook } from '../discord.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123';
const call = { ticker: 'KXBTC15M-26OCT12-T1', side: 'YES', price: 0.92, conf: 97, at: Date.UTC(2026, 9, 12, 15, 3), closeTime: new Date(Date.UTC(2026, 9, 12, 15, 15)).toISOString(), result: null };

test('only Discord\'s own webhook addresses are accepted', () => {
  assert.equal(validWebhook(HOOK), true);
  assert.equal(validWebhook(HOOK.replace('discord.com', 'discordapp.com')), true);
  // as people paste it: quotes, spaces, a versioned address, ?wait=true, a trailing slash
  for (const ok of [`"${HOOK}"`, ` ${HOOK}\n`, HOOK.replace('/api/', '/api/v10/'), `${HOOK}?wait=true`, `${HOOK}/`, `<${HOOK}>`]) assert.equal(validWebhook(ok), true, ok);
  for (const bad of ['', null, 'http://discord.com/api/webhooks/1/2', 'https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://discord.com.evil.io/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', `${HOOK}/../x`]) assert.equal(validWebhook(bad), false, String(bad));
});

test('the call and result messages: side, price, confidence, the close in each reader\'s own time, the record, the disclaimer', () => {
  const m = callMessage(call, { strike: 100050, floor: 0.9 }), e = m.embeds[0];
  assert.match(e.title, /🐂 UP call/); assert.match(e.description, /above \$100,050/);
  assert.deepEqual(e.fields.map((f) => f.name), ['Price', 'Confidence', 'Closes', 'Price floor', 'Market']);
  assert.equal(e.fields[0].value, '92¢'); assert.equal(e.fields[2].value, `<t:${Date.UTC(2026, 9, 12, 15, 15) / 1000}:t>`);
  assert.match(e.footer.text, /Not financial advice/);
  const paper = callMessage(call, { paper: true }).embeds[0];
  assert.match(paper.title, /PAPER/); assert.match(paper.description, /profit guard/);
  const r = resultMessage({ ...call, result: 'yes' }, { graded: 40, wins: 37, usd: -1.25 }).embeds[0];
  assert.match(r.title, /✅ WIN · UP at 92¢/); assert.match(r.description, /37–3 \(93% won\) · −\$1\.25 at \$10 a call after fees/);
  assert.match(resultMessage({ ...call, result: 'no' }).embeds[0].title, /❌ LOSS/);
});

test('posting: off without a valid address; one at a time; waits out Discord\'s rate limit and retries', async () => {
  const off = createDiscord({ url: 'https://example.com/hook', log: { warn() {} } });
  assert.equal(off.on, false); assert.equal(off.call(call), false);
  assert.match(off.status().why, /not a Discord webhook address/); assert.match(createDiscord({ url: '' }).status().why, /not set/);
  assert.ok(!JSON.stringify(off.status()).includes('example.com'), 'the address itself is never shown');
  const hits = []; let first = true;
  const d = createDiscord({ url: HOOK, base: null, sleep: async () => {}, log: { warn() {} }, fetchImpl: async (url, opts) => {
    hits.push({ url, body: JSON.parse(opts.body) });
    if (first) { first = false; return { status: 429, ok: false, json: async () => ({ retry_after: 1 }) }; }
    return { status: 204, ok: true };
  } });
  assert.equal(d.call(call, { strike: 100050 }), true); d.result({ ...call, result: 'yes' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hits.length, 3, 'the rate-limited call retried, then the result');
  assert.equal(hits[0].url, HOOK); assert.match(hits[2].body.embeds[0].title, /WIN/);
  assert.deepEqual(d.status(), { on: true, why: null, sent: 2, failed: 0, queued: 0, branded: false });
});

test('branding: posts come from Shot Caller with the app icon and an Official calls header linking to the app', async () => {
  assert.equal(appUrl({ RAILWAY_PUBLIC_DOMAIN: 'shot-caller.up.railway.app' }), 'https://shot-caller.up.railway.app');
  assert.equal(appUrl({ APP_URL: 'https://calls.example.com/', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), 'https://calls.example.com');
  for (const bad of [{}, { APP_URL: 'http://plain.example.com' }, { APP_URL: 'javascript:alert(1)' }, { APP_URL: 'https://a.com/x"y' }]) assert.equal(appUrl(bad), null, JSON.stringify(bad));
  const base = 'https://shot-caller.up.railway.app';
  const m = callMessage(call, { base }), r = resultMessage({ ...call, result: 'yes' }, null, base);
  for (const msg of [m, r]) {
    assert.equal(msg.username, 'Shot Caller'); assert.equal(msg.avatar_url, `${base}/icon-512.png?v=3`);
    assert.deepEqual(msg.embeds[0].author, { name: 'Shot Caller · Official calls', url: base, icon_url: `${base}/icon-512.png?v=3` });
  }
  // without an address: still sent, no avatar or link
  const plain = callMessage(call);
  assert.equal(plain.username, 'Shot Caller'); assert.equal(plain.avatar_url, undefined); assert.deepEqual(plain.embeds[0].author, { name: 'Shot Caller · Official calls' });
  const hits = [];
  const d = createDiscord({ url: HOOK, base, sleep: async () => {}, fetchImpl: async (u, o) => { hits.push(JSON.parse(o.body)); return { status: 204, ok: true }; } });
  d.call(call); await new Promise((res) => setTimeout(res, 10));
  assert.equal(hits[0].avatar_url, `${base}/icon-512.png?v=3`); assert.equal(d.status().branded, true);
});
