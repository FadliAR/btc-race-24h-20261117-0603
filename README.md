# btc-race-24h-20261117-0603 — Aggressive Hybrid BTC Bot

![competition](https://make.fun/badge/btc-race-24h-20261117-0603.svg)
![rank](https://make.fun/badge/btc-race-24h-20261117-0603/FadliAR/btc-race-24h-20261117-0603/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261117-0603/FadliAR/btc-race-24h-20261117-0603/reward.svg)

Entry for [btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603) on
[make.fun](https://make.fun): a BTC trading bot racing live for 24 hours on
1-minute on-chain cbBTC/USDC prices, starting with $1,000 of paper money.

## Strategy

Aggressive dip-buying on 1-minute closes:

- **Entry:** close ≥ 120 bps below the trailing 240-bar (4-hour) high, with
  the latest bar ticking back up (bounce confirmation) — buys with 100% of cash.
- **Exits:** take-profit +150 bps, stop-loss −100 bps, or recovery to within
  5 bps of the trailing high; max hold 360 bars.

Every trade must clear the ~26 bps round-trip cost (4 bps fee + 2 bps slippage
+ price impact per side). The dev window moves in slow multi-hour waves
(best 120-bar rise +231 bps, best fall −212 bps) while 1-minute noise averages
~4 bps, so the bot trades the waves, not the noise. Fully deterministic: no
wall clock, no network, no files outside the repo; time comes only from each
bar's time.

## Run

Node 22, standard library only:

```
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (NDJSON stdin/stdout): one `hello`,
one `batch` per minute bar, one `reply` per batch echoing its `seq`, then `done`.
