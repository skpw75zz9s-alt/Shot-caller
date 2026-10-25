# Shot Caller

A mobile signal bot for **Kalshi's 15-minute markets**: Bitcoin by default (series `KXBTC15M`), and every other 15-minute market Kalshi lists (other coins, stock indexes, gold, oil), picked from the menu up top. It's a phone-installable web app (PWA). It watches the open round, prices it with a volatility model and calls a shot: **UP** (YES: above the target at close) or **DOWN** (NO: below). Buy calls come with a suggested size, and every round gets a locked round call once its first 5 minutes are up.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/skpw75zz9s-alt/Shot-caller)

> **Signals first.** Out of the box it never places orders: you trade yourself. The optional **Auto-trader** (v7) can trade the bot's calls, starting in Test mode with pretend money; real-money Live mode stays locked until Test has run clean. Linking a Kalshi account only reads your trades unless you turn Live on.
> No model reliably beats these markets. Watch the paper P&L in the History tab before you risk real money.

## The app

Along the top: the market picker, **Ask** (the chat button: type a question about the live round and get a deep dive from the live numbers, see v13.47), **Simple / Pro** (Simple shows just the call; Pro shows every card and tab) and split screen.

Nine tabs along the bottom (Simple mode hides Radar, X-ray and Learn):

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
- **Radar.** The market radar: the next few minutes' likely path with 90% bands, its graded record, and every exchange in the round scan (see v13.2 and v13.10).
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
- **Map.** The map to success: your stats, the road from first call to steady results with a tip per step, and the coach.
- **X-ray.** A scanner sweeps the live round like an x-ray film, hunts for breaks in the market (marking each with a crack) and shows the stats that help but nobody looks at (see v13.58).
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

## Version notes (newest first)

### The Fact checker (v13.91)
A new hire in the hiring center: the **🔬 Fact checker** (`public/hires.js factCheck`), in the grading room. It puts six claims about the bot to a real test on the official record and gives each **TRUE** (the evidence is clearly for it, at 95%), **FALSE** (clearly against it, or for a "does better" claim, the difference shown to be under 5 points either way), or **UNPROVEN** (not enough evidence yet, with about how many more calls it would take if the gap held):
1. The calls win more than half the time (Wilson 95% range against 50%).
2. The calls win more often than their prices say they should (wins minus the wins the prices needed).
3. Wins and losses come in streaks (Wald-Wolfowitz runs test).
4. The calls are getting better (the newer half's edge against the older half's).
5. UP calls do better than DOWN calls.
6. Pricier calls (85¢ and up) beat their prices more than cheaper ones.

Groups are compared by their edge over their prices, so cheap and pricey calls are judged fairly; each test needs 30+ calls in each group. It applies at 60+ graded official calls and tells the Caller (and for 2 and 3 the Risk officer) when a claim is settled. Unproven is not false, and with six tests at 95% one verdict in a few reports can be luck.

### Order book heatmap and CoinGlass (v13.90)
- **Heatmap** (free, on the Pending orders card): like Bookmap's. The server already reads Kraken's order book for BTC, ETH, SOL, XRP and DOGE every 15 seconds; every 30 seconds it now also keeps the dollars resting at each price (bucketed on a fixed grid of about 0.04% of the price, within 1% of it, the 40 biggest per side), for the last hour, and keeps them through restarts. The phone draws it: price up the side, time along the bottom, green buy orders below the price, red sell orders above, brighter where more dollars sit, the white line the price. `GET /api/heatmap?m=`.
- **CoinGlass** (needs your own key, a paid plan at coinglass.com/pricing): a "Futures market" card with open interest across the big exchanges, OI-weighted funding, liquidations (Binance, OKX, Bybit) and Binance's long/short accounts. `py scripts\shotctl.py env set COINGLASS_API_KEY=your-key` then restart. Fetched only while someone looks, kept a minute. Each reading is fetched on its own, so one your plan doesn't include shows its error and the rest still show. `COINGLASS_INTERVAL` (default `4h`, the smallest the cheapest plan allows). `GET /api/coinglass?m=`. Context only: no call uses either.
- Bookmap itself is a desktop app with no feed a server can use, so the heatmap is built from the book the bot already has.

### The Restart watcher tells planned restarts apart (v13.89)

On a home server every update restarts the app on purpose, so the Restart watcher's "the server keeps restarting" flag went off for nothing. `scripts/shotctl.py` now leaves a note (`DATA_DIR/planned-restart.json`) before a planned stop: an update installing itself, `restart`, `stop`, a backup restore. A start within 10 minutes of that note is recorded as planned (`hiring.js`). The watcher counts only unplanned starts (crashes, reboots, power cuts) toward its 10-a-week warning and shows the planned ones next to them. Starts from before this version can't be sorted, so they aren't counted.

### A stronger flip watch (v13.88)

Flip warnings and the chart's ↺ turn marks were going off on noise. Now:

- **Flip warnings** ("the bot now leans against its call"; Discord, push and the phone) used to fire the moment the call's odds dipped under 50%, for a single tick, so a price wobbling around the target set them off again and again. A warning now needs the call's odds **40% or under for 20 seconds straight**, with **a minute or more left** to act; a wobble back over 45% starts the count again (`public/flipwarn.js`, shared by the server and the phone).
- **They're graded.** Every warning is checked when its round settles (right = the called side lost), kept in `DATA_DIR/flipwarn.json`, and each Discord warning shows the record so far. If they prove no better than a coin flip (20+ graded, the 95% low end of their hit rate under 50%), the bar rises on its own to **30% held 45 seconds**.
- **The flip check's warning** (chart history and buyers/sellers) now needs a 60%+ chance of the call losing, held 20 seconds, with a minute left (was 50%, 10 seconds).
- **↺ marks on the chart** only show when the move is ripe to turn (flip score 50%+) and the turn is a real one (0.6 of a typical minute either side, was 0.2), and they switch off while their own record proves them no better than a random minute. The prediction path still bends the same way; only the marks (and the turns graded) are stricter.

### The Mathematician (v13.87)

A new hire in the hiring center: the **🧮 Mathematician** (`public/hires.js recordMath`), in the grading room. It works the official record out exactly, as $10 calls held to settlement after Kalshi's fees:

- the win rate with its **95% range** (Wilson), and the win rate the calls' prices needed to **break even** (each call's −loss ÷ (win − loss), averaged)
- the **average profit per call** with its standard error, and the total
- a verdict: **proven ahead** of its prices (the whole range above breakeven), **proven behind** (the whole range below), or **not decided yet**, with about how many more calls it would take at the current gap. Under 30 calls nothing is proven.
- once an edge is proven, the **Kelly stake** (and half of it, the usual safer size)

It tells the Risk officer when the record is proven either way, and the Trader the Kelly stake. Exact math on the past, not a forecast: like every agent it reports, and no call uses it.

### Members and new buyers in backup mode (v13.86)

While the home server is off, the Cloudflare backup now handles the paywall too:

- **Members sign in with their code.** Every few minutes the server sends the backup its member list (codes, status, expiry; never sessions) and the price (`edgesync.js` → `POST /__edge/members`, kept in the Worker's free KV storage `EDGE_KV`). A revoked code is out there too, and a renewal counts.
- **New buyers can buy.** The backup makes the code (same format), takes "I've paid", and the admin can approve, deny or revoke from the app's admin panel as usual.
- **Everything comes back.** When the server is up it fetches what happened on the backup (`GET /__edge/changes`) and merges it into its list (`access.js mergeEdge`: each record carries `updatedAt`, the newer side wins). A payment made while it was off sends the admin the usual "payment to verify" ping then. The backup then drops what was merged.

The `/__edge/` calls need `EDGE_SECRET` and are answered by the Worker itself, never passed to the server. `shotctl.py cloud-backup` creates the storage (`shotcaller-edge`) and keeps this machine's Worker settings in `cloudflare/wrangler.local.jsonc`.

### The RSI agent (v13.85)

A new hire in the hiring center: the **📈 RSI agent** (`public/rsiagent.js`), on the Market desk. Approve it in Settings → Admin → Hiring center and it joins the team of every market.

- **Reads** RSI 14 on 1-, 5- and 15-minute candles (70+ overbought, 30 or under oversold) and spots a fresh divergence on 1 minute (a new 30-minute high on weaker RSI, or a new low on stronger RSI).
- **Tests** every past 15-minute round in the market's saved history (up to 21 days of 1-minute bars, `bars.json`) that opened with the 1-minute RSI at an extreme: did it reverse (overbought → down, oversold → up) more often than the base rate of up rounds says? 30+ extreme rounds and z ≥ 2 proves **extremes fade**, z ≤ −2 proves **extremes run** (momentum), anything else is **no proven edge**. The test is redone each new round.
- **Tells** the Scout and the Caller when 1-minute RSI hits an extreme or a divergence prints, and what the test says about it.

Like every agent it reports and informs: no call uses it.

### Backup mode on Cloudflare (v13.84)

When the home server is off, the site no longer goes dark. A Cloudflare Worker (`cloudflare/worker.js`, free plan) sits in front of the app's address:

- **Home server up:** every request goes to it through the tunnel (`ORIGIN`), as before. The Worker adds the visitor's address with the shared `EDGE_SECRET`, so the server's sign-in limits still count each visitor separately (`clientIp` trusts `x-sc-client-ip` only with that secret).
- **Home server down** (unreachable, over 20 seconds, or Cloudflare's dead-tunnel page): the Worker serves the website and the app's files itself, behind the same paywall. Members get in with the signed pass their phone already keeps: the Worker checks it with the server's `ACCESS_SECRET` and gives the phone its own signed cookie until the pass runs out. The admin code works too (`ADMIN_CODE`). It fetches the market data the phone needs (Kalshi's and Coinbase's public prices, the same read-only paths the server allows) and a snapshot of Kraken's order book (`bookmath.js`, shared with the server). The phone works out the calls itself, so prices, the chart and the bot's calls keep going, under a *Backup mode* banner.
- **What waits for the server:** Discord, push, the Auto-trader, the official record, the bot team and the other server-side cards, and buying or approving codes. Those answer "offline". The Worker stores nothing, so nothing is lost or split: everything picks up when the server is back.

Set up the easy way: with the tunnel route below in place, run `python3 scripts/shotctl.py cloud-backup` on the home server. It signs in to Cloudflare (a browser window), uploads the Worker as `shotcaller-backup` and copies `ORIGIN` (`https://home.<APP_URL host>`, or `--origin`), `ACCESS_SECRET`, `EDGE_SECRET` and `ADMIN_CODE` from `.env` into it as secrets. Then add your domain to it as a Custom Domain. After that, `up` uploads the backup again by itself whenever an update changes the app's files (`public/`), so its copy never falls behind; `cloud-backup` again does it by hand.

Or set it up in the Cloudflare dashboard:
1. **The tunnel:** add a second route to the tunnel, `home.<your domain>` → `HTTP` `localhost:8080`. That's `ORIGIN`.
2. **The Worker:** Workers & Pages → your Worker → Settings → Build → connect this GitHub repo, branch the server follows, root directory `cloudflare`. The Worker's name must match `name` in `cloudflare/wrangler.jsonc`.
3. **Its settings:** Variables and Secrets: `ORIGIN` (text, `https://home.<your domain>`), and as secrets `ACCESS_SECRET`, `EDGE_SECRET` and `ADMIN_CODE`, copied from the server's `.env` (`shotctl.py fix` creates `EDGE_SECRET`; restart the server after).
4. **The address:** Settings → Domains & Routes → add your domain as a Custom Domain (Cloudflare replaces the old tunnel record for it).

### Run only the markets you want (v13.83.4)

Every running market is a full bot, ticking every second. A small home server running all of Kalshi's 15-minute markets (the coins, the stock indexes, gold, oil) answered phones so slowly that requests timed out, and a phone could end up with half-updated app files. `MARKETS_ONLY=BTC,ETH,SOL,XRP,DOGE` lists and runs only those assets (any of BTC, ETH, SOL, XRP, DOGE, SPX, NDX, DJI, GOLD, SILVER, OIL); without it every market runs, as before.

### Pending orders answer at once (v13.83.3)

On a busy home server the Pending orders card never appeared: each phone request waited for a fresh read of Kraken's book, which could outlast the phone's 10-second limit, and the card stayed hidden on any failure. The server now answers from its last read straight away (the tracker keeps it under 15 seconds old) and refreshes in the background; only a first request, or one after a minute without a good read, waits for Kraken. If the card still can't load, it shows why instead of staying hidden.

### A quieter activity log (v13.83.2)

On the live book the Pending orders log filled with about 40 events in 10 minutes: $30k walls and market makers sliding orders a few dollars. Now only **big walls** are logged (at least 2% of the dollars waiting within 0.5% on an average side: about $300k on Bitcoin's Kraken book), and a wall that disappears while one at least 60% its size stands within 0.15% on the same side counts as **moved**, not pulled, and isn't logged. Smaller walls still show on the card while they stand.

### The self-heal keeps a copy (v13.83.1)

When the Deck can't draw a market for 10 seconds, the phone clears that market's saved data and reloads. It used to delete it, scorecards and call logs included. It now keeps the last copy of each as `<key>.bak` in the phone's storage, so nothing is gone for good. Updates themselves never touched this data: they only refresh the app's files.

### Pending orders (v13.83)

A **📖 Pending orders** card on the Deck (Pro, crypto markets: BTC, ETH, SOL, XRP and DOGE) shows the orders waiting on Kraken's order book (`orderbook.js`):

- **Who's stacked.** The dollars waiting to buy and to sell within 0.1%, 0.5%, 1% and 2% of the price, a bar comparing the two within 0.5%, and a label: *buyers stacked*, *sellers stacked* or *even*.
- **Best orders.** The best buy and sell order and the spread.
- **Walls.** A price holding at least 5 times what a typical price within 2% holds, with how far away it is and how long it's been there.
- **Tracked around the clock.** The server reads all five coins' books every 15 seconds, phones or not (`BOOK=off` to read only while a phone looks). A chart shows which side was stacked within 0.5%, minute by minute, for the last 2 hours. An **activity log** lists walls going **up** (stood 30 seconds), getting **hit** (the price reached them) and getting **pulled** (gone before the price got there, with under a fifth of the wall left at that price). Big orders are often placed to look like support or resistance and taken away before they fill. A wall that only shrank a little, slid out of the 500-level view or stopped counting because the prices around it grew is not called pulled. History and log are kept in `DATA_DIR/orderbook.json`.

Kraken's public book (`/0/public/Depth`, no key) gives up to 500 prices a side; a band those don't reach is marked with an asterisk. A phone that's looking gets a fresh read at most every 3 seconds, shared between phones. One exchange's book, not the whole market, and orders can be cancelled any moment: context only, no call uses it.

### Saves that don't trip over each other (v13.82.4)

Every saved file (the records, what the bot learned, members, the Auto-trader's history...) was written to one shared `<file>.tmp` and then renamed into place. When two saves of the same file overlapped, the second found its temp file already renamed away and failed (`ENOENT ... record-pick.json.tmp`), so that save was lost. Slower disks and Windows antivirus made the overlap common. Every save now goes through `atomicfile.js`: its own temp name each time, and a short retry when Windows briefly holds the file.

### Moving day (v13.82.3)

The app can move to a new address and take its people with it.

- **The old address sends everyone to the new one.** Set `MOVED_TO` on the old host (for example Railway) to the new site's `https://` address. Every page and API call is redirected there (`moved.js`), and an installed copy of the app at the old address replaces its service worker, removes it and opens the new address. Nothing else starts on the old host: no bots, feeds, push or Discord posts, so nothing runs twice. `/healthz` still answers, so the host's health check passes.
- **Members come along.** `python3 scripts/shotctl.py live migrate --from https://old-address` (signed in to the new site first) copies every active member with the same code and expiry, and the price and days. Paid-but-unapproved codes are listed for you to approve. Members sign in on the new site with their code once.
- **Settings come along.** In Railway, Variables → Raw Editor, copy everything; then `Get-Clipboard | py scripts\shotctl.py env import` (Windows) or `shotctl.py env import railway.env` adds the variables this computer doesn't have yet (Discord, Anthropic, Whale Alert keys...). It skips the old host's own (`RAILWAY_*`, `APP_URL`, `DISCORD_REDIRECT_URI`, `PORT`, `DATA_DIR`).
- **Discord.** With `APP_URL` set to the new address, the Discord posts link there, the website's *Join the Discord* button uses `DISCORD_INVITE`, and the members' role linking sends people back to `APP_URL/api/discord/callback`: add that address under OAuth2 → Redirects in the Discord Developer Portal.

### Opens faster (v13.82.2)

Every time the app opened, the phone downloaded all of its ~100 files again (about 1.8 MB), because the server never told it which files hadn't changed. Files now carry an ETag: the phone asks "still this version?" and gets a tiny *not modified* answer, so only changed files are downloaded. It matters most when the server is far from the phone or behind a slow link, such as a home computer behind a Cloudflare tunnel.

### Runs on Windows (v13.82.1)

On a Windows computer every page answered `{"error":"payment required"}`, the sign-in page included, so nobody could get in. The server matched the page's address against the pages open to everyone with the operating system's path rules, and Windows writes paths with backslashes, so `/paywall.html` never matched. It now uses web-style paths on every system. Linux hosts (Railway, Render) were never affected.

### The Whale filter (v13.82)

A **🐋 Whale filter** on the Market desk tells the whales that move the market from the ones that don't (`public/whales.js`, `whalefilter.js`, one per crypto market).

- **Every whale is graded.** Each trade of $100k or more on a USD exchange (`WHALE_FILTER_MIN` to change it) is checked a minute later: did the price move its way by at least one typical minute's move (**moved**), go the other way as much (**faded**), or neither (**no real move**)? The typical minute's move comes from the same price stream, sampled every 5 seconds over the last 2 hours.
- **It learns which kinds move it.** The whales are grouped by what's known the moment they print: size ($100k-250k, $250k-1M, $1M+), exchange, buy or sell, and alone or in a sweep (another whale the same way within 30 seconds). A group is proven to **move the market** once it has 30 graded whales and its average move its way has a t of 2 or more; otherwise it's **noise** (or proven to **fade**, t of −2 or less). Up to 5,000 graded whales per market are kept in `DATA_DIR`, so it keeps learning across restarts.
- **The filter.** A new whale is a **likely mover** when one of its groups is proven to move, **likely noise** when its size group is proven noise. On the Deck, the **Whale filter** card shows which groups move the market, the last whales and what the price did next, and the likely movers' dollars in the last 15 minutes. On the live tape, ⚡ marks a likely mover and 💤 likely noise. Discord whale alerts say what the filter expects; set `DISCORD_WHALES=movers` to skip the whales it has proven are noise (the ones it can't say yet still post).
- **On the team.** It tells the Scout and the Judge when the whales that move the market lean one way.

It measures what the price did after each whale, not why: a whale can buy into a rise that was coming anyway. Context only: no call uses it.

### The Recruiter never stops (v13.81)

- **Searches nonstop.** The Recruiter looks every 5 seconds on its own timer (it used to look once an hour, and only while the bot was ticking), and again the moment you approve, decline or let someone go.
- **Always at least one applicant.** When no gap in the team's data calls for anyone, the next ready agent stands by, and its application says so (*Standing by: no gap in the team's data calls for it yet*). If the data later calls for it, its application updates with why. Decline one and the next steps up. A declined agent still waits a week before applying for a gap, but comes back to stand by if nobody else is left. Only when you've hired the whole catalog is there nobody to put forward, and the Recruiter says so.
- **Five more agents (10 in all),** each real code that reads the official record:
  - 🔥 **Streak watcher** (Risk office): the run of wins or losses now, and the longest losing run before it; tells the Risk officer when a losing run is as long as the worst yet.
  - 💵 **Price-band coach** (Grading room): splits the record by the price paid and flags a band that clearly loses to its prices (30+ calls, z of −2 or worse).
  - ↕️ **UP/DOWN checker** (Grading room): the UP calls and the DOWN calls apart, the same test.
  - 📅 **Weekday coach** (Grading room): by day of the week (Eastern time), the same test.
  - 🤫 **Quiet-spell watcher** (Call desk): tells the Caller when the gap since the last official call is three times the usual and over two hours.

Like every hire, they start on a 24-hour trial with a trainer, report and inform, and never change a call.

### The Doctor (v13.80)

A **🧑‍⚕️ Doctor** in the Manager's office makes the rounds of every teammate that needs attention (a warning, or a flag from the Manager or the Improvement crew) and writes each one a chart (`public/doctor.js`). The rounds are on the Deck's **Bot team** card (*Doctor's rounds*, opened on its own when someone is critical or needs you) and at the top of the live window; tap a teammate there to see its chart.

- **Triage.** 🔴 critical (the calls can't run without it: the bot's loop, the price, the odds), 🟣 needs you (only the admin can fix it), 🟠 serious (broken, stuck, slacking or hurting), 🟢 just watching (a warning that is the report itself, like a guard doing its job).
- **Root cause.** When one part fails, the parts that read it go quiet too: the bot's loop stops and the price, the odds and Kalshi's quotes freeze; the price feed falls behind and the Scout holds; the exchange feeds drop and the tape starves. Each symptom is charted under its cause (*Treat the cause: the Night watch is down*), and the cause's fixer is told what fixing it clears.
- **Treatment.** Who's actually on it: its team's fixer (try 1 of 3), its floor's helper (try 1 of 6), a rule that already handles it, or you, with what to do.
- **Second opinion.** The Feed medic flagged every warning on the Market desk as broken, including ones that are the market, not a fault: a wide or crossed Kalshi spread, a wave of liquidations, Market Watch holding calls on purpose. The fixers then reconnected the exchange feeds or kicked the bot for them, the worst time to drop data. The Doctor now clears those flags before the fixers plan: no reconnects, nothing handed to you, no merit lost. The warning itself stays on show.

The Doctor diagnoses and refers. The fixes are still the fixers' and the floor helpers', and nothing it says changes a call.

### The road to graduation on the Deck too (v13.79)

The **🎓 Road to graduation** bars (v13.78) were only in the admin's live window (Watch them live → Lab floor → Training room). They're now also on the Deck's **Bot team** card, for everyone with Pro, with a count of how many trainees have graduated (*0 of 15 graduated*). Both places draw from one renderer (`training.js` `roadHtml`), so they always show the same thing.

### Road to graduation (v13.78)

The Training room in the live window now has a **🎓 Road to graduation** panel: a bar for every trainee, closest to its proof first.

- **On probation:** the bar fills as its counter moves (*27% · 40 of 150 rounds · about 28 h to go*), with ticks at 25, 50 and 75%.
- **Bar reached:** full and pulsing green, *judged on its next test* (judged, not passed: it can still fail).
- **No counter:** a striped bar, *judged on its own schedule, no shortcuts*. No percentage is made up for a learner that doesn't have one.
- **Blocked:** an amber striped bar naming what it needs (*Blocked: needs the exchange feeds*), keeping its percentage.
- **Graduated:** a full gold bar 🎓. New hires on their 24-hour trial show up here too.

### The hiring center, and new hires start in training (v13.77)

A 🧑‍💼 **Recruiter** in the Manager's office looks for gaps the team has (every hour, or when you tap **Search now**) and files an **application** for each ready-built agent that would fill one. Applications wait in **Settings → Admin → Hiring center**. Each says **why now** (the evidence from the team's own data), **what it would do** and **what it can't**. **Approve** hires it onto the team; **decline** and it won't apply again for a week; **Let go** removes a hire. Kept in `DATA_DIR/hiring.json`.

| Candidate | Applies when | What it does once hired |
|---|---|---|
| ⏰ Market-hours keeper | a running market trades on hours (an index, gold, silver, oil) | tracks the stock market's hours (9:30-4:00 ET, weekdays) and CME's (Sunday 6pm to Friday 5pm ET, with a daily break), and tells the Scout and the Caller as a session opens or closes. It doesn't know holidays |
| 📉 Drawdown watcher | 30+ graded official calls | follows the record as $10 calls after fees: how far below its best, its worst drop, and warns the Risk officer when a drop is the deepest yet |
| 🕐 Hour-of-day coach | 120+ graded official calls | splits the record into six 4-hour blocks (ET) and flags a block that clearly loses to its prices (30+ calls, z ≤ −2) |
| 🌊 Liquidity scout | calls are being made or traded | reads Kalshi's order book every 30 seconds and tells the Trader and the Caller how many dollars of each side are for sale within 2¢ of the best price |
| 🔄 Restart watcher | always | records each server start: how long it's been up, and how often it restarts (each restart empties the team's memory) |
| 📈 RSI agent | 5+ hours of saved price history | reads RSI 14 on 1, 5 and 15 minutes, tests on the saved history whether RSI extremes predicted the 15-minute rounds, and tells the Scout and the Caller when RSI hits an extreme |
| 🧮 Mathematician | 10+ graded official calls | works the record out exactly after fees: win rate with its 95% range, the breakeven win rate, profit per call with its error, whether the record is proven ahead or behind its prices, and the Kelly stake once it is |
| 🔬 Fact checker | 60+ graded official calls | tests six claims about the bot on the record (wins more than half, beats its prices, streaks, getting better, UP vs DOWN, pricier calls) and marks each TRUE, FALSE or UNPROVEN at 95% |

**Every new hire starts on probation**: a **24-hour trial**, restarted if it's flagged stuck or broken while on it. The **Training room picks it up the moment it joins**: a trainer appears on the same reading, tracking the trial (*0 of 24 hours of its trial · about 24 h to go*). When the hire graduates, the hire and its trainer each earn **+50 merit**. Like everyone on the team, a hire reports and informs: none of them changes a call.

### The Training room (v13.76)

A 🏋️ **trainer for every learner** (the 14 in the Research lab, and the Flip checker), in a new Training room on the Lab floor. What gets a learner off probation is **new graded rounds**: it has to beat what the bot does now on data it never saw. Nothing can hurry that without cheating (rerunning the test until one run passes by luck), so a trainer does what's real:

- **The pace.** Where its trainee stands against the bar it has to reach, and about how long that will take: *On probation · 40 of 150 rounds (27%) · about 28 h to go at this pace*. The counter comes from the server where it knows it directly (minutes of history toward a week for the Clock watcher, graded predictions toward 500 for the Micro modeler, graded rounds toward 600 for the Flip checker), else from the trainee's own status. The pace is measured from how fast that counter actually moved over the last 6 hours. "To go" means **until it's judged, not until it passes**: it can still fail.
- **The path.** A trainee that can't gather data because something it reads is broken (the exchange feeds for the Scan analyst, the Micro modeler and the Flip checker; the futures for the Micro modeler) shows **Blocked**, and its trainer tells that team's fixer.
- **No shortcuts.** For a learner whose test reruns on its own schedule with no counter, the trainer says exactly that, and never reruns a test to fish for a pass.
- **Graduation.** A trainee that proves itself earns its trainer **+50 merit**, and the trainer keeps watching: a proven learner stays in the calls only while it keeps proving itself.

### The Near-certain desk says why it's warning (v13.75.1)

The Near-certain desk turned amber when the profit guard paused Near-certain calls, but its line didn't say so. Now it does: *Paused by the profit guard: its last 25 graded calls lost $4.10 at $10 each, so Near-certain buy alerts are off until they're back in profit*.

### Merit pay (v13.75)

Every teammate now earns or loses **points for what it verifiably did**, never for looking busy:

| Earns | | Loses | |
|---|---|---|---|
| a fix that cleared a flag (the fixer or floor helper who made it) | +20 | flagged stuck | −10 |
| a learner proving itself on rounds it never saw | +50 | flagged slacking | −5 |
| back on track: its own flag cleared | +5 | flagged hurting or broken | −3 |
| each hour on the job | +1 | a flag handed to the admin (fixer or helper) | −5 |
| each headline the News scout routes (10 an hour at most) | +1 | a learner dropped back to probation | −25 |
| each graded official call, to the Caller | +10 × (result − price) | (a win at 90¢ is +1; a loss at 90¢ is −9) | |

Points count the last 24 hours, and there's **no back-pay**: nothing that was already true when the server started earns or costs anything. The top scorer of the last hour is **Employee of the hour**, with a 🏆 on its desk and on the Manager's banner, and the Manager tells it to keep it up. Anyone in the red this hour hears *Your score is −10 this hour (last: flagged stuck). Turn it around.* Each teammate's sheet shows its merit (today, this hour, the last thing it earned or lost for), and the live window has a **Merit pay** leaderboard (the top five, and the bottom three).

**The incentive that actually changes the bot was already there: proof earns influence.** A learner or a council voice gets a say in the calls only by being right on graded rounds, and loses it by being wrong. Merit pay makes the rest of the team's work visible and ranked. Points themselves change no call and no trade.

### The News scout (v13.74)

A 🗞️ **News scout** on the Market desk searches the market news and tells whoever it concerns. Two kinds of news, from free sources that need no key:

- **Headlines** for every running market's asset (Google News searches for Bitcoin, the S&P 500, gold…, plus CoinDesk's feed for crypto), every 5 minutes, deduplicated, the last 6 hours.
- **The economic calendar** (ForexFactory's public calendar), every hour. These are the scheduled releases that move every market at once: CPI, jobs, the Fed.

Each headline goes to the teammate whose part it bears on:

| The headline is about | It goes to |
|---|---|
| ETF and fund money | Money-flows desk |
| hacks, bans, lawsuits | Risk officer |
| liquidations | Liquidation watcher |
| the Fed, rates, CPI, jobs | Related-markets desk |
| a big move (surge, crash) | Analyst |
| anything else | Scout |

A **high-impact US release** in the next hour gets a heads-up to the Risk officer and the Analyst (*Heads-up: CPI m/m (USD, high impact) in 25 min, forecast 0.3%*), and the Analyst hears again once it's out. The live window has a **Market news** panel: the coming releases, then the headlines with links and who each one was told to.

**News informs; it doesn't change calls.** Headlines have no graded record here, so they get no say in the odds; if a source can't be reached, the News scout says so instead of guessing. Set `NEWS=off` to turn it off, or `NEWS_EVERY_MIN` to change how often it looks.

### Floor helpers (v13.73)

The office is now a building of **four floors**: the Top floor (Manager, Improvement crew, Grading room, Newsroom), the Calls floor (Call desk, Risk office, Trading floor), the Lab floor (Research lab, X-ray room, Council chamber) and the Ground floor (Market desk, Operations). Each floor has a 🦺 **floor helper**, the second line of support when a teammate on that floor is **still stuck after its team's fixer** has escalated. A flag goes to the helper before it reaches you:

- **A feed still down** after the fixer's 3 reconnects: exchanges come back after outages, so the helper keeps **reconnecting every 30 minutes, 6 more times** (3 hours).
- **The bot's loop frozen**: the helper uses a new **watchdog** (`bot.js` `unstick`). A bot cycle that has hung for 2 minutes is let go of so the next one can run, and the loop is restarted. (Every request in a cycle has an 8-second timeout, so this should never be needed; now it's covered if it is.)
- **Anything else** (no fix in code, or the helper's tries ran out too): **handed to you**. The live window's **Needs you** panel lists what the helpers hand off, with what to do and how many tries it got.

A fix counts only when the flag actually clears (*got 1 back on track in the last day*). The helper tells the stuck teammate (*I've got you: the Market desk fixer tried 3 times, so I'll keep reconnecting…*) and the fixer it took over from. The Manager's banner counts the helpers too.

### A flag fixer for every team (v13.72)

Each team (department) now has its own 🛠️ **fixer**: eleven of them, one per room in the live window. Every flag on its team (*stuck* or *slacking* from the Manager, *hurting* or *broken* from the Improvement crew) gets one of three answers:

- **Fixed.** If there's a real fix the server can make, the fixer makes it:
  - **reconnect the exchange feeds** (the Exchange runner, the Tape reader, the Liquidation watcher)
  - **reconnect the futures feed**
  - **make sure the bot's loop is running** (a frozen Price clerk or Analyst, the Night watch, the Quote clerk, the Scout)
  - **run the tune-up now**, to rerun the learners (a slacking or stuck researcher, the Tune-up runner; at most once an hour, and the tune-up still keeps a setting only if it proves better on unseen rounds)

  It tries at most **3 times, 10 minutes apart**, and one reconnect counts for every flag it covers. A fix is logged as **fixed only when the flag actually clears**: *Fixed 1 in the last day (last: Exchange runner, reconnect the exchange feeds)*.
- **Already handled.** The bot has a rule for it: a council voice with a bad record is already vetoed; calls that lose to their prices are what the profit guard pauses.
- **Escalated to you.** If nothing in code can fix it, or 3 tries didn't clear the flag, it goes to a **Needs you** panel at the top of the live window with what to do. Examples: the Archivist not on a volume (*add a volume in Railway and set DATA_DIR*), the Caller making no round calls, a layer of the odds proven to hurt accuracy.

The fixers tell each flagged teammate what they're doing (*On it: I'll reconnect the exchange feeds (try 1 of 3)*) and report to the Manager. The Manager's banner counts them too: *· 11 fixers: 1 fixing, 0 with something escalated to you*. Nothing a fixer does changes a call or a trade, and no fixer touches a setting directly: the only setting changes still come from the tune-up's proof rule.

### The Manager catches slacking (v13.71)

The Manager now makes sure **nobody is slacking**, as well as nobody stuck. **Slacking** means not stuck, but not producing: a teammate whose work has to move every round, and that many rounds have passed with nothing new from it. Only work that *must* move counts, so a calm market or a proven setting sitting still is never called slacking:

| Teammate | Has to | Slacking after |
|---|---|---|
| Quote clerk | see Kalshi's bid or ask move | 4 rounds without a cent of change |
| Caller | make a round call (or a buy) each round | 3 rounds |
| Accuracy coach | grade every settled round (its count goes up each one) | 3 rounds |
| Proof clerk | grade the break lab's cases (every minute) | 3 rounds |
| Kalshi blender, Settlement matcher | count rounds toward their proof, while on probation | 3 rounds |
| Tune-up runner | keep to its schedule | its tune-up overdue by more than an hour |

The server counts rounds as they end and keeps a **time sheet** for every teammate: when it last did something, how many updates in the last hour, and how many rounds since. It's on each teammate's sheet in the live window. A slacker gets a *Slacking* review, an amber **z** on its desk (stuck stays a red **!**), and a word from the Manager: *nothing new in 3 rounds, and its work should move every round. Get back to it.* The banner counts them: *… · 1 slacking: Caller · nobody stuck*. The Manager judges each reading only after recording that reading's changes, so a teammate that acts in the same moment a round ends is never caught by mistake. Off by design is never slacking. As before, **the Manager reports; it doesn't fix.**

### The Manager (v13.70)

A 👔 **Manager** now watches every teammate on every reading and makes sure each one is **doing something, or has a stated reason not to**. Everyone lands in one of four groups:

- **Working:** on it, acting or warning, and for the live readers (the Price clerk, the Analyst) the reading is still moving.
- **Waiting for a reason:** idle with the reason on show, such as between rounds, on probation, or not enough data yet.
- **Off by design:** for this market or this server, such as no futures for gold or Discord not set up.
- **Stuck:** silent (not reporting), frozen (a live reading that hasn't changed in 2 minutes while a round is open), or a bot that has stopped ticking.

The server keeps when each teammate's status last changed, so a frozen reading shows up. Anyone stuck gets a **Stuck** review on their sheet and a red **!** in the live window, and the Manager's line sits on a banner at the top: *24 of 55 working · 28 waiting for a reason · 3 off by design · nobody stuck*. It also talks: it tells each stuck teammate, and briefs every department through its lead (*Market desk: 5 of 10 working, 5 waiting*).

No false alarms by design: between rounds nothing is called frozen, and Kalshi's quotes aren't held to it (they can rightly sit still for minutes). **The Manager reports; it doesn't fix.** Flagging a stuck part to you is the job.

### The Improvement crew (v13.69)

Seven new teammates whose job is **the other teammates**. Each one grades a part of the team on its graded track record and tells each teammate it coaches what the record says: **helping**, **hurting**, **noise**, **still gathering data**, or **needs attention**. In the admin's live window they have their own room at the top of the office, their reviews show in each teammate's sheet, they talk to the teammates they coach, and a teammate they flag as hurting or broken gets a red **!**.

| Crew member | Grades | On |
|---|---|---|
| ⚙️ Tune-up runner | the learners and the round call | **runs the tune-up automatically every 6 hours** |
| 📋 Track-record reviewer | the council's seven voices | each voice's graded nudges (helping at z 2+, hurting when the council vetoes it, data under 20) |
| 🧭 Break coach | the X-ray's kinds of break | the break lab's verdicts: trust, read backwards, ignore as noise, still testing |
| 🏷️ Price checker | the official calls | wins against the prices paid for them (breakeven), with a z: 30 graded calls and z 2 before it says helping or hurting |
| 📐 Accuracy coach | each layer of the odds | the strength meter's paired scores: does the Kalshi blend help, do the council's nudges help, does the bot beat Kalshi |
| 🩺 Feed medic | the feeds and systems | anything warning on the Market desk or in Operations |
| 🧑‍🏫 Probation mentor | the 14 learners | which are proven and which on probation, and for how long (a time only once it has seen the change happen) |

**Only one of them changes anything: the Tune-up runner.** It runs the existing tune-up (`tuneup.js`) on a schedule instead of only when the admin taps it: every `TUNEUP_EVERY_H` hours (6), the first 30 minutes after a start; `TUNEUP_AUTO=off` leaves it to the button. It changes nothing the tune-up wouldn't: a setting is kept only while it beats what the bot does now on graded rounds it never saw, and dropped when it stops. The other six **coach**: they point at what's helping and what's hurting, and the proof rules already in the bot (the council's veto, the break lab, each learner's probation) are what act on that. None of them can make a part look better than its record, and with too little data they say so instead of guessing.

### Auto-trade on your phone, the key never leaves it (v13.68)

The Auto-trader can now run **on this phone** instead of the server, so you can auto-trade **without giving the server your Kalshi key** (and without setting `KEY_SECRET` in Railway). Settings → Auto-trader → **On this phone**.

- **The key stays on the phone.** It uses the key you link in Settings → Kalshi account: stored as a non-extractable WebCrypto key, so it can sign but nothing (not even the app) can read it back out. Every order is signed on the phone. The server only forwards the signed order to Kalshi, after the same check it gives every order (`validateOrder`: BTC 15-minute markets only, fill-now-or-cancel, the $100 cap, at most 30 orders a minute). It never sees the key.
- **The same trader, the same calls.** It runs the exact executor the server uses (`public/trader.js`: the sizing, the no-double-buy and never-oversell rules, the error stops), on the same official call. Every 4 seconds the phone asks the server (`POST /api/auto/feed`) for what the server's own traders get each tick: the official call, the round, a sell check (SELL HIGH / BAIL) for each position the phone holds, and any results the server already knows.
- **Modes: Off, Test, Live.** Test needs no key (a simulator on Kalshi's live book). Live unlocks after 10 clean Test trades *on this phone*, needs the linked key to have **trading permission**, and asks you to confirm. No Demo on the phone: it uses the key linked here.
- **Never both.** It won't go Live while your Auto-trader on the server is on in Demo or Live, and if that one comes on later, the phone pauses rather than both buying. The card runs one place at a time: turn one off before switching.
- **The catch: it only trades while the app is open.** A phone freezes a web app in the background, so with the app closed or the screen locked nothing is bought **or sold** (open positions still settle on Kalshi). It keeps the screen awake while it runs where the phone allows it, and when you come back it says how long it was closed. For trading around the clock with the phone off, use the server option.

Built on `public/phonetrade.js` (and `test/phonetrade.test.js`: the full Live flow against a fake server and Kalshi that verify every signature like Kalshi does; the key appears in no request and nothing saved).

### The whole staff, talking (v13.67)

The bot team grew from 9 to **48 teammates**, one for **every real part of the bot**, in ten departments: the Market desk (price, Kalshi's book, the exchange feeds, the tape, futures, liquidations, related markets, money flows, the market finder), the Research lab (one researcher per learner: volatility, momentum, calibration, the Kalshi blend, the scan, the micro model, indicators, reversals, the forecaster, the predictor, the call filter, the flip check), the X-ray room (with the Proof clerk), the Council chamber (with the Records keeper), the Call desk (early, late and near-certain calls), the Risk office (the win-rate guard, the profit guard, the Fee checker, the Auditor), the Trading floor, the Grading room (the Settlement clerk, the Tune-up mechanic), the Newsroom (push, Ask) and Operations (the Archivist, the Night watch).

- **Every status is that part's own live reading**, word for word: *9 of 12 exchange feeds live*, *Last 15 min: 75% of the money bought*, *$10 at 62¢: 16 contracts, fee $0.27, a win pays $5.81*, *On probation: needs more rounds*. A part this market doesn't have (no futures for gold, say) is shown *off*, never made up.
- **The Auditor** is the one new check: it flags when the team's reports contradict each other (a buy showing during a Market Watch hold, on a delayed price, while the profit guard pauses calls, or against the round call).
- **The live window (admin only) is now an office:** each department is a room of little robots, and **they talk to each other**. Each teammate tells whoever uses its part, along the real handoffs in the code (the price to the Analyst, the guards to the Risk officer, the call to the Trader). The speaker's mouth moves with its words in a bubble, a dot flies to the listener, who turns to hear it. A teammate whose situation just changed speaks first, marked **CHANGED** in the conversation log (with a filter for only those). Tap anyone to see what it owns, what it's saying, who it tells and who it hears from.
- The phone's Deck card still shows the nine leads, plus one line for the rest of the staff (who's warning).

**About accuracy:** more teammates make the bot **easier to watch**. They don't make it more accurate on their own. None of them changes a call: each one reports a part that already existed. Accuracy still comes from the learners and the council, and each of those only shapes the calls once it has proven itself on rounds it was never tuned on. The Research lab shows which ones have (*In the calls*) and which are still *On probation*.

### Watch the bot team live (v13.66, admin only)

A separate window for the admin: **▶ Watch them live** on the Bot team card, or **▶ Watch the bot team live** in the Admin card, opens `/team-live`. The nine teammates are little robots on a snaking line (Scout → Analyst → Inspector → Judge → Caller → Risk officer → Trader → Coach → Reporter), read fresh **every second** from `GET /api/admin/team?m=…`:

- **Each robot acts out its state:** green and bobbing when it's on it; cyan, fast and talking when it's acting; amber with a shake and a pulsing ring when it's warning; grey and slow when it's waiting; eyes shut with a floating *z* when it's off. The state is also written under its name, and its live status line updates every second.
- **When a teammate changes position** (*DOWN took the lead*, *found: High flip risk*), it pops a speech bubble and sends a bright packet down the wire to the next teammate, which flashes when it arrives. A faint packet runs the whole line on every reading.
- **Up top:** the round's UP/DOWN odds bar, a live countdown and the price vs the target. Underneath: everything the team did, newest first, with new lines sliding in. A market picker switches between the running markets.
- With *Reduce Motion* on, everything still updates, just without the movement.

**Only the admin can open it.** The server checks the admin sign-in on the page, its script and its data (`team-live.html`, `team-live.js`, `/api/admin/team`); everyone else gets *403 Admin only*, paywall or not. Inside the installed app it opens in place (the app keeps its own sign-in), with **← App** to go back; in a browser it opens in a new tab.

### The bot team (v13.65)

Every action the bot takes now has **one teammate who owns it**, shown on the Deck's **Bot team** card (Pro) for the market open on the phone:

| Teammate | Owns | Example status |
|---|---|---|
| 🔭 Scout | the feeds and Market Watch | *Holding new calls: no fresh price for 30s+* |
| 🧮 Analyst | the round's odds | *UP 96% · UP ahead by 2.10 typical moves · 9.0 min left* |
| 🩻 Inspector | the X-ray's breaks | *2 breaks open: High flip risk; Kalshi swing* |
| ⚖️ Judge | the council | *2 counted, 1 vetoed* |
| 📣 Caller | the buy signal and the round call | *BUY DOWN at 62% · 80% at its worst-case odds* |
| 🛡️ Risk officer | every guard that can stop a call | *Calls paused by the profit guard* |
| 💼 Trader | the server's auto-traders (a count, never anyone's account) | *3 auto-traders trading the official calls* |
| 🎓 Coach | grading and the learners | *Stronger than a coin flip · 1 of 2 learners proven* |
| 📰 Reporter | Discord and Ask | *Discord on · 12 posts sent · Ask: free answers* |

The server (`team.js`) reads every part every 5 seconds, per market, and keeps a feed of what each teammate *did*: a line only when its situation changes (*DOWN took the lead*, *held new calls*), never every tick's numbers. The feed is in memory (the last 60 lines per market) and starts empty after a restart. `GET /api/team?market=…` returns the roster and the feed. The team is a view of the bot, not a new decision-maker: every status comes from a part that already existed.

### The Ask AI is off (v13.64.1)

The AI behind Ask is **off by default**, so it never spends credits, even if `ANTHROPIC_API_KEY` is still set in Railway. Every question gets the free market answers below. To turn the AI back on later, set `ASK_AI=on` in Railway (with a key).

### Ask for free (v13.64)

Ask answers questions about **any market without an AI, and without spending any credits.** Whenever the AI is off (the default since v13.64.1; with `ASK_AI=on` and a key it answers instead), questions go to `freeask.js`: it reads which markets the question names (Bitcoin, ETH, Solana, XRP, Doge, the S&P, Nasdaq, the Dow, gold, silver, oil, "the coins", "every market"; none named means the market open on the phone) and what kind of question it is, runs the same live lookups the AI uses (v13.63), and writes the answer from the numbers:

| Ask something like | It answers with |
|---|---|
| Should I buy? | the buy signal (side, price, worst-case odds, confidence), the locked round call, the odds and Kalshi's price |
| Is the lead safe? / Will it flip? | the lead in typical moves and on the price, how safe that is, the chance the price math gives the leader, volatility, a flip-risk break |
| Which market has the safest lead? | every running market ranked by its lead (with the reminder that the safest lead isn't the best buy) |
| Compare Bitcoin and Ethereum | each market's lead, odds and Kalshi's price side by side, and any buy signal |
| What's the record? | the official calls won, the win rate, the result on $10 a call, the round calls' record |
| How accurate is it? | the strength meter's verdicts |
| What has it learned? | which learners are proven and shape the calls, which are still being tested |
| Any breaks? | the breaks open and which kinds of break are proven |
| Why is it moving? | the drivers (stock indexes, gold, oil), or the last 15 minutes and the council's arguments (crypto) |
| Bitcoin last 30 minutes | the change, the high and the low |

It doesn't understand free-form chat the way the AI does: when it can't tell the market or the question, it says what it can answer instead of guessing. The answers are labelled **Live numbers · free** on the phone; the AI's stay **AI deep dive**. Free answers have a light limit (20 a minute) so a runaway script can't hammer the server.

### Ask: the market chatbot (v13.63)

**Ask the bot** now answers any question about **any market, at any time**, not just the round on screen. With `ANTHROPIC_API_KEY` set, the AI looks things up live on the server before it answers, with read-only tools over the app's own readers (`asktools.js`):

| Lookup | What it returns |
|---|---|
| `list_markets` | every market: name, kind, whether its bot runs, the open round and the bot's odds |
| `market_now` | one market's live round: price, target, time left, the bot's odds (price math, after Kalshi's blend, final), Kalshi's bid and ask, the lead in typical moves, volatility vs normal, the buy signal, the locked round call, the council's debate, open breaks |
| `market_history` | its last 5-120 one-minute closes: the path, change, high and low |
| `market_record` | the official record and the round calls' record |
| `market_strength` | the strength meter (v13.62) |
| `market_learning` | which learners are proven and shape the calls, and each feature's council record |
| `market_xray` | each kind of break's proof, forced closes and the cost of leverage |
| `market_drivers` | what's moving a stock index, gold or oil |

- So "Which market has the safest lead?", "Compare Bitcoin and Ethereum", "How accurate has the bot been on every market?" or "What's gold doing?" get answers from real, current numbers. A market whose bot isn't running is started, and the AI says to ask again in a minute.
- The AI answers only from what it looked up and what the phone shows; it says when the data can't answer something. Same rules as before: bottom line first, honest about uncertainty, never financial advice, plain text.
- Under the hood: a tool loop (up to 6 turns), each turn streamed; every lookup's input is checked before it runs, all results go back in one message, a turn cut off or refused never runs its tools, and an unparseable stream is re-issued once. Prompt caching keeps repeated questions cheap. On the newest models (Claude Opus 5 and later, Fable 5.1, Sonnet 5.5) the server-side refusal fallback is on: a declined answer is retried on a fallback model; if the API ever rejects that, Ask drops it and asks without.
- Without a key, the phone's built-in answers still cover the market on screen.
- Cost: each lookup adds tokens, so a multi-market question costs more than a simple one. The rate limits (4 a minute, 40 an hour per member) still apply.

### The strength meter (v13.62)

**Is the bot actually getting stronger?** The Record tab has a **Strength meter**. Every second, the server keeps the live round's odds at each stage, plus Kalshi's own price, and when the round settles it scores every one of those seconds against the result with the Brier score (the squared miss: 0 is perfect, 0.25 is a coin flip):

| Line | What it is |
|---|---|
| Bot | the odds its calls actually use (after Kalshi's blend and the council's nudges) |
| Kalshi's price | the mid of Kalshi's bid and ask: the bar to beat |
| Bot's price math alone | distance to the target, volatility and time left, before anything else |
| Coin flip | the dashed zero line |

- The chart shows each day's **skill** (how much less it misses than a coin flip; above zero beats it) for the last 30 days, with a hover crosshair and a day-by-day table.
- In plain words, each only as strong as its evidence: stronger than a coin flip or not; ahead of, level with or behind Kalshi's price; **getting stronger, weaker or no clear change** (the last 7 days against the 7 before); and whether mixing in Kalshi's price and the council's nudges clearly helped or hurt.
- By time left in the round (minutes 15-10, 10-5, 5-1, the last minute): the bot against Kalshi.
- **Judged round by round, never second by second**: a round's seconds all grade the same way when it settles, so counting seconds would make a lucky streak look like proof. Every "clearly" means z ≥ 2 on per-round differences; nothing is said before 30 settled rounds; once the last 7 days have 30+ rounds, they're what it's judged on.
- `strength.js` (server) and `public/strength.js` (scoring); `/api/strength?m=SERIES`; the last 3,000 rounds per market in `strength.json` in `DATA_DIR`.

### Proven breaks and the blip (v13.61)

**Every break in the X-ray is now proven or labelled.** A break is a measurement (a $280 minute is arithmetic); what it *means* was a claim, and claims are now graded. The server (`breaklab.js`) runs the break finder on every market every second, records each new break with the facts at that moment, and grades its claim when its horizon passes or its round settles. Where it makes sense it also samples an ordinary moment every minute and grades the same outcome there, so a break is compared with "no break", not with a guess. Each break in the list shows its badge:

| Badge | Meaning |
|---|---|
| PROVEN | the claim held clearly more often than ordinary moments (or a coin flip): z ≥ 2 on 30+ graded cases |
| PROVEN WRONG | the opposite held clearly; the X-ray says what really happens |
| NOISE | 30+ cases, no clear difference: the break shows, its claim doesn't |
| TESTING n/30 | still being graded |
| FACT | nothing to prove (the UP and DOWN prices added up) |
| UNTESTED | the server can't grade it: exchange splits (it doesn't keep each exchange's later price) and big Kalshi orders (only the phone sees Kalshi's trades) |

The claims: a jump or spike is followed by a bigger-than-usual 5-minute move (vs ordinary moments); a breakout still holds 5 minutes later (vs a coin flip); Kalshi catches up to a lag within a minute (vs an ordinary minute); in a bot-vs-Kalshi disagreement, who was closer to the result; high flip risk, a volatility shift and a lead change: the side ahead loses more often (vs ordinary moments); an odds or Kalshi swing holds a minute later; when the bot and Kalshi move apart, whose side won; one-sided flow and liquidation bursts: does the price keep going that way for 5 minutes. Two-sided claims say which way the evidence points (for example "Kalshi has been right more often: trust Kalshi"). The definitions and verdicts are in `public/breakproof.js`; the graded cases (the last 400 per claim per market) in `breaks.json` in `DATA_DIR`; `/api/xray` sends the verdicts. The server grades flip risk from late toss-ups (the phone also flags it from the hold odds).

**The blip** is a small light under the header, on every tab, for Market Watch and the buy signal. It lights green (**BUY UP 62¢ · +$1.20/$10**) only when the Deck's buy signal is on, with the profit per $10 worked out from the bot's worst-case odds after the fee: the cautious number, and still an estimate. It turns amber while Market Watch holds new calls (with the reason), gray when calls are paused (loss limit or profit guard), and otherwise says Watching. Tap it to jump to the call. (`public/blip.js`)

### The council (v13.60)

Every feature that can move the bot's odds now **argues its case to a council** before anything reaches a call, instead of all the proven nudges simply being added up. The council rules on each argument, on the server (`council.js`) and on the phone with the same rules (`public/council.js`):

1. **The facts beat opinions.** When the lead is 2.5+ typical moves for the time left, or the 60-second settlement average is mostly in (crypto, the last 15 seconds), an argument against the leader is vetoed.
2. **Track record.** The council grades every argument it heard (each feature's last word before a round's final minute) against Kalshi's result, keeping the last 60 per feature and market. A feature clearly wrong lately (20+ graded, z ≤ −1.5 against a coin flip) is **vetoed**; a shaky one (below 50%, shrunk toward 50% while its record is short) is **discounted**, down to half weight. A good record never adds weight: proof gets a feature in, results can only take it out.
3. **No echoes.** Features reading the same data form a family: buyers and sellers (Round scan, micro model, flip check), the chart (tuned indicators, reversal checklist), related markets, money flows. If a family agrees, only its strongest argument counts (the rest are echoes); if it contradicts itself, its data is split and all of it is vetoed.
4. **The debate.** What's left is netted across families by weight, capped at 10 points.

So the council can only shrink or remove a nudge, never grow it: the "only proven things touch the calls" rule holds. The **X-ray** tab has a new **The debate** section: the verdict, each argument with its side, size and ruling (counted, discounted ×weight, or vetoed with the reason), features still on probation listed as heard but not admitted, and every feature's graded record. `/api/council?m=SERIES` serves it; the records live in `council.json` in `DATA_DIR`.

### More breaks (v13.59)

The break finder also looks for **high flip risk**, **market shifts** (odds swings on the bot or Kalshi, a lead change, the price and Kalshi moving opposite ways) and **UP and DOWN prices that disagree** (or cost less than $1 together, a crossed book). The thin-book check became the UP/DOWN check, and "Kalshi far from fair" is now "Bot and Kalshi disagree". The full list is in the table under v13.58.

### X-ray break finder (v13.58)

The X-ray now hunts for **breaks in the market**: places where it's out of line with itself. Every 2 seconds while the tab is open it checks:

| Break | Found when | Severity |
|---|---|---|
| Jump | a one-minute move of 3+ typical one-minute moves | 2 (5+ moves: 3) |
| Spike | the last 15 seconds moved 2.5+ typical 15-second moves (crypto, from the exchange trades) | 2-3 |
| Breakout | the round's price closed beyond the 15 minutes before it, high or low | 1 |
| Kalshi lagging | the price moved the bot's odds 8+ points in 30 seconds while Kalshi's quote moved 2 or less | 2 |
| Bot and Kalshi disagree | Kalshi's mid 15+ points from the bot's odds | 2 (25+: 3) |
| UP and DOWN disagree | the UP and DOWN prices add to 108¢ or more (a fair pair adds to about 100¢) | 1 (115¢+: 2) |
| Crossed book | UP and DOWN together cost less than $1, or the bid is at or above the ask | 3 |
| High flip risk | flip risk 40+/100 from the hold odds (the chance the call's side stays ahead to the close), or without a call a late toss-up: the leader at 65% or less with 5 minutes or less left | 2 (60+: 3) |
| Odds swing | the bot's UP odds moved 20+ points in a minute | 2 (35+: 3) |
| Kalshi swing | Kalshi's UP price moved 20+ points in a minute | 2 (35+: 3) |
| Price and Kalshi pull apart | in the last minute the bot's odds and Kalshi's moved 5+ points in opposite directions | 2 |
| Lead change | the price crossed the target in the last minute | 2 |
| Exchange split | one exchange 1.5+ typical one-minute moves (and 0.05%+) from the others' median (crypto) | 2 |
| One-sided flow | 80%+ of the last minute's exchange dollars on one side, at 2x the usual pace (crypto) | 2 |
| Volatility shift | volatility at 2x normal | 1 |
| Big Kalshi order | one order 35%+ of the round's Kalshi dollars ($500+) | 1 |
| Liquidation burst | $2M+ of forced closes in 30 minutes (crypto; $6M+: 2) | 1-2 |

- **On the film:** each break is a jagged crack where it happened, red and pulsing while open, faint once healed. The scanner beam turns red and the film says how many breaks are open.
- **Breaks found:** the round's log, open ones first: what broke, when, the numbers, and what it usually means. A break not seen for 20 seconds has healed; a new round starts a new log.
- **Honest limits:** breaks are places to look, not trades. They aren't graded yet and the bot's calls don't use them. The scanner runs only while the X-ray tab is open (on the phone; nothing extra on the server).
- The thresholds are in `BREAKS` in `public/xray.js` (`findBreaks`, `trackBreaks`).

### X-ray scanner (v13.57)

The **X-ray** tab (Pro) became an x-ray animation of the live round, with the stats that help but nobody looks at. (It replaces v13.56's layer list, which replaced v13.55's insider trades.)

- **The film:** the round's price drawn like an x-ray. The price path is the glowing spine, each minute a rib, the dashed line the target, and the haze the typical move left before the close. Glowing dots mark target crossings (amber), the high, the low and the live price (pulsing). A scanner beam sweeps across it on a loop.
- **The hidden stats** develop out of a blur as the beam passes when the tab opens or a new round starts, then keep their numbers fresh every 2 seconds:

  | Stat | What it tells you |
  |---|---|
  | Cross chance | how often the price touches the target before the close from where it is (twice the chance of finishing past it, for a price with no drift). A touch isn't a loss |
  | Clock value | the points a minute with the price standing still adds to the side that's ahead |
  | Odds per move | how many points the odds swing for each $X the price moves now |
  | Break-even | the win rate the side the bot favours needs at its price plus the fee, and how far the bot's odds are above or below it |
  | Round-trip toll | what buying and selling straight back costs: the spread plus both fees, in cents and % of the stake |
  | Target crossings | how many times the price crossed the target this round, and the round's range |
  | Volatility vs normal | volatility now against normal, and the typical move in the time left |
  | Settlement locked in | crypto: Kalshi settles on the last 60 seconds' average, so each second counts 1/60; in the final minute, how much is already locked |
  | Trade pace | crypto: exchange trades in the last minute against the last 10 minutes' average |
  | Average Kalshi order | this round's average and biggest Kalshi order: many small traders or a few big ones |
  | Cost to hold leverage | crypto: futures funding per year, and whether one side is crowded |
  | Forced closes | crypto: futures liquidations in the last 30 minutes, longs vs shorts |

- Context only: none of it is a call or moves the bot's odds. A stat shows up once there's data for it.
- Built from `public/xray.js` (pure: the stats and the film's SVG) and `/api/xray` (liquidations and funding for the market). Nothing extra runs on the server. With reduced motion turned on, the film and stats show without animation.
- The insider-trades reader (v13.55) is gone with its SEC requests; `SEC_USER_AGENT` isn't used.

### Money flows (v13.53)

Three outside sources join the signal board for crypto markets, each **on probation** until it proves itself on data it never trained on (`flowsfeed.js` fetches them, `public/flows.js` parses and tests them):

| Factor | Source | Reading | Tested against |
|---|---|---|---|
| Spot-ETF flows | Farside (BTC, ETH, SOL) | the day's net flow into the spot ETFs, US$ m | the next day's move (it's published after the US close) |
| Stablecoin supply | DefiLlama (free API) | 7-day change in total stablecoin supply: fresh dollars arriving or leaving | the next day's move |
| Whale transfers | Whale Alert (`WHALE_ALERT_API_KEY`) | last hour's $500k+ transfers onto exchanges (to sell) minus off them | the next 15 minutes' move, from the bot's 1-minute candles |

- **Judged honestly:** a daily reading holds for a whole day of rounds, so it's graded on days, not rounds (96 rounds that share one reading are one sample). The direction (with the reading, or faded) is picked on the older 70% of days and scored on the newest 30%. A factor is proven when it's right more often than chance there with z ≥ 2.5 on 60+ unseen days (whales: 100+ unseen hours, one sample an hour so overlapping readings aren't counted twice).
- **If one proves itself,** its edge is scaled to the minutes left and turned into odds through the bot's own volatility model, so a daily edge moves a 15-minute round by a fraction of a point (capped at 2; all flows together at 3).
- **Every source says whether it's working:** the board row shows the reading, its record on unseen days, and the source's error if it couldn't read (blocked, page layout changed, key refused). `/api/flows` has the details.
- Fetching: Farside every 3 hours, DefiLlama every 6 (shared by every market), Coinbase daily candles every 6 (for grading), Whale Alert once a minute while a key is set. Only the whale log is saved (`flows.json` per asset); the rest is re-read.
- To turn on whale transfers, set `WHALE_ALERT_API_KEY` in Railway. Without it the row says it's off and Whale Alert is never called.

### Tune-up (v13.52)

An accuracy check you run whenever you want. It does nothing between runs, so it costs no memory.

- **Run it:** Settings → Admin → **Run tune-up** (admins), `POST /api/admin/tuneup`, or `npm run tuneup` on the server's data (for example from a Railway shell). `npm run tuneup -- --dry-run` shows the report without saving.
- **What it does, for every running market:**
  1. Reruns every learner now instead of waiting for its hourly timer: the indicator test, the cushion table and flip study, the volatility tuner and the flip check, each on the latest candles. Markets on the same asset share them, so they're refreshed once.
  2. Tests the round call's **blend** (how much is the bot's odds vs Kalshi's) and its **calibration** (whether a call that says 80% wins about 80%: a temperature that pulls over-confident odds toward 50%) on graded rounds they never saw. Each setting is tuned on the older 70% of rounds and checked on the newest 30%.
  3. Keeps a setting only if it beats what the bot does now on those unseen rounds by a clear margin (z ≥ 2 on the per-round difference, 80+ graded rounds). Otherwise the bot keeps its own settings, and a setting that stops proving itself on a later run is dropped.
- Calibration never changes the side, only the odds, which decide which round calls are worth buying. The tests always start from the raw odds each round call stored, so the tune-up never learns from its own output.
- The report shows, per market: graded rounds and Brier scores (round call, bot alone, Kalshi), the blend and calibration verdicts with the reason, and what the learners say after the rerun. It's saved with the settings in `DATA_DIR/tuneup.json`; a running server picks up a terminal run within a minute.

### Ask the bot (v13.47)

Tap the **chat button** up top and type a question ("should I buy?", "is the lead safe?", "why is it dumping?", "any patterns?", "deep dive"), or tap a suggestion. The sheet answers from everything the app already knows about the live round.

- **Built-in answers, no setup** (`public/ask.js`): the question is matched to what it's about (the call, the lead, flip risk, why it moved, buyers and sellers, chart patterns, the signal board, market mood, the record, your position, sessions), and each part is written from the live numbers: the bottom line first, then the parts. Nothing new is guessed: it reads the Deck's last render, the round call, the cushion, the flip check, the scan, the pattern reader, the board and the record. Ask about another coin and it tells you to switch markets.
  - "Is the lead safe?" and "will it flip?" open with the verdict: how safe the lead is, the chance it flips by the close, and how rounds at this cushion ended.
  - With no live flip check, the flip chance comes from how rounds at this cushion and time left actually finished (when the server has that history), not a rule of thumb.
  - Odds are given for the side being called ("DOWN 99%+", not "UP 0%"), and never as a flat 0% or 100%.
- **AI deep dive, optional** (`askai.js`): set `ANTHROPIC_API_KEY` in Railway and the server sends Claude the same facts with the question. It weighs them and answers in a few short plain sentences: bottom line first, only the snapshot's numbers, honest about uncertainty, unproven factors as context only, never financial advice. The built-in answer shows instantly and folds under "The numbers behind it" when the AI's arrives. `ASK_MODEL` picks the model; without it the server uses the newest Opus model the key can use (from the Models API). A key pasted with stray spaces, a line break or quotes still works. Members and admins only; 4 questions a minute and 40 an hour each, since every answer costs API tokens. Without a key, `/api/ask` returns 501 and the phone uses the built-in answer.
- Adds the server's only npm dependency, `@anthropic-ai/sdk`, loaded only when the first AI question comes in.

### Why it's on probation (v13.46)

Every factor on the signal board's probation list now says why it isn't used, in plain words. The rows are grouped:

- **Close:** a real edge so far (z 2+) that hasn't cleared the bar. The row says how often luck alone would do as
  well, and what it takes to go in.
- **Gathering data:** how much graded data it has and how much it needs.
- **No edge:** about a coin flip on data it never trained on, or a test it passed only when training disagreed.
- **Reversed:** what it learned went the other way on new data. It's noise.

Unproven factors stay out of the calls: one with no edge only adds noise to odds that are already priced.

### Locked means locked (v13.45)

Once a round's call locks, its side never changes for the rest of the round:

- **No flip calls:** a locked call never switches sides (`engine.js` flipOk; only a `switchLocked` setting, off
  everywhere, would allow it). The flip study still runs and is shown for reading, as context.
- **Nothing against the locked side:** once the 10-minute pick has locked (`snap.lockedSide`: the server's pick, or
  the side the phone showed), no buy call is made on the other side. The card says when the bot leans the other way
  but the lock holds.
- **The phone never shows two sides:** it waits up to 15 seconds past 10:00 left for the server's pick ("Locking the
  round call…") rather than showing its own guess. The first side it shows is the side for the rest of the round.

### Chart patterns (v13.44)

`public/chartpatterns.js` reads the candles for the shapes traders look for:

- **Shapes:** head and shoulders (and inverse); ascending, descending and symmetric triangles; rising and falling
  wedges; channels; flags; support and resistance breaks after 3+ touches.
- **Candlestick patterns:** hammer, shooting star, engulfing, morning and evening star, three white soldiers and black
  crows, piercing line and dark cloud cover.

It never peeks ahead: a swing high or low only counts once 3 more candles have closed, and a pattern counts on the
candle that confirms it (tested: the patterns found on part of the history match the full history's).

- **On the Chart tab:** a marker on the confirming candle (short tags: H&S, Tri, Wedge, Chan, Flag, Res/Sup, …), the
  2 newest shapes' lines, and the shape still forming dashed. A **Chart patterns** card lists the recent ones, with
  what each says and how that kind has done on unseen rounds.
- **In the calls:** each kind is a candidate in the indicator test (`public/tune.js`), its signal held 3 or 8 minutes
  after it confirms. It touches the calls only once proven there, like every indicator. With 17 families tested at
  once, the bar is now z 3.0 (was 2.9). On random-walk test data none of them passes (49.7–52.8% right): patterns
  are a popular idea, and the record says whether they work here.

### A call every round, guaranteed (v13.43.3)

From 10:00 left the Deck always shows a side; there's no SIT OUT after the first 5 minutes.

- **No fresh price yet:** if the round is loaded but there's no fresh price (only last visit's, marked DELAYED), the
  Deck shows the round call and waits for a price only for buy calls. This state used to throw and blank the Deck.
- **The bot's odds aren't ready:** if they can't be worked out yet (no price or volatility), the pick falls back to
  Kalshi's favourite (its mid price), else the side price is on. It's marked as a fallback and never a buy
  (`pickFallback`, `public/pick.js`). The phone replaces it with the bot's own pick as soon as it can.
- **On the server:** the pick is given a minute after 10:00 left to use the bot's math. After that it locks the
  fallback, or locks even when Kalshi shows no price to buy at. So every round's call is recorded, posted and graded.
- **Scoring:** fallback picks stay out of the bot-vs-Kalshi score and the learned mix. A pick with no price counts no
  money.

### The flip study (v13.43)

Flip calls had never fired on the live record, so their accuracy couldn't be measured. `public/flipstudy.js` replays
them on the server's candle history (up to 21 days, every coin, rerun hourly in `tunefeed.js`):

- **Replay:** in every past round, the side ahead at 10:00 left is the locked call. The first minute the other side's
  worst-case odds (the bot's own math, volatility 20% off either way) reach the flip bar is a flip. It won if the
  round closed on the new side. The study learns from every minute down to the last one, and reports the real lane's
  flips (10 to 5 minutes left) separately.
- **What it records at each flip:** minutes left; how far past the target in typical moves; how many minutes price had
  held the new side; whether one sudden minute did the crossing; the last 3 minutes' push; how jumpy the market was;
  the wick back toward the target.
- **The rule:** one-line filters ("only after 2+ minutes on the new side", "never on a spike over 2.5 typical
  moves", ...). The best is picked on the older two thirds of the flips and tested on the newest third. It blocks
  flip calls (bot and phone, `engine.js` flipOk) only once proven there: the flips it keeps beat the ones it blocks,
  z 2+, 30+ kept.

**Late flips (v13.43.1):** flip calls can run past the last-minutes rule (5 minutes on Profit and 90% target). They go
down to the latest minute where history's flips won at least the flip bar (90%): over all of them, in both the older
and the newer half, with 30+ flips, and with each added minute holding on its own (20+). The window is checked
minute by minute, 4 then 3, 2 and 1 left, and stops at the first one that fails. The price rules still apply (the
Profit level's 90¢ cap, the 90% target's floor, the switching gap over Kalshi's price). Until history proves it, the
last-minutes rule stands.

The Record tab's flip-calls row shows history's win rate for the lane and for every minute, and the rule's test
numbers. The signal board lists the rule as in calls or on probation.

### Simple mode, the signal board and Discord roles (v13.42)

- **Simple mode:** the **Simple / Pro** button at the top. Simple shows the call, the line and the signal board's
  one-line summary, and hides the Radar and Learn tabs and every card marked `data-pro`. A brand-new phone starts in
  Simple; a phone that already used the app stays in Pro.
- **Signal board** (Deck, `public/signals.js`): every factor the bot learns from in one list, each marked **in
  calls** (proven on rounds it never trained on), **probation** (still being tested, with a bar showing how far it is
  from proven) or **context** (never part of a call). Each proven factor that has a read on this round shows its side
  and whether it is with or against the side on the card. The rows on probation are folded under the proven ones.
- **Discord role sync** (`discordroles.js`): a paying member taps **Link Discord** in Settings and signs in on
  Discord's own page. The server adds them to your Discord server with the members' role, and removes the role when
  their access ends (expired or revoked). It re-checks right after any admin change and every 10 minutes. Admins see
  each member's Discord name and role state in the members list. To turn it on:
  1. In the Discord Developer Portal, create an application. Under **OAuth2 → Redirects**, add
     `https://<your app>/api/discord/callback`.
  2. Under **Bot**, create the bot and reset its token. Invite it to your server with **Manage Roles** and
     **Create Invite**, then drag its role above the members' role.
  3. Turn on Developer Mode in Discord, then copy your server's ID and the role's ID.
  4. In Railway → Variables, set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
     `DISCORD_GUILD_ID` and `DISCORD_ROLE_ID`. The redirect comes from `APP_URL` or the Railway domain, or from
     `DISCORD_REDIRECT_URI` if you set it.

  Until these are set, the feature is off, and admins see which variables are missing. The client secret and the bot
  token never leave the server.

**Every coin opens, refresh-proof (v13.42.1–v13.42.2):** closed coins stay pickable. Only the server's own sign-in 401s
(marked `x-paywall`) send the phone to sign in. Each coin keeps its own saved price and learned numbers, and until a
coin's bot is running, the server answers its requests with "starting" instead of Bitcoin's data. On the phone, saved
logs are type-checked as they load, and a bad saved position gets its own small card. If the Deck still can't draw,
the error shows on the card, and the phone clears that coin's saved logs and reloads, once a session.

**Every coin, its own numbers (v13.42.3):** prices, misses and moves are shown at the coin's own precision across the
Deck, the accuracy report, Market watch and Discord alerts (DOGE's $0.078 used to read $0). Labels and explanations name
the coin you're on. The accuracy report says which market it's for, and its numbers are tidied to 6 significant
digits. Your own trades get a good/bad verdict from 10 trades (a ledger, not an estimate). A pick whose odds are
within 0.002 of Kalshi's reads "level with Kalshi", and BUY picks are judged on money from 20.

### The line, receipts and record windows (v13.41)

These ideas came from studying another 15-minute terminal. Each was rebuilt and tested the Shot Caller way.

The Deck's new **The line** card has these parts:

- **The lead:** the lead over the target next to how far price usually still moves in the time left. The ratio between
  them is the cushion (razor, thin, solid, strong, near-certain).
- **History at this cushion:** how often rounds actually finished on the leader's side at this cushion and time left,
  over the last three weeks of candles (`cushionTable`, `public/settle.js`).
- **What a flip needs:** how much the other side has to move, and in how long.
- **Razor warning:** shown when the lead is under a quarter of the move left.
- **Settlement watch (crypto, last 60 seconds):** Kalshi settles on the average of the last 60 one-second prints. The
  watch shows the seconds already banked, where the average lands if price holds, and what the seconds left would
  have to average to flip it. Past about 4σ it is locked by arithmetic.
- **Pressure vs the leader:** how often the leader still won when buyers and sellers disagreed with it (the Round
  scan's graded samples).
- **Sessions:** when Sydney, Tokyo, London and New York open and close.

Every official call and round call is **sealed with a receipt**: a hash of the call and the receipt before it. Editing
or removing any call breaks every receipt after it. The receipt is shown in the record and posted to Discord with the
call.

The official record can be read over the **last 1h, 4h, 12h, 24h or 3d**, or all time.

One idea was deliberately not copied: keeping thin-lead rounds off the record as "practice". Every round call is
graded.

### A call every round, and the loss lab (v13.39)

**Every round gets a call.** From 10:00 left, when nothing is worth buying, the Deck shows the round call (the
10-minute pick: the likelier side by the bot's odds and Kalshi's combined) instead of SIT OUT. It's marked BUY only when
the price is right; otherwise it says it's a lean. A server that restarts late still locks the round's call (marked
late) until the last minute. If the server's call isn't in, the phone works out the same call itself. Discord posts it
as the ROUND CALL.

**The loss lab** (`public/losslab.js`). Every call stores what the bot saw: distance to the target, volatility vs
normal, Kalshi's odds, the bot-vs-Kalshi gap, momentum, the flip check, and buyers vs sellers. After each loss it does a
deep dive from the candles: how far ahead it got, how far behind, when price last crossed the target, and how fast price
moved vs what the bot expected. It names the likely reasons (too close to call, a volatility spike, a late turn, never
ahead, Kalshi disagreed, sellers against it, the flip check warned, momentum against it, or just the odds). Discord's
result post says why it lost.

Ten kinds of call are scored over the whole record. A kind is proven when it has 30+ graded calls (20 for calls worth
buying), a gap clear by z 2.8, and the same direction in the older and newer half. A proven kind changes the calls from
then on. The round call takes the other side when calls like it lose more than they win. Calls worth buying skip that
kind when it wins less often than its price needs. The Record tab's **Loss lab** card shows the latest losses and why,
the most common reasons, and every lesson's status.

### Flip check (v13.38)

The flip logic now reads the chart's history and the buyers and sellers (`public/flipmodel.js`, `flipfeed.js`). Every
hour it relearns how often the side that's ahead at 10, 6 and 3 minutes left ends up losing, on top of the bot's math:

- **Chart history:** every past round in up to 3 weeks of 1-minute candles. It reads momentum against the leader, the
  leader's recent run, RSI, a rejection wick, candle flow (volume on up vs down candles, where candles closed), a
  volume surge, and the pullback from the round's extreme.
- **Buyers / sellers:** the Round scan's graded tape samples (flow, absorption, big prints, futures, liquidations),
  turned to point against the leader.

Each part is fitted on the older 2/3 of its data and scored on the newer 1/3 against the bot's math. It's used only
once it beats the math there (z 2.5+ on 600+ chart or 200+ tape samples). Once proven, it does three things. It nudges
the odds (5 points at most). It blocks a flip call when it says the new side is likely to flip back (more than the flip
bar allows plus 5 points). It sends a flip warning when it gives the called side a 50%+ chance of losing. The Deck's
hold box shows the live flip check, or that it's still learning.

### Your notes, tested (v13.37)

A member's notes (MACD, EMA, RSI, ceiling / floor, the double bottom) are turned into rules the bot tests instead of
believes (`public/lessons.js`). The new ones join the hourly indicator test (`public/tune.js`): the MACD line crossing
its signal, RSI / MACD divergence, bounces off a rising or falling EMA, the round's opening ceiling / floor
(breakthrough and rejection), and double bottom / top neckline breaks. Each is tuned on the first 2/3 of the history,
tested on the last 1/3, and only reaches the calls if proven. With 12 families tested at once, the bar is now |z| 2.9
(it was 2.7 for 8).

Two of the notes' own claims are checked directly. One is the "60%+ / 70%+ areas" past the ceiling: how often rounds
finished that way from each zone, next to the bot's math. The other is the double bottom's take profit vs stop as
drawn. The Learn tab's **Your notes, tested** card shows each lesson's live read and its record.

### Why it's moving (v13.34)

Gold, silver, oil and the stock indexes get a **Why it's moving** card on the Deck (crypto keeps its trade tape and
scan instead). It splits the move over the last 15 minutes, hour, 4 hours or day into:

- **Macro**: the US dollar, the 10-year Treasury yield, stocks (and oil for the metals).
- **Its market**: silver, platinum and copper for gold; Brent, gasoline, diesel and natural gas for US crude. Only
  the part the macro doesn't already explain counts here, so nothing is counted twice.
- **Its own**: what's left, which is this market's own buying, selling and news.

The parts add up to the actual move. The chart shows the actual move against the part its drivers explain (the
shaded gap is its own part), the futures volume underneath (amber when it's 3× usual), and the EIA's weekly oil
inventory report on oil. The fit comes from the last 3 days of 1-minute moves and says how much of the market it
covers. It explains moves; it doesn't predict them. The drivers come from Yahoo's public charts (`YAHOO_API`
overrides the host, for tests). Silver is listed too, in case Kalshi opens 15-minute silver rounds.

### Related markets (v13.33)

Every market now reads every other market, not just its own price. The Deck's **Related markets** card shows, for
the market you're on, each other asset (crypto, S&P 500, Nasdaq, Dow, gold, oil) sorted by how closely it moves with
this one: correlation and beta on 1-minute moves over the last 3 days, its last 5- and 15-minute move, and the
catch-up it implies (how far this market has lagged what moves it).

Behind it, a model of each market's next 5 minutes from every asset's recent moves is refitted every 30 minutes and
scored on minutes it never trained on. It nudges the calls (at most 5 points) only once proven: 1,500+ test minutes,
at least 0.5% less squared error than "no change", z 2.5+. Until then it's shown, never used. Lead-lag between liquid
markets is small, so it may stay unproven, and that's the honest outcome. The index, gold and oil rows need Yahoo to
be reachable from the server. Set `CROSS=off` to turn it off.

### 15-minute markets only (v13.31)

The market picker and the server list and run only Kalshi's 15-minute rounds, for every asset Kalshi offers them on
(crypto, and any index or commodity that gets a 15-minute market). Hourly, daily, "custom" and longer markets are left
out. `MARKETS_FREQ=all` brings every timeframe back; a series added with `MARKETS_EXTRA` is always listed.

### Every Kalshi price market (v13.30)

The header picker lists every Kalshi market the bot can price, grouped by asset:
Bitcoin, Ethereum, Solana, XRP and Dogecoin (15-minute, hourly and daily), the S&P 500, Nasdaq-100, Dow, gold and WTI oil.
The server finds them live every 10 minutes (`discovery.js`: Kalshi's series by category, matched to an asset by ticker
or title) and runs a full copy of the bot for each market that closes within a day (`stacks.js`): its own odds,
calls, push alerts, learning, official record, guards, 10-minute pick and Discord posts (tagged `[ETH · hourly]`), and
for each asset its own Round scan, liquidations, futures, Market watch, micro model, forecasts and tuners. Crypto uses
Coinbase plus each coin's exchange feeds and index; indexes, gold and oil use Yahoo's public chart prices (`prices.js`),
settle on the price at the close (not a 60-second average), have no exchange trade feeds (those cards hide), and get
no calls while their price is delayed (over 90 seconds old) or the market is closed. A round with many strikes is
called on the strike nearest even odds, locked once calls can start. Each market keeps its own files
(`data/markets/SERIES/`, `data/assets/ASSET/`); Bitcoin's 15-minute bot keeps its files where they were.
Settings: `MARKETS=off` (Bitcoin's 15-minute market only), `MARKETS_EXTRA=SERIES:ASSET,...` (series discovery misses),
`MARKETS_OFF=SERIES,...`, `DISCORD_ALERT_MARKETS=BTC` (which assets post market alerts; `all` for every one; calls,
results and picks post for every market). The Auto-trader still trades Bitcoin's 15-minute official calls only.

### Discord auto-posts (v13.11)

The server posts each official call to a Discord channel the moment it's made, and its result once Kalshi settles the
round (`discord.js`).
- **Call:** UP/DOWN, price, confidence, the target, when the round closes (shown in each reader's own time zone) and the
  win-rate guard's floor. While the profit guard has buy alerts paused, calls post as **PAPER** calls.
- **Result:** win or loss, with the record so far and profit after fees at $10 a call.
- **Setup:**
  1. In Discord, open `#bot-calls` → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.
  2. In Railway, open the service → Variables → New Variable. Set `DISCORD_WEBHOOK_URL` to the copied URL.
  3. Redeploy. `/healthz` shows `"discord": true`.
- **Pasting it.** Quotes, spaces, a `?wait=true` and versioned addresses (`/api/v10/webhooks/`) are all fine (v13.11.1).
  If `/healthz` shows `"discord": false`, its `discordWhy` says whether the variable is missing or isn't a Discord
  webhook address (it never shows the address).
- **Safety.** Only Discord webhook addresses are accepted, and the URL is never logged. Treat it like a password: anyone
  who has it can post in that channel. If it leaks, delete the webhook in Discord and make a new one. Posts go out one
  at a time and respect Discord's rate limits.

### Every exchange in the Round scan and the Market radar (v13.10)

- **Round scan.** It now reads the seven global markets as well (the Binance, Bybit, OKX and Deribit perpetuals,
  Binance, Bitfinex and Crypto.com) as two new inputs:
  - **global flow:** buyers' share across them, recent minutes counting more
  - **global futures lead:** how far the perpetuals ran ahead of USD spot in 30 s, in typical moves

  Both show in the verdict and the table (a new "Global markets" section), and both are learned like the rest. Older
  graded rounds read them as 0, and they only shape the scan chance once the scan's own record proves them. The five
  USD exchanges' reads are computed exactly as before, so the record the scan has earned keeps its meaning.
- **Server.** It streams the global markets too, in their own store, with prices aligned to USD spot. They never touch
  the bot's price, Market watch's feed and bad-data checks, the scan's sample gating or the micro model. Binance and
  Bybit block US servers, so the server uses whichever ones connect; the phone streams all of them.
- **Market radar.** Every exchange is now a blip on the radar's scope at its current price: green when buyers led its
  last minute, red when sellers did. A summary line shows how many trade above vs below the target. The radar's 90%
  calls keep their own math and graded record.

### Classic bitcoin icon (v13.9.1)

The icon is cleaned up to the classic bitcoin mark: an orange coin (#F7931A) with a white ₿ tilted 14°, drawn with the
logo's proportions (slab ends on the left, two ticks above and below), a soft rim, a light gloss and a gentle glow on
deep navy. The circuit traces, milled edge and sparkle are gone, so it reads as bitcoin at every size. The icon links
now carry `?v=3`.

### Gold bitcoin icon (v13.9)

A new app icon: a gold bitcoin coin with a polished rim and 144 milled edge ridges, an engraved circuit-trace face with
a ring of nodes, an embossed ₿ tilted like the classic mark (depth shadow, bevel highlight), a light sweep, a warm halo
and a glint, on a deep navy background. One vector (`public/icon.svg`) renders the 180, 192 and 512 px PNGs. The coin
stays inside the safe zone, so circle or squircle crops never cut it, and the ₿ still reads at 32 px. The icon links
carry `?v=2` so phones and installed apps pick it up.

### Global markets (v13.8)

Seven more BTC markets stream live, the ones where most of bitcoin's price discovery happens, so moves often show up
there before the USD exchanges (`public/feeds.js` GLOBAL_EXCHANGES):
- **Perpetual futures:** Binance perp, Bybit perp, OKX perp and Deribit perp.
- **The biggest USDT spot market:** Binance.
- **More USD flow:** Bitfinex and Crypto.com.

**What they feed:** the trade tape, the bull/bear tug of war, whale alerts, the live-order bubbles, "why it moved", the
exchanges' trend line (renamed "Exchanges"; it's graded and weighted by its own record, so it only gains weight if it
predicts better) and the flip forecast.

**What they never feed:** the bot's live price, Market watch's bad-data checks, the Round scan and the server's proven
learners. USDT prices and futures premiums sit off the USD spot price Kalshi settles on.

**Price alignment.** Each venue's price level is aligned to USD spot. The offset is measured only when both traded
within a second, at most once a second, with a ~3-minute time constant: premiums drift over minutes, while lead moves
happen in seconds and are kept as they are. Trades are held back until the first offset is known.

**Where they stream.** From the phone. Binance and Bybit block US servers, and outside the US they may block your phone
too; a venue that can't connect just shows as down in the feed chips. Keep-alives are handled: Bybit and OKX pings,
Crypto.com's heartbeat replies and its subscribe delay.

### Profit protection (v13.7)

A high win rate isn't profit. Calls bought at 90¢+ win small and lose big: a level winning 92.5% of its calls at 93¢
loses money after fees. This version guards the money, not the win rate (`public/profitguard.js`).
- **Profit guard.** It scores each level's last 40 graded calls as $10 held to settlement after Kalshi's fee.
  - With 20+ calls adding up to a loss, that level's **buy alerts pause**: on the phone the call shows as PAUSED, and
    push alerts and the Auto-trader's buys stop.
  - The bot keeps logging what it would have called, so the alerts come back on their own once those calls make money
    again.
  - Sources: the official record for the 90% target level, Near-certain's record for Near-certain, and the phone's own
    call log for other levels.
- **Daily loss limit** (Settings, $25 by default, 0 = off). Once your tracked trades lose that much in a day, buy alerts
  stop until midnight, on the phone and in push alerts (the stop is synced to the server).
- **Accuracy card.** Levels are now judged by profit after fees, not win rate. New rows show the profit guard on your
  level and your own trades against your daily limit.

### Fast lane for early calls (v13.6)

The 90% target level now calls overwhelming leads sooner, without lowering its bar.
- **Fast lane.** When the bot is **98%+ sure** and **Kalshi prices the side at 93¢+**, the steady wait drops from 60 s
  (30 s in a calm market) to **20 s**. Every other check stays exactly as strict: the price floor and win-rate guard,
  the 1¢ gap after the fee, 90%+ hold odds, and never switching sides.
- **Why the hold rule stays.** Hold odds don't depend on time left (a 97% lead has ~0.83 hold odds at 12 minutes or
  at 4), so the 90%-hold rule works as "be ~98.5%+ sure", not as a penalty on early calls. That rule keeps the record
  clean, so it stays.
- **Simulated** (30,000 rounds per case, 15-second steps):
  - calls with 8–14 minutes left rose 30–75% (470 → 767, 279 → 498, 660 → 852)
  - those early calls won 92–95%, about the same as or a bit better than before
  - all calls won 94–96% vs 92–94% before
- **Record tab.** It shows how many minutes are left on average when calls come, and how the early calls (8+
  minutes left) have done.

### 90% target level and win-rate guard (v13.5)

From now on the official bot record is made on a new risk level built for a 90%+ win rate. The earlier Steady calls
stay in the file and show under it as "Before the 90% target".
- **90% target** (`RISK_LEVELS.target90`, also in Settings → Risk level). A call needs:
  - **Kalshi's own ask for the side at the floor or more** (90¢ to start). Kalshi's price is a well-calibrated win
    chance, so 90¢ sides win about 90% of the time on their own.
  - **the bot rating it higher still at that price**, after the fee: a 1¢ gap at the worst of three volatility guesses,
    confidence 92+ held for a minute, and a 90%+ chance it holds all round.
  - It never switches sides mid-round.
- **Win-rate guard** (`public/winguard.js`). It watches the level's last 100 graded calls, with the win rate shrunk
  toward its 92% aim by 40 calls' worth. If the record slips, the price floor rises (90¢ + 1.5 × the shortfall, at most
  97¢), so it makes fewer, surer calls until the record recovers. One early loss in 3 calls lifts it to 93¢; 88% over
  100 calls lifts it to 95¢. The phone applies the same floor when you pick the level.
- **Record tab.** It shows the guard's floor, the last 100 calls' win rate and its 95% lower bound. The Accuracy card
  judges this record against the 90% win rate, with profit shown.
- **Simulated** (20,000 rounds per case, Kalshi calibrated plus noise, the bot with real volatility errors):
  - won 92–97%, vs 80–84% for Steady's rules on the same rounds
  - with the guard on: about 92.5% when Kalshi prices fairly, 94–95% when favorites are 2¢ underpriced (common in
    betting markets) and about 91% when they're 2¢ overpriced
  - If Kalshi overpriced favorites by 4¢ across the board, it would hold only 89–90%. Raising the floor can't fix a
    market that's wrong at every price, and the Accuracy card would show it red.
- **The cost.** Calls cost 90¢+, so a $10 win pays $1 or less, and one loss costs the $10. When Kalshi's prices are
  efficient, the fee makes these calls lose a little money even while they win 92%+ (simulated: −$0.06 to −$0.21 per
  $10 call). When its prices are noisy, they made a little (+$0.08 to +$0.18).

### Tuned momentum, accuracy card, accuracy report (v13.4)

- **Tuned momentum.** Momentum has been off since an old test found BTC's drift doesn't carry, a hand-made call that
  was never retested. The volatility tuner (`public/voltune.js`) now also tests carrying or fading the last 5–60
  minutes' drift at weights −0.6 to +0.6, walk-forward by log score against no momentum. A proven pick (z ≥ 2.5) sets
  the bot's drift lookback and weight, unless you've set your own momentum weight in Settings. On simulated random
  walks it was never proven (0 of 6 seeds); on a market whose drift really carries, it was.
- **Accuracy card (Record tab, top)** (`public/accuracy.js`). Every predictor's out-of-sample record, each next to the
  baseline it has to beat:
  - official and Near-certain calls: win rate, with profit after fees at $10 a call as the bar
  - the prediction engine: Brier vs the distance odds, and its 90%+ calls
  - the blended prediction lines and the expected path vs "no change"
  - the cone's band coverage and its Brier vs Kalshi
  - the radar's promised 90%
  - flip calls vs a random minute
  - which tuners are on

  Green beats its baseline, red is behind it, and grey means fewer than 30 samples.
- **Copy accuracy report.** One tap copies all of it as JSON, with sample sizes and nothing personal (no keys,
  balances or trades), to send to whoever tunes the bot.

### Tuned volatility and fat tails (v13.3)

Every probability the bot gives comes from its volatility estimate, so this is the most direct lever on how accurate its
odds are. Until now the settings were hand-picked (EWMA decay 0.94, a floor at 60% of the 2-hour volatility, no
scaling) and the moves were assumed normal.
- **The tuner** (`public/voltune.js`, run hourly on the server by `voltunefeed.js`) tests 630 combinations on the
  server's 1-minute history (up to 21 days):
  - EWMA decay 0.88–0.98
  - floor 0.4–0.8 × the 2-hour volatility
  - scale 0.85–1.2
  - fat tails 0–0.6
- **How it's scored.** Every 15 minutes it checks how likely each setting made the real moves over the next 5, 10 and
  15 minutes. That's the log score, a proper scoring rule: it rewards the setting whose whole distribution, middle and
  tails, matches what happens.
- **Walk-forward by day.** Each day is scored with the setting that did best on the days before it, against the
  standard setting. The bot switches only when that out-of-sample gain has z ≥ 2.5. The 15-minute starts don't
  overlap.
- **Fat tails** (`public/model.js` probYes). The volatility itself is treated as uncertain: log-normal around the
  estimate, with the same average variance, averaged with 9-point Gauss–Hermite. Big moves become likelier and middling
  ones a little less likely. So the bot is **less sure of big leads (odds above ~95%)**, where Near-certain and the
  radar's direction calls live, and slightly surer of modest ones.
- **Where it's applied.** In the bot's odds on the server and the phone (through `/api/learn`), the stress-tested edge
  and the dip limit, only while learning is on. "What it's using" shows the settings and their z. `/api/voltune` has
  the full report, including how often each setting's 90% range held on out-of-sample days.
- **Simulated markets (21 days).** When volatility shifts every half hour without warning, it's proven (z 3.7–5.6),
  picks a faster decay and fat tails, and its 90% range holds 0.89–0.90 vs 0.885 for the standard setting. On GARCH and
  constant-volatility markets it was proven on one seed of two. It can't be checked on real BTC from this build
  environment; the server runs it on its own history.
- An hourly run is ~2.5 s of work, done in slices, so the server never stalls more than ~0.13 s.

### Market radar (v13.2)

A new card under the chart. It makes calls about the current round that come true **at least 90% of the time**,
graded at every close.
- **How 90% is reached honestly.** Not by out-guessing BTC: any question whose answer is wide enough can be answered
  90% of the time, and the radar finds the narrowest such answers from the bot's own record. The method is split
  conformal prediction (`public/radar.js`). Every logged minute left a score, how far the close landed from the blend's
  expected close in typical moves. With n past scores, the ⌈(n+1)·0.9⌉-th smallest is a threshold a new score stays
  under with probability ≥ 90%, whatever the distribution (fat tails, skew), provided coming rounds behave like past
  ones.
- **The calls:**
  - closes above a floor
  - closes below a ceiling
  - closes inside a range
  - the next 1-minute candle closes inside its band
  - **UP or DOWN**, but only when even the 90% floor (ceiling) clears the target, so it inherits the 90%. Otherwise it
    says how far short the margin is.
- **Per stage of the round.** Scores come from the same stretch (1–3, 4–7, 8–14 minutes left) once it has 30, else from
  every minute. Below 9 graded minutes there's no guarantee yet: it uses the normal curve's 90% points and labels the
  calls "≈90% (learning)".
- **Graded.** Every call is logged each minute and graded at the close. The card shows how often each kind really held.
- **What to expect from direction calls.** If the lines add nothing over the price, a random walk that starts at the
  target gets a 90% direction call at 10 minutes left in about 7% of rounds, at 5 minutes left in about 37% and at 2
  minutes left in about 62%. Kalshi prices those sides at about 90¢ or more as well, so they're accurate but rarely
  profitable. Ninety percent accuracy on the open question (which way, from the start) isn't available to anyone.

### Calibrated lines (v13.1)

Each prediction line is now made more accurate on its own before the blend.
- **Move scale per line.** A line can point the right way but call the size of the move wrong. Kalshi's price or the
  bot's odds turned into a close overshoot when they're noisy or priced with another volatility; the exchanges' trend
  undershoots. Each line's predicted move (from "no change") is multiplied by its least-squares slope on the real move
  (Cov(predicted, actual) / Var(predicted), in typical moves). The slope is shrunk toward 1 by 20 rounds' worth of
  data, kept within 0–2, and fitted per stretch of the round. A line that knows nothing collapses onto "no change".
  The chart draws the scaled lines.
- **The blend's own scale.** Averaging lines that were each shrunk on their own leaves the blend too timid, because
  combining cancels some of their noise. So the blended move gets its own slope the same way. The expected path (the
  cone's centre) multiplies its move by it.
- The Prediction lines card shows each line's scale ("moves ×0.62") and the blend's.

Walk-forward simulation (3 seeds × 3 scenarios, 300 rounds), blend average miss vs v13.0:

| Lines | Change |
|---|---|
| Know part of the move, roughly well sized | 0–1.7% smaller |
| Over- or undershoot | 12–14% smaller |
| Know nothing | 1.3–1.5% smaller, level with "no change" (v13.0 was 1–2% behind) |

Single lines: the exchanges' trend about 4–10% smaller miss when scaled; noise-only lines about 7–15% smaller. These are
simulated rounds; the scoreboard on the card shows the real numbers.

### Every-minute blend (v13.0)

There is no magic accuracy switch, because BTC over 15 minutes is mostly noise. v13.0 makes the blend learn faster and
fit the moment better, and it adds a scoreboard so you can see whether it's working.
- **Every minute is graded.** Each line's close prediction is logged at every whole minute of the round (14 down to 1
  minute left), not only at 5 minutes left. A round now gives about 14 graded samples instead of 1. Misses are measured
  in typical moves (miss ÷ (price × 1-minute volatility × √minutes left)), so samples taken early and late in the round
  can be pooled.
- **Weights by stretch of the round.** The weights are fitted separately for 1–3, 4–7 and 8–14 minutes left, each
  pulled toward the all-minutes fit until it has 30 rounds of its own. Kalshi's price tends to say more near the close
  and a trend more early, and the weights can now follow that. Error sizes are pulled toward the pooled fit on a log
  scale and correlations linearly, so one stretch's bigger misses can't swamp another's.
- **Steadier on a short record.** Weights are pulled toward equal weights by 20/(n+20), because a plain average is hard
  to beat on a few rounds. Biases are shrunk by n/(n+60).
- **Blend scoreboard.** The blend's own close forecast is logged each minute using the weights known at that moment, so
  it's out of sample. The Prediction lines card shows its average miss next to "no change" and the best single line on
  the same calls.

Walk-forward simulation (5 seeds, 300 rounds): about 3–8% smaller average miss than v12.9, about level with a plain
average for the first 30 rounds and about 2–5% better after that. When the lines carry no information, it's level with
v12.9 (both 1–2% behind "no change"). These numbers come from simulated rounds; the scoreboard will show the real ones.

### More prediction lines, optimally blended (v12.9)

Four new lines join Kalshi, the five exchanges and the prediction engine: the **bot's own odds** (its P(YES) turned into
the close it implies), the **guide** forecast, the **micro model**'s push over the next five minutes and the **move
model**'s proven moves (both used to be bolted onto the path; now they're lines like the rest and get graded the same
way). **No change** is logged and graded as a hidden line too.

The expected path (the cone's centre) is now the **minimum-variance combination** of the lines (Bates–Granger with the
full error covariance): w = M⁻¹1 / (1ᵀM⁻¹1), with M the matrix of the lines' past misses at the close. The old
inverse-MSE weights were only right if the lines' errors were independent. Bot and Kalshi often miss together, so they
used to count twice; now they share weight, and a duplicated line can't double its say.
- **Bias removed.** Each line's average miss is subtracted (shrunk by n/(n+20) while the record is short).
- **Shrinkage.** M is shrunk toward its diagonal by 20/(n+20), so a handful of rounds can't overfit.
- **Non-negative.** A line whose weight would go negative drops out and the rest are re-solved.
- **Waiting lines.** A line with fewer than 5 graded rounds weighs as an average line. No change weighs nothing until it
  has a record.

The Prediction lines card shows each line's share of the blend and the bias removed. This is the exact optimum *given
the measured errors*; it can't make the combined forecast better than the information in the lines, and it needs
graded rounds before the weights move.

### Ghost candles removed (v12.8)

The faint prediction candles after the live candle are gone from the chart.
- **What stays:** the expected path they were drawn from: the prediction lines, the flip forecast, the micro model and the move model, scaled by its own record. It's what the **cone** is centred on, and the **flip markers (↺)** and **⏱ round closes** sit on it, carried by an invisible line.
- **Grading:** it's still graded every minute (direction, close miss vs "no change", and its scale factor) in the line under the chart.
- **Removed along with the candles:** the "Prediction candles" chart toggle, the candle-size (wick) model and the size grading, which only existed to draw the candles. The candle model is now just the **move model**.

### No wiggle room (v12.7)

The last numerical gaps, closed and **checked against exact references**:
- **The settlement, done right.** Testing v12.6's claim showed its two-moment log-normal was off by up to 0.0004 in probability, because an average of prices isn't shaped like one log-normal price. The settlement sum now splits exactly into two independent parts:
  - **The move until the last minute starts:** exactly normal in log terms.
  - **The last minute's 60-print shape:** depends only on the volatility, so it's computed once and cached. It gets its exact mean, variance and third cumulant, and is represented by the shifted log-normal with all three.
  - **Combining them:** 24-point Gauss–Hermite quadrature over whichever part is narrower.
  - **Checked against:** an exact one-dimensional integral (two prints left, at 25× BTC's usual volatility), where it agrees to under 1e-9. And against an independent print-by-print exact recursion from 10 minutes out to the last seconds, where it agrees to within 3e-9, the reference's own accuracy.
  - **A bug found on the way:** a log-normal's skewness is (w + 3)√w, not (w + 2)√w.
- **Hold odds:**
  - The 10-second move kernel keeps its variance exactly. Integrating the density over each grid cell would add the cell's own spread; I tested that and it biased the answer.
  - Two grids are combined by Richardson extrapolation, which cancels the leading grid error.
  - The result is within 0.00001–0.00003 of a reference on a grid four times finer.
  - Seven Gauss–Hermite points cover the volatility uncertainty: five would shift answers by up to 0.000007.
- **Fees in exact integer arithmetic:** prices in 1/10,000ths of a dollar, contracts in hundredths, the rate in parts per million, and a true ceiling. There's no floating-point fudge term any more. Floating point gets 4 contracts at 50¢ wrong (7.000000000000001 rounds up to 8¢); the exact answer is 7¢.
- `test/math.test.js` pins each of these.
- **What's left:** floating-point rounding (~1e-15), and the model's assumptions about the market (a random walk at a learned volatility, Kalshi's index vs Coinbase, zero drift). No math removes those; the live record measures them.

### Exact to the last digit (v12.6)

The last approximations in the bot's own math, removed:
- **The settlement, exactly:** Kalshi settles on the average of its index's last 60 one-second prints.
  - The prints still to come are correlated log-normal prices, and the exact mean and variance of their sum are computed for every price. The variance is calculated directly with `expm1`, so no digits cancel.
  - The settlement is priced from a log-normal with exactly those moments. Prints already made in the last minute count at face value. *(Correction: these notes first claimed the remaining shape error was below a billionth. It was really up to ~0.0004, found and fixed in v12.7.)*
  - The averaging is discrete: 60 prints give a variance of t − 1 + 0.3417 (×σ²), not the continuous t − 1 + 1/3. An average of a random walk is also skewed very slightly upward, so at the money the true chance is about 50.003%, not exactly 50%.
  - Every odds nudge is now the settlement odds' own difference.
  - Kalshi's implied close, the engine line and the cone use the same exact spread.
- **Fees, exactly:** Kalshi rounds the fee once per order. Every buy edge now charges the exact fee of the order the bot would place (its Kelly-sized count), and exits use the position's own count. Every "$10 a call" result (records, scorecards, live records) uses whole contracts and the order's real fee. For example, $10 at 37¢ is 27 contracts and their single rounded fee.
- **Calibration's standard error:** a round's samples in one probability bin share its outcome, so they count as one observation of their combined weight. Older rounds count at their faded weight, and the standard error comes from the sum of squared weights. Older saved data starts from the old, cautious count.
- **Hold odds:** the grid cell straddling the confidence floor now keeps its exact fractional share, so the answer converges as the grid gets finer instead of wobbling. With a finer grid it's within ~0.0002 of the converged value.
- `test/math.test.js` checks the settlement against a brute-force sum over all 60×60 print pairs (agreement to 1e-12), and also checks the fee rounding and the calibration weights.
- **What exact math can't remove:** the model's assumptions about the market. These are a random walk at a learned volatility (real BTC has jumps), Kalshi's index vs Coinbase (learned from settlements), and zero drift. The live record measures how well those hold.

### The candle model (v12.5; its size half removed with the ghost candles in v12.8)

The prediction candles, deep-dived. **100x more accurate isn't possible.** That would mean missing a minute's close by 1% of what "no change" misses, and one-minute BTC moves are mostly noise. But a candle has two parts that behave very differently, and each now gets the most the data allows (`public/candlemodel.js`, run on the server):
- **Sizes (predictable):** how big each coming minute's candle will be.
  - It's a regression of the log high-low range on the last 5, 30 and 120 minutes' ranges (volatility clusters) and the time of day and week (BTC is busier at some hours).
  - It's tested walk-forward against the old method, the last 30 candles' average, with that baseline's own bias corrected so the comparison is fair.
  - When proven (z ≥ 2.5), each ghost's total size comes from it, split into upper and lower wicks the way the market's recent wicks lean.
- **Moves (barely predictable):** where BTC will be 1, 2, 3, 5, 8, 12 and 15 minutes out.
  - It's one ridge regression per horizon on the prediction engine's factors, graded by out-of-sample R² against "no change".
  - A horizon only moves the candles once it beats "no change" (z ≥ 2.5, on non-overlapping samples). In simulation, pure noise switched on nothing and a planted momentum edge was found.
- **Bodies scaled by their own record:** every graded minute feeds beta = Σ(predicted × actual) / Σ(predicted²). That's the least-squares factor that minimises the squared miss: if the bot's minute moves have overshot, the bodies shrink to match. It's shrunk toward 1 until there are plenty of minutes, and kept within 0–1.5. The cone's centre uses the same scaled path.
- **Grading now includes size:** each minute's predicted high-low vs the real one, next to the recent-average size. The line under the chart shows the direction hit rate, the close miss vs "no change", the size miss vs the recent average, the current beta, and which parts of the candle model are on.
- It runs walk-forward on the server every 15 minutes, a few minutes after the other analyses, so no single tick carries all the work.

### Exact math (v12.4)

A full audit of the bot's math. The predictions can't be perfect (BTC's next 15 minutes are partly random), but every formula now computes exactly what it claims:
- **Normal distribution:** the CDF behind every probability now uses Marsaglia's series in the middle and the continued fraction for Mills' ratio in the tails. It's accurate to ~1e-15, even for tiny tail chances; the old approximation was good to ~1e-7. The inverse adds a Halley step on the exact CDF, so it's full precision too (it was ~1e-9).
- **Hold odds** ("will confidence stay above 80 all round", used by Steady, Sniper and Near-certain) were a 300-path random simulation, about ±2.5 points of noise. Now they're computed exactly:
  - the price distribution is stepped forward on a fine grid, with the paths that break the floor removed at every 10-second check;
  - it's averaged over the volatility uncertainty with 7-point Gauss–Hermite quadrature;
  - it matches a 40,000-path simulation within that simulation's own error, and it's cached so every device shares the answer.
- **One volatility rule everywhere:** Kalshi settles on the last minute's average, which the bot's own odds always accounted for. The odds nudges (micro model, tuned indicators, reversal checklist, guide forecast, engine), Kalshi's implied close, the engine line and the cone's chance above the target now use that same settlement variance instead of a single price's. That's about a 7% difference in variance with 5 minutes left.
- **Blend weights:** the prediction lines are now weighted by inverse mean squared error, the correct inverse-variance weights. The old weights were inverse squared average miss.
- **The cone:** it now uses the exact quantiles of its skewed (split-normal) distribution. Calibration is graded by where each close fell in that distribution (the probability integral transform), and the width factor is solved exactly from the band edges.
- **Constants:** range-to-volatility uses √(8/π) (was 1.6), and the 90% edge uses 1.6448536…
- **Order sizing:** Kalshi rounds the fee once per order, not per contract, so sizing now uses the order's exact total. For example, $25 at 50¢ buys 48 contracts with a $0.84 fee, not 47.
- **Checked as correct and left alone:**
  - the settlement-average variance
  - the probability of settling above the target
  - the Kelly formula
  - Kalshi's fee rounding
  - the volatility estimates
  - RSI and EMAs
  - the calibration's 2-standard-error rule
  - the walk-forward tests' statistics
- `test/math.test.js` pins all of it to reference values.

### The cone: the market's most predictable outcome (v12.2)

The forecast cone used to be a plain funnel around the current price, sized by volatility, and it ignored everything the bot reads. Now it scans the market for where BTC is most likely to be (`public/predict.js` `marketCone`):
- **Centre:** the expected path, the same market read the prediction candles follow: the prediction lines (bot, Kalshi's implied close, the 5 exchanges' trend, the prediction engine), the flip forecast and the micro model.
- **Width:** the volatility the bot prices with (learned by time of week, corrected every second), blended with how far the last 30 real candles actually moved. That's multiplied by the cone's own calibration factor.
- **Skew:** the last hour's upside vs downside moves. When drops have been sharper than rallies, the downside of the cone is wider, and the reverse. It's kept within 0.7×–1.4×.
- **Self-calibrating:** every round, the cone's close band with 5 minutes left is checked against where BTC really closed. The width factor is set so the 90% band holds about 90% of closes; it's taken from the actual misses and shrunk toward 1 until 20+ rounds.
- **The most predictable outcome**, in the line under the chart:
  - the most likely close zone (the 50% band) and the 90% band
  - which side is wider, and why
  - the chance of finishing above the target
  - the cone's record: how often each band held, and whether its above-the-target chance has scored better than Kalshi's own price at the same moment (Brier)

### Prediction candles (v10.1; read from the market since v12.1; removed from the chart in v12.8)

In the Chart tab's Round and 1m views, faint **prediction candles** follow the live candle, one for each minute left until the close (`public/predict.js`). Since v12.1 they draw **exactly what the bot expects, with no random noise**. From v10.2 to v12.0 each ghost was one random scenario around the forecast, so its ups and downs were dice rolls.
- **Bodies: the expected path, minute by minute.** It blends the prediction lines, weighted toward whichever has missed least at past closes (1 / miss²; lines without 5 graded rounds count as average):
  - **Bot:** the bot's own drift.
  - **Kalshi:** the close Kalshi's price implies.
  - **5 exch:** the exchanges' trend.
  - **Engine (new):** the close the prediction engine's P(UP) implies.

  The flip forecast then bends it (today's momentum carried forward, turning where the market looks ripe to flip), and so does the micro model's proven 1–5 minute read. When the read leans up, the candles go up; when it's unsure, the bodies are small. They don't invent moves.
- **Wicks: how the market has been trading.** They're the average upper and lower wicks of the last 30 real candles. For example, long lower wicks lately (buyers absorbing dips) give the ghosts long lower wicks. They also include any turn the expected path makes inside the minute.
- **Graded every minute:** each minute's candle, as it stood just before that minute began, is compared with what that minute really did. The line under the chart shows the direction hit rate and the average miss at the minute's close vs "no change". The prediction lines are graded at each close, the Engine line included.
- Turn them off in Chart tools & indicators (**Prediction candles**).
- **⟲ LIVE** now shows only when the live candle itself has scrolled off screen. Tapping it brings the live candle back with the minutes to the close in view, keeping your zoom.

### The prediction engine and the 90% question (v12.0)

A statistical model trained on the 1-minute BTC history (`public/predictor.js`, run by `playbookfeed.js`). It gives a calibrated **P(UP) and P(DOWN)** for the live round at 15, 10, 5 and 2 minutes before the close.
- **The start:** the distance-to-target odds, N(ln(price / target) / (volatility × √minutes left)). This is what the bot's odds are built on.
- **The factors**, added by a logistic model (one per checkpoint, heavily regularised):
  - 1-hour trend (20 vs 50-hour average)
  - 15-minute EMA 20/50
  - VWAP
  - 5-minute RSI, and whether it's rising
  - 5- and 15-minute momentum
  - buy vs sell volume, and volume rising with the move
  - a liquidity sweep and reclaim
  - 5-minute market structure

  The 1-minute chart is only used for entry timing. Live order flow is shown on the guide card.
- **Walk-forward:** each day's predictions come from a model fitted on earlier days only, and every factor uses only candles already closed. Live reads need fresh candles; stale data is never a signal.
- **Compared against** a 50/50 guess, the distance odds alone, and simple momentum (at the open, call the last 15 minutes' direction).
  - Brier and log-loss are reported.
  - For each confidence threshold (55–90%) and each checkpoint: how often calls were right, how often it called, and what the distance odds alone got.
  - Profit from betting every disagreement with the distance odds, after Kalshi's fee and 1¢ slippage.
  - A live record at real Kalshi asks.
- **The 90% answer**, shown in the table: nobody is 90% sure at the open. 90%+ calls only come late (in simulation at 2 minutes left: right ~98% on ~60% of rounds), and **the distance odds alone are just as accurate there**. That's why Kalshi prices those contracts at 90¢+. High accuracy is easy to buy late; profit isn't.
- **Live forecast card (Deck)** in the indicator format:
  - **Call:** UP / DOWN / NO CALL at your chosen confidence (60/70/80/90%+). It calls only when that level has held up walk-forward at this point of the round (100+ past calls, right at least as often as claimed) **and** Kalshi's ask plus fee plus slippage leaves an edge. Otherwise NO CALL, with the reason.
  - **Probabilities:** P(UP)/P(DOWN), and the distance odds.
  - **Evidence:** trend, momentum and volume confirmation, sweep detection, and structure.
  - **Entry:** with 1-minute pullback timing.
  - **Invalidation:** the target, the settlement reference.
  - **Expiry:** the round's settlement.
  - **Track record:** the tested accuracy at your level.
- **On the chart:** a forecast badge (call, P(UP), expiry), plus an entry line on round charts when there's a call.
- **In the bot's calls:** only once it beats the distance odds walk-forward (log-loss z ≥ 2.5 over 1,000+ rounds). Then it nudges by its difference, capped at ±4 points (±6 with the guide and reversal nudges).
- **Simulated:**
  - On pure noise it never beat the distance odds, and momentum at the open was ~50%.
  - A planted edge was found.
  - One test "false positive" turned out to be the test's own random-number generator: a simple LCG with serial correlation, which is a real pattern the model correctly found. The test now uses a proper generator.
- **TradingView:** `tradingview/shot-caller.pine` is a Pine Script v5 indicator for a 15-minute BTC chart. Paste it into TradingView's Pine Editor.
  - **Factors:** 1-hour trend (no repainting), VWAP, EMA 20/50, RSI above 50 and rising, volume, sweep and reclaim, and pivot structure, summed to a score.
  - **Probability:** P(UP) for that score, calibrated walk-forward on the chart's own history.
  - **Calls:** UP / DOWN / NO CALL at your threshold.
  - **On the chart:** entry and invalidation lines, the expiry time, sweep markers, and a table of its accuracy next to 50/50 and momentum, plus its Brier score. It also has alerts.
  - It wasn't compiled here (no TradingView access); if the editor flags a line, it'll name it.

### The 15-minute forecast (v11.9)

"The ultimate BTC 15-minute shot-caller guide" as a forecast card in its own output format (`public/guide.js`, run by `playbookfeed.js`).
- **The rule**, on each closed 15-minute candle (each new Kalshi round):
  - **UP candidate:** price above the day's VWAP, 20 EMA above the 50 EMA, RSI 14 above 50, and bullish structure (higher highs and higher lows, or a close above the last swing high).
  - **DOWN candidate:** the mirror image.
  - **NO CALL:** conflicting indicators; volatility too low (ATR 14 in the bottom 20% of the last week); an untested setup (fewer than 30 past examples); or one its history doesn't back (the calibrated chance for its side isn't above 50%).
  - Major economic announcements aren't known to the bot (no calendar feed), so skip those yourself.
- **Estimated UP probability:** how often BTC really finished up after the same evidence (the four signals summed, −4 to +4). It's counted walk-forward (only rounds already finished at that time) and shrunk toward 50%. Never assumed.
- **The card:**
  - **Calls:** UP / DOWN / NO CALL with the reason, and the estimated UP probability.
  - **Levels:** entry at the candle close, and invalidation at the latest higher low (lower high), kept within 1.5 ATR. Expiry is the next settlement.
  - **Evidence:**
    - trend: VWAP and the EMAs
    - momentum: RSI, and CVD from live exchange trades
    - structure
    - liquidity: the nearest swing high and low, where stops cluster
    - volatility: ATR
    - positioning: funding and open interest
- **Kalshi:** the calibrated chance vs the contract's ask plus Kalshi's fee: the edge in points, and the most worth paying. A right call at a bad price still loses money.
- **The record (Record → Playbook check):**
  - every past round predicted walk-forward, with skipped rounds counted by reason
  - accuracy (and z), UP and DOWN separately
  - profit buying the called side at 50¢ plus fee (a round opens near 50¢), and drawdown
  - the Brier score against always saying 50%, and a calibration table (said vs really up)
  - a **live record** from each round's opening forecast at the real Kalshi ask then, plus fees. It's graded on Coinbase's price; Kalshi settles on its own index, so very close rounds can differ.
- **In the bot's calls:** only once its walk-forward calls beat a coin flip (z ≥ 2.5 on 300+ calls) does a call nudge its round, by the measured move. That's capped at ±4 points, and the guide and reversal nudges together are capped at ±6. In simulation pure noise was never proven, and a planted momentum edge was (56% right, Brier 0.239 vs 0.250).
- Also fixed: the reversal study's 0–4 "insufficient" band can never reach the calls, even if it beats a coin flip, because the reversal guide calls it too little confirmation.

### Reversal watch (v11.8)

The 15-minute BTC reversal guide ("how to predict when the market is about to flip"), as code that gets measured (`public/reversal.js`, run by `playbookfeed.js`).
- **The checklist**, scored on each closed 15-minute candle for a DOWN flip and an UP flip:
  | Signal | Points | What the bot checks (DOWN flip; UP is the mirror image) |
  |---|---|---|
  | Liquidity sweep and reclaim | 3 | a candle in the last 45 min took out the last swing high, and price has closed back below it |
  | Market structure break | 3 | since the sweep, a 15-minute close below the latest higher low |
  | RSI divergence | 2 | higher high in price, lower high in 15-minute RSI 14 |
  | Volume confirmation | 1 | the sweep candle traded 1.5×+ average volume with little progress (exhaustion) |
  | VWAP flip | 1 | price got above the day's VWAP in the last hour but closed back below it |
  | Open interest | 1 | Hyperliquid open interest fell 0.5%+ in 5 min as price spiked (a flush). Live only |
  | MACD divergence | — | shown, not scored (as in the guide) |

  8+ is strong confluence, 5–7 developing, 0–4 not enough. The guide says its scoring is hypothetical and its scores aren't probabilities, so:
- **The bot checks whether the scores predict anything.** After every closed 15-minute candle with a clear side, did the next 15 minutes and the next hour go that way? Results are kept per band against 50%. Rounds start when a 15-minute candle closes, so "the next 15 minutes" is the next Kalshi round. The scoring isn't tuned to the data, so the whole history is a fair test. On pure noise no band beats a coin flip.
- **The guide's flip strategy, backtested step by step:**
  1. a sweep above a previous high (below a previous low)
  2. a close back inside
  3. RSI divergence
  4. within an hour, a 15-minute close through the latest higher low (lower high)
  5. within the next hour, a retest of that level that gets rejected; entry at that candle's close ("wait for a candle close and retest")

  The stop goes beyond the sweep's extreme plus 30% of a typical 15-minute range. The target is 2R (1.5R also recorded), with a 24-hour cap; if the stop and target are hit in the same minute, the stop counts. Costs are 0.05% fee plus 0.02% spread/slippage a side, counted in R. Tight stops make costs a big share of R (0.6R of a 2R win in the test setup).
  - A looser variant without the RSI step is also recorded, as is a split of trades with and against the 1-hour trend.
  - The guide asks for 200+ signals before trusting it. The full rules are strict, so expect a handful a week.
- **Where it shows:**
  - **Deck → Reversal watch**: the live checklist (each signal, its points, the band, the other side's score)
  - **Record → Playbook check**: each band's hit rate for the next round and hour, and the strategy's scorecard (trades, win rate, average R, total R, drawdown, costs, how many to 200)
  - **Chart:** a 5+ checklist score for a flip in the same direction adds to the flip forecast. The flip forecast's strength already follows its own graded record.
- **In the bot's calls:** only a band that has called the next round better than a coin flip (z ≥ 2.5 on 100+ signals) nudges that round, by its measured move, capped at ±4 points. Until then it changes nothing. As the guide says, no indicator can guarantee a reversal.

### Near-certain mode (v11.7)

The highest win rate the bot can honestly aim for. It's never 100%: each round is decided by BTC's price at one second, moved by trades that haven't happened yet. And if the bot were ever truly certain, Kalshi's price would already be 99¢.
- **Settings → Risk level → Near-certain.** A new call needs all of these:
  - confidence 95+, held for 2 minutes (half that in a calm market, 1.5× in a jumpy one)
  - a 95%+ chance that confidence stays above 80 for the rest of the round
  - **Kalshi's own price agreeing:** its bid for the side at 85¢ or more. When the bot is sure and the market isn't, the bot is usually the one that's wrong. The new **Kalshi must agree** setting can also be used on any level (0 = off).
  - the usual gap after fees (1 pt here), the call filter and Market watch
  - and it never switches sides mid-round
- **The cost:** calls are rare and priced 90¢+. A $10 call that wins pays well under $1; one that loses costs the $10. So one loss can erase 20+ wins, and a 95% win rate can still lose money.
- **Measured, not assumed:** the server runs Near-certain on every round alongside the official (Steady) calls and keeps its own graded record (`record-certain.json`). These calls are never traded and never fed to the call filter. **Record → Near-certain record** shows its wins and losses, its win rate and its profit after fees at $10 a call, side by side with the official calls.

### Tuned indicators (v11.6)

Which chart indicators, at which settings, have actually called BTC's 15-minute rounds (`public/tune.js`, `tunefeed.js`).
- **The question:** at 10, 6 and 3 minutes before each round's close, did the indicator's signal say which way BTC would move from there to the close?
- **The candidates** (32 settings in 7 families):
  - EMA and RMA crosses: 5/13, 9/21, 12/26 and 20/50
  - RSI zones: lengths 7, 14 and 21, with levels 70/30, 65/35, 60/40 and 80/20
  - MACD: 12/26/9, 8/17/9 and 5/35/5
  - Bollinger breaks: 20 ±2σ, 20 ±1.5σ, 10 ±2σ and 30 ±2.5σ
  - VWAP from the round's open
  - 3, 5, 15 and 30-minute momentum

  Each signal may work with the move or against it (a fade); the direction is learned too.
- **The data:** the playbook's 1-minute Coinbase history (up to 21 days, about 2,000 rounds). It reruns every hour. Each signal is read off the candle before the latest, so a minute-old candle on the server can't flatter it.
- **No fooling itself:**
  - The first 2/3 of the rounds pick each family's best setting and direction.
  - Only that pick is tested on the last 1/3, rounds it never saw.
  - "Proven" means the unseen rounds agree with z ≥ 2.7 on 150+ rounds. That's strict because 7 families are tested at once. Training must have agreed too (z ≥ 2).
  - Each round counts once. Its checkpoints are summed, never averaged over only the active ones: averaging let a signal that stays on while it's wrong dilute its own losses, which made pure noise look like a working fade. Caught in simulation and fixed.
- **Simulated:**
  - Pure noise: nothing proven in 30 of 30 runs.
  - A planted trend edge: found 5 of 5 times, the right way round.
  - A weaker planted fade: found 3 of 5 times.
- **In the bot's calls:** the proven indicators' read right now (averaged, since trend indicators overlap) shifts where BTC is expected at the close. That becomes a change in P(YES), capped at ±4 points, added to the Round scan's and the micro model's nudges. Unproven indicators add nothing.
- **Record → Indicator tuning** shows each family's best setting, its hit rate on the tuning rounds and on the unseen rounds, its z, and whether it's in the calls. Record → **Used in the bot's calls** lists the proven ones.
- Expect most rows to say "—". Classic indicators rarely have a lasting edge on 15-minute BTC; the point is to use one only if it really does.

### The playbook: market structure, tested instead of believed (v11.4)

What "The BTC Trader's Playbook" teaches, and what the bot does with each part:

| Secret | In the bot |
|---|---|
| Liquidity sweeps / stop hunts | `public/structure.js` finds a wick through yesterday's, the last hour's or the last swing's high or low that closes back inside. It's a micro-model input, a Market watch event and a chart marker. |
| Market structure shift | A close through the last swing against the leg. Micro input, watch event, chart marker. |
| Fair value gaps | Unfilled 3-candle gaps. The nearest one is a micro input (does price get pulled to it?) and is drawn on the chart. |
| Order blocks | The last opposite candle before a 2×-body move. A micro input when price is back in the zone. |
| VWAP | Distance from the UTC day's VWAP, in typical moves. Micro input. |
| Volume divergence | A new 30-minute high or low on less than 70% of the last one's volume. Micro input. |
| Open interest, funding | Already covered by the Hyperliquid futures feed (v10.9). Funding is now also a micro input. |
| Liquidation clusters | Not added. Real liquidation maps need a paid CoinGlass key. Sweeps catch the result (the stop run) from the price itself. |
| ETF flows | Not usable. They're published daily, too slow for 15-minute rounds. |
| Session volatility | Already learned. The volatility table is by hour of the week. |

**None of it is trusted on faith.** These are inputs to the micro model, so they move the prediction candles and the bot's calls only if the model proves they help, out of sample, by its usual rule (500+ graded predictions, 0.5%+ better than "no change"). If the playbook's ideas don't predict BTC's next minutes, they get zero weight automatically.

**The 15-minute sweep strategy, paper-traded** (`public/playbook.js`, `playbookfeed.js`). The playbook says to test it on 100+ examples first, measuring win rate, average reward-to-risk, max drawdown and fees. The server does exactly that:
- **Data:** 21 days of Coinbase 1-minute candles, two weeks read on first start, then topped up every minute.
- **The rules, as written:**
  - Trade with the 1-hour trend only.
  - A 15-minute candle sweeps yesterday's high or low and closes back inside.
  - Within 30 minutes, a structure shift on 1.2× average volume confirms it.
  - Enter on the retest within 30 minutes. No retest, no trade.
  - Stop beyond the sweep's extreme plus 30% of a typical 15-minute range.
  - Target 2R (1.5R also recorded), with a 24-hour cap. If the stop and target are hit in the same minute, the stop counts.
  - Fees are 0.05% a side, counted in R.
- **A variant with more examples** uses the last hour's high or low instead of yesterday's.
- **No parameter is tuned to the data,** so the backtest and the live paper trades are one walk-forward test. It reruns every 15 minutes.
- **Record → Playbook check** shows each version's trades, win rate, average R, total R, worst drawdown, fees, open trades, and how many more it needs to reach 100. Break-even before costs is 33% at 2R and 40% at 1.5R.
- It's a scorecard, not a signal: it doesn't place orders or change calls.
- The chart's **Market structure** toggle draws unfilled gaps and sweep and shift markers.
- `PLAYBOOK=off` turns it off.

### The micro model: small details bend the prediction candles (v11.2)

To make the candles more accurate where small details matter most (the next few minutes), a **micro model** learns how those details move BTC 1, 3 and 5 minutes out (`public/micro.js`, `microfeed.js`).
- **Every 10 s** the server reads:
  - buyers vs sellers on the exchanges (30 s and 2 min)
  - the last 1 and 5 minutes' move (does it continue or snap back?)
  - futures moving ahead of spot, futures flow and the futures premium
  - the leading exchange pulling away
  - big orders soaked up without moving the price (absorption)
  - Coinbase's premium
  - Kalshi's price vs the bot's odds, and Kalshi's trade flow
  - the direction of the latest jump Market watch flagged
- **How it learns:** one recursive least-squares model per horizon, with recent data counting more (about a day's memory). It starts at "no opinion" and is pulled toward it, so nothing sways the lines on a hunch.
- **Graded out of sample:** each prediction is made before its outcome and graded when its 1, 3 or 5 minutes pass, against simply predicting "no change".
- **Proven-only:** a horizon bends the prediction candles only once it beats "no change" by 0.5%+ over 500+ graded predictions.
  - Simulated: pure noise switched it on 0 times in 20 and a tiny push 0 in 20; a moderate push 6 in 20 (+0.4%) and a clear one 20 in 20 (+3.3%).
- **Under the chart:** its current read (next 1, 3, 5 minutes in dollars), which details are swaying it right now, and each horizon's record.
- **The candles:** the expected path bends through the 1-, 3- and 5-minute moves, then holds and blends into the longer-term lines. The per-minute candle grading shows whether it helps.
- **In the bot's calls (v11.3):** a proven read also shifts the bot's odds. The predicted move over the minutes left (up to 5) shifts where BTC is expected to be at the close. With the distance to the target, the volatility and the time left, that's a change in P(YES).
  - +$40 expected matters a lot right at the target and barely at all $500 away.
  - Capped at ±6 points. Only proven horizons count; unproven ones predict 0 and add nothing.
  - It adds to the Round scan's nudge and reaches official calls, push alerts, the Auto-trader and the phone alike.
  - Its predictions are graded on BTC's actual price moves, and its "Kalshi vs the bot" input reads the bot's odds from before any nudge, so its own nudge can't feed back into it.
  - Record → **Used in the bot's calls** shows "Small details (micro model)" with ✓ once it's shaping calls, and the line under the chart shows how many points it's moving the current odds.

### Maker buys for the Auto-trader (v11.0, opt-in)

Research on Kalshi finds **makers** (resting orders) earn more than takers (orders that cross the spread), and makers can pay lower fees.
- **Turning it on:** the Auto-trader's new limit **Maker buys: rest up to (sec, 0 = off)**. It's off by default; 20 is a sensible start.
- **How it buys:** when the bot makes a call, instead of crossing the spread the Auto-trader rests a **post-only** buy a cent above the best bid. Post-only means Kalshi refuses it rather than let it take. It never pays at or over the current ask and never over the call's max price.
- **Watching the order:** it checks every second.
  - A fill is booked at the order's price with the maker fee (measured from real fills once there are enough, v10.7).
  - What's left is cancelled at the deadline, at once if the call goes away, or a minute before the close.
  - If nothing filled, the next try is a normal buy, so a missed maker fill never costs the call.
  - If the price moves onto it before it rests (Kalshi refuses the post-only order), that's not counted as an error; the next try is a normal buy.
- **Safety:**
  - The server allows a resting order only from its own Auto-trader, only as a post-only buy that opens a position (never a resting sell), still in whole cents, under the $100 cap and on BTC 15-minute markets. The phone's direct order route still allows fill-now-or-cancel only.
  - If the server restarts while an order rests, the next step cancels it and books what filled.
  - Cancelling uses Kalshi's V2 `DELETE /portfolio/events/orders/{id}`.
- **Test it first:** the Test simulator rests maker buys too, filling them when the live book's ask comes down to their price and holding the cash meanwhile, so maker buys can be proven in Test before Demo or Live.

### Futures as a leading signal (v10.9)

Research finds BTC futures often move before spot, though the lead has weakened since the spot ETFs launched. So the bot reads Hyperliquid's BTC perpetual (`futures.js`; public data, no key; Binance and Bybit block US servers): every trade over its websocket, plus funding, open interest, mark and oracle price every 15 s.
- **Four new Round scan inputs**, learned like the rest and only shaping the odds once the scan's graded record proves them:
  - **Futures lead:** futures' last-30-second move beyond spot's, in typical moves.
  - **Futures flow:** takers' buy share of the last 2 minutes.
  - **Open interest:** its 5-minute change × the price direction. New money pushing the move reads +, positions being closed reads −.
  - **Premium:** futures vs the oracle (spot) price.
- **Market watch events:**
  - **flush:** open interest down 1.5%+ in 5 min while the price moves 0.2%+, so positions are being forced out (liquidations; the public feed doesn't flag them, this is the standard proxy).
  - **funding:** 0.01%+/hour, one side crowded.
  - **premium:** futures 0.1%+ off spot.
- The Round scan card shows a futures line; `/healthz` shows whether the futures feed is live. `FUTURES=off` turns it off.

### Market watch: the sharp eye (v10.8)

Every second, on the server (`marketwatch.js`, detectors in `public/watch.js`), the bot checks every detail it can see and logs anything unusual:

| Event | What it spots | Effect |
|---|---|---|
| **Jump** | BTC moved 3×+ its normal 5-second move | logged; at 5×+, new calls wait 30 s |
| **Burst** | 5× the usual 10 seconds of exchange volume | logged |
| **Breakaway** | one exchange 0.03%+ (or $25+) away from the others for 5+ s | logged |
| **Silent** | an exchange's feed quiet 30 s+ while others trade; or no fresh price at all | logged; no price at all holds new calls |
| **Spread** | Kalshi's spread on the live round blew out (8¢+, or 3× its usual) | new calls wait until it tightens |
| **Pulled** | contracts near Kalshi's price fell under 30% of the last minute's | logged |
| **Wall** | one Kalshi level 5× the typical size (1,000+ contracts) | logged |
| **Flurry** | Kalshi trades on the round at 4× the usual pace (and which way) | logged |
| **Reprice** | Kalshi's price moved 8¢+ in 10 s while BTC barely moved | logged |

- The server reads Kalshi's public order book for the live round every 2 s and its trades every 3 s.
- The Deck's **Market watch** card shows the live state ("All calm", or a hold and why) and the latest events. The phone's own calls respect the server's holds too.
- Each official call now also records Kalshi's spread and Market watch's notable events in the minute before. The **call filter** learns from these, so if calls made in a busy or thin market lose, it will learn to skip them (once proven, as always).

### Real fees and a closer copy of the settlement index (v10.7)

From the research round (pros' tips checked against the bot):
- **Kalshi's real fee, measured.**
  - Fees decide whether these markets pay at all: one study of 6,298 rounds found a ~0.67¢ gross edge against a ~1.55¢ average fee.
  - Sources disagree on the crypto rate, and Kalshi has changed it. So the bot measures it (`public/fees.js`, `feebook.js`).
  - Every fill your linked Kalshi account makes is reported with Kalshi's exact fee (numbers only). So is every Auto-trader order where Kalshi returns its fee.
  - Once there are 8+ fills, the rate that reproduces them best replaces the published 7% in every fee the bot figures: edges, sizing and the Auto-trader. Takers and makers are measured apart.
  - Record → What the bot has learned shows it.
- **A closer copy of the settlement index.** Kalshi settles on CF Benchmarks' BRTI, built every second from the constituent exchanges' consolidated order books.
  - The bot's index now reads each exchange's **order book**, not just its ticker. It weighs venues by the dollars resting within 0.1% of the mid (a depth-weighted median), so deep venues count for more, as in the real index.
  - It adds **itBit (Paxos)**, one of the venues CF Benchmarks has drawn from.
  - Books are read at most every 15 seconds, with tickers in between. A venue whose book can't be read falls back to its ticker.
- **Backup target:** if a market ever arrives without Kalshi's strike, its target is the 60-second average before the open (Kalshi's rule), not the first candle's open.

### Everything it learns feeds the calls, once proven (v10.6)

Three learners that used to be context only now shape the bot's calls (official, push alerts, Auto-trader and the phone alike). Each switches on only when its own graded record proves it helps; until then it keeps learning and changes nothing.
- **Round scan → odds.** Once the scan's out-of-sample record shows it makes the odds more accurate at that point of the round (100+ graded samples where it was used, and a lower Brier score than the bot alone), its nudge goes into the bot's odds, capped at ±8 points (`scanfeed.js` shifts → `engine.js` snapshot). The scan still grades itself against the odds before its own nudge, so it can't fool itself.
- **Kalshi's price → odds.** Once 150+ rounds of per-second scoring show some blend of the bot's odds and Kalshi's price beats the bot alone (by 1%+ in log loss), that blend is used (`pulse.js` pulseBlend). Settings → **Learn how much to trust Kalshi** turns it off and hands control back to Respect the market.
- **Call filter (new, `public/callgate.js`).**
  - Every official call is saved with what the bot saw: confidence, price, minutes left, stability and volatility vs its 2-hour norm.
  - After each settle, a regularised logistic regression learns each call's chance of winning, including combinations like "late in the round and jumpy".
  - It skips a new call when that chance is below the price + Kalshi's fee + 2¢.
  - It switches on only when an honest replay passes. Each past call is judged by a model fitted only on the calls before it. The calls it would have skipped must have **lost money overall** and won **clearly** less often than the kept ones (a significance test, z ≥ 2, so a lucky losing streak can't switch it on).
  - In simulation: on pure noise it switched on 1 time in 30. With a real losing pattern it switched on 13 times in 30 at 400 calls, saving about $4/contract each time, and it catches more as calls build up.
  - The Deck says when it skipped a call and why.
- **Record → What the bot has learned → Used in the bot's calls** lists every learner with ✓ (shaping calls) or … (still learning) and why: volatility by time of week, calibration, the Coinbase–Kalshi gap, the live volatility check, Kalshi's price, the Round scan and the call filter.

### Rolling 15-minute horizon (v10.4)

The cone, the prediction lines and the prediction candles used to stop at the round's close, so they shrank as the round ran out: 12 minutes ahead early in a round, 2 minutes near its end. Now they always look **at least 15 minutes ahead**, running past the close into the next round. A **⏱ round closes** marker shows where the current round ends.
- **Past the close:** Bot stays flat, the 5-exchange trend keeps its pace, and Kalshi holds its close level (its price only speaks for this round).
- **Unchanged:** each line's close prediction (what gets graded at 5 minutes left).
- **Fixed in v10.5:** after v10.3/v10.4 the chart kept jumping back in time, about 16 minutes every few seconds. The cone and prediction lines put their future points at "now + n minutes". Those times changed on every redraw and fell between the candles, and the chart library slid the view back each time the timeline reshuffled. All future points now sit on whole minutes (the candles' own times), so the view stays where you put it.

### Flip watch: catching the turns (v10.3)

The prediction candles now try to catch the drops and the bounces (`public/flip.js`):
- **Flip score (0–100%)**, how ripe the current move is to turn, from:
  - **Stretched:** the last 5 minutes moved much more than BTC's usual 5 minutes.
  - **RSI:** 1-minute RSI past 75 or under 25.
  - **Level:** pinned at the round's floor after a fall, or its ceiling after a rise.
  - **Wick:** the last candle has a long wick against the move (rejection).
  - **Flow:** the live trades lean against the move (absorption).
- **The shape.** The expected path carries today's momentum, then bends like a damped spring around the blended prediction. It also wins back part of the move: flip score × 40% of the last 5 minutes. A ripe move turns sooner and swings back. A weak one just fades.
- **↺ markers.** Turns on the path are marked on the chart: **↺ flip up now** on the live candle when the bounce starts right away, and **↺ flip up / flip down** on the prediction candles where it bottoms or tops out.
- **Graded.**
  - Every turn predicted at least a minute ahead is frozen a minute before it. Two minutes after, it's checked: did price really make a V (or an upside-down V) there, deep enough to count (half a typical minute on each side)?
  - The line under the chart shows the hit rate next to how often a random minute passes the same test.
  - After 20 graded calls, the flip shape's strength follows the record: hit rate ÷ random rate, between 0.3× and 1.3×. So it fades if it isn't beating chance.
- Turn it off in Chart tools & indicators (**Flip watch**).

### Split screen (v9.6; computers only since v9.7)

On a computer, tap the **⊞** button in the header to show **1, 2, 3 or 4 screens at once**: any of Deck, Chart, Alerts, Record, Learn and Settings (`public/split.js`). It's for computers only: any Windows, Mac, Linux or ChromeOS machine, touchscreen laptops included, at any screen size (since v9.9). Phones and tablets, including iPads asking for the desktop site, don't show the button and always get one screen. **Settings** says what the device was detected as. If a computer is ever mistaken for something else, opening the app with `?split=1` at the end of the address turns split screen on for that browser (and `?split=0` turns it off).
- **Layouts:** 2 or 3 screens sit side by side, and 4 is a 2×2 grid.
- **Each pane has its own menu** to pick its screen. Picking one another pane already shows swaps them. **⤢** shows that pane full screen.
- **Click a pane to focus it** (it glows). The bottom bar then changes what the focused pane shows.
- **Narrow panes shrink their contents to fit,** so every card lays out as it does full screen. Each pane scrolls on its own, and charts and live updates keep running in every pane.
- **Big panes (v10.0):** in split mode the header and price bar shrink to one row and the bottom bar slims down, so the panes get the room. A pane is never shorter than 380px: on a short laptop screen, the 4-screen view keeps every pane that tall and you scroll the page to reach the bottom row.
- The layout is remembered.

### Why it moved (v9.5)

Whenever BTC makes a real move on the Chart tab, the chart explains it (`public/why.js`). A real move is well beyond its usual 30-second wiggle: 1.3× the typical 30-second move at the bot's volatility, and at least $15.
- **On the candle:** a marker names the cause: *buyers*, *sellers*, *sweep*, *whale*, *thin book*, *Kraken led*, *volume surge*, *light volume*, *crossed target* or *drift*.
- **Over the chart:** a **Why it moved** note with the move ("▲ +$135 in 30s") and its reasons. It stays for 30 seconds; tap it to dismiss.
- **Under the chart:** the last 8 explanations.

The reasons come from every trade on the five exchanges:
- **Who drove it:** aggressive buyers vs sellers in those 30 seconds.
- **Thin book:** the price moved *against* the heavier side, so the other side had pulled its orders.
- **Sweep:** a big market order pushed through the book (the same orders the chart's bubbles show).
- **Leader:** which exchange got there first, and by how many seconds.
- **Volume:** a surge (2× the usual pace or more) or a move on light trading.
- **Target:** it crossed the round's target, so the winning side flipped.

A move is explained once. A new note comes after 30 seconds, or sooner if the move goes a whole threshold further. Turn it off in Chart tools & indicators (**Why it moved**).

### Learns every second (v9.3)

The server's bot now runs **every second** instead of every 5 seconds. Calls, sells, bail-outs and the Auto-trader react 5× faster. The exchanges' REST tickers are still read every 5 seconds (their rate limits). In between, the price moves with the live trades the server streams from the five exchanges, kept on the index's level.

Every second it also learns (`public/pulse.js`, kept with the rest of its memory in `learned.json`):
- **Volatility check.** Each second, the move over the last 60 seconds is graded against the volatility the bot expected a minute earlier. Recent misses, weighted by a 30-minute half-life, give a live correction: if BTC has been moving 1.2× what the bot expected, its odds widen to match.
  - The correction only applies after an hour of grading, and only while it's helping. Each second it's scored, out of sample, on whether it would have predicted the move better than no correction (log-likelihood over the last ~6 hours).
  - It switches itself off when it stops helping. It's capped at 0.8–1.25×.
  - The phone prices with the same correction (it now refreshes the bot's memory every 2 minutes).
- **Kalshi's price.** Every second of a round, the bot's own odds and Kalshi's price are saved. When the round settles, every blend from 0% to 100% Kalshi is scored on those seconds, with each round counting once. This learns how much Kalshi's price is worth next to the bot's.
  - It's shown, not applied: blending changes which calls the bot makes, so it's your choice.
  - The new **Respect the market** setting sets the blend (0 = the bot alone, the default).

**Record → What the bot has learned** shows:
- the seconds watched and graded
- how BTC has been moving vs what the bot expected
- whether the correction is on
- the best Kalshi blend so far

### Stronger Round scan (v9.1)

The Round scan (`public/roundscan.js`) now reads more, runs on the server around the clock, and grades itself honestly:
- **New reads:**
  - **Flow, recent first:** buyers' share of the dollars with a 3-minute half-life, so the last few minutes count most instead of the whole round equally.
  - **Absorption:** heavy selling (or buying) over the last 3 minutes that hasn't moved the price. Someone big is soaking it up on the other side, which tends to win.
  - **Leader's move:** the exchange that moves first (⚡) has just pulled away from the pack. The rest usually follow.
  - **Coinbase premium:** Coinbase's price vs the other four (keen or heavy US spot demand).
- **Scan chance.** Flow alone can't call a round, because what matters is whether BTC closes above the target. Scan chance starts from the bot's odds, which know the distance to the target, the volatility and the time left. It then nudges them by the scan's reads, using weights *learned* from graded rounds (a regularised logistic regression with the bot's odds as the base). Until a checkpoint has 150 graded rounds the weights stay at zero, and the card says it's still learning. A read that proves useless stays at zero, and one that turns out backwards is shown as backwards.
- **On the server, every round** (`scanfeed.js`).
  - The server streams the five exchanges' public trade feeds itself.
  - It scans the live round and takes a sample at 10, 6 and 3 minutes left. Samples are only taken while at least 3 exchanges are streaming.
  - It grades each sample once Kalshi settles, and refits the weights. Data is kept in `DATA_DIR/scan.json`.
  - The phone shows the server's scan whenever its own feeds aren't streaming. `/api/scan` serves the live scan, the weights and the record. `SCAN_FEEDS=off` turns the server's feeds off.
- **The honest record.** The old record graded the scan at the close, when flow since the open already mirrors the result, so it flattered itself. Now each checkpoint shows:
  - how often the lean matched the result
  - Brier scores for the bot alone, the scan chance and Kalshi's own price (lower is better, 0.25 is a coin flip)
  - whether the scan improved the bot's odds

  Each sample is scored with the weights the scan had *before* that round's result was known, so it's out of sample.
- The phone now keeps every trade of the round (it used to drop the oldest in busy rounds, which skewed the scan).

It's still context: the bot's calls and the Auto-trader don't use it. If the record shows the scan improving the bot's odds over a few hundred rounds, that's the evidence for wiring it in.

### TradingView charts (v9.0)

The Chart tab is now built on **TradingView Lightweight Charts™** (`public/vendor/lightweight-charts.js`, v4.2.3, Apache License 2.0, copied in unmodified, still no npm dependencies). `public/tvchart.js` sets it up:
- **Neater candles and axes.** There are crisp candles, a volume histogram along the bottom, a right-hand price scale with tags for the last price, target, floor and ceiling, and a clean time axis.
- **RSI and MACD** are their own small panes under the main chart. They scroll and zoom with it.
- **Shot Caller's layers on top:**
  - EMA 9/21, Bollinger, VWAP, the forecast cone and the three prediction lines (Bot / Kalshi / 5 exch) as labelled series.
  - Calls as arrows, your fills as B / S / ✕ circles, and trend turns as 🐂/🐻 markers.
  - The trend shows as a faint watermark.
  - The popping order bubbles stay on their own fast layer, pinned to the candles as you scroll.
- **Gestures come from TradingView:**
  - drag to scroll, with momentum
  - pinch or the mouse wheel to zoom
  - drag the price scale to stretch it
  - press and hold for a crosshair
- **⟲ LIVE** snaps back to now, and **S / M / L** sets the height.
- **Credit:** the small TradingView logo on the chart links to TradingView, and the credit line is in Learn. The license and notice are in `public/vendor/`.

### Opens faster (v8.8)

Measured cold start on a phone-like connection (150 ms latency, 4x slower CPU): price on screen **4.2 s → 1.7 s**, call 4.4 s → 1.8 s, first paint 1.5 s → 0.8 s. How:
- **Modules preloaded.** `index.html` preloads every module, so all 22 download in parallel instead of the browser finding them one import at a time (the last now starts at 0.3 s instead of 2.1 s). A test keeps the list in sync.
- **Data fetched early.** The page's first lines start the startup data requests (price, candles, Kalshi markets, learned data, index) while the code loads, and `getJSON` uses those responses instead of asking again.
- **Fonts don't block.** Google Fonts load in the background, so the first paint isn't held up by a trip to Google.
- **Last price shown instantly.** The price from your last visit shows right away, marked as not live yet. The bot never makes a call or alert until a fresh price arrives.

### Cleaner and smoother (v8.7)

- **Fold any card** by tapping its title; the app remembers which. Live notes start folded, and the long settings list sits behind **All settings**. (The Live orders tape started folded too until v9.2, which made it look gone; it starts open again.)
- **Faster formatting.** Times and dollar amounts use formatters made once. Building a new one per call (the old way) was a real share of the phone's time with the tape streaming. Deck slow frames under a flood of trades: 10 → 6, the worst 202 → 89 ms; Chart tab: 39 → about 10.
- **Lighter chart painting.** Charts paint at up to 2x pixel density (sharp on any phone; 3x painted 2.25x the pixels).
  - The fast layer runs at 30 fps while bubbles pop, 20 fps when only the price glides, and stops when nothing moves.
  - At most 40 bubbles are on screen at once.
- **Old data cleared.** What the old phone-side Auto-trader left in storage is removed (it runs on the server now).

### Prediction lines in the forecast cone (v8.6)

The cone on the Chart tab (Round and 1m views) now holds three predictions of where BTC closes, each from a different market, with its number at the end (`public/predict.js`):
- **Bot** (cyan, solid): the bot's own model. It doesn't carry momentum forward (testing showed BTC drift doesn't persist), so it runs flat from today's price, plus the learned index basis.
- **Kalshi** (violet): the close Kalshi's price implies, i.e. the level where "above the target" is exactly as likely as Kalshi's YES price says, using the bot's volatility. A 50¢ YES puts it on the target.
- **5 exch** (gold): the five exchanges' trend. It's a straight-line fit through their median price over the last 5 minutes, carried to the close at half strength.
- All three are kept inside the 90% cone.

**Graded every round.** With 5 minutes left, each line's close prediction is saved. After the close it's compared with where BTC really closed (Coinbase's last 1-minute candle of the round), next to "no change" as the baseline any prediction has to beat. The line under the chart shows each one's average miss in dollars and which has been closest. Turn the lines off in Chart tools & indicators.

### Live, adjustable charts (v8.5)

The Chart tab:
- **Moves with every trade.** The current candle, a dashed price line and the price tag follow each Coinbase trade, gliding to the new price (they glow while moving).
  - They draw on the fast layer with the order bubbles, so the indicators underneath only redraw every 5 seconds or when the scale has to change.
- **Drag** sideways to scroll back in time.
- **Pinch** (or the mouse wheel) to zoom from 10 bars up to everything loaded.
- **Press and hold** (or hover a mouse) for a crosshair. It shows the time, open/high/low/close and the move for the candle under your finger, plus the price at the line.
- Tap **⟲ LIVE** to snap back to now. LIVE only shows once you've moved the chart. (Since v9.0 the gestures come from TradingView Lightweight Charts.)
- **S / M / L** changes the chart's height (remembered).

### Round scan: all five exchanges, every round (v8.4)

The Deck's **Round scan** reads every trade since the round opened on all five exchanges the app streams: Coinbase, Kraken, Bitstamp, Gemini and Binance.US (`public/roundscan.js`).
- **Per exchange:** buyer vs seller share of the dollars, net dollars, the move since the open, and whales.
- **⚡ Leader:** the exchange whose price moves first. It's found by cross-correlating each exchange's 1-second moves with the others, at 1-5 second lags.
- **Spread:** how far apart the exchanges' prices are. Wide means a fragmented, jumpy market.
- **Momentum:** the last minute's flow vs the round's pace: speeding up, steady, fading or flipping.
- **Big prints:** which side the $25k+ trades are on.
- **Verdict:** all of it rolls into one score, from −100 (sellers) to +100 (buyers): Strong buyers / Leans up / Mixed / Leans down / Strong sellers. Each part's points are listed.

**Graded every round.** The scan standing at the close is checked against Kalshi's result, and the card keeps the record (lean right X of Y, strong reads separately, last 10 rounds ✓/✕). That's the honest test of whether it's worth anything. Until the record says so, it's context: the bot's calls don't use it. It needs the app open, because the trade feeds run on the phone.

### Live orders on the chart (v8.1)

The Chart tab draws the live trades onto the candles:
- **Order bubbles** (since v9.4: only orders that move the market): an order's fills on one exchange, on one side, less than a second apart, count as one order (a market order sweeping the book). It bubbles only if it pushed that exchange's price its way by at least $5 and 30% of BTC's typical 10-second move right now (about $10 on a normal day), with $2k+ traded. Trades the book soaks up don't bubble, even whales. The bubble shows how far the order moved the price (+$25), grows if the same order keeps pushing, and is green for buyers, red for sellers, gold for a whale. Bubbles are sized by dollars.
  - It floats up a little, then bursts (a ring and droplets) and disappears after about 3 seconds, so the chart shows what's trading right now.
  - The bubbles draw on their own layer over the chart, so they animate without redrawing the candles.
- **Trade flags**: **B** (bought), **S** (sold) and **✕** (bailed out) mark your tracked trades and the server Auto-trader's fills (🤖), at the BTC price at that moment.
- Both can be turned off in Chart tools & indicators.

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

### Auto-trader (v8: runs on the server, phone can be closed)

Settings → **Auto-trader**. It buys the bot's **Steady** calls (the server's official call, the same one the Record tab grades) and sells on SELL HIGH and BAIL OUT.
- **It runs on the server**, every 5 seconds around the clock (`autotrade.js`), so it keeps trading with your phone closed.
- It also keeps going through redeploys: its settings, keys and history live in the data volume.
- The app is just the remote control: it shows what the server did and sends your changes, and a toast tells you about fills that happened while it was closed.

| Mode | What happens |
|---|---|
| **Off** | Nothing (the default) |
| **Test** | A simulator on Kalshi's live order book: fills at the real prices, with Kalshi's fee, against a pretend balance. Nothing is sent |
| **Demo** | Real orders on Kalshi's demo exchange (fake money), with a demo key from demo.kalshi.co |
| **Live** | Real orders, real money, with your Kalshi key (needs trading permission). Locked until Test has settled 10 trades without a serious error, then asks you to confirm |

**One-time setup: `KEY_SECRET`.** The server only holds Kalshi keys if it has this secret. (Not needed to run it **on this phone** instead, v13.68: the key stays on the phone.)
1. In Railway, open the service → **Variables** → **New Variable**.
2. Name it `KEY_SECRET` and give it a long random value (32+ characters; a password manager's generator is fine).
3. Redeploy, then give the server your key in the Auto-trader card ("Keys on the server").

Test mode doesn't need a key. `/healthz` shows `"autotrade":{"canHoldKeys":true}` once the secret is set.

How the server keeps your key:
- **Encrypted.** The key is encrypted with AES-256-GCM, using a key derived from `KEY_SECRET`. The secret lives only in Railway's variables, never on disk next to the encrypted key.
- **Per person.** Each member has their own keys, settings and history.
- **Never sent back.** The key is only used to sign requests to Kalshi; the phone only ever sees the first 8 characters of the key ID.
- **Only these orders.** Every order still goes through `validateOrder` (BTC 15-minute markets only, fill-now-or-cancel, the $100 cap).
- **You can cut it off.** Delete the key from the card any time, or delete it on Kalshi to cut it off everywhere.
- **Checked first.** A key is tested against Kalshi (it reads your balance) before it's saved.

Your limits (all editable): **max per trade** ($10), **daily loss stop** ($30, counting what's still open), **max buys a day** (20), **max open at once** ($40). **STOP** is on the card and on the Deck tab while it runs; it turns the server's trader off. Each mode keeps its own history and P&L.

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
- As admin, the app's Health check (Settings) warns "Server data resets on every deploy" until the volume is attached. `/healthz` shows `storage.persistent`, and `version` says which build is live.

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

Needs Node 22+ (the current long-term-support line; Railway picks it from `package.json`). One npm dependency, `@anthropic-ai/sdk`, used only by Ask's optional AI deep dive (`npm install`).

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
- **Your own computer or server, no Railway** (`scripts/shotctl.py`, Python 3.9+, nothing to install). It scans the code, fixes what it safely can, runs the server as a real app and website, and manages the live app:
  - `python3 scripts/shotctl.py scan` checks Node, dependencies, every `.js` file, the tests, `.env`, the data folder and the running server. `fix` installs dependencies, creates `.env` with a fresh `ACCESS_SECRET`, `KEY_SECRET` and pinned VAPID keys, and creates the data folder.
  - `env set KEY=VALUE` / `env unset KEY` / `env list` edit `.env`, which takes the place of Railway's Variables (secrets are masked when listed).
  - `start` / `stop` / `restart` / `status` / `logs` run the server in the background and restart it if it crashes. `deploy` pulls, installs, tests and restarts, and rolls back to the last commit if the tests or the health check fail.
  - `up` runs everything and keeps it running: the app, your named Cloudflare tunnel (`env set TUNNEL_TOKEN=...`, the token from the tunnel's install command), and updates. It restarts the app only if it stops answering (for 90 seconds) or an update arrives. Every 5 minutes it checks GitHub; on a new commit it backs up the data folder (`data/.backups`, last 10 kept), then pulls, installs (only if dependencies changed), tests and restarts, and keeps the old version running if the update fails. Members, the record, what it learned and the Auto-trader's history all live in the data folder, so nothing is lost. `install-startup` starts `up` when you log in to Windows. `backup` makes a copy by hand; `backup --restore NAME` puts one back.
  - `scripts/bugwatch.py` never stops looking for problems, and fixes the ones it safely can. Every minute: the app (restarts it after 5 minutes without an answer, a backstop to `up`), the website (restarts a stuck tunnel), Kalshi (reconnects Cloudflare WARP when it's blocked), the bot (restarts the app if it stopped ticking while Kalshi answers), the server log (groups new errors), logs over 20 MB (rotated) and disk space (old backups pruned). Every 10 minutes it reads every saved data file and restores a damaged one from the newest good backup. With `--tests` it also runs the test suite after every code change and every 12 hours (off by default: `up` already tests each update, and a test run takes the whole CPU for minutes). What it can't fix goes in `data/.shotctl/bugwatch.md`, and to Discord if `BUGWATCH_WEBHOOK` is set (use a private channel). `--install-startup` starts it at login on Windows; `--once` runs one round.
  - Public address: `tunnel` gives a free `https://….trycloudflare.com` address through [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (no domain needed). For your own domain, `install-service --domain shotcaller.example.com` writes a systemd unit (starts on boot) and a Caddyfile (automatic HTTPS) and sets `APP_URL`.
  - `live login --url https://your-app` signs in with the admin code, then `live health`, `live members`, `live approve CODE --days 30`, `live deny`, `live revoke`, `live config --price 5 --days 30`, `live tuneup --run` and `live hiring` work against that app, wherever it's hosted (Railway included).
  - Moving off Railway: copy the volume's files into `data/`, and set `ACCESS_SECRET` to `<RAILWAY_PROJECT_ID>:<RAILWAY_SERVICE_ID>` (before running `fix`) so members' saved passes keep working.
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
