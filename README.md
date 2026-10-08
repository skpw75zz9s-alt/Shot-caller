# Shot Caller

A mobile signal bot for **Kalshi's 15-minute Bitcoin markets** (series `KXBTC15M`). It's a phone-installable web app (PWA). It watches the open market, prices it with a volatility model and calls a shot: **YES** (BTC above the target at close), **NO** (below) or **PASS**. Each call comes with a suggested size.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/skpw75zz9s-alt/Shot-caller)

> **Signals first.** Out of the box it never places orders: you trade yourself. The optional **Auto-trader** (v7) can trade the bot's calls, starting in Test mode with pretend money; real-money Live mode stays locked until Test has run clean. Linking a Kalshi account only reads your trades unless you turn Live on.
> No model reliably beats these markets. Watch the paper P&L in the History tab before you risk real money.

## The app (v6)

Six tabs along the bottom:

- **Deck.** The command deck:
  - **Status tiles:** live feed, a server-synced clock, the active contract, and the bot's verified record.
  - **The call:** UP, DOWN or SIT OUT, with a confidence / hold odds / flip risk meter.
  - **Kalshi prices:** UP and DOWN buy prices in cents, next to the bot's odds.
  - **Contract stats:** live BTC, price to beat, distance, time left, data health, and what the bot learned.
  - **Tug of war:** the bear (sell pressure) against the bull (buy pressure); the winning side grows and pulses. It shows buy versus sell pressure from Coinbase's live trades over the last 2 minutes, round flow, whale trades, and the distance to the round's floor and ceiling.
  - **Live orders · all markets:** a live tape of every BTC/USD trade on Coinbase, Kraken, Bitstamp, Gemini and Binance.US, plus the trades on the live Kalshi contract.
    - The phone connects straight to each exchange's public WebSocket, with no keys and no server in between. Kalshi's trades are polled every 3 seconds through the server's market-data proxy.
    - It shows a status chip per feed, trades per minute, and each exchange's buy/sell split for the round.
    - A Kalshi view shows how many UP and DOWN contracts takers bought, and for how much.
    - Whale trades are marked 🐋.
    - All exchanges feed the tug of war and whale alerts.
    - Turn the extra exchanges off in Settings ("Live orders from all exchanges") to save data. Coinbase stays on.
  - **Suggestions** (top of the Deck, and a bar on the call card), from `public/suggest.js`:
    - **CONFIDENT BUY:** the call clears the strictest bar (confidence 90+ and hold odds 90%+), full suggested size. The lock-in says "CONFIDENT · LOCKED", and pushes say "Confident buy".
    - **BUY:** a call on your risk level.
    - **BUY LIGHT:** a real gap that holds even if volatility is a bit off, confidence 80+ and hold odds 60%+, but under one of your level's bars. It says which bar it missed and suggests about a third of a normal bet. It's an optional, lower-conviction idea, not a call: it doesn't lock, isn't logged and isn't in the record.
    - **WAIT:** nothing worth buying.
    - For each position you hold:
      - **SELL HIGH:** in profit, and Kalshi pays at least what it's worth. It rings the cash register.
      - **BAIL:** losing, and Kalshi pays clearly more than it's worth. It shouts "Bail!".
      - **WATCH:** a sell signal that's still being confirmed.
      - **HOLD:** worth more than Kalshi pays.
  - **Live notes:** a running feed of what just happened.
  - **Why this call / rejections:** both fold away.
- **Chart.**
  - Timeframes: round, 1m, 5m, 15m, 1h, 4h, 1D.
  - Toggleable overlays: target, EMA 9/21, RMA 9/21, Bollinger 20 ±2σ, VWAP from the round open, round floor/ceiling, the forecast cone, volume, RSI 14 and MACD 12/26/9 panes, call markers and price labels.
  - **Bull and bear:** a big faded bull or bear behind the candles shows the trend (EMA 9 above or below EMA 21). Small ones mark EMA crosses, and bull and bear heads mark the bot's UP and DOWN calls. Indicators warm up on the full history, so they're ready even at the start of a round.
  - The **forecast cone** is the bot's own: where BTC usually ends by the close at the bot's volatility, showing the middle 50% and 90% of outcomes.
- **Alerts.**
  - Sound and banner switches for every event, each with a Preview button.
  - Events covered:
    - calls, wins and losses, sat-out rounds;
    - flip warnings (the bot leans against your call for 10s) and high flip risk (hold odds below your threshold for 10s);
    - BTC crossing the target, pressure flips, whale buys and sells;
    - position sell signals, and live data lost or back.
  - Quiet mode, volume, banner length, repeat cooldown, whale minimum and flip-risk threshold, plus an alert history.
  - **Sounds:**
    - UP calls get a bull (snort and bellow) and DOWN calls a bear roar; chart trend turns use the same two.
    - Sitting out a round says "Wait." and a sell signal shouts "Bail!".
    - A win rings a cash register.
    - Everything else has its own tone.
  - The clips are `public/sounds/*.mp3`:
    - "Wait." and "Bail!" are a natural neural voice: Piper's LibriTTS voice, speaker 135, made by `scripts/make-voice.py`. The voice is trained on LibriTTS (CC BY 4.0, openslr.org/60), so commercial use is fine with credit; the Learn tab gives it.
    - The bull and bear are real recordings supplied by the app owner (posted as free to use), trimmed and leveled. The synthesized versions are still available with `scripts/make-sounds.py --synth-animals`.
    - The cash register is synthesized by `scripts/make-sounds.py`.
  - **Your own sounds:** Alerts → Sounds lets anyone pick an audio file on their phone for each slot (bull, bear, wait, bail, cash register), for example a free one from Pixabay or Freesound. It's kept on that phone in IndexedDB, works offline, and Reset brings back the built-in one.
  - Phones need one tap to allow sound. Push notifications with the app closed use the phone's normal notification sound, because the web can't attach custom sounds to them.
  - **Call lock-in animation:** when the bot makes a call, the bull (UP) or bear (DOWN) slams in, the padlock snaps shut, and "CALL LOCKED" shows with the confidence, hold odds and price. It lasts about 3 seconds; tap to dismiss.
  - **Bull / bear charge:** when the 1-minute chart turns bullish (EMA 9 crosses above EMA 21 and holds for 15 seconds), the bull gallops across the screen with "BULLS TAKING OVER". A bearish turn sends the bear the other way.
    - The first trend after opening the app doesn't count, and a quick wiggle across doesn't either.
    - Both animations can be switched off and previewed in Alerts. Quiet mode silences them, and the phone's reduce-motion setting turns them into a simple fade.
- **Record.** The official bot record, calls seen on this phone, your trades, and what the bot has learned.
  - **Official bot record:** the server's own bot runs on the default Steady settings around the clock, with or without phones connected. Every call it makes is graded against Kalshi's real result, and every user sees the same record.
  - It shows wins and losses, win rate, the current streak, the best win streak, and the confidence it claimed versus how often it won. It also shows $10 a call held to settlement after fees, a 14-day win/loss chart, results by confidence, and the latest calls (WIN / LOSS / LIVE).
  - The Deck's "Bot record" tile shows it too.
  - Losses are never hidden or reset. The record is kept in `record.json` in `DATA_DIR`, so add the Railway volume or it restarts with each deploy.
- **Learn.** How calls, hold odds, the indicators and the tug of war work, in plain words.
- **Settings.** As before.

**Flip risk** is 100 minus the hold odds. Hold odds come from 300 simulated paths and were tested against outcomes (see Risk level), so flip risk is a measured number, not a made-up score.

**Order flow and whales** come from every exchange's public trade feed (see `public/feeds.js`). Each feed is turned into the aggressor's side. Coinbase and Gemini report the resting (maker) side, so it's flipped. Binance.US says whether the buyer was the maker. Kraken and Bitstamp give the aggressor directly. They're shown as context and don't move the call: they haven't been tested as predictors of the 15-minute result.

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

Every confidence bar doubled in v4.1. Aggressive went from 40 to **80**, and Balanced and Safe now need **85** and **90**.

**Smart exception (big gaps):** a call under the bar still fires when its gap is huge **even at the worst volatility guess**: 15 pts on Safe, 12 on Balanced, 10 on Aggressive. These are usually cheap sides that Kalshi has badly underpriced. They win less often at settlement but are worth more than they cost, and most get sold at a profit before then. Push alerts mark them *big-gap exception*.

Tested on 48 fresh simulated runs per level (6 market types × 8 seeds × 400 windows):

| | Old bars (40 / 55 / 60) | New bars + exception |
|---|---|---|
| Aggressive | +$503 per 100 windows, 90% of trades won | **+$636, 92% won** (worst drawdown $400 vs $280) |
| Balanced | +$231, 91% won | **+$248, 94% won** |
| Safe | +$228, 93% won, 39 trades | **+$226, 94% won, 19 trades** (half the trades, same profit) |

Without the exception, the high bars alone cut profit by 60–85%. On a perfectly efficient Kalshi, no setting makes money, old or new. The edge only exists when Kalshi lags or misprices.

### Call record (History)

Every BUY THE LOW call the bot makes while the app is open is logged. When Kalshi settles the market, the call is graded.

History shows:
- How many calls won.
- The win odds the bot claimed (its confidence), on average and by confidence range.
- What $10 on every call would have made, held to settlement after Kalshi's fee.

This is the real accuracy test. Calls rated 85–90 should win about 85–90% of the time. Under about 30 graded calls, luck still dominates.

**How accurate the odds are (simulated).** The test used 114,000 moments from synthetic BTC with fat tails and changing volatility:
- When the bot's own odds said 80–85%, it won 80–82% of the time. When they said 90–95%, it won 90–92%.
- Confidence (the most cautious of three volatility guesses) runs conservative. Confidence 85–90 won 91–92%.
- Three alternative volatility estimators scored no better: a 50/50 short/long blend, a slower EWMA, and completed candles only.

The model is already close to the limit set by BTC's randomness. Fancier math won't make it many times more accurate. What decides profit is whether Kalshi's price is wrong, and only the live call record can show that.

### BTC index estimate (several exchanges)

Kalshi settles on CF Benchmarks' BRTI, which is built from several exchanges, not Coinbase alone.

- **What the server reads:** the mid price on Coinbase, Kraken, Bitstamp and Gemini, every 5 seconds.
- **How it combines them:** it takes the median, dropping any quote that's more than 15 seconds old or more than 0.3% from the rest.
- **What the phone does:** it shifts its live Coinbase price by that offset before pricing a call.
- **Fallback:** if fewer than two exchanges answer, the bot uses Coinbase alone.
- **What's left over:** the remaining gap to Kalshi's settlement is learned as the basis (see below).
- **Switching it off:** set `INDEX=off` to use only Coinbase.
- **Not yet tested live:** the exchange feeds couldn't be reached from the development sandbox. The code is covered by unit tests with sample replies.
- **Live check:** run `npm run livecheck` anywhere with internet access. It checks that:
  - each exchange answers and its price parses;
  - the exchanges agree on an index estimate;
  - Kalshi lists an open market;
  - Kalshi reports settlement values, which the basis learner needs.

  On the deployed app, open `/api/index` (signed in) to see the live estimate and which exchanges it used.

### Learning the market (day, week, year)

The server watches BTC and every 15-minute window around the clock, even with every phone closed. It learns three things and uses them in every call, on the phone and in push alerts. The History tab shows what it has learned so far.

1. **Volatility by time of week.** It learns how wild BTC usually is in each half hour of the week, in New York time, so the US open and 8:30 news line up all year.
   - When the next 15 minutes are usually busier than the last half hour (or calmer), the bot prices that in before the move arrives.
   - On first start it reads 4 weeks of 1-minute history from Coinbase, which takes about a minute.
   - Old weeks fade out with an 8-week half-life, so it keeps up with the seasons.
2. **Calibration.** For every settled window, it checks how often the side it favored really won at each level of odds. It corrects only the part of a miss that is bigger than luck (2 standard errors). Corrections are capped at ±5 pts, and memory fades over about a year.
3. **Basis.** It learns the gap between Coinbase (the app's price) and the index Kalshi settles on, from Kalshi's reported settlement values. It uses the median of the last 100, and only after 10 settlements.

You can turn this off in Settings under "Use what the bot learned".

**What it's worth (simulated).** Each test trained on 6 weeks of synthetic BTC, then scored 1,500–3,000 new windows. Synthetic BTC here has a weekly volatility pattern, fat tails and changing volatility. A Brier score measures probability error; lower is better.

| Case | Without learning | With learning |
|---|---|---|
| Index $15 above Coinbase: Brier | 0.162 | 0.131 |
| Index $15 above Coinbase: calls the bot gave 85% | won 75% | won 85% |
| Index $5 above Coinbase: Brier | 0.128 | 0.125 |

- **Time of week alone:** odds got a little more accurate at busy and quiet times, and stayed about even overall.
- **Calibration when the bot was already right:** no corrections, so no harm.
- **Calibration when the bot underestimated volatility by 20%:** its 90%+ odds were pulled 1.5–3 pts toward the truth.

**Keep what it learns:** it's saved in `learned.json` in `DATA_DIR`. Add the Railway volume (see Push notifications below) so calibration and the basis survive redeploys. Without the volume, the time-of-week pattern is re-read from history in about a minute after each deploy, but calibration and the basis start over. Set `LEARN=off` to stop watching while no phone is subscribed.

### Two rejections in a row (calling rule)

When price gets rejected **twice in a row at about the same level** inside the window, it tends to go the other way. Twice at the top means down; twice at the bottom means up.
- **Counts as a rejection:** a candle that pokes at or near the window's high or low and closes well back, with a wick of at least 0.35× the average candle range and about as long as its body.
- **When it fires:** the last two rejections point the same way, within half an average candle range of each other and 2–12 minutes apart. The second must be in the last ~5 minutes, and no candle can have closed through the level since.
- **What it does:** no new call against it, and the call card says so (*NO looks cheap, but not calling it: Two rejections in a row at $85,392: expect down*). The bot's odds lean that way. The deep dive scores it +10 when the call agrees and −15 when it's against.
- **Scorecard:** every time the rule fires on a real market, the app records whether price moved the expected way 5 minutes later and whether the side it favored won at settlement. The score shows in the Health check card (Settings). The pattern couldn't be checked against enough real history from here, so this is how to find out whether it holds up.

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

### Link your Kalshi account (optional)

Settings → **Kalshi account**. On Kalshi, go to Account → API keys → Create key, then copy the key ID and download the private key file. Paste the key ID, then paste the key or pick the file, and tap **Link account**. The app checks the key by reading your balance.

Once linked, the app reads your **fills** (every buy and sell, with exact price, size and time) every 10 seconds and whenever you open it. It also imports the last 24 hours when you first link:
- A buy in the current series becomes a position card marked *From Kalshi*. The "I bought it" button goes away.
- Adding to a position averages the price in.
- A sale, partial or full, goes into **My trades** at the price you actually got.
- Buying the other side nets out, the way Kalshi does it.
- Positions you hold to settlement are scored when the market settles.
- Positions sync to the alert server as before, so SELL NOW pushes keep working with the app closed.
- Fees in P&L are Kalshi's actual fees when the fill reports them, otherwise Kalshi's taker formula.

Security:
- **The key never leaves the phone.** It's imported as a non-extractable WebCrypto key in IndexedDB, so it can sign requests but can't be read back out, not even by the app's own code. The pasted text is cleared right away.
- Each request is signed on the phone (Ed25519 or RSA-PSS, matching the key type Kalshi issued). The server only forwards the signature headers.
- Reads: the server forwards GET requests only for `portfolio/fills`, `positions`, `balance` and `settlements`, and never caches the responses.
- Orders: only the Auto-trader sends them, and only in Demo or Live mode. The server re-checks every order (`validateOrder`): BTC 15-minute markets only, fill-now-or-cancel only, whole cents, at most $100 to open a position (`AUTO_MAX_ORDER_USD`), no extra fields, at most 30 a minute. It can't cancel orders or reach anything else. A read-only key is enough unless you use Live.
- **Unlink** deletes the key from the phone. Deleting the key on Kalshi cuts access everywhere.

**Account sync matches Kalshi:** Kalshi's own records are the source of truth, checked on every sync:
- **Fills** are read in full (every page) and on the right side. Newer fills give the side in `outcome_side`. Their `side` field can say "bid"/"ask", which older versions read as YES. Every trade records the exact fee Kalshi charged (`fee_cost`) instead of an estimate.
- **Positions** are compared with Kalshi's positions list. If the app's count, side or average price differs, Kalshi wins. The Kalshi card says *✓ matches Kalshi* or *corrected from Kalshi: 56 YES → 9 NO*.
- **Settlements** close linked positions from Kalshi's settlement records. The market result is used only as a fallback 15 minutes after close.

### Market pulse: stability and pressure (v7.2)

The Chart tab opens with **Market pulse**:
- **Stability, 0-100.** 👍 **stable** (70+), 🤷 **moderate** (45-69), red 👎 **unstable** (under 45). It also shows as a chip under the call.
  - Points come off for: 1-minute volatility above its 2-hour norm, a shock candle in the last 10 minutes, the bot's odds whipsawing across 50/50, Kalshi's price jumping 6¢+, and a usually busier time of week coming up (`stability()` in `public/analysis.js`).
  - Each deduction is listed under the score.
- **Buy vs sell pressure**: the same tug of war as the Deck, from the last 2 minutes of trades on 5 exchanges.

**More calls at the same 85+ bar.** Steady waits for the confidence to hold before it calls. That wait now follows stability: **30s** when 👍 stable, **60s** when 🤷 moderate, **90s** when red 👎 unstable (Sniper: 45 / 90 / 135s). In the same simulation (3 × ~13,000 rounds):

| Wait before calling | Calls per 100 rounds | Won |
|---|---|---|
| fixed 60s (before) | 49 | 95.5% |
| by stability (now) | 67 | 94.8% |
| no wait | 92 | 92.1% |

That's about 37% more calls, every one still at confidence 85+, for under a point of win rate. Turn it off with `steadyByStability: false`.

Stability is information, not a filter. In a simulation with calm, normal and jumpy stretches (20,000 rounds × 3 seeds), skipping calls when it read "unstable" didn't raise the win rate. Those calls won more, not less, because the bot's own volatility already prices a jumpy market in. So it shows on the call and in "Why this call", but it doesn't block calls.

### Bail out (v7.4)

When a call goes bad, the bot calls the bail-out instead of riding it to zero. It sells once its odds for the called side fall under the **bail-out line (40% by default; Settings, 0 = off)**. It doesn't bail in the last 30 seconds, when the price is nearly settled.
- **Deck:** the call card flips to **BAIL OUT** and shows the price to sell at. It also shows in Suggestions, plays the "Bail!" sound and sends a push with the app closed. It stays up for the rest of the round, with no new buys.
- **Your tracked positions:** the position card says BAIL OUT right away, with no 30-second wait.
- **Auto-trader:** sells on it the same way.

From a simulation of 2 × ~9,000 calls, priced as a fair market:

| Bail when the bot's odds fall under | Calls that lose everything | Average loss | Cost per contract |
|---|---|---|---|
| never | 5.2% | 94¢ | — |
| **40% (default)** | **1.6%** | **73¢** | **0.3¢** |
| 50% | 1.3% | 62¢ | 0.4¢ |

The trade-off: about a third of bailed calls would have come back and won. Bailing gives up a little on average to stop the big losses.

### Auto-trader (v7)

Settings → **Auto-trader**. It buys the bot's **Steady** calls (whatever risk level the screen shows) and sells on the SELL HIGH / BAIL signals.

| Mode | What happens |
|---|---|
| **Off** | Nothing (the default; Demo and Live also switch back to Off when the app reloads) |
| **Test** | A simulator on Kalshi's live order book: fills at the real prices, with Kalshi's fee, against a pretend balance. Nothing is sent |
| **Demo** | Real orders on Kalshi's demo exchange (fake money), with a separate demo key from demo.kalshi.co |
| **Live** | Real orders, real money, with your linked key (needs trading permission). Locked until Test has settled 10 trades without a serious error, then asks you to confirm |

Your limits (all editable): **max per trade** ($10), **daily loss stop** ($30, counting what's still open), **max buys a day** (20), **max open at once** ($40). **STOP** is on the card and on the Deck tab while it runs. Each mode keeps its own history and P&L.

Built so the old auto-trader's errors can't happen (`public/trader.js`):
- **No "insufficient balance".** It only sends fill-now-or-cancel orders, so nothing rests on Kalshi holding cash. Right before each buy it re-reads the balance and the order book, and sizes the order so contracts × max price + Kalshi's fee (rounded up per fill, a cent extra per price level) fits under the cash with a 5¢ cushion. If one contract doesn't fit, no order goes out.
- **No rate-limit errors.** One request at a time, at least 350 ms apart.
- **Never buys twice.** Each order has its own client order id, and a retry reuses it. If an answer gets lost (a timeout, or the app closed mid-order), it reads the position back from Kalshi before doing anything else and books what actually filled.
- **Never oversells.** Sells are reduce-only and sized from Kalshi's own position count.
- **Errors stop it.** Three Kalshi errors in a row pause it for 15 minutes. A refused key or a refused order stops it until you tap Resume.

Tested against a strict fake Kalshi (`test/trader.test.js`):
- The fake refuses anything off: wrong fields or formats, collateral plus fees over the balance, reduce-only overselling, reused order ids, requests too close together.
- Thousands of simulated rounds, including a "bad day" where 5% of requests fail or time out after going through.
- Results: zero refused orders, no double buys, its ledger always matches the fake exchange's positions, and every limit held.

### Risk level

Settings → **Risk level**. Each level sets the whole strategy.

**Steady (default since v5.3): calls that hold.** Confidence moves with BTC, so no call can promise to stay at 85–90 all round. Steady only calls when that's likely, using three rules:
- **Confidence 85+ that has lasted.** The bot's odds must have stayed at 85+ for a full minute, not one lucky tick.
- **Hold odds of 80%+.** The bot simulates 300 paths of BTC for the rest of the window, each with its own volatility. In at least 80% of them, the side's confidence must stay above 80 until the last minute. Every call card shows these hold odds.
- **Locked call.** Once a side is called, it never switches sides that round.

In simulation (9,000+ moments at confidence 85+):

| Calls | Confidence stayed above 80 all round | Won |
|---|---|---|
| Confidence 85–90 alone | 65% | 92–94% |
| Confidence 85+ alone | 84% | 96.5–97.5% |
| **Steady (85+ and hold odds 80%+)** | **93%** | **98.4–98.9%** |
| **Sniper (90+ held 90s, hold odds 90%+)** | **97–98%** | **99.2–99.6%** |

**Sniper** is the strictest level. It needs confidence 90+ that has held for 90 seconds and hold odds of 90%+, and its minimum gap is 3 pts. It makes the fewest calls, and they're priced high, so each win pays only a few cents. One loss erases many wins. The hold odds came true: predicted 78% held 79–81% of the time, and predicted 90% held 87–88%. Steady makes fewer calls, and calls that hold are often priced high on Kalshi, so each win pays less. It still isn't 100%: about 1 in 15 Steady calls drops below 80 at some point, and a few lose. Phones on Balanced moved to Steady in v5.3, and Balanced is still available.

| | Safe | Balanced | Aggressive |
|---|---|---|---|
| Min gap / confidence (win odds) | 8 pts / 90, or a 15-pt worst-case gap | 6 pts / 85, or a 12-pt gap | **2 pts / 80**, or a 10-pt gap |
| Scales in | no | no | yes, tiers 1.5 pts apart |
| Re-entry cooldown | 15s | 15s | **5s** |
| Max price | half the gap | half the gap | **tighter (¼ of the gap)** |
| Cut a loser when Kalshi pays | 3 pts over the bot | 3 pts over | **1 pt over** (still after the 30s hold) |
| Bet size | ¼ Kelly, ≤ $25 | ¼ Kelly, ≤ $25 | **½ Kelly, ≤ $50** |

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

**Every level re-enters.** After you sell, the call on that market is released, and a new call can fire after the cooldown. Aggressive scales in by opening on a small gap and adding each time the gap clears the next tier. Phones holding the call get an **Add** push.

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
- Push notifications are on

Each problem comes with what to do about it. You're told once, with a toast and a notification, when a **new** problem appears. Problems that stay don't re-alert. The card also shows the two-rejections rule's scorecard.

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

- Service → **Settings → Volumes → + New Volume**, mount path `/data`. That's all: the server finds the volume on its own (Railway sets `RAILWAY_VOLUME_MOUNT_PATH`), and `DATA_DIR` is only needed to override it.
- As admin, the app's Health check (Settings) warns "Server data resets on every deploy" until the volume is attached. `/healthz` shows `storage.persistent`.

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
- Service → **Settings → Volumes**: mount a volume at `/data` (picked up on its own). **Without it, every redeploy wipes all paid members, the bot record and what the bot learned.**
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

- Coinbase spot differs a little from BRTI. The bot learns the typical gap from Kalshi's settlements (after 10), but the gap moves around during the day.
- Realized vol lags regime changes such as news or liquidations.
- The strike comes from Kalshi's `floor_strike`. If that field is missing, the app uses the BTC open price of the window.
