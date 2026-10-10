// The real fee: Kalshi charges ceil(rate x contracts x price x (1 - price)) per fill, rounded up to the cent, and the
// rate has changed over time (and differs for makers). Instead of trusting a hard-coded 7%, the bot measures it from
// real fills: your Kalshi account's (the phone reads each fill's exact fee_cost) and the server Auto-trader's orders.
// Once there are 8+ fills of a kind (taker or maker), the rate that reproduces those fees best is used everywhere a
// fee is figured (edges, sizing, the Auto-trader). Pure; model.js holds the rate in use.
export const FEE_MIN_SAMPLES = 8;
const charge = (k, count, price) => Math.ceil(k * count * price * (1 - price) * 100 - 1e-9) / 100;

// samples: [{ count, price, fee, taker }]. Returns { taker: { k, n } | null, maker: { k, n } | null }
export function learnFeeRates(samples) {
  const fit = (xs) => {
    const ok = xs.filter((s) => s.count > 0 && s.price > 0 && s.price < 1 && s.fee >= 0 && s.fee < s.count);
    if (ok.length < FEE_MIN_SAMPLES) return ok.length ? { k: null, n: ok.length } : null;
    let best = null;
    for (let k = 0; k <= 0.2 + 1e-9; k += 0.0025) { // the rate whose rounded-up fees miss the real ones least
      const err = ok.reduce((a, s) => a + Math.abs(charge(k, s.count, s.price) - s.fee), 0);
      if (!best || err < best.err - 1e-9) best = { k: Math.round(k * 10000) / 10000, err };
    }
    return { k: best.k, n: ok.length, miss: best.err / ok.length };
  };
  return { taker: fit(samples.filter((s) => s.taker !== false)), maker: fit(samples.filter((s) => s.taker === false)) };
}
// One fill's sample (or null): from a parsed Kalshi fill (public/kalshi.js parseFill) or an order response
export function feeSample({ count, price, fee, taker = true }) {
  return count > 0 && price > 0 && price < 1 && fee != null && fee >= 0 ? { count: Number(count), price: Number(price), fee: Number(fee), taker: taker !== false } : null;
}
