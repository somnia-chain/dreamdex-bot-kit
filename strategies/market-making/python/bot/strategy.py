# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Two-sided PostOnly market maker with inventory skew (Python).

Same design as the TypeScript market-maker: quote a bid below mid and an ask
above mid, skew both toward the side that reduces inventory, and only requote
when the mid drifts. PostOnly guarantees we stay on the maker side. See
strategies/market-making/README.md for the full rationale.
"""
from __future__ import annotations

import time

from dreamdex_core import Pool, OrderType, shift_bps, spread_bps

from .config import Config


class MarketMaker:
    def __init__(self, pool: Pool, cfg: Config, log) -> None:
        self.pool = pool
        self.cfg = cfg
        self.log = log
        self.bid = None  # (order_id, price, qty)
        self.ask = None
        self.last_mid: float | None = None
        self.last_requote_at = 0.0

    def requote(self) -> None:
        tob = self.pool.top_of_book()
        if tob.mid is None:
            self.log("no mid price (empty book) — skipping")
            return

        if tob.best_bid is not None and tob.best_ask is not None:
            book_bps = spread_bps(tob.best_bid, tob.best_ask)
            if book_bps > self.cfg.max_book_spread_bps:
                self.log(f"book spread {book_bps:.1f}bps > max — skipping")
                return

        if self.last_mid is not None and self.bid and self.ask:
            drift = abs((tob.mid - self.last_mid) / self.last_mid) * 10_000
            if drift < self.cfg.requote_trigger_bps:
                return
        self.last_mid = tob.mid

        # Read the WALLET balance, not the vault: in the default auto-pull/auto-
        # deliver mode fills land in the wallet and the vault reads ~0, so reading
        # the vault would leave the skew permanently at zero (no inventory defense).
        inv_usdso = self.pool.wallet_base() * tob.mid
        imbalance = (inv_usdso - self.cfg.target_inventory_usdso) / self.cfg.notional_usdso
        skew_bps = imbalance * self.cfg.inventory_skew_bps

        bid_price = shift_bps(tob.mid, -self.cfg.half_spread_bps - skew_bps)
        ask_price = shift_bps(tob.mid, +self.cfg.half_spread_bps - skew_bps)
        qty = self.cfg.notional_usdso / tob.mid
        if qty < self.pool.min_qty:
            self.log(f"qty {qty} below market min {self.pool.min_qty} — raise MM_NOTIONAL_USDSO")
            return

        self.log(f"requote mid={tob.mid:.6f} bid={bid_price:.6f} ask={ask_price:.6f} qty={qty:.6f} skewBps={skew_bps:.2f}")
        self._replace_leg("bid", bid_price, qty)
        self._replace_leg("ask", ask_price, qty)

    def _replace_leg(self, side: str, price: float, qty: float) -> None:
        existing = self.bid if side == "bid" else self.ask
        if existing and abs(existing[1] - price) / (price or 1) < 1e-9 and abs(existing[2] - qty) / (qty or 1) < 1e-9:
            return

        if self.cfg.dry_run:
            self.log(f"[dry-run] {side} {qty:.6f} @ {price:.6f}")
            rec = (0, price, qty)
            if side == "bid":
                self.bid = rec
            else:
                self.ask = rec
            return

        if existing and existing[0]:
            try:
                self.pool.cancel(existing[0])
            except Exception as err:
                self.log(f"cancel {side} failed: {err}")

        try:
            res = self.pool.place(is_bid=(side == "bid"), price=price, qty=qty, order_type=OrderType.POST_ONLY)
            rec = (res.order_id, price, qty)
            if side == "bid":
                self.bid = rec
            else:
                self.ask = rec
            self.log(f"posted {side} {qty:.6f} @ {price:.6f} id={res.order_id} tx={res.tx_hash}")
        except Exception as err:
            self.log(f"post {side} failed: {err}")
            if side == "bid":
                self.bid = None
            else:
                self.ask = None

    def cancel_all(self) -> None:
        for o in (self.bid, self.ask):
            if o and o[0]:
                try:
                    self.pool.cancel(o[0])
                except Exception:
                    pass
        self.bid = None
        self.ask = None
