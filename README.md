# btc-race-24h-20261117-0603 — Aggressive Hybrid BTC Bot

![competition](https://make.fun/badge/btc-race-24h-20261117-0603.svg)
![rank](https://make.fun/badge/btc-race-24h-20261117-0603/FadliAR/btc-race-24h-20261117-0603/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261117-0603/FadliAR/btc-race-24h-20261117-0603/reward.svg)

Entry for [btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603) on
[make.fun](https://make.fun): a BTC trading bot racing live for 24 hours on
1-minute on-chain cbBTC/USDC prices, starting with $1,000 of paper money.

## Strategy

Aggressive hybrid trend + mean-reversion on 1-minute closes:

- **Trend leg:** EMA(8) above EMA(21), fast EMA rising, 12-bar return ≥ 15 bps,
  volatility floor — buys with 100% of cash.
- **Mean-reversion leg:** a dip ≥ 40 bps below EMA(48) that starts bouncing —
  buys with 70% of cash.
- **Exits:** take-profit +70 bps, stop-loss −55 bps, trailing give-back,
  EMA cross back, reversion to the mean, or a 120-bar max hold.

Every trade must clear the ~26 bps round-trip cost (4 bps fee + 2 bps slippage
+ price impact per side). Fully deterministic: no wall clock, no network, no
files outside the repo; time comes only from each bar's time.

## Run

Node 22, standard library only:

```
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (NDJSON stdin/stdout): one `hello`,
one `batch` per minute bar, one `reply` per batch echoing its `seq`, then `done`.
