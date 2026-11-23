[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Mhmdzulfi/cbbtc-race-bot-20261123/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Mhmdzulfi/cbbtc-race-bot-20261123/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511)

# Patient trend + washout-dip bot for cbBTC

Entry for [make.fun — Race a BTC trading bot live for 24 hours](https://make.fun/c/btc-race-24h-20261123-0511)
(`btc-race-24h-20261123-0511`). A paper-trading bot for Coinbase Wrapped BTC
(cbBTC) on 1-minute on-chain bars, starting with $1,000 of paper money. No real
money is traded.

## Strategy

Cash is the default. The bot only buys when it has a reason, and buys the whole
cash balance when it does, because a full-size round trip costs only ~30 bps
while a caught move pays 1–3%.

- **Trend entries** ride a confirmed uptrend: EMA(12) above EMA(48), the close
  above EMA(12), EMA(48) rising over the last 20 bars, and the 60-bar return
  above +0.1%. They exit on a wide 2% trailing stop or a 1% hard stop, never on
  a take-profit, so a grind is ridden to the end.
- **Dip entries** buy a washout: the close at least 2% below the 120-bar high
  with RSI(14) under 40, an uptick close, and a sharp 30-bar fall. They exit on
  a +2% take-profit, a 1.2% trailing stop, or a 1% hard stop.
- **Discipline:** at most 6 round trips, 60 bars of cooldown after an exit, no
  trading before 68 bars of history. Exits are re-sent while their reason holds.

The previous race (2026-11-18) was won by bots that made exactly one round trip
each (+$18 to +$22) by buying one washout dip and selling the rebound, while
frequent traders bled out on fees and whipsaw. This bot copies that pattern —
few, patient, full-size trades — and adds a trend leg so a steady grind is
ridden instead of watched from cash.

## Local results (official `grade-local`, `--driver process`)

Dev window of this competition (24h, BTC +3.6% grind):

| Bot | Net PnL | Trades | Max DD |
| --- | --- | --- | --- |
| **this bot** | **+$32.32** | 1 | 1.98% |
| momentum (house) | +$34.94 | 1 | 1.98% |
| buy-and-hold (house) | +$32.17 | 1 | 1.98% |
| hold-cash (house) | $0.00 | 0 | 0% |
| rsi-bollinger | −$9.32 | 10 | 2.06% |
| adx-momentum | −$11.20 | 24 | 4.16% |
| ema-cross | −$114.83 | 76 | 11.65% |

Momentum beats this bot by $2.62 on this one window only because it buys at bar
24 unconditionally. On the choppy −2.8% dev window of the previous race this bot
makes **+$6.36** (4 trades, win rate 50%) while momentum loses **−$23.87** and
buy-and-hold loses **−$31.63** — so across both public windows this bot is the
only one that is profitable on both. Both grades reproduce byte for byte
(deterministic).

## Run

The entrypoint is `main.ts` (Node 22, standard library only, plus the kit's
Python/TS SDK shim vendored byte-for-byte under `vendor/`). It speaks
`agent-fun/bars-replay/v1` on stdin/stdout. Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
