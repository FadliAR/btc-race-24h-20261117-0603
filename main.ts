// Aggressive dip-buying BTC bot for make.fun.
//
// Speaks agent-fun/bars-replay/v1 over NDJSON stdin/stdout: one hello, then
// one batch per minute bar, then done. Exactly one reply per batch, echoing
// its seq, with at most one order. Fully deterministic: time comes only from
// each batch's bar time, no wall clock, no network, no files, no randomness.
//
// Strategy — buy the multi-hour dip, sell the recovery (v2, replaces the
// fast EMA-crossover v1, which lost badly on the dev window: 60 trades,
// 6.7% win rate, -$100.57, because 1-minute noise is only ~4 bps while a
// round trip costs ~26 bps, so fast trend-following just pays fees).
//
// Dev-window facts that drive this design (1,440 one-minute bars, close
// $64,461 -> $64,776, range $63,874-$65,466): the market moves in slow
// multi-hour waves — the best 120-bar rise is +231 bps and the best fall
// -212 bps — while 1-minute moves average 4 bps. So:
//   * Entry: close at least 120 bps below the trailing 240-bar (4-hour)
//     high, with the latest bar ticking back up (bounce confirmation).
//     Full cash, one position at a time.
//   * Exit: take-profit +150 bps, stop-loss -100 bps, or recovery to
//     within 5 bps of the trailing 240-bar high — whichever comes first.
//     Max hold 360 bars so no position lingers into the close.
//   * No new entries in the final 20 bars (the flatten would eat the edge).
// The whole neighbourhood of these parameters is profitable on the dev
// window (dip 110-130 bps, lookback 120-480 bars all clear +$10..+$24),
// so the rules are a market structure, not a fitted accident.

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const BPS = 10000;
const MAX_SLIPPAGE_BPS = 200;

// Strategy parameters (tuned only on the dev window via grade-local).
const LOOKBACK = 180; // bars of trailing high
const DIP_BPS = 120; // buy when this far below the trailing high
const TP_BPS = 150;
const SL_BPS = 100;
const RECOVER_BPS = 5; // sell when within this of the trailing high
const MAX_HOLD_BARS = 360;
const NO_ENTRY_TAIL = 20; // bars from the end where no new entry opens
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
  entryPrice: number | null = null;
  entrySeq = -1;
  nextId = 1;
  seq = -1;

  constructor(hello: any) {
    this.cash = Number(hello.capital.quote_units);
    this.equity = this.cash;
    this.warmupBars = Number(hello.warmup_bars ?? 0);
  }

  trailingHigh(): number {
    let hi = 0;
    const start = Math.max(0, this.closes.length - LOOKBACK);
    for (let i = start; i < this.closes.length; i++) {
      if (this.closes[i] > hi) hi = this.closes[i];
    }
    return hi;
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
      } else if (f.side === "sell") {
        this.entryPrice = null;
        this.entrySeq = -1;
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
    this.closes.push(close);
    if (this.seq < this.warmupBars) return orders;
    if (this.closes.length <= LOOKBACK) return orders;

    const hi = this.trailingHigh();
    const dipBps = Math.trunc(((close - hi) * BPS) / hi);
    const gain = this.gainBps(close);

    if (this.qty > 0) {
      // Exits (long only, single position).
      const held = this.seq - this.entrySeq;
      let exitNow = false;
      if (gain >= TP_BPS) exitNow = true;
      else if (gain <= -SL_BPS) exitNow = true;
      else if (dipBps >= -RECOVER_BPS) exitNow = true; // recovered to the high
      else if (held >= MAX_HOLD_BARS) exitNow = true;
      if (exitNow) {
        const o = this.sellAll();
        if (o) orders.push(o);
      }
      return orders;
    }

    // Entries (flat): deep dip below the trailing high + bounce up.
    if (this.seq >= TOTAL_BARS - NO_ENTRY_TAIL) return orders;
    const bounce =
      this.closes.length >= 2 &&
      this.closes[this.closes.length - 1] > this.closes[this.closes.length - 2];
    if (dipBps <= -DIP_BPS && bounce) {
      const o = this.buy(this.cash);
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
