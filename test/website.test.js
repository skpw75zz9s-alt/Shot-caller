import test from 'node:test';
import assert from 'node:assert/strict';
import { discordInvite, publicRecord } from '../website.js';

test('the public record shows settled calls only, newest first, never the live call', () => {
  const calls = [
    { side: 'YES', price: 0.91, result: 'yes', at: 1 }, { side: 'NO', price: 0.93, result: 'yes', at: 2 },
    { side: 'NO', price: 0.92, result: 'no', at: 3 }, { side: 'YES', price: 0.94, result: null, at: 4, ticker: 'LIVE' },
  ];
  const r = publicRecord({ level: '90% target', since: 1, graded: 3, wins: 2, usd: -6.1, streak: { kind: 'W', n: 1 }, bestWin: 1, calls, guard: { floor: 0.9 } });
  assert.deepEqual(r.recent.map((c) => c.at), [3, 2, 1]);
  assert.deepEqual(r.recent[0], { side: 'DOWN', price: 0.92, won: true, at: 3 });
  assert.equal(r.recent[1].won, false);
  assert.ok(!JSON.stringify(r).includes('LIVE') && !('guard' in r), 'no live call, nothing internal');
  assert.equal(publicRecord(null).graded, 0); assert.deepEqual(publicRecord({}).recent, []);
  assert.equal(publicRecord({ calls: Array.from({ length: 30 }, (_, i) => ({ side: 'YES', price: 0.9, result: 'yes', at: i })) }).recent.length, 12);
});

test('the Discord invite: only discord.gg or discord.com/invite links', () => {
  assert.equal(discordInvite({ DISCORD_INVITE: 'https://discord.gg/abc123' }), 'https://discord.gg/abc123');
  assert.equal(discordInvite({ DISCORD_INVITE: ' "https://discord.com/invite/Shot-Caller?x=1" ' }), 'https://discord.com/invite/Shot-Caller');
  for (const bad of ['', 'discord.gg/abc', 'http://discord.gg/abc', 'https://evil.gg/abc', 'https://discord.gg.evil.io/abc', 'https://discord.com/api/webhooks/1/2', 'javascript:alert(1)']) assert.equal(discordInvite({ DISCORD_INVITE: bad }), null, bad);
  assert.equal(discordInvite({}), null);
});
