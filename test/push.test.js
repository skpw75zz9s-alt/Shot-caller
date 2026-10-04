import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { encryptPayload, generateVapidKeys, sendPush, vapidJwt } from '../push.js';
import { fakeBrowser } from './helpers.js';

function verifyJwt(jwt, publicKey) {
  const [h, c, s] = jwt.split('.');
  const pub = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  return { ok: crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

test('payload round-trips through RFC 8291 encryption', () => {
  const ua = fakeBrowser();
  const msg = JSON.stringify({ title: 'Buy the low: YES · Above at 40%', body: 'héllo ✓' });
  assert.equal(ua.decrypt(encryptPayload(msg, ua.keys)), msg);
});

test('VAPID JWT is a valid ES256 signature with the right claims', () => {
  const keys = generateVapidKeys();
  const { ok, claims } = verifyJwt(vapidJwt('https://push.example.net', 'mailto:a@b.co', keys), keys.publicKey);
  assert.ok(ok);
  assert.equal(claims.aud, 'https://push.example.net');
  assert.equal(claims.sub, 'mailto:a@b.co');
  assert.ok(claims.exp > Date.now() / 1000);
});

test('sendPush posts an encrypted, authorized request a push service accepts', async () => {
  const ua = fakeBrowser();
  const vapid = { ...generateVapidKeys(), subject: 'mailto:a@b.co' };
  let seen;
  const svc = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen = { headers: req.headers, body: Buffer.concat(chunks), url: req.url }; res.statusCode = 201; res.end(); });
  });
  await new Promise((r) => svc.listen(0, r));
  const endpoint = `http://127.0.0.1:${svc.address().port}/push/abc123`;
  const status = await sendPush({ endpoint, keys: ua.keys }, { title: 'SELL NOW' }, vapid, { topic: 'sell-17000:take' });
  svc.close();

  assert.equal(status, 201);
  assert.equal(seen.url, '/push/abc123');
  assert.equal(seen.headers['content-encoding'], 'aes128gcm');
  assert.equal(seen.headers.urgency, 'high');
  assert.equal(seen.headers.topic, 'sell-17000take');
  const [, t, k] = seen.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  assert.ok(verifyJwt(t, vapid.publicKey).ok);
  assert.deepEqual(JSON.parse(ua.decrypt(seen.body)), { title: 'SELL NOW' });
});

test('matches the RFC 8291 Appendix A test vector byte for byte', () => {
  const out = encryptPayload('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
  assert.equal(out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
