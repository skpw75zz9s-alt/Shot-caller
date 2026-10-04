import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// A fake browser: its keys, and RFC 8291 decryption.
export function fakeBrowser() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decrypt(buf) {
      const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32);
      const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
      const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(pt[pt.length - 1], 2, 'last-record padding delimiter');
      return pt.subarray(0, pt.length - 1).toString();
    },
  };
}


// A fake push service that records what it receives and answers with `status`.
export async function fakePushService() {
  const svc = { received: [], status: 201 };
  svc.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { svc.received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = svc.status; res.end(); });
  });
  await new Promise((r) => svc.server.listen(0, r));
  svc.base = `http://127.0.0.1:${svc.server.address().port}`;
  return svc;
}
