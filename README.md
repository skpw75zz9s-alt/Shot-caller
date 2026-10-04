# Shot Caller

A mobile signal bot for **Kalshi's 15-minute Bitcoin markets** (series `KXBTC15M`). It's a phone-installable web app (PWA). It watches the open market, prices it with a volatility model and calls a shot: **YES** (BTC above the target at close), **NO** (below) or **PASS**. Each call comes with a suggested size.

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

### 5-minute wait

The bot watches the first **5 minutes** of every window before it makes any call. Early in a window BTC sits near the target, so calls there are mostly momentum guesses, and the paper test lost money on exactly those. During the wait, the call card shows *Watching the first 5 minutes* with a countdown, and the confidence badge is labeled as a preview. No BUY THE LOW alerts go out, the server's window scoring doesn't trade, and the 15-minute update says when calls start. Sell signals for positions you already hold keep working the whole time. Change it with *Wait before calling* in Settings (0 = no wait).

### Live price

A sticky ticker at the top streams every BTC trade from Coinbase's public WebSocket. It shows a **LIVE** badge, flashes green or red on each move, and shows the 24h change and how far BTC is **above or below the target**. The candles, odds and sell signals update with it, up to 4 times a second. If the stream drops, it falls back to polling every few seconds and shows **DELAYED**. Kalshi's own prices reload every 3 seconds (*Kalshi refresh*), because Kalshi's live feed requires an account login. Push notifications include the BTC price at the moment they fire.

### Buying the low

"Low" means **Kalshi's price is below the bot's odds**. For example, YES costs 40¢ (Kalshi says 40%) while the bot gives it 66%. The top of the screen shows Kalshi % vs bot % for both YES and NO on a bar. The app calls **BUY THE LOW** when the gap, after Kalshi's fee, beats *Min gap* (4¢ by default).

### Rejection trends (inside each 15-minute window)

The bot tracks how price behaves around the target since the window opened:

| Event | What happened | Reads as |
|---|---|---|
| **Target rejected** | Wicked up to the target and closed back below it | Sellers capping it: bearish |
| **Target held** | Wicked down to the target and closed back above it | Buyers defending it: bullish |
| **High rejected / Low held** | Retested the window's high or low and got pushed back | Bearish / bullish |
| **Breakout / breakdown** | Closed through the target after rejecting it | Old rejections no longer count; this counts the other way |

It also weighs wick pressure (long upper wicks mean sellers hit rallies, long lower wicks mean buyers absorb dips), the window's structure (higher lows, lower highs, squeezing) and chop around the target. Recent events count more. The result nudges the bot's odds by up to ±5 pts (*Rejection weight*, 0 = off). The **Rejections this window** card shows the counts and summary, and the chart marks each rejected wick with an orange ✕. A fresh rejection against an open position also counts as a flip sign for **SELL NOW**.

### Deep dive (confidence score)

Before any **BUY THE LOW**, the bot scores the call from 50 and adds or subtracts points per factor:

- Edge after fees (up to +25 / −20)
- Rejection trend for or against the side (+10 / −15)
- Trend on 3, 10 and 30 minutes all with you (+8), mostly with you (+3), mostly against (−3) or all against (−8)
- The bot's own read: favored the side steadily for 3 minutes (+6) or keeps flipping (−8); odds building toward the side over 2 minutes (+4) or fading (−6)
- Edge has held for 30+ seconds (+4), or just appeared and could be a stale quote (−3)
- Candle timing: dip now (+8) or chasing (−10)
- How far BTC already is on your side, in volatility units: well past the target (+10), past it (+6), or needing a big move (−8)
- Volatility spiking vs its 2-hour norm (−8) or calm (+4)
- Time left: late in the window (+5) or early (−5)
- Kalshi spread: tight (+3) or wide (−5)
- Kalshi's price catching up to the bot (+3), or moving against the call while the bot's own odds fade too (−5). A Kalshi dip while the bot holds steady scores 0, because that dip *is* the low
- **Stress test:** re-prices the call with 25% more volatility and with any momentum or rejection tilt that helps the call removed (adverse ones stay). The edge still clears the min gap (+6), survives thinner (+2), or flips negative (−4)

The result is a single **confidence score from 0 to 100**, shown on the call, in the Deep dive card and in push alerts. There are no letter grades. A call only fires, on screen and as a push, when confidence is at least *Min confidence* (60). Below that the bot keeps watching and calls if confidence rises. The suggested size scales with confidence: half size at 45, three quarters at 60, full size at 75 and above. The **Deep dive** card lists every factor with its points.

### Candle timing (optional)

When the model likes a side, the app reads the last 2 hours of 1-minute candles and checks whether right now is a cheap entry:

| Signal | YES (wants BTC up) | NO (wants BTC down) |
|---|---|---|
| RSI(14) | under 35 and turning up | over 65 and turning down |
| Bollinger Bands (20, 2σ) | at the lower band | at the upper band |
| Support / resistance (30-min low/high) | testing support | testing resistance |
| Reversal candle | hammer, bullish engulfing | shooting star, bearish engulfing |

Two or more of these, after subtracting reversal candles pointing the other way, gives **dip now**. If price has just run in your favor, you get **CHASING**: you'd be buying the high. Otherwise you get **no dip yet**, with an even lower limit price to rest. That price is where the contract should trade if BTC reaches the dip level, capped so a fill still clears *Min edge*. The chart shows the candles, support, resistance, the strike, the buy-low level, and ▲/▼ markers on reversal candles.

Alerts fire on every BUY THE LOW. Turn on **Also wait for candle dip** to alert only when the candles agree. History tracks a separate candle-dip hit rate so you can see whether the timing actually helps. 1-minute candle patterns are weak signals, so judge them by that number.

### Cash-out prices

Next to each side's buy price, the app shows Kalshi's **cash-out price**: the live bid, which is what you get if you sell right now. It also shows what $10 bought this second would cash out for after fees, so you can see the round-trip cost. Open positions show **Cash out at** (the bid) and **Cash out value** (your contracts × bid after fees), and SELL NOW alerts include the cash-out value.

### Window scoring (behind the 15-minute updates)

The server still follows each whole window (the bot's odds every 5 seconds, plus a paper "follow the bot" trade) so the 15-minute update can say how the last window went. The app's History tab shows only **My trades**.

### Selling for profit (exit signals)

The app can't see your Kalshi account. After you buy on Kalshi, tap **I bought it**. That's it: one tap, no typing. The app records the bot's side, Kalshi's live price and the exact time, and uses the bot's suggested amount. Set *Fixed trade amount* in Settings if you always buy the same dollar amount. An **Undo** bar appears for a few seconds in case of a mis-tap. Tap right after your Kalshi order fills so the recorded price matches your fill. A position card appears at the top and checks every tick whether to **HOLD** or **SELL NOW**:

| Signal | When | Why |
|---|---|---|
| **Take profit** | The bid, after the sell fee, is at or above the bot's odds | The low is gone. Holding is worth no more than selling |
| **Flip warning** | You're up at least *Min profit to lock* and any flip sign shows | Lock it in before it turns |
| **Cut** | The bot's odds fall below what you could sell for, even at a loss | Holding is now worse than selling |

Flip signs: a reversal candle against you (shooting star or bearish engulfing for YES, the mirror for NO), RSI rolling over from overbought or oversold, rejection at the Bollinger band, stalling at resistance or support, two strong candles against you, the bot's odds down *Odds drop* from their peak, or the bid down *Trailing drop* from its peak.

On a SELL NOW your phone vibrates and gets a notification with the price and P&L. Tap **I sold at 72%** right after cashing out. It's also one tap: the whole position is closed at Kalshi's live cash-out price and the time is recorded, with Undo. History shows when you bought and sold. Positions still open at expiry are settled automatically from Kalshi's result. Realized P&L shows under **History → My trades**.

### Push notifications (app closed)

The server runs the same bot as the app, around the clock. It sends **Web Push** notifications for **BUY THE LOW** and **SELL NOW**, so you get them with the app closed and your phone locked.

1. **iPhone:** iOS 16.4 or later. Add the app to your Home Screen and open it from there. Safari tabs can't receive push. **Android:** Chrome works, installed or not.
2. Open **Settings → Turn on push notifications** and allow notifications.
3. Tap **Send test**. You should get "Shot Caller ✓" within a few seconds.

**15-minute updates:** each time a new window opens, every subscribed phone gets one push. It covers how the last window went (settled YES or NO, the odds the bot gave the winner, follow-the-bot result) and the read on the new one (target, where BTC is versus it, which way the bot leans, and BUY THE LOW if it's already a call). For example:

> 🕒 3:30 AM–3:45 AM window · target $84,812
> 3:15 AM window settled YES · bot had 67% on the winner · follow-the-bot +$3.20. Now BTC $84,820 (+$8) · bot leans YES 58% · BUY THE LOW YES · Above at 52%.

The server waits up to 4 minutes for Kalshi to settle the last window so the result is included. Times use the phone's time zone. Each update replaces the previous one in the notification list, and there's no update right after you first turn on push. Turn it off with **Notify: 15-minute updates**.

Your settings and tracked positions sync to the server whenever they change, so it watches the same thresholds and positions. Turn off either alert type with **Notify: buy the low** and **Notify: sell now**. With push on, the app only vibrates in the foreground; the server sends the notification, so you don't get duplicates.

**Keep subscriptions across redeploys (Railway):** the server stores its push keys and subscribed phones in a small JSON file. Railway's disk resets on each deploy, so add a volume:

- Service → **Settings → Volumes → + New Volume**, mount path `/data`
- Service → **Variables → New Variable**: `DATA_DIR` = `/data`

Without a volume, push still works, but after each redeploy you need to open the app once to resubscribe automatically. If you'd rather pin the keys, run `npm run vapid` and set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in Variables. `/healthz` shows how many phones are subscribed and when the bot last ran.

How it's built: `push.js` implements VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291) with `node:crypto`, still with no dependencies. It's tested against the RFC's published test vector. The server only sends to real browser push services (Apple, Google, Mozilla, Microsoft).

Every first call on a market goes into **History**. After the market settles, the app fetches the result and tracks hit rate and paper P&L.

## Paywall (Cash App)

New visitors see a paywall instead of the app: **$5 for 30 days** by default, paid to **$Akizzle55** on Cash App.

1. The buyer taps **Get started** and gets a personal code like `SC-7KQ2X4`.
2. **Pay on Cash App** opens `cash.app/$Akizzle55/5` with the amount filled in and copies the code. The buyer pastes it in the payment note.
3. The buyer taps **I've paid**. Every admin phone with push on gets *"💵 Payment to verify: SC-7KQ2X4"*.
4. The admin checks Cash App for a payment with that note and taps **Approve** in **Settings → Admin**. The buyer's page unlocks by itself within about 10 seconds.

Cash App has no API for personal $cashtags, so an admin has to approve each payment. The **Admin** panel lists people waiting for approval and active members (Approve, Deny, +days, Revoke), and lets you change the price and length. A paid code works on up to 3 devices: on a new phone, or in the iPhone Home Screen app, which keeps its own login, use *"Already paid? Enter your code"*. Renewals reuse the same code. When access ends, the app and push alerts stop until they renew.

**Paid devices are remembered:** once you approve someone, their phone keeps its code and a **signed access pass**. If the phone loses its cookie, or the server loses its data (for example a redeploy without a volume), the app signs them back in automatically with the same code and expiry. They don't type anything. Passes can't be forged or edited. A revoked member stays locked out as long as the server still has its data (after a wipe, an old pass works until its expiry date). Signing back in on the same phone reuses that phone's device slot. The admin's phone is remembered the same way, and changing `ADMIN_CODE` cancels saved admin passes. Pending codes survive too: the phone gets its same code back, and **Approve code** works even if the server forgot it. The signing secret comes from `ACCESS_SECRET` if you set one, otherwise from Railway's built-in project and service IDs, which stay the same across redeploys.

**Admin bypass:** enter the admin code in either box on the paywall (*Admin* or *Already paid? Enter your code*), or tap **Admin code** in Settings if you're signed in as a member. You get full access with no expiry, plus the Admin panel. It works out of the box: the source holds only a slow scrypt hash of the built-in code, never the code itself. To use a different code, set the `ADMIN_CODE` variable in Railway, which replaces the built-in one. Codes are case-insensitive. Only wrong codes count toward the lockout: 8 wrong codes per 15 minutes per address, plus 40 per 15 minutes across all addresses so the code can't be brute-forced from many IPs. Rate limits use the address added by the hosting proxy, so they can't be dodged with a fake `X-Forwarded-For` header. Changing `ADMIN_CODE` signs out every existing admin session.

Everything is enforced on the server: without access, it serves only the paywall. The app's code, market data, push and admin APIs all return 401 or 403. Set `PAYWALL=off` to disable it, for example locally.

**Railway setup (required for the paywall):**
- Optional: Service → **Variables** → `ADMIN_CODE` to replace the built-in admin code, `ACCESS_SECRET` (any long random text) to sign access passes with your own secret
- Service → **Settings → Volumes**: mount a volume at `/data` and add the variable `DATA_DIR` = `/data`. **Without it, every redeploy wipes all paid members.**
- Optional: `PAYWALL_PRICE` / `ACCESS_DAYS` set the starting price and length (you can also change them in the Admin panel), and `CASHTAG` changes the $cashtag.

## Run it

Needs Node 18+ and nothing else (no dependencies).

```bash
npm start            # http://localhost:8080
npm test             # model and proxy tests
```

The small Node server serves the app and proxies Kalshi and Coinbase market data, so the phone browser doesn't hit CORS limits. The proxy only allows read-only market-data paths.

### Put it on your phone

Choose one:

- **Host it** (best). Tap the **Deploy to Render** button above, sign in to Render with GitHub (free plan, no card), and tap **Apply**. Render reads `render.yaml`, builds the app, gives you a `https://shot-caller-xxxx.onrender.com` URL, and redeploys on every push to `master`. The free plan sleeps after 15 minutes idle, so the first load after a break takes about 30–60 seconds. Fly.io works too, with start command `npm start`.
- **Railway.** On railway.com: **Login with GitHub** → **New Project** → **Deploy from GitHub repo** → `Shot-caller`. `railway.json` sets the start command and health check. When the deploy goes green, open the service → **Settings → Networking → Generate Domain** (leave the port blank or enter `8080`). That gives you your `https://…up.railway.app` URL, and every push to `master` redeploys. Open the HTTPS URL on your phone, then:
  - **iPhone:** Safari → Share → *Add to Home Screen*
  - **Android:** Chrome → ⋮ → *Install app*
- **Same Wi-Fi.** Run `npm start` on your computer, then open `http://<computer-ip>:8080` on your phone. Install and notifications need HTTPS, but the live view works.
- **Android only, on the device.** Install Termux, then `pkg install nodejs git`, clone the repo, run `npm start`, and open `localhost:8080`.

Tap **Settings → Turn on push notifications** to get alerts even when the app is closed. See *Push notifications* below.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Kalshi series | `KXBTC15M` | Change it if Kalshi renames the series |
| Fixed trade amount | 0 | What one-tap "I bought it" records ($). 0 = the bot's suggested amount |
| Min confidence | 60 | Confidence (0–100) a call needs to fire |
| Rejection weight | 1 | How much rejection trends move the odds (0 = off, 1 = up to ±5 pts) |
| Min gap | 4 pts | How far Kalshi's price must be below the bot's odds, after fees |
| Also wait for candle dip | off | Only alert when the candles show a dip too |
| Notify: buy the low / sell now / 15-minute updates | on / on / on | Which push alerts to send |
| Min profit to lock | 1 pt | Profit per contract, after both fees, before flip signs trigger a sell |
| Trailing drop | 6 pts | Sell-% drop from its peak that counts as a flip sign |
| Odds drop | 8 pts | Bot odds drop from their peak that counts as a flip sign |
| Max spread | 10¢ | Skip illiquid books |
| Wait before calling | 5 min | Minutes into each window before any call |
| Min minutes left | 0.5 | Stop calling this close to settlement |
| Vol multiplier | 1.15 | Higher means fewer, more conservative calls |
| Momentum weight | 0.25 | 0 means pure random walk |
| Bankroll / Kelly fraction / Max stake | $100 / 0.25 / $25 | Position sizing |

Configure the upstream APIs with the `KALSHI_API` and `COINBASE_API` env vars.

## Known limitations

- Coinbase spot differs a little from BRTI. Near the strike in the final minute, that gap matters.
- Realized vol lags regime changes such as news or liquidations.
- The strike comes from Kalshi's `floor_strike`. If that field is missing, the app uses the BTC open price of the window.
