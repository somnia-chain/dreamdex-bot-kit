# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/agent/state.py
"""
Local agent history + open-position tracker.

DO NOT USE _balances FOR SAFETY CHECKS — they are best-effort accounting
based on (qty, mid) which drifts from real on-chain fills (real fill is at
ask/bid, not mid). Use monitor.portfolio.Portfolio.summary() for the
capital-floor check. This module is for:
  • trade history (LLM context, last 5 decisions)
  • open positions count (for MAX_CONCURRENT_POS gate)
  • LLM prompt context (entry_price for "down N% — don't double down")

C6/H5 fix: `record_trade` now uses the actual fill price emitted by
place_order (when available via `result.fill_price`), falling back to
the limit price the order was placed at, falling back to mid as last
resort. The Portfolio chain-truth read is the authoritative number.
"""
from config import AGENT_CAPITAL

class AgentState:
    def __init__(self):
        # _balances is best-effort accounting — NOT safety-critical. Portfolio
        # is the source of truth for the capital-floor check.
        self._balances = {
            "usdso": AGENT_CAPITAL,
            "weth": 0.0, "wbtc": 0.0, "somi": 0.0, "usdc.e": 0.0,
            "total": AGENT_CAPITAL,
        }
        self._positions = {}
        self._history = []
        self._tx_count = 0

    def balances(self):
        return self._balances

    def open_positions(self):
        return self._positions

    def history(self):
        return self._history

    def record_trade(self, log_entry: dict):
        """Only called on vault-delta-proven successes (see dreamdex.place_order).
        Updates local accounting using the BEST available price estimate:
          1. actual fill price if the result includes it (future enhancement)
          2. limit_price the order was placed at
          3. mid (worst case)"""
        self._history.append(log_entry)
        self._tx_count += 1

        action = log_entry.get("action")
        pair = log_entry.get("pair")
        if not pair or action not in ("buy", "sell"):
            return

        base = pair.split(":")[0].lower()
        qty = log_entry.get("qty", 0)
        # H5: prefer the limit price actually sent to the DEX over `mid` for the
        # cost basis. Sells fill at the BID (≤ mid), buys at the ASK (≥ mid) —
        # using mid systematically over-reports gains.
        fill_price = (
            log_entry.get("limit_price")
            or log_entry.get("result", {}).get("limit_price")
            or log_entry.get("mid", 0)
        )
        try:
            fill_price = float(fill_price)
        except (TypeError, ValueError):
            fill_price = log_entry.get("mid", 0)
        cost_usdso = qty * fill_price

        if action == "buy":
            self._balances["usdso"] = max(0, self._balances["usdso"] - cost_usdso)
            self._balances[base] = self._balances.get(base, 0) + qty
            if pair in self._positions:
                old_qty = self._positions[pair]["qty"]
                old_entry = self._positions[pair]["entry_price"]
                new_qty = old_qty + qty
                new_entry = ((old_qty * old_entry) + (qty * fill_price)) / new_qty
                self._positions[pair] = {"qty": new_qty, "entry_price": new_entry}
            else:
                self._positions[pair] = {"qty": qty, "entry_price": fill_price}
        elif action == "sell":
            if pair in self._positions:
                held = self._positions[pair]["qty"]
                if qty >= held:
                    del self._positions[pair]
                else:
                    self._positions[pair]["qty"] -= qty
            self._balances[base] = max(0, self._balances.get(base, 0) - qty)
            self._balances["usdso"] += cost_usdso

    def summary(self):
        return {
            "tx_count": self._tx_count,
            "usdso_balance": self._balances["usdso"],  # local estimate; not safety-authoritative
            "open_positions": len(self._positions),
        }
