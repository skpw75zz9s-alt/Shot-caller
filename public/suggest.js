// Plain suggestions on top of the bot's signals: what to do right now, and how big.
//   CONFIDENT BUY  the call clears the strictest bar (confidence 90+, hold odds 90%+): full suggested size
//   BUY            a call on your risk level: full suggested size
//   BUY LIGHT      a real gap and decent confidence, but it misses one of the bot's bars (hold odds, the steady
//                  minute or the confidence bar): about a third of the size, and it says which bar it missed
//   WAIT           nothing worth it
// and for positions you hold:
//   SELL HIGH      Kalshi pays at least what it's worth (in profit): cash out
//   BAIL           losing, and Kalshi pays clearly more than it's worth: get out
//   HOLD           worth more than Kalshi pays: keep it
import { contractsFor } from './model.js';

export const CONFIDENT = { conf: 90, hold: 0.9 };
export const LIGHT = { conf: 80, hold: 0.6, size: 1 / 3 };

// sig: buySignal(); ev: the live row's evaluate(); s: settings. Returns { kind, side, price, contracts, title, why }
export function suggestEntry(sig, ev, s) {
  if (!sig || !ev) return { kind: 'none' };
  const conf = sig.deep?.score ?? null, hold = sig.hold ?? null;
  const name = (side) => (side === 'YES' ? 'UP' : 'DOWN');
  if (sig.bail) return { kind: 'bail', title: `BAIL OUT of ${name(sig.bail.side)}${sig.bail.bid ? ` at ${Math.round(sig.bail.bid * 100)}¢` : ''}`, why: `The call went bad: the bot's odds fell to ${Math.round(sig.bail.p * 100)}%. Sell if you're in; no new buys this round.` };
  if (sig.callSide) {
    const confident = conf != null && conf >= CONFIDENT.conf && hold != null && hold >= CONFIDENT.hold;
    return {
      kind: confident ? 'confident' : 'buy', side: sig.callSide, price: sig.price, contracts: sig.contracts,
      title: `${confident ? 'CONFIDENT BUY' : 'BUY'} ${name(sig.callSide)} at ${Math.round(sig.price * 100)}¢`,
      why: confident ? `Confidence ${conf} and hold odds ${Math.round(hold * 100)}%: the bot's strongest kind of call.` : `Clears your risk level: confidence ${conf ?? '—'}${hold != null ? `, hold odds ${Math.round(hold * 100)}%` : ''}.`,
    };
  }
  // Below the bar but close: a real edge, robust to volatility, and confidence and hold odds that are decent
  const side = sig.side, price = side === 'YES' ? ev.quote?.yesAsk : ev.quote?.noAsk;
  const edge = side === 'YES' ? ev.evYes : ev.evNo;
  if (side && price != null && ev.open && !sig.called && edge != null && edge >= s.minEdge && sig.robust && conf != null && conf >= LIGHT.conf && (hold == null || hold >= LIGHT.hold)) {
    const missed = conf < s.minConfidence ? `confidence ${conf} is under your ${s.minConfidence} bar`
      : sig.holdOk === false ? `hold odds ${Math.round(hold * 100)}% are under the ${Math.round((s.minHold || 0) * 100)}% bar`
        : sig.steadyOk === false ? `it hasn't held for ${sig.steadyNeed ?? s.steadySec}s yet` : null;
    if (missed) {
      const prob = side === 'YES' ? ev.pYes : 1 - ev.pYes;
      const contracts = Math.max(1, Math.floor(contractsFor(prob, price, s) * LIGHT.size));
      return { kind: 'light', side, price, contracts, title: `BUY LIGHT ${name(side)} at ${Math.round(price * 100)}¢`, why: `A real gap, but ${missed}. If you take it, go small (about a third of a normal bet).` };
    }
  }
  return { kind: 'wait', title: 'WAIT', why: 'Nothing worth buying right now.' };
}

// ex: exitSignal() / positionCheck().ex for a position
export function suggestExit(ex) {
  if (!ex) return { kind: 'none' };
  if (ex.action === 'SELL' && ex.kind === 'take') return { kind: 'sellHigh', title: 'SELL HIGH', why: ex.why };
  if (ex.action === 'SELL' && ex.kind === 'cut') return { kind: 'bail', title: 'BAIL', why: ex.why };
  if (ex.action === 'SELL' && ex.kind === 'bail') return { kind: 'bail', title: 'BAIL OUT', why: ex.why };
  if (ex.kind === 'steady') return { kind: 'watch', title: 'GETTING CLOSE', why: ex.why };
  if (ex.action === 'WAIT') return { kind: 'settle', title: 'SETTLING', why: ex.why };
  return { kind: 'hold', title: 'HOLD', why: ex.why };
}
