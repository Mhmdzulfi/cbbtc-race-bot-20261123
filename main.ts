// Patient trend + washout-dip bot for cbBTC on 1-minute bars.
//
// Strategy (designed and tuned by the author on two public 24h windows: the
// 2026-11-23 dev window, a steady +3.6% grind, and the 2026-11-18 dev window,
// a choppy -2.8% drift):
//
//   * Cash is the default. The bot only buys when it has a reason, and it buys
//     the whole cash balance when it does, because a full-size round trip costs
//     only ~30 bps while a caught move pays 1-3%.
//   * TREND entries ride a confirmed uptrend: EMA(12) above EMA(48), the close
//     above EMA(12), EMA(48) rising over the last 20 bars, and the 60-bar
//     return above +0.1%. They exit on a wide 2% trailing stop or a 1% hard
//     stop, never on a take-profit, so a grind is ridden to the end.
//   * DIP entries buy a washout: the close at least 2% below the 120-bar high
//     with RSI(14) under 40, an uptick close, and a sharp 30-bar fall. They
//     exit on a +2% take-profit, a 1.2% trailing stop, or a 1% hard stop.
//   * Discipline: at most 6 round trips, 60 bars of cooldown after an exit, and
//     no trading before 68 bars of history. Every exit is re-sent while its
//     reason holds, so a rejected sell is retried on the next bar.
//
// The previous race (2026-11-18) was won by bots that made exactly one round
// trip each (+$18 to +$22) by buying one washout dip and selling the rebound,
// while frequent traders bled out on fees and whipsaw. This bot copies that
// pattern -- few, patient, full-size trades -- and adds a trend leg so a
// steady grind is ridden instead of watched from cash.
//
// Deterministic: pure functions of the bars (float64, no randomness, no clock,
// no I/O, no environment). Standard library only, via the kit's TS shim.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuned parameters (see the header comment) ---
const FAST_SPAN = 12;
const SLOW_SPAN = 48;
const SLOPE_BARS = 20;
const WARM_BARS = 68;
const TREND_RET = 0.001; // 60-bar return above +0.1%
const TREND_TRAIL = 0.02; // 2% trailing stop from the peak close
const TREND_STOP = 0.01; // 1% hard stop vs entry cost
const DIP_PCT = 0.02; // 2% below the 120-bar high
const DIP_RSI = 40;
const DIP_FAST = 0.004; // 30-bar fall sharper than -0.4%
const DIP_TRAIL = 0.012;
const DIP_STOP = 0.01;
const DIP_TP = 0.02; // +2% take-profit vs entry cost
const HIGH_BARS = 120;
const RSI_BARS = 14;
const COOLDOWN_BARS = 60;
const MAX_TRIPS = 6;
const MAX_SLIPPAGE_BPS = 200;

type Kind = 'trend' | 'dip';

/** An EMA seeded as the mean of its first span of closes. */
class Ema {
  readonly span: number;
  readonly alpha: number;
  warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
    this.alpha = 2 / (span + 1);
  }

  push(close: number): number | null {
    if (this.value !== null) {
      this.value += this.alpha * (close - this.value);
      return this.value;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
    return this.value;
  }
}

/** RSI(14), Wilder's smoothing, seeded from the first 14 changes. */
class Rsi {
  readonly period: number;
  changes: number[] = [];
  gain: number | null = null;
  loss: number | null = null;
  last: number | null = null;
  value: number | null = null;

  constructor(period: number) {
    this.period = period;
  }

  push(close: number): number | null {
    if (this.last !== null) {
      const change = close - this.last;
      if (this.gain === null || this.loss === null) {
        this.changes.push(change);
        if (this.changes.length === this.period) {
          const ups = this.changes.reduce((a, c) => a + (c > 0 ? c : 0), 0);
          const downs = this.changes.reduce((a, c) => a + (c < 0 ? -c : 0), 0);
          this.gain = ups / this.period;
          this.loss = downs / this.period;
          this.value = this.calc();
        }
      } else {
        const up = change > 0 ? change : 0;
        const down = change < 0 ? -change : 0;
        this.gain = (this.gain * (this.period - 1) + up) / this.period;
        this.loss = (this.loss * (this.period - 1) + down) / this.period;
        this.value = this.calc();
      }
    }
    this.last = close;
    return this.value;
  }

  private calc(): number {
    const moved = (this.gain ?? 0) + (this.loss ?? 0);
    return moved === 0 ? 50 : (100 * (this.gain ?? 0)) / moved;
  }
}

const closes: number[] = [];
const highs: number[] = [];
const fast = new Ema(FAST_SPAN);
const slow = new Ema(SLOW_SPAN);
const slowHist: (number | null)[] = [];
const rsi = new Rsi(RSI_BARS);

let armedKind: Kind | null = null; // kind of the buy just sent, awaiting its fill
let armedSeq = -1;
let entryKind: Kind | null = null; // kind of the open position
let peak = 0; // highest close since entry
let wasHeld = false;
let trips = 0;
let lastExitSeq = -1_000_000_000;

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }): (BuyInput | SellInput)[] {
    let bar: Bar | undefined;
    for (const b of batch.bars) {
      if (b.symbol === SYMBOL) {
        bar = b;
        break;
      }
    }
    if (bar === undefined) return []; // a gap adds nothing: no decision on a missing bar

    const close = Number(bar.c) / 100000;
    const high = Number(bar.h) / 100000;
    closes.push(close);
    highs.push(high);
    const fastNow = fast.push(close);
    const slowNow = slow.push(close);
    slowHist.push(slowNow);
    const rsiNow = rsi.push(close);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && !wasHeld) {
      // The buy filled: adopt its kind and start the peak at this close.
      entryKind = armedKind;
      armedKind = null;
      peak = close;
    } else if (held === undefined && wasHeld) {
      // The position closed: count the round trip, start the cooldown.
      trips += 1;
      lastExitSeq = state.seq;
      entryKind = null;
    }
    if (armedKind !== null && held === undefined && state.seq > armedSeq + 1) {
      armedKind = null; // the buy was rejected; forget it
    }
    wasHeld = held !== undefined;

    if (state.warmingUp) return [];

    if (held !== undefined) {
      peak = Math.max(peak, close);
      const value = state.value(SYMBOL, held.qty);
      const gain = held.cost > 0n ? Number(value) / Number(held.cost) - 1 : 0;
      const trail = entryKind === 'dip' ? DIP_TRAIL : TREND_TRAIL;
      const stop = entryKind === 'dip' ? DIP_STOP : TREND_STOP;
      const take = entryKind === 'dip' ? DIP_TP : null;
      let exits = close < peak * (1 - trail) || gain <= -stop;
      if (take !== null && gain >= take) exits = true;
      if (exits) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for an entry.
    const n = closes.length;
    if (state.seq < WARM_BARS || trips >= MAX_TRIPS) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (fastNow === null || slowNow === null || rsiNow === null) return [];
    const slowAgo = n - 1 - SLOPE_BARS >= 0 ? slowHist[n - 1 - SLOPE_BARS] : null;
    if (slowAgo === null) return [];

    const ret60 = close / closes[n - 61] - 1;
    const trend = fastNow > slowNow && close > fastNow && slowNow > slowAgo && ret60 > TREND_RET;

    // A dip is measured against a full 120-bar high: before 120 bars of
    // history there is no such high yet, so no dip entry.
    let dip = false;
    if (n >= HIGH_BARS) {
      const windowHigh = Math.max(...highs.slice(-HIGH_BARS));
      if (close / windowHigh - 1 <= -DIP_PCT && rsiNow < DIP_RSI && close > closes[n - 2]) {
        const ret30 = close / closes[n - 31] - 1;
        dip = ret30 < -DIP_FAST;
      }
    }

    let kind: Kind | null = null;
    if (trend) kind = 'trend';
    else if (dip) kind = 'dip';
    if (kind === null) return [];
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    armedKind = kind;
    armedSeq = state.seq;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
