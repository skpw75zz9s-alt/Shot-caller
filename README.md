# Shot Caller

A mobile signal bot for **Kalshi's 15-minute Bitcoin markets** (series `KXBTC15M`). It's a phone-installable web app (PWA). It watches the open market, prices it with a volatility model and calls a shot: **YES** (BTC above the target at close), **NO** (below) or **PASS**. Each call comes with a suggested size.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/skpw75zz9s-alt/Shot-caller)

> **Signals only.** It never logs in to Kalshi and never places orders. You place trades yourself.
> No model reliably beats these markets. Watch the paper P&L in the History tab before you risk real money.

## How it calls shots

1. **Data.** Kalshi's public API gives the open market, its strike and its YES/NO quotes. Coinbase gives BTC spot and 1-minute candles. Coinbase stands in for the CF Benchmarks index (BRTI) that Kalshi settles on.
2. **Volatility.** Per-minute realized vol is an EWMA of the last 2 hours of 1-minute returns. The *Vol multiplier* setting scales it (default 1.0: a check against real BTC showed the old 1.15 overstated actual 15-minute swings by about 1.3×, which pulled the bot's odds toward 50/50).
3. **Fair probability.** `P(YES) = Φ((ln(S/K) + drift·t) / σ_eff)`. The variance accounts for Kalshi settling on a 60-second average, not a single print, and inside that last minute the part of the average already printed counts at face value. Momentum drift is off by default (real BTC/ETH/SOL candles showed recent drift doesn't carry forward).
4. **Edge.** `EV = P(model) − ask − Kalshi fee` per contract, for both YES and NO. The fee is `ceil(0.07·p·(1−p))`.
5. **Call.** Take the better side if its EV beats *Min edge*, the spread is tight enough, and the market is inside the time window. Otherwise PASS.
6. **Size.** Fractional Kelly on your bankroll, capped by *Max stake*.

### 5-minute wait

The bot watches the first **5 minutes** of every window before it makes any call. Early in a window BTC sits near the target, so calls there are mostly momentum guesses, and the paper test lost money on exactly those. During the wait, the call card shows *Watching the first 5 minutes* with a countdown, and the confidence badge is labeled as a preview. No BUY THE LOW alerts go out, the server's window scoring doesn't trade, and the hourly update says when calls start. Sell signals for positions you already hold keep working the whole time. Change it with *Wait before calling* in Settings (0 = no wait).

### Live price

A sticky ticker at the top streams every BTC trade from Coinbase's public WebSocket. It shows a **LIVE** badge, flashes green or red on each move, and shows the 24h change and how far BTC is **above or below the target**. The candles, odds and sell signals update with it, up to 4 times a second. If the stream drops, it falls back to polling every few seconds and shows **DELAYED**. Kalshi's own prices reload every 3 seconds (*Kalshi refresh*), because Kalshi's live feed requires an account login. Push notifications include the BTC price at the moment they fire.

### Buying the low

"Low" means **Kalshi's price is below the bot's odds**. For example, YES costs 40¢ (Kalshi says 40%) while the bot gives it 66%. The top of the screen shows Kalshi % vs bot % for both YES and NO on a bar. The app calls **BUY THE LOW** when the gap, after Kalshi's fee, beats *Min gap* (6¢ on the default Balanced risk level) **even if volatility is 20% lower or 25% higher than measured** (the robust edge), and confidence (the call's win odds) clears 85. An edge that only exists at one volatility guess is mostly model error; in the profit simulator those trades lost money.

### Rejection trends (inside each 15-minute window)

The bot tracks how price behaves around the target since the window opened:

| Event | What happened | Reads as |
|---|---|---|
| **Target rejected** | Wicked up to the target and closed back below it | Sellers capping it: bearish |
| **Target held** | Wicked down to the target and closed back above it | Buyers defending it: bullish |
| **High rejected / Low held** | Retested the window's high or low and got pushed back | Bearish / bullish |
| **Breakout / breakdown** | Closed through the target after rejecting it | Old rejections no longer count; this counts the other way |

It also weighs wick pressure (long upper wicks mean sellers hit rallies, long lower wicks mean buyers absorb dips), the window's structure (higher lows, lower highs, squeezing) and chop around the target. Recent events count more. The result nudges the bot's odds by up to ±5 pts (*Rejection weight*, 0 = off). The **Rejections this window** card shows the counts and summary, and the chart marks each rejected wick with an orange ✕. A fresh rejection against an open position also counts as a flip sign for **SELL NOW**.

### Confidence = win odds

**Confidence is the call's win odds**: how many times in 100 the side it calls should settle in the money. It comes from the bot's price model at the most cautious of three volatility guesses (20% lower, measured, 25% higher). "Confidence 85" means it should win about 85 times in 100.

Why: on about 65,000 simulated calls, those odds matched reality. Calls given 80–90% won 82–83% of the time, and calls given 90%+ won 95%. The old points score (below) predicted wins worse than the odds alone, so it no longer sets confidence.

Every confidence bar doubled in v4.1. Aggressive went from 40 to **80**, and Balanced and Safe now need **85** and **90**. Practice and Live use the same bars.

**Smart exception (big gaps):** a call under the bar still fires when its gap is huge **even at the worst volatility guess**: 15 pts on Safe, 12 on Balanced, 10 on Aggressive. These are usually cheap sides that Kalshi has badly underpriced. They win less often at settlement but are worth more than they cost, and most get sold at a profit before then. Push alerts mark them *big-gap exception*.

Tested on 48 fresh simulated runs per level (6 market types × 8 seeds × 400 windows):

| | Old bars (40 / 55 / 60) | New bars + exception |
|---|---|---|
| Aggressive | +$503 per 100 windows, 90% of trades won | **+$636, 92% won** (worst drawdown $400 vs $280) |
| Balanced | +$231, 91% won | **+$248, 94% won** |
| Safe | +$228, 93% won, 39 trades | **+$226, 94% won, 19 trades** (half the trades, same profit) |

Without the exception, the high bars alone cut profit by 60–85%. On a perfectly efficient Kalshi, no setting makes money, old or new. The edge only exists when Kalshi lags or misprices.

### Deep dive (the reasons)

The Deep dive card still lists every factor behind a call, with points from a base of 50:

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

These points are the reasons, not the confidence number. The confidence badge (on the call, in the Deep dive card and in push alerts) shows the win odds. A call only fires, on screen and as a push, when confidence is at least *Min confidence*. Below that the bot keeps watching and calls if confidence rises. Bet size comes from Kelly on the bot's odds. When the factor points fall under 35 (many red flags at once), it bets half size.

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

### Live auto-trading (real money)

Settings → **Live auto-trading**. It appears once Kalshi is linked, and your Kalshi API key needs trading permission.

**What it does:** while the app is open on screen, the bot places real orders in your Kalshi account using the same rules as Practice.
- It buys new calls (and real switches) at or above *Min confidence*.
- On Aggressive, it adds as the gap grows.
- It sells on the same exits as every position card, and re-enters after a sale.

**How orders are placed:**
- Every buy is a limit order at the call's max price that fills now or cancels. Nothing is left resting on Kalshi.
- Sells go at the bid or better and can never sell more than you hold.

**Your money limits**, all checked before every order:

| Limit | Default | What it does |
|---|---|---|
| Budget | $50 | Most it will ever have at risk (open positions at cost) |
| Max $ per trade | $10 | Most one order may cost |
| Daily loss stop | $40 | Buying stops for the day once today's realized losses plus everything still open could reach this |
| Max trades / day | 40 | |
| Kalshi balance | | It never spends more cash than the account holds. Kalshi has no borrowing, and the bot can't withdraw or reach your bank. |

**Server check:** orders use Kalshi's V2 order API (`POST /portfolio/events/orders`: one YES book, so buy YES = bid, buy NO = ask at 1 − price, and sells are `reduce_only` so they can only close what's held). Before any order reaches Kalshi, the server refuses it unless all of these hold:
- It's for the BTC 15-minute series.
- It's a fill-now-or-cancel (`immediate_or_cancel`) order with a price of 1–99¢ and a sane size.
- Its total cost is at most $100 (`AUTO_MAX_ORDER_USD`).
- It has no unknown fields.
- It's within 20 orders a minute.

**Profit lock (on by default, Live card checkbox):** once a live trade has been up at least **4¢ a contract**, the bot sells while it's still a win if both of these happen:
- it gives back **half** of that peak profit
- it shows at least one other sign of turning: the bot's odds down 8+ points from their peak, a reversal candle pattern, RSI rolling over, rejection at a band or level, or two strong candles against you

The order shows as *lock profit: sell …* in Live orders. In the simulator, this raised the share of winning trades from 92% to 93% and cut the worst losing stretch from $400 to $363. It cost about 2% of profit, because sometimes the trade would have recovered. Uncheck it to hold for value instead.

**Bot's own price on calls (on by default, Live card checkbox):** when a call fires, the buy is a limit order at the bot's max price that waits on Kalshi for up to 2 minutes. Before, it was fill-now-or-cancel, which gave up if Kalshi's price was a cent too high. Kalshi fills it as soon as a seller comes down to the bot's price.
- The app cancels the order the moment the call ends.
- **STOP** cancels everything that's waiting.
- Each order also carries an expiry, so Kalshi itself cancels it within 2 minutes (and 1 minute before the market closes) even if your phone dies. The server refuses any waiting order that would last longer than 5 minutes.
- Waiting buys count toward your budget while they wait.

If Kalshi (or the server) ever refuses a waiting order, the bot immediately sends the same buy as a fill-now order instead, and keeps using fill-now orders until the app restarts. The Live card says so. The server also pulls a waiting order's expiry back into range if the phone's clock is a few minutes off.

Tested in the simulator against fill-now: +$7 per 100 windows, worst losing stretch $338 instead of $363, and much better with a slow connection (+$43 vs +$30 at a 10-second delay).

What it deliberately does **not** do: post its own price when there's no call, or keep a waiting sell posted. Both were tested. The no-call version lost money in every variant tried, even on a perfectly priced Kalshi, because those orders mostly fill when the market knows something the bot doesn't. Waiting sells have the same risk of selling too cheap right as a position gains value.

**Instant orders:** while Live is on, the app reads Kalshi's prices every second (not every 3). Each order is a single request: the server, which sits next to Kalshi, reads the live order book and places the order immediately. That saves a second round trip over mobile data.
- **Buys** go out only if something is for sale at or under the max price, sized to what's there. If the bargain is already gone, no order is sent and it doesn't count as a try.
- **Sells** step to the live bid if it's within 2¢.
- After a fill, the position syncs right away, so the sell can follow at once.

Measured against the stand-in Kalshi, from a price change to the order arriving at Kalshi: buys went from 5.3s to **1.0s**, and sells from 5.9s to **1.0s**.

**Doesn't miss calls:** if an order doesn't fill (the price moved in the second it took) or errors, it tries the same call again, up to 3 orders at least 5 seconds apart. It also picks up a call that was already active when you turned Live on or reopened the app. It never buys the same call twice. Only buys that went through count toward *Max trades / day*. While Live is on and the app is on screen, it keeps the screen awake. In Low Power Mode iPhone may still lock it, so set Auto-Lock to Never while trading.

**Right now line:** while it's on, the Live card always says what it's doing. For example: *Waiting for a call: YES is at confidence 73 (needs 80, or a 10-pt gap) with a 9-pt worst-case gap*. If an order fails, the card also shows Kalshi's exact error. It only runs while the app is open on screen. iPhone pauses it when the app is in the background or the phone is locked.

**Turning it on and off:**
- Turning it on needs a confirmation tick plus typing **LIVE**.
- A red **LIVE AUTO-TRADING** strip with a **STOP** button sits on the Live screen while it's on.
- It switches itself off if Kalshi refuses an order for permissions (a read-only key) or after 3 failed orders in a row.
- **STOP doesn't sell open positions.** They keep their sell signals, and you can sell them on Kalshi.

**Rules:**
- Turn it on on one phone only.
- Only keep money in Kalshi you're fine losing.
- The strategy is tested in simulation and Practice, not proven on live money.

### Link your Kalshi account (optional)

Settings → **Kalshi account**. On Kalshi, go to Account → API keys → Create key, then copy the key ID and download the private key file. Paste the key ID, then paste the key or pick the file, and tap **Link account**. The app checks the key by reading your balance.

Once linked, the app reads your **fills** (every buy and sell, with exact price, size and time) every 10 seconds and whenever you open it. It also imports the last 24 hours when you first link:
- A buy in the current series becomes a position card marked *From Kalshi*. The "I bought it" button goes away.
- Adding to a position averages the price in.
- A sale, partial or full, goes into **My trades** at the price you actually got.
- Buying the other side nets out, the way Kalshi does it.
- Positions you hold to settlement are scored when the market settles.
- Positions sync to the alert server as before, so SELL NOW pushes keep working with the app closed.
- Fees in P&L are estimated with Kalshi's taker formula.

Security:
- **The key never leaves the phone.** It's imported as a non-extractable WebCrypto key in IndexedDB, so it can sign requests but can't be read back out, not even by the app's own code. The pasted text is cleared right away.
- Each request is signed on the phone (Ed25519 or RSA-PSS, matching the key type Kalshi issued). The server only forwards the signature headers.
- Reads: the server forwards GET requests only for `portfolio/fills`, `positions`, `balance`, `settlements` and `orders`, and never caches the responses.
- Orders: these are placed only when you turn on **Live auto-trading** (see below). The server checks every order before it reaches Kalshi.
- **Unlink** deletes the key from the phone. Deleting the key on Kalshi cuts access everywhere.

### Risk level

Settings → **Risk level**. Each level sets the whole strategy, and Practice's limits move with it:

| | Safe | **Balanced (default)** | Aggressive |
|---|---|---|---|
| Min gap / confidence (win odds) | 8 pts / 90, or a 15-pt worst-case gap | 6 pts / 85, or a 12-pt gap | **2 pts / 80**, or a 10-pt gap |
| Scales in | no | no | yes, tiers 1.5 pts apart |
| Re-entry cooldown | 15s | 15s | **5s** |
| Max price | half the gap | half the gap | **tighter (¼ of the gap)** |
| Cut a loser when Kalshi pays | 3 pts over the bot | 3 pts over | **1 pt over** (still after the 30s hold) |
| Bet size | ¼ Kelly, ≤ $25 | ¼ Kelly, ≤ $25 | **½ Kelly, ≤ $50** |
| Practice | conf 90+, $5, $20/day, 10 trades | conf 85+, $5, $20/day, 10 trades | conf 80+, $10, $40/day, 40 trades |

**How Aggressive was chosen:**
1. A random search tried 100 strategy configurations at a fixed bet size, scored across 6 simulated Kalshi market types at instant and ~10s fills.
2. The top 8 were re-run on fresh seeds they weren't picked on.
3. The winner beat the previous Aggressive in 11 of 12 market/fill-speed cells.

On that fresh data, per 100 windows:

| Market type | Safe | Aggressive |
|---|---|---|
| Sloppy, instant | +$1,155 | **+$3,915** |
| 5s slow + noisy, instant | +$746 | **+$2,022** |
| 5s slow, instant | +$695 | **+$1,700** |
| Noisy ±4, instant | +$25 | **+$396** |
| Noisy ±2, instant | +$2 | **+$38** |
| Noisy ±4, ~10s by hand | +$17 | **+$174** |
| Sloppy, ~10s by hand | +$6 | **+$80** |
| Kalshi priced right, by hand | −$0.57 | −$7.31 |
| 5s lag, by hand | +$1.39 | −$2.85 |

The cost is swings: Aggressive's worst stretch was ~$90–200 (up to ~$280 by hand) vs Safe's ~$15–40.

Doubling the bet size again would double profit, but the worst stretch would reach ~$560, over 5× the $100 bankroll the bot sizes from, so it was not shipped. If you really have a bigger bankroll, set *Bankroll* in Settings and stakes scale with it.

**Every level re-enters.** After you sell (or Practice sells), the call on that market is released, and a new call can fire after the cooldown. Aggressive scales in by opening on a small gap and adding each time the gap clears the next tier. Phones holding the call get an **Add** push.

Editing the gap or confidence by hand shows as *Custom*.

### Max price and speed (why calls can lose money by hand)

Every call now comes with a **max price**: *"Buy YES at 40% · max 47%, skip if higher."* That's the most you can pay and still clear half the min gap with volatility 20% off either way. If Kalshi's price has run past it by the time you get there, skip the trade. Buy pushes say *"Act now"* and expire after 45 seconds, so a stale call never arrives late. The call card shows how long ago the call was made.

Why this matters: in the profit simulator, the same calls that made **+$459 per 200 windows when bought instantly lost $193 when bought 5 seconds later**. Much of the bot's edge is Kalshi lagging BTC by a few seconds, and that's gone by the time a person opens Kalshi.

Results with the max price, by how fast you buy:

| Buy within | Simulator result |
|---|---|
| ~5s | Profitable |
| ~10s | Modest profit in most market types |
| ~30s | Roughly break-even |
| ~60s | Losing |

Without the max price, every delay lost more.

Things tested and left off by default:
- **Requiring the edge to hold 30–60s** before calling: almost no calls left.
- **Blending in Kalshi's price** (*marketWeight*): fewer calls, no gain.
- **Capping edges** that look too good (*maxEdge*): steadier, but not more profitable.

### Auto-trade practice

Settings → **Auto-trade practice**. Turn it on and the app runs the rules an auto-trader would use, on live Kalshi prices, and logs every trade it **would** make. **It never places an order.**

The rules:
- **Buy** on a new BUY THE LOW call with confidence at or above *Min confidence* (default 85), at Kalshi's ask, only if the ask is at or under the call's max price.
- **One buy per window**, sized to *Max $ per trade* (default $5).
- **Stop buying for the day** after *Max trades / day* (default 10) or the *Daily loss limit* (default $20). Open positions count as fully at risk, so the limit can't be overrun.
- **Sell** on the same exits as real positions: take profit as soon as Kalshi pays what the bot thinks it's worth, and cut only after the hold-steady wait. Otherwise hold to settlement.

A **PRACTICE** strip on the Live screen shows what it's holding and today's P&L. The card shows today's and all-time results and the log, including why it skipped a call.

Caveats:
- It only runs while the app is open on screen.
- Fills assume the price on screen at that moment. Real orders can fill a bit worse.

Run it for a few days and compare the practice P&L with what the market actually did before considering real auto-trading.

### Range watch (experiment, inside Practice)

The ceiling/floor chart rule runs side by side with the bot's practice trades on its own paper book:
- **Ceiling and floor** are the highest high and lowest low of the last 20 one-minute candles, each touched at least twice, with a range at least 2× the average candle.
- **Rejected at the ceiling:** paper-buy NO. **Rejected at the floor:** paper-buy YES.
- One trade per window, held to settlement, sized like practice.

It never changes the bot's calls or places orders. The Practice card shows Range watch next to the bot's practice results.

Offline, on ~1,100 real candles from Oct 4, the rule was right about half the time overall. Floor bounces worked and ceiling rejections failed, likely because of that day's uptrend, so it's being measured live before it can influence anything.

### Trusting its gut

The bot sticks with its calls instead of reacting to every tick:
- **Once it calls a side, the call stands** while the robust gap is at least half of *Min gap* and confidence is within 10 of the cutoff. If the gap closes past that, the card says *Called YES earlier · no new buy*. It doesn't flip to PASS and back.
- **Switching sides in the same window** needs a 12-pt gap (Min gap + 4) and confidence 8 above the cutoff. A switch push says **Switch:** so it's clear the bot changed its mind for a real reason.
- **Selling at a loss** needs Kalshi to pay at least 3 pts more than the bot's odds, and that has to stay true for 30 seconds (*Hold steady*). In the meantime the position card says it's holding the call and counts down. A dip that reverses resets the clock. In the last minute there's no wait.
- **Taking profit stays instant**, because Kalshi's lag closes fast.

In the profit simulator this left profit unchanged and cut panic sells by 75–80%. The win rate rose 2–4 pts. The trade-off is a somewhat deeper worst losing stretch, because the bot now sits through more dips. Smoothing the bot's odds was also tested and dropped: it cost about 25% of profit.

### Selling for profit (exit signals)

The app can't see your Kalshi account. After you buy on Kalshi, tap **I bought it**. That's it: one tap, no typing. The app records the bot's side, Kalshi's live price and the exact time, and uses the bot's suggested amount. Set *Fixed trade amount* in Settings if you always buy the same dollar amount. An **Undo** bar appears for a few seconds in case of a mis-tap. Tap right after your Kalshi order fills so the recorded price matches your fill. A position card appears at the top and checks every tick whether to **HOLD** or **SELL NOW**:

| Signal | When | Why |
|---|---|---|
| **Take profit** | The bid, after the sell fee, is at or above the bot's odds | The low is gone. Holding is worth no more than selling |
| **Cut** | The bot's odds fall below what you could sell for, even at a loss | Holding is now worse than selling |

There's no sell on flip signs alone. They're listed on the position card as a **Flip watch**, but selling below what the contract is worth gave up profit in testing (higher win rate, less money), and holding to settlement also skips Kalshi's exit fee. Flip signs: a reversal candle against you (shooting star or bearish engulfing for YES, the mirror for NO), RSI rolling over from overbought or oversold, rejection at the Bollinger band, stalling at resistance or support, two strong candles against you, the bot's odds down *Odds drop* from their peak, or the bid down *Trailing drop* from its peak.

On a SELL NOW your phone vibrates and gets a notification with the price and P&L. Tap **I sold at 72%** right after cashing out. It's also one tap: the whole position is closed at Kalshi's live cash-out price and the time is recorded, with Undo. History shows when you bought and sold. Positions still open at expiry are settled automatically from Kalshi's result. Realized P&L shows under **History → My trades**.

### Health check (every 2 rounds)

While the app is open, it checks itself every 2 rounds: every 30 minutes, at :00 and :30, plus once about 20 seconds after you open it. **Settings → Health check → Check now** runs it any time. It checks:
- Kalshi and BTC prices are fresh
- The phone's clock matches the server (Kalshi refuses orders from a wrong clock)
- The Kalshi link and balance sync work (a deleted or wrong API key shows here)
- The live auto-trader: a stuck or failed order, low cash, a full budget, or a Min confidence that found no trades in an hour when a lower one would have
- Push notifications are on

Each problem comes with what to do about it. You're told once, with a toast and a notification, when a **new** problem appears. Problems that stay don't re-alert, and the Live card shows a line while any problem is open.

### Push notifications (app closed)

The server runs the same bot as the app, around the clock. It sends **Web Push** notifications for **BUY THE LOW** and **SELL NOW**, so you get them with the app closed and your phone locked.

1. **iPhone:** iOS 16.4 or later. Add the app to your Home Screen and open it from there. Safari tabs can't receive push. **Android:** Chrome works, installed or not.
2. Open **Settings → Turn on push notifications** and allow notifications.
3. Tap **Send test**. You should get "Shot Caller ✓" within a few seconds.

**Hourly updates:** once an hour (on the window that opens on the hour), every subscribed phone gets one push. It covers how the last window went (settled YES or NO, the odds the bot gave the winner, follow-the-bot result) and the read on the new one (target, where BTC is versus it, which way the bot leans, and BUY THE LOW if it's already a call). For example:

> 🕒 3:30 AM–3:45 AM window · target $84,812
> 3:15 AM window settled YES · bot had 67% on the winner · follow-the-bot +$3.20. Now BTC $84,820 (+$8) · bot leans YES 58% · BUY THE LOW YES · Above at 52%.

The server waits up to 4 minutes for Kalshi to settle the last window so the result is included. Times use the phone's time zone. Each update replaces the previous one in the notification list, and there's no update right after you first turn on push. Turn it off with **Notify: hourly updates**.

**No spam:** the server and the app share one limiter (`public/notify.js`):
- **Buy alerts:** at most 2 per 15-minute market (the first call, plus one switch or re-entry), at least 3 minutes apart.
- **Add alerts:** at most 1 per market.
- **Hourly cap:** no more than 6 buy, add and update alerts combined per hour.
- **Sell alerts:** one per position, never held back by the cap, because they're about money you hold.

An alert that gets held back is dropped, never sent late.

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
| Min confidence | 85 | Win odds (0–100) a call needs to fire |
| Rejection weight | 1 | How much rejection trends move the odds (0 = off, 1 = up to ±5 pts) |
| Min gap | 8 pts | How far Kalshi's price must be below the bot's odds, after fees, even with volatility 20% off either way |
| Also wait for candle dip | off | Only alert when the candles show a dip too |
| Notify: buy the low / sell now / hourly updates | on / on / on | Which push alerts to send |
| Min profit | 1 pt | Profit per contract, after both fees, for a sell to count as taking profit |
| Trailing drop | 6 pts | Sell-% drop from its peak that shows as a flip sign (warning only) |
| Odds drop | 8 pts | Bot odds drop from their peak that shows as a flip sign (warning only) |
| Max spread | 10¢ | Skip illiquid books |
| Wait before calling | 5 min | Minutes into each window before any call |
| Min minutes left | 0.5 | Stop calling this close to settlement |
| Vol multiplier | 1.0 | 1 = measured volatility; higher expects bigger swings (odds closer to 50/50) |
| Momentum weight | 0 | Fraction of the 10-min drift carried forward (0 = pure random walk) |
| Bankroll / Kelly fraction / Max stake | $100 / 0.25 / $25 | Position sizing |

Configure the upstream APIs with the `KALSHI_API` and `COINBASE_API` env vars.

## Known limitations

- Coinbase spot differs a little from BRTI. Near the strike in the final minute, that gap matters.
- Realized vol lags regime changes such as news or liquidations.
- The strike comes from Kalshi's `floor_strike`. If that field is missing, the app uses the BTC open price of the window.
