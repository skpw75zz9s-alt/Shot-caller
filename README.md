# Shot Caller

A mobile signal bot for **Kalshi's 15-minute Bitcoin markets** (series `KXBTC15M`). It's a phone-installable web app (PWA). It watches the open market, prices it with a volatility model and calls a shot: **YES**, **NO** or **PASS**. Each call comes with a suggested size.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/skpw75zz9s-alt/Shot-caller)

> **Signals only.** It never logs in to Kalshi and never places orders. You place trades yourself.
> No model reliably beats these markets. Watch the paper P&L in the History tab before you risk real money.

## How it calls shots

1. **Data.** Kalshi's public API gives the open market, its strike and its YES/NO quotes. Coinbase gives BTC spot and 1-minute candles. Coinbase stands in for the CF Benchmarks index (BRTI) that Kalshi settles on.
2. **Volatility.** Per-minute realized vol is an EWMA of the last 2 hours of 1-minute returns. The *Vol multiplier* setting scales it up to account for jumps.
3. **Fair probability.** `P(YES) = Φ((ln(S/K) + drift·t) / σ_eff)`. The variance accounts for Kalshi settling on a 60-second average, not a single print. A small, damped momentum drift is optional.
4. **Edge.** `EV = P(model) − ask − Kalshi fee` per contract, for both YES and NO. The fee is `ceil(0.07·p·(1−p))`.
5. **Call.** Take the better side if its EV beats *Min edge*, the spread is tight enough, and the market is inside the time window. Otherwise PASS.
6. **Size.** Fractional Kelly on your bankroll, capped by *Max stake*.

Every first call on a market goes into **History**. After the market settles, the app fetches the result and tracks hit rate and paper P&L.

## Run it

Needs Node 18+ and nothing else (no dependencies).

```bash
npm start            # http://localhost:8080
npm test             # model and proxy tests
```

The small Node server serves the app and proxies Kalshi and Coinbase market data, so the phone browser doesn't hit CORS limits. The proxy only allows read-only market-data paths.

### Put it on your phone

Choose one:

- **Host it** (best). Tap the **Deploy to Render** button above, sign in to Render with GitHub (free plan, no card), and tap **Apply**. Render reads `render.yaml`, builds the app, gives you a `https://shot-caller-xxxx.onrender.com` URL, and redeploys on every push to `master`. The free plan sleeps after 15 minutes idle, so the first load after a break takes about 30–60 seconds. Railway and Fly.io work too, with start command `npm start`. Open the HTTPS URL on your phone, then:
  - **iPhone:** Safari → Share → *Add to Home Screen*
  - **Android:** Chrome → ⋮ → *Install app*
- **Same Wi-Fi.** Run `npm start` on your computer, then open `http://<computer-ip>:8080` on your phone. Install and notifications need HTTPS, but the live view works.
- **Android only, on the device.** Install Termux, then `pkg install nodejs git`, clone the repo, run `npm start`, and open `localhost:8080`.

Tap **Settings → Enable call alerts** to get a vibration and notification when a new shot is called. Alerts only fire while the app is open. iOS needs the app on the Home Screen first.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Kalshi series | `KXBTC15M` | Change it if Kalshi renames the series |
| Min edge | 4¢ | EV after fees needed to call |
| Max spread | 10¢ | Skip illiquid books |
| Min / max minutes left | 0.5 / 14 | Window where calls are allowed |
| Vol multiplier | 1.15 | Higher means fewer, more conservative calls |
| Momentum weight | 0.25 | 0 means pure random walk |
| Bankroll / Kelly fraction / Max stake | $100 / 0.25 / $25 | Position sizing |

Configure the upstream APIs with the `KALSHI_API` and `COINBASE_API` env vars.

## Known limitations

- Coinbase spot differs a little from BRTI. Near the strike in the final minute, that gap matters.
- Realized vol lags regime changes such as news or liquidations.
- The strike comes from Kalshi's `floor_strike`. If that field is missing, the app uses the BTC open price of the window.
