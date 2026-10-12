import test from 'node:test';
import assert from 'node:assert/strict';
import { callMessage, createDiscord, resultMessage, validWebhook } from '../discord.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123';
const call = { ticker: 'KXBTC15M-26OCT12-T1', side: 'YES', price: 0.92, conf: 97, at: Date.UTC(2026, 9, 12, 15, 3), closeTime: new Date(Date.UTC(2026, 9, 12, 15, 15)).toISOString(), result: null };

test('only Discord\'s own webhook addresses are accepted', () => {
  assert.equal(validWebhook(HOOK), true);
  assert.equal(validWebhook(HOOK.replace('discord.com', 'discordapp.com')), true);
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
  const hits = []; let first = true;
  const d = createDiscord({ url: HOOK, sleep: async () => {}, log: { warn() {} }, fetchImpl: async (url, opts) => {
    hits.push({ url, body: JSON.parse(opts.body) });
    if (first) { first = false; return { status: 429, ok: false, json: async () => ({ retry_after: 1 }) }; }
    return { status: 204, ok: true };
  } });
  assert.equal(d.call(call, { strike: 100050 }), true); d.result({ ...call, result: 'yes' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hits.length, 3, 'the rate-limited call retried, then the result');
  assert.equal(hits[0].url, HOOK); assert.match(hits[2].body.embeds[0].title, /WIN/);
  assert.deepEqual(d.status(), { on: true, sent: 2, failed: 0, queued: 0 });
});
