// Read-only link to a Kalshi account with a Kalshi API key, done entirely on the phone.
// Kalshi signs API requests with RSA-PSS: signature = sign(timestamp + METHOD + path). The private key
// is imported as a non-extractable WebCrypto key, so after linking even this app's own code can't read
// it back out, and it never leaves the device. The server only forwards signed GETs for portfolio data.

const b64 = (bytes) => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

// DER helpers for wrapping a PKCS#1 key ("BEGIN RSA PRIVATE KEY", what Kalshi hands out) as PKCS#8.
function derLen(n) {
  if (n < 0x80) return [n];
  const out = []; while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}
const der = (tag, body) => Uint8Array.from([tag, ...derLen(body.length), ...body]);
const RSA_ALG_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption, NULL

// PEM (PKCS#1 or PKCS#8) -> PKCS#8 DER bytes
export function pemToPkcs8(pem) {
  const text = String(pem || '').trim();
  const m = text.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/);
  if (!m) throw new Error('That doesn\'t look like a Kalshi private key (it starts with -----BEGIN RSA PRIVATE KEY-----)');
  const body = unb64(m[2].replace(/[^A-Za-z0-9+/=]/g, ''));
  if (!m[1]) return body;
  return der(0x30, [0x02, 0x01, 0x00, ...RSA_ALG_ID, ...der(0x04, body)]);
}

export async function importKey(pem, subtle = globalThis.crypto.subtle) {
  try {
    return await subtle.importKey('pkcs8', pemToPkcs8(pem), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
  } catch (e) {
    if (/look like/.test(e.message)) throw e;
    throw new Error('Couldn\'t read that private key. Paste the whole file Kalshi gave you, including the BEGIN/END lines.');
  }
}

// Headers for one Kalshi request. `path` is the full API path without the query, e.g. /trade-api/v2/portfolio/fills
export async function signHeaders(key, keyId, method, path, ts = Date.now(), subtle = globalThis.crypto.subtle) {
  const msg = new TextEncoder().encode(`${ts}${method}${path}`);
  const sig = new Uint8Array(await subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, msg));
  return { 'x-kalshi-key': keyId, 'x-kalshi-ts': String(ts), 'x-kalshi-sig': b64(sig) };
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// One Kalshi fill -> { id, ticker, side, action, count, price (dollars, for that side), at (ms) }.
// Handles both the cents fields (yes_price) and the newer *_dollars / *_fp fields.
export function parseFill(f) {
  const side = String(f.side || '').toLowerCase() === 'no' ? 'NO' : 'YES';
  const pick = (k) => num(f[`${k}_dollars`]) ?? (num(f[k]) != null ? num(f[k]) / 100 : null);
  const price = side === 'YES' ? pick('yes_price') ?? (pick('no_price') != null ? 1 - pick('no_price') : null)
    : pick('no_price') ?? (pick('yes_price') != null ? 1 - pick('yes_price') : null);
  const count = num(f.count) ?? num(f.count_fp);
  const at = Date.parse(f.created_time) || (num(f.ts) ? num(f.ts) * 1000 : null);
  const action = String(f.action || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  return { id: String(f.trade_id ?? f.fill_id ?? `${f.order_id}-${at}-${count}`), ticker: String(f.ticker || f.market_ticker || ''), side, action, count, price: price == null ? null : Math.round(price * 10000) / 10000, at };
}

// Apply fills (oldest first) to holdings { [ticker]: { side, contracts, price, at } }.
// Returns the new holdings, the closes (partial or full sales) and which tickers opened or grew.
// Kalshi nets the two sides: buying NO while holding YES closes YES at 1 − price (and vice versa), and
// selling a side you don't hold opens the other side.
export function foldFills(holdings, fills) {
  const h = structuredClone(holdings);
  const closes = [], touched = new Set();
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    if (!f.ticker || !(f.count > 0) || f.price == null) continue;
    let side = f.side, price = f.price, buying = f.action === 'buy';
    const cur = h[f.ticker];
    if (!buying && (!cur || cur.side !== side)) { buying = true; side = side === 'YES' ? 'NO' : 'YES'; price = Math.round((1 - price) * 10000) / 10000; }
    let left = f.count;
    if (cur && cur.side !== side && buying) { // opposite side closes what's held
      const n = Math.min(left, cur.contracts);
      closes.push({ ticker: f.ticker, side: cur.side, contracts: n, entry: cur.price, entryAt: cur.at, exit: Math.round((1 - price) * 10000) / 10000, at: f.at });
      cur.contracts -= n; left -= n;
      if (cur.contracts <= 1e-9) delete h[f.ticker];
    } else if (cur && !buying) { // selling the held side
      const n = Math.min(left, cur.contracts);
      closes.push({ ticker: f.ticker, side: cur.side, contracts: n, entry: cur.price, entryAt: cur.at, exit: price, at: f.at });
      cur.contracts -= n; left = 0;
      if (cur.contracts <= 1e-9) delete h[f.ticker];
    }
    if (left > 1e-9 && buying) {
      const pos = h[f.ticker];
      if (pos && pos.side === side) { pos.price = Math.round(((pos.price * pos.contracts + price * left) / (pos.contracts + left)) * 10000) / 10000; pos.contracts += left; }
      else h[f.ticker] = { side, contracts: left, price, at: f.at };
      touched.add(f.ticker);
    }
  }
  return { holdings: h, closes, touched: [...touched] };
}

// Kalshi balance response -> dollars
export const balanceDollars = (b) => num(b?.balance_dollars) ?? (num(b?.balance) != null ? num(b.balance) / 100 : null);
