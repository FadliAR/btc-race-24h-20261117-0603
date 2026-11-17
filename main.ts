// Aggressive hybrid trend + mean-reversion BTC bot for make.fun.
//
// Speaks agent-fun/bars-replay/v1 over NDJSON stdin/stdout: one hello, then
// one batch per minute bar, then done. Exactly one reply per batch, echoing
// its seq, with at most a couple of orders. Fully deterministic: time comes
// only from each batch's bar time, no wall clock, no network, no files,
// no randomness.
//
// Strategy (designed from the dev-window facts in prose: 1,440 one-minute
// bars, close $64,461 -> $64,776, range $63,874-$65,466, round trip ~26 bps):
//   * Trend leg: EMA(8) vs EMA(21) crossover on 1-minute closes, confirmed
//     by a positive 12-bar return and a volatility floor, sized at 100% cash.
//   * Mean-reversion leg: a deep dip below EMA(48) that starts bouncing
//     back, sized at 70% of cash.
//   * Exits: take-profit +70 bps, stop-loss -55 bps, trailing give-back,
//     EMA cross back, reversion to the mean, or a 120-bar max hold.
//   * A short cooldown after each exit keeps the bot from re-buying the
//     same whipsaw bar. No new entries in the final 20 bars.

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const BPS = 10000;
const MAX_SLIPPAGE_BPS = 200;

// Strategy parameters (tuned only on the dev window via grade-local).
const EMA_FAST = 8;
const EMA_SLOW = 21;
const EMA_MEAN = 48;
const MOM_BARS = 12;
const MOM_MIN_BPS = 15; // 12-bar return needed for a trend entry
const MR_DIP_BPS = 40; // dip below EMA(48) that arms mean reversion
const MR_SIZE_BPS = 7000; // 70% of cash on a mean-reversion entry
const ATR_BARS = 30;
const ATR_MIN_BPS = 3; // skip entries when the market is dead flat
const TP_BPS = 70;
const SL_BPS = 55;
const TRAIL_PEAK_BPS = 50; // arm the trailing stop once up this much
const TRAIL_GIVEBACK_BPS = 30;
const MAX_HOLD_BARS = 120;
const COOLDOWN_BARS = 2;
const NO_ENTRY_TAIL = 20; // bars from the end where no new entry opens
const WARMUP_MIN_BARS = 50; // bars of history before the first entry
const TOTAL_BARS = 1440;

type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

class Bot {
  cash: number;
  equity: number;
  qty = 0;
  warmupBars: number;
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  emaMean: number | null = null;
  prevEmaFast: number | null = null;
  entryPrice: number | null = null;
  entrySeq = -1;
  peakGainBps = 0;
  cooldownUntil = -1;
  nextId = 1;
  seq = -1;

  constructor(hello: any) {
    this.cash = Number(hello.capital.quote_units);
    this.equity = this.cash;
    this.warmupBars = Number(hello.warmup_bars ?? 0);
  }

  ema(prev: number | null, price: number, n: number): number {
    const alpha = 2 / (n + 1);
    return prev === null ? price : prev + alpha * (price - prev);
  }

  retBps(n: number): number | null {
    if (this.closes.length < n + 1) return null;
    const old = this.closes[this.closes.length - n - 1];
    const cur = this.closes[this.closes.length - 1];
    return old === 0 ? null : Math.trunc(((cur - old) * BPS) / old);
  }

  atrBps(n: number): number | null {
    if (this.closes.length < n + 1) return null;
    let total = 0;
    for (let i = this.closes.length - n; i < this.closes.length; i++) {
      const prev = this.closes[i - 1];
      total += prev === 0 ? 0 : Math.trunc((Math.abs(this.closes[i] - prev) * BPS) / prev);
    }
    return Math.trunc(total / n);
  }

  gainBps(close: number): number {
    if (this.entryPrice === null || this.entryPrice === 0) return 0;
    return Math.trunc(((close - this.entryPrice) * BPS) / this.entryPrice);
  }

  cid(): string {
    return "o" + this.nextId++;
  }

  buy(notional: number): Order | null {
    // Leave a small buffer so the 4 bps fee can never trip insufficient_cash.
    notional = Math.min(notional, Math.trunc((this.cash * 9990) / BPS));
    if (notional < 1_000_000) return null;
    return {
      side: "buy",
      client_id: this.cid(),
      symbol: SYMBOL,
      notional_quote_units: String(Math.trunc(notional)),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  sellAll(): Order | null {
    if (this.qty <= 0) return null;
    return {
      side: "sell",
      client_id: this.cid(),
      symbol: SYMBOL,
      qty: String(this.qty),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  onBatch(batch: any): Order[] {
    this.seq = Number(batch.seq);
    const orders: Order[] = [];
    // Fold the fills of the orders decided on the previous batch.
    for (const f of batch.fills ?? []) {
      if (f.symbol !== SYMBOL || f.status !== "filled") continue;
      if (f.side === "buy") {
        this.entryPrice = Number(f.price);
        this.entrySeq = this.seq;
        this.peakGainBps = 0;
      } else if (f.side === "sell") {
        this.entryPrice = null;
        this.entrySeq = -1;
        this.peakGainBps = 0;
        this.cooldownUntil = this.seq + COOLDOWN_BARS;
      }
    }
    // Fold the account the batch carries.
    const acct = batch.account ?? {};
    this.cash = Number(acct.cash_quote_units ?? this.cash);
    this.equity = Number(acct.equity_quote_units ?? this.equity);
    this.qty = 0;
    for (const p of acct.positions ?? []) {
      if (p.symbol === SYMBOL) this.qty = Number(p.qty);
    }
    // Fold this batch's bar (one symbol, one bar per batch).
    const bars = batch.bars ?? [];
    if (bars.length === 0) return orders;
    const close = Number(bars[0].c);
    this.prevEmaFast = this.emaFast;
    this.emaFast = this.ema(this.emaFast, close, EMA_FAST);
    this.emaSlow = this.ema(this.emaSlow, close, EMA_SLOW);
    this.emaMean = this.ema(this.emaMean, close, EMA_MEAN);
    this.closes.push(close);
    if (this.seq < this.warmupBars) return orders;
    if (this.closes.length < WARMUP_MIN_BARS) return orders;

    const gain = this.gainBps(close);
    if (this.qty > 0 && gain > this.peakGainBps) this.peakGainBps = gain;

    if (this.qty > 0) {
      // Exits (long only, single position).
      const held = this.seq - this.entrySeq;
      const devMeanBps =
        this.emaMean === null ? 0 : Math.trunc(((close - this.emaMean) * BPS) / this.emaMean);
      let exitNow = false;
      if (gain >= TP_BPS) exitNow = true;
      else if (gain <= -SL_BPS) exitNow = true;
      else if (
        this.peakGainBps >= TRAIL_PEAK_BPS &&
        gain <= this.peakGainBps - TRAIL_GIVEBACK_BPS
      )
        exitNow = true;
      else if (held >= MAX_HOLD_BARS) exitNow = true;
      else if (
        this.prevEmaFast !== null &&
        this.emaFast !== null &&
        this.emaSlow !== null &&
        this.emaFast < this.emaSlow &&
        this.prevEmaFast >= this.emaSlow &&
        held >= 5
      )
        exitNow = true; // EMA cross back down
      else if (devMeanBps >= 0 && gain > 0 && held >= 5) exitNow = true; // mean reversion done
      if (exitNow) {
        const o = this.sellAll();
        if (o) orders.push(o);
      }
      return orders;
    }

    // Entries (flat).
    if (this.seq <= this.cooldownUntil) return orders;
    if (this.seq >= TOTAL_BARS - NO_ENTRY_TAIL) return orders;
    const atr = this.atrBps(ATR_BARS);
    if (atr === null || atr < ATR_MIN_BPS) return orders;
    const mom = this.retBps(MOM_BARS);
    const devMeanBps =
      this.emaMean === null ? 0 : Math.trunc(((close - this.emaMean) * BPS) / this.emaMean);
    const fastRising =
      this.prevEmaFast !== null && this.emaFast !== null && this.emaFast > this.prevEmaFast;
    const trendLong =
      this.emaFast !== null &&
      this.emaSlow !== null &&
      this.emaFast > this.emaSlow &&
      fastRising &&
      mom !== null &&
      mom >= MOM_MIN_BPS;
    const bounce =
      this.closes.length >= 2 &&
      this.closes[this.closes.length - 1] > this.closes[this.closes.length - 2];
    const mrLong = devMeanBps <= -MR_DIP_BPS && bounce;
    if (trendLong) {
      const o = this.buy(this.cash);
      if (o) orders.push(o);
    } else if (mrLong) {
      const o = this.buy(Math.trunc((this.cash * MR_SIZE_BPS) / BPS));
      if (o) orders.push(o);
    }
    return orders;
  }
}

async function main(): Promise<void> {
  let bot: Bot | null = null;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    const msg = JSON.parse(text);
    if (msg.type === "hello") {
      bot = new Bot(msg);
    } else if (msg.type === "batch") {
      const orders = bot!.onBatch(msg);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      break;
    } else {
      break;
    }
  }
}

main().catch(() => process.exit(1));
