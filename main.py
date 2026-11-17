#!/usr/bin/env python3
"""Aggressive hybrid trend + mean-reversion BTC bot for make.fun.

Speaks agent-fun/bars-replay/v1 over NDJSON stdin/stdout: one hello, then one
batch per minute bar, then done. Exactly one reply per batch, echoing its seq,
with at most a couple of orders. Fully deterministic: time comes only from
each batch's bar time, no wall clock, no network, no files, no randomness.

Strategy (designed from the dev-window facts in prose: 1,440 one-minute bars,
close $64,461 -> $64,776, range $63,874-$65,466, round trip ~26 bps):
  * Trend leg: EMA(8) vs EMA(21) crossover on 1-minute closes, confirmed by a
    positive 12-bar return and a volatility floor, sized at 100% of cash.
  * Mean-reversion leg: a deep dip below EMA(48) that starts bouncing back,
    sized at 70% of cash.
  * Exits: take-profit +70 bps, stop-loss -55 bps, trailing give-back,
    EMA cross back, reversion to the mean, or a 120-bar max hold.
  * A short cooldown after each exit keeps the bot from re-buying the same
    whipsaw bar. No new entries in the final 20 bars (flatten costs money).
"""

import json
import sys

SYMBOL = "CBBTC"
BPS = 10_000
MAX_SLIPPAGE_BPS = 200

# --- strategy parameters (tuned only on the dev window via grade-local) ---
EMA_FAST = 8
EMA_SLOW = 21
EMA_MEAN = 48
MOM_BARS = 12
MOM_MIN_BPS = 15          # 12-bar return needed for a trend entry
MR_DIP_BPS = 40           # dip below EMA(48) that arms mean reversion
MR_SIZE_BPS = 7000        # 70% of cash on a mean-reversion entry
ATR_BARS = 30
ATR_MIN_BPS = 3           # skip entries when the market is dead flat
TP_BPS = 70
SL_BPS = 55
TRAIL_PEAK_BPS = 50       # arm the trailing stop once up this much
TRAIL_GIVEBACK_BPS = 30
MAX_HOLD_BARS = 120
COOLDOWN_BARS = 2
NO_ENTRY_TAIL = 20        # bars from the end where no new entry is opened
WARMUP_MIN_BARS = 50      # bars of history before the first entry


class Bot:
    def __init__(self, hello):
        self.seed = int(hello.get("seed", "0"))
        self.cash = int(hello["capital"]["quote_units"])
        self.equity = self.cash
        self.qty = 0            # held qty in asset units (qty_scale)
        self.cost = 0           # cost basis in quote units
        self.price_scale = 6
        self.qty_scale = 8
        for s in hello.get("symbols", []):
            if s["symbol"] == SYMBOL:
                self.price_scale = int(s["price_scale"])
                self.qty_scale = int(s["qty_scale"])
        self.warmup_bars = int(hello.get("warmup_bars", 0))
        self.closes = []        # close prices, raw ints at price_scale
        self.ema_fast = None
        self.ema_slow = None
        self.ema_mean = None
        self.prev_ema_fast = None
        self.entry_price = None  # fill price of the current position
        self.entry_seq = -1
        self.peak_gain_bps = 0
        self.cooldown_until = -1
        self.next_id = 1
        self.seq = -1

    # -- indicators ------------------------------------------------------
    def _ema(self, prev, price, n):
        alpha = 2.0 / (n + 1)
        return price if prev is None else prev + alpha * (price - prev)

    def _update_indicators(self, close):
        self.prev_ema_fast = self.ema_fast
        self.ema_fast = self._ema(self.ema_fast, close, EMA_FAST)
        self.ema_slow = self._ema(self.ema_slow, close, EMA_SLOW)
        self.ema_mean = self._ema(self.ema_mean, close, EMA_MEAN)
        self.closes.append(close)

    def _ret_bps(self, n):
        """Return over the last n bars in bps, or None if not enough bars."""
        if len(self.closes) < n + 1:
            return None
        old = self.closes[-n - 1]
        new = self.closes[-1]
        return (new - old) * BPS // old if old else None

    def _atr_bps(self, n):
        """Mean absolute 1-bar move over the last n bars, in bps."""
        if len(self.closes) < n + 1:
            return None
        total = 0
        for i in range(len(self.closes) - n, len(self.closes)):
            prev = self.closes[i - 1]
            total += abs(self.closes[i] - prev) * BPS // prev if prev else 0
        return total // n

    def _gain_bps(self, close):
        if self.entry_price is None or self.entry_price == 0:
            return 0
        return (close - self.entry_price) * BPS // self.entry_price

    # -- orders ----------------------------------------------------------
    def _cid(self):
        cid = "o%d" % self.next_id
        self.next_id += 1
        return cid

    def _buy(self, notional):
        # Leave a small buffer so the 4 bps fee can never trip insufficient_cash.
        notional = min(notional, self.cash * 9990 // BPS)
        if notional < 1_000_000:
            return None
        return {"side": "buy", "client_id": self._cid(), "symbol": SYMBOL,
                "notional_quote_units": str(notional),
                "max_slippage_bps": MAX_SLIPPAGE_BPS}

    def _sell_all(self):
        if self.qty <= 0:
            return None
        return {"side": "sell", "client_id": self._cid(), "symbol": SYMBOL,
                "qty": str(self.qty),
                "max_slippage_bps": MAX_SLIPPAGE_BPS}

    # -- per-batch decision ----------------------------------------------
    def on_batch(self, batch):
        self.seq = int(batch["seq"])
        orders = []
        # Fold the fills of the orders decided on the previous batch.
        for f in batch.get("fills", []):
            if f.get("symbol") != SYMBOL:
                continue
            if f.get("status") != "filled":
                continue
            if f.get("side") == "buy":
                self.entry_price = int(f["price"])
                self.entry_seq = self.seq
                self.peak_gain_bps = 0
            elif f.get("side") == "sell":
                self.entry_price = None
                self.entry_seq = -1
                self.peak_gain_bps = 0
                self.cooldown_until = self.seq + COOLDOWN_BARS
        # Fold the account the batch carries.
        acct = batch.get("account", {})
        self.cash = int(acct.get("cash_quote_units", self.cash))
        self.equity = int(acct.get("equity_quote_units", self.equity))
        self.qty = 0
        self.cost = 0
        for p in acct.get("positions", []):
            if p.get("symbol") == SYMBOL:
                self.qty = int(p["qty"])
                self.cost = int(p["cost_quote_units"])
        # Fold this batch's bar (one symbol, one bar per batch).
        bars = batch.get("bars", [])
        if not bars:
            return orders
        close = int(bars[0]["c"])
        self._update_indicators(close)
        if self.seq < self.warmup_bars:
            return orders
        if len(self.closes) < WARMUP_MIN_BARS:
            return orders

        gain = self._gain_bps(close)
        if self.qty > 0 and gain > self.peak_gain_bps:
            self.peak_gain_bps = gain

        if self.qty > 0:
            # --- exits (long only, single position) ---
            held = self.seq - self.entry_seq
            dev_mean_bps = ((close - self.ema_mean) * BPS // self.ema_mean
                            if self.ema_mean else 0)
            exit_now = False
            if gain >= TP_BPS:
                exit_now = True
            elif gain <= -SL_BPS:
                exit_now = True
            elif (self.peak_gain_bps >= TRAIL_PEAK_BPS
                    and gain <= self.peak_gain_bps - TRAIL_GIVEBACK_BPS):
                exit_now = True
            elif held >= MAX_HOLD_BARS:
                exit_now = True
            elif (self.prev_ema_fast is not None
                    and self.ema_fast < self.ema_slow
                    and self.prev_ema_fast >= self.ema_slow
                    and held >= 5):
                exit_now = True  # EMA cross back down
            elif dev_mean_bps >= 0 and gain > 0 and held >= 5:
                exit_now = True  # mean reversion completed
            if exit_now:
                o = self._sell_all()
                if o is not None:
                    orders.append(o)
            return orders

        # --- entries (flat) ---
        if self.seq <= self.cooldown_until:
            return orders
        if self.seq >= 1440 - NO_ENTRY_TAIL:
            return orders
        atr = self._atr_bps(ATR_BARS)
        if atr is None or atr < ATR_MIN_BPS:
            return orders
        mom = self._ret_bps(MOM_BARS)
        dev_mean_bps = ((close - self.ema_mean) * BPS // self.ema_mean
                        if self.ema_mean else 0)
        fast_rising = (self.prev_ema_fast is not None
                       and self.ema_fast > self.prev_ema_fast)
        trend_long = (self.ema_fast > self.ema_slow and fast_rising
                      and mom is not None and mom >= MOM_MIN_BPS)
        bounce = False
        if len(self.closes) >= 2:
            bounce = self.closes[-1] > self.closes[-2]
        mr_long = dev_mean_bps <= -MR_DIP_BPS and bounce
        if trend_long:
            o = self._buy(self.cash)
            if o is not None:
                orders.append(o)
        elif mr_long:
            o = self._buy(self.cash * MR_SIZE_BPS // BPS)
            if o is not None:
                orders.append(o)
        return orders


def main():
    bot = None
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            bot = Bot(msg)
        elif kind == "batch":
            orders = bot.on_batch(msg)
            reply = {"type": "reply", "seq": msg["seq"], "orders": orders}
            out.write(json.dumps(reply, separators=(",", ":")) + "\n")
            out.flush()
        elif kind == "done":
            break
        else:
            # Unknown message: protocol violation if we answer wrongly;
            # safest is to stop. The harness only sends hello/batch/done.
            break


if __name__ == "__main__":
    main()
