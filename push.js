// Minimal Web Push sender using only node:crypto.
// VAPID auth (RFC 8292) + aes128gcm payload encryption (RFC 8291 / RFC 8188).
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// ES256 JWT proving this server owns the VAPID key the subscription was made with.
export function vapidJwt(audience, subject, { publicKey, privateKey }, ttlSec = 12 * 3600) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject }));
  const pub = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey },
  });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(sig)}`;
}

// Encrypt a payload for one subscription (single aes128gcm record).
// `fixed` (server private key, salt) is only for reproducing the RFC test vector.
export function encryptPayload(plaintext, { p256dh, auth }, fixed = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.privateKey) ecdh.setPrivateKey(Buffer.from(fixed.privateKey, 'base64url'));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ? Buffer.from(fixed.salt, 'base64url') : crypto.randomBytes(16);

  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Send one notification. Returns the push service's HTTP status:
// 201 = accepted, 404/410 = subscription is gone and should be dropped.
export async function sendPush(subscription, payload, vapid, { ttl = 300, urgency = 'high', topic } = {}) {
  const { protocol, host } = new URL(subscription.endpoint);
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: `vapid t=${vapidJwt(`${protocol}//${host}`, vapid.subject, vapid)}, k=${vapid.publicKey}`,
  };
  // Topic lets a newer notification replace an older undelivered one (max 32 url-safe chars)
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const r = await fetch(subscription.endpoint, {
    method: 'POST', headers, body: encryptPayload(JSON.stringify(payload), subscription.keys), signal: AbortSignal.timeout(10000),
  });
  return r.status;
}
