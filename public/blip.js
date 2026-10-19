// The blip (v13.61): a small light under the header, on every tab, saying whether Market Watch and the bot see a buy worth
// making right now. It never makes its own call: it lights only when the Deck's buy signal fires (the bot's edge after
// fees, every guard passed), and its profit figure uses the bot's worst-case odds (the low end of its three volatility
// guesses), so it's the cautious number, and still only an estimate.
//   buy      the buy signal is on: side, price, and the expected profit per $10 staked if the bot's worst-case odds hold
//   hold     Market Watch is holding new calls (bad data or an untradeable book), and why
//   paused   calls are paused (the daily loss limit or the profit guard)
//   watch    no buy with an edge right now
import { kalshiFee } from './model.js';

export function blip({ live, sig, showBuy, block, watchHold, now = Date.now() }) {
  if (!live) return { tone: 'off', text: '', title: '' };
  if (block) return { tone: 'paused', text: 'Calls paused', title: block.kind === 'loss' ? 'The daily loss limit was hit: no new buys until it resets.' : 'The profit guard paused calls: recent calls lost money at their prices.' };
  if (watchHold && watchHold.until > now) return { tone: 'hold', text: 'Watch: hold', title: `Market Watch is holding new calls: ${watchHold.why || 'the market is untradeable right now'}.` };
  if (showBuy && sig?.callSide && sig.price > 0 && sig.price < 1) {
    const side = sig.callSide === 'YES' ? 'UP' : 'DOWN', p = sig.winProb ?? null, fee = kalshiFee(sig.price);
    const per10 = p == null ? null : ((p * (1 - sig.price) - (1 - p) * sig.price - fee) / sig.price) * 10;
    return { tone: 'buy', side: sig.callSide, per10,
      text: `BUY ${side} ${Math.round(sig.price * 100)}¢${per10 != null ? ` · ${per10 >= 0 ? '+' : '−'}$${Math.abs(per10).toFixed(2)}/$10` : ''}`,
      title: `The bot's buy signal: ${side} at ${Math.round(sig.price * 100)}¢.${p != null ? ` At its worst-case odds (${Math.round(p * 100)}%) and after the ${Math.round(fee * 100)}¢ fee, that's about ${per10 >= 0 ? '+' : '−'}$${Math.abs(per10).toFixed(2)} per $10 staked, on average, if those odds are right.` : ''} An estimate, never a guarantee: any call can lose.` };
  }
  return { tone: 'watch', text: 'Watching', title: 'Market Watch and the bot are watching: no buy with an edge after fees right now.' };
}
