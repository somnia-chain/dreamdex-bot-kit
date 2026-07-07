# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Yield Maker - configurable vault-funded PostOnly quoting with an optional
read-only paper mode.

Fix for gap #3: this version actually tracks placed quotes. The strategy
assigns `_our_bid`/`_our_ask` immediately when it emits a PLACE signal, so
subsequent ticks know we already have resting quotes and only requote when
they drift beyond threshold. `on_fill` and `on_reject` clear the tracking so
the next tick re-quotes that side.

Reservation price (Avellaneda & Stoikov 2008):
    r = s − q · γ · σ² · (T−t)
where s=mid, q=inventory delta from target (normalized), γ=risk aversion,
σ²=variance, (T−t)=remaining time. We use a simplified version that drops the
(T−t) term (constant = 1 in tight loops) and adds an empirical floor on
half-spread.

Pattern adapted from Polymarket/poly-market-maker (MIT) Bands strategy.
"""

from __future__ import annotations

import statistics
import time
import uuid
from collections import deque
from decimal import Decimal
from typing import Any

from dreamdex_bot.config import MARKETS, MarketSymbol
from dreamdex_bot.interfaces.strategy import (
    CancelIntent, FundingSource, MarketState, OrderIntent, OrderType, OwnInventory,
    Side, SignalAction, TradingSignal, TradingStrategy,
)
from dreamdex_bot.utils.logger import get_logger
from dreamdex_bot.utils.markets import ensure_min_quantity, round_to_lot, round_to_tick


log = get_logger(__name__)


class YieldMaker(TradingStrategy):
    """PostOnly quoting with inventory-skewed reservation price."""

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(name="yield_maker", config=config)
        self.market = MarketSymbol(config.get("market", MarketSymbol.SOMI_USDSO.value))

        self.paper_mode = bool(config.get("paper_mode", False))
        self.quote_mode = str(config.get("quote_mode", "reservation"))
        self.improve_ticks = int(config.get("improve_ticks", 1))
        self.target_base_value_usd = Decimal(str(config.get("target_base_value_usd", "12.50")))
        self.quote_size_usd = Decimal(str(config.get("quote_size_usd", "2.00")))
        self.min_half_spread_bps = int(config.get("min_half_spread_bps", 25))
        self.min_book_spread_bps = Decimal(str(config.get("min_book_spread_bps", "0")))
        self.min_side_depth_usd = Decimal(str(config.get("min_side_depth_usd", "0")))
        self.gamma = float(config.get("gamma", 0.5))
        self.k_vol = float(config.get("k_vol", 2.0))
        self.requote_threshold_bps = Decimal(str(config.get("requote_threshold_bps", "5")))
        self.requote_min_interval_sec = float(config.get("requote_min_interval_sec", 3.0))
        reserve_by_market = config.get("native_base_reserve_by_market", {})
        self.native_base_reserve = Decimal(str(
            reserve_by_market.get(self.market.value, config.get("native_base_reserve", "0"))
        ))
        # Flatten valve: taker-sell excess base back to target BEFORE the
        # inventory_drift risk rule fires. The rule's pause is sticky and
        # leaves resting quotes stranded on the book, so prevention is the
        # only unattended-safe option. 0 disables the valve.
        self.flatten_above_usd = Decimal(str(config.get("flatten_above_usd", "0")))
        self.flatten_cross_bps = Decimal(str(config.get("flatten_cross_bps", "2.0")))

        # Quote tracking: set when we emit PLACE, cleared on fill/reject/cancel.
        # Each is None when no resting order is known, otherwise:
        # {"coid": str, "price": Decimal, "qty": Decimal, "placed_at": float}
        self._our_bid: dict[str, Any] | None = None
        self._our_ask: dict[str, Any] | None = None
        self._last_requote_ts: float = 0.0
        self._paper_base_delta = Decimal("0")
        self._paper_quote_delta = Decimal("0")

        self._mid_window: deque[Decimal] = deque(maxlen=int(config.get("vol_window", 60)))

    async def generate_signals(
        self,
        market_state: dict[MarketSymbol, MarketState],
        inventory: dict[MarketSymbol, OwnInventory],
    ) -> list[TradingSignal]:
        ms = market_state.get(self.market)
        inv = inventory.get(self.market)
        if (
            ms is None or inv is None or ms.mid is None
            or ms.best_bid is None or ms.best_ask is None
        ):
            return []

        self._mid_window.append(ms.mid)
        if self.paper_mode:
            self._apply_paper_fills(ms)

        book_spread_bps = (ms.best_ask - ms.best_bid) / ms.mid * Decimal("10000")
        if book_spread_bps < self.min_book_spread_bps:
            return []
        if (
            ms.bid_depth_usd < self.min_side_depth_usd
            or ms.ask_depth_usd < self.min_side_depth_usd
        ):
            return []

        # Flatten valve — checked before the requote-interval gate because
        # shedding runaway inventory is urgent, quoting is not.
        if not self.paper_mode and self.flatten_above_usd > 0:
            base_value_usd = self._inventory_base_balance(inv) * ms.mid
            if base_value_usd > self.flatten_above_usd:
                return self._flatten_signals(ms, inv, base_value_usd)

        # Reservation price
        sigma = self._realized_vol()
        q_delta_usd = (self._inventory_base_balance(inv) * ms.mid) - self.target_base_value_usd
        q_normalized = float(q_delta_usd / self.target_base_value_usd) if self.target_base_value_usd > 0 else 0.0
        reservation_shift = q_normalized * self.gamma * (sigma ** 2) * float(ms.mid)
        reservation_price = float(ms.mid) - reservation_shift

        # Half-spread
        min_half = float(ms.mid) * self.min_half_spread_bps / 10_000
        vol_half = self.k_vol * sigma * float(ms.mid)
        half_spread = max(min_half, vol_half)

        if self.quote_mode == "top_of_book":
            tick = MARKETS[self.market].tick_size
            improvement = tick * self.improve_ticks
            bid_price = min(ms.best_bid + improvement, ms.best_ask - tick)
            ask_price = max(ms.best_ask - improvement, ms.best_bid + tick)
        else:
            bid_price = round_to_tick(
                Decimal(str(reservation_price - half_spread)), self.market, direction="down",
            )
            ask_price = round_to_tick(
                Decimal(str(reservation_price + half_spread)), self.market, direction="up",
            )

        # Don't requote if too recent
        if time.time() - self._last_requote_ts < self.requote_min_interval_sec:
            return []

        signals: list[TradingSignal] = []

        # Sizes — guard against zero/negative price
        if bid_price <= 0 or ask_price <= 0:
            return []
        bid_qty = round_to_lot(self.quote_size_usd / bid_price, self.market, direction="down")
        ask_qty = round_to_lot(self.quote_size_usd / ask_price, self.market, direction="down")

        if self.paper_mode:
            changed = self._paper_manage_quote(
                current=self._our_bid, target_price=bid_price, target_qty=bid_qty,
                side=Side.BUY, mid=ms.mid, inv=inv,
            )
            changed = self._paper_manage_quote(
                current=self._our_ask, target_price=ask_price, target_qty=ask_qty,
                side=Side.SELL, mid=ms.mid, inv=inv,
            ) or changed
            if changed:
                self._last_requote_ts = time.time()
            return []

        # Bid: size to free quote. POST_ONLY collateral is pulled from the
        # wallet at placement (Phase 2 Finding 2), so quoting full size while
        # a cancel refund is in flight double-locks collateral and drains the
        # wallet — observed live 2026-06-10: the third bid in a requote burst
        # simulation-reverted with have=$9.14 want=$20.
        free_quote = max(
            Decimal("0"), inv.quote_balance - inv.quote_locked_in_orders,
        )
        affordable_qty = round_to_lot(
            free_quote * Decimal("0.95") / bid_price, self.market, direction="down",
        )
        bid_qty_capped = min(bid_qty, affordable_qty)
        if bid_qty_capped > 0:
            signals.extend(self._manage_quote(
                current=self._our_bid, target_price=bid_price, target_qty=bid_qty_capped,
                side=Side.BUY, mid=ms.mid,
            ))
        elif self._our_bid is None:
            log.info(
                "yield_maker.bid_skipped_insufficient_quote",
                market=self.market.value, free_quote=str(free_quote),
            )
        # Ask: only when we actually hold base inventory to back the resting
        # order. Without this check, the engine's simulate-before-broadcast
        # reverts with "ERC20: transfer amount exceeds balance" and increments
        # failed_tx_streak — paper mode hid this because _paper_manage_quote
        # already clamps to available balance.
        available_base = self._inventory_base_balance(inv)
        if available_base >= MARKETS[self.market].min_quantity:
            sell_qty_lot = round_to_lot(
                min(ask_qty, available_base), self.market, direction="down",
            )
            sell_qty = ensure_min_quantity(sell_qty_lot, self.market)
            if sell_qty is not None and sell_qty > 0:
                signals.extend(self._manage_quote(
                    current=self._our_ask, target_price=ask_price, target_qty=sell_qty,
                    side=Side.SELL, mid=ms.mid,
                ))
        elif self._our_ask is not None:
            # Inventory drained (last ask filled, or none deposited) — drop
            # the stale tracking so we don't emit a cancel for a never-placed
            # order, which would 400 with the API expecting a numeric ID.
            self._our_ask = None

        if signals:
            self._last_requote_ts = time.time()
            log.debug(
                "yield_maker.requote",
                mid=str(ms.mid), reservation=reservation_price,
                bid=str(bid_price), ask=str(ask_price),
                inventory_skew_usd=str(q_delta_usd), sigma=sigma,
            )
        return signals

    def _paper_manage_quote(
        self,
        current: dict[str, Any] | None,
        target_price: Decimal,
        target_qty: Decimal,
        side: Side,
        mid: Decimal,
        inv: OwnInventory,
    ) -> bool:
        if side == Side.BUY:
            available_qty = self._paper_quote_balance(inv) / target_price
        else:
            available_qty = self._inventory_base_balance(inv)
        target_qty = min(target_qty, round_to_lot(available_qty, self.market, direction="down"))
        qty_checked = ensure_min_quantity(target_qty, self.market)
        if qty_checked is None or qty_checked <= 0:
            if current is None:
                return False
            self._clear_paper_quote(side)
            log.info(
                "yield_maker.paper_cancel",
                market=self.market.value,
                side=side.value,
                coid=current["coid"],
                reason="insufficient_balance",
            )
            return True

        if current is not None:
            drift_bps = abs(target_price - current["price"]) / mid * Decimal("10000")
            if drift_bps <= self.requote_threshold_bps and current["qty"] == qty_checked:
                return False
            log.info(
                "yield_maker.paper_cancel",
                market=self.market.value,
                side=side.value,
                coid=current["coid"],
                drift_bps=str(drift_bps),
            )

        place = self._place(side, qty_checked, target_price)
        self._record_placement(side, place.order)
        log.info(
            "yield_maker.paper_quote",
            market=self.market.value,
            side=side.value,
            coid=place.order.client_order_id,
            qty=str(qty_checked),
            price=str(target_price),
        )
        return True

    def _clear_paper_quote(self, side: Side) -> None:
        if side == Side.BUY:
            self._our_bid = None
        else:
            self._our_ask = None

    def _apply_paper_fills(self, ms: MarketState) -> None:
        assert ms.best_bid is not None and ms.best_ask is not None
        if self._our_bid and self._our_bid["price"] >= ms.best_ask:
            self._paper_fill(Side.BUY, self._our_bid, ms.best_ask)
        if self._our_ask and self._our_ask["price"] <= ms.best_bid:
            self._paper_fill(Side.SELL, self._our_ask, ms.best_bid)

    def _paper_fill(self, side: Side, quote: dict[str, Any], fill_price: Decimal) -> None:
        qty = quote["qty"]
        quote_value = qty * fill_price
        if side == Side.BUY:
            self._paper_base_delta += qty
            self._paper_quote_delta -= quote_value
            self._our_bid = None
        else:
            self._paper_base_delta -= qty
            self._paper_quote_delta += quote_value
            self._our_ask = None
        log.info(
            "yield_maker.paper_fill",
            market=self.market.value,
            side=side.value,
            coid=quote["coid"],
            qty=str(qty),
            price=str(fill_price),
            paper_base_delta=str(self._paper_base_delta),
            paper_quote_delta=str(self._paper_quote_delta),
        )

    def _manage_quote(
        self,
        current: dict[str, Any] | None,
        target_price: Decimal,
        target_qty: Decimal,
        side: Side,
        mid: Decimal,
    ) -> list[TradingSignal]:
        qty_checked = ensure_min_quantity(target_qty, self.market)
        if qty_checked is None or qty_checked <= 0:
            return []

        if current is None:
            place = self._place(side, qty_checked, target_price)
            self._record_placement(side, place.order)
            return [place]

        # Existing quote — check drift
        existing_price = current["price"]
        drift_bps = abs(target_price - existing_price) / mid * 10_000
        if drift_bps <= self.requote_threshold_bps:
            return []

        # Cancel existing + place new
        cancel = TradingSignal(
            action=SignalAction.CANCEL,
            cancel=CancelIntent(market=self.market, order_id=current["coid"],
                                reason=f"yield_maker requote drift={drift_bps:.1f}bps"),
        )
        # Optimistically clear; the cancel WS event will arrive shortly
        if side == Side.BUY:
            self._our_bid = None
        else:
            self._our_ask = None

        place = self._place(side, qty_checked, target_price)
        self._record_placement(side, place.order)
        return [cancel, place]

    def _flatten_signals(
        self,
        ms: MarketState,
        inv: OwnInventory,
        base_value_usd: Decimal,
    ) -> list[TradingSignal]:
        assert ms.best_bid is not None and ms.mid is not None
        signals: list[TradingSignal] = []

        # The resting bid would keep refilling the inventory we're shedding.
        if self._our_bid is not None:
            signals.append(TradingSignal(
                action=SignalAction.CANCEL,
                cancel=CancelIntent(
                    market=self.market,
                    order_id=self._our_bid["coid"],
                    reason="yield_maker flatten: stop accumulating",
                ),
            ))
            self._our_bid = None

        base_balance = self._inventory_base_balance(inv)
        excess_usd = base_value_usd - self.target_base_value_usd
        qty = excess_usd / ms.best_bid
        # Don't walk the book: shed at most half the displayed bid depth per
        # cycle; the valve re-fires next tick if inventory is still high.
        depth_qty = ms.bid_depth_usd * Decimal("0.5") / ms.best_bid
        qty = min(qty, depth_qty, base_balance)
        qty = round_to_lot(qty, self.market, direction="down")
        qty_checked = ensure_min_quantity(qty, self.market)
        if qty_checked is None or qty_checked <= 0:
            return signals

        price = round_to_tick(
            ms.best_bid * (Decimal("1") - self.flatten_cross_bps / Decimal("10000")),
            self.market, direction="down",
        )
        log.warning(
            "yield_maker.flatten",
            market=self.market.value,
            base_value_usd=str(base_value_usd),
            flatten_above_usd=str(self.flatten_above_usd),
            target_base_value_usd=str(self.target_base_value_usd),
            qty=str(qty_checked),
            price=str(price),
        )
        signals.append(TradingSignal(
            action=SignalAction.PLACE,
            order=OrderIntent(
                market=self.market,
                side=Side.SELL,
                order_type=OrderType.IOC,
                quantity=qty_checked,
                price=price,
                funding=FundingSource.WALLET,
                client_order_id=f"ym_flat_{uuid.uuid4().hex[:8]}",
                reason="yield_maker flatten excess inventory",
            ),
        ))
        return signals

    def _place(self, side: Side, qty: Decimal, price: Decimal) -> TradingSignal:
        coid = f"ym_{side.value}_{uuid.uuid4().hex[:8]}"
        return TradingSignal(
            action=SignalAction.PLACE,
            order=OrderIntent(
                market=self.market,
                side=side,
                order_type=OrderType.POST_ONLY,
                quantity=qty,
                price=price,
                funding=FundingSource.VAULT,
                client_order_id=coid,
                reason="yield_maker quote",
            ),
        )

    def _inventory_base_balance(self, inv: OwnInventory) -> Decimal:
        base_balance = inv.base_balance
        if self.paper_mode:
            base_balance += self._paper_base_delta
        if not MARKETS[self.market].is_base_native:
            return max(Decimal("0"), base_balance)
        reserved = min(base_balance, self.native_base_reserve)
        return max(Decimal("0"), base_balance - reserved)

    def _paper_quote_balance(self, inv: OwnInventory) -> Decimal:
        return max(Decimal("0"), inv.quote_balance + self._paper_quote_delta)

    def _record_placement(self, side: Side, order: OrderIntent) -> None:
        """Fix for gap #3: track that we have a resting quote on this side
        so subsequent ticks don't re-place duplicate quotes."""
        record = {
            "coid": order.client_order_id,
            "price": order.price,
            "qty": order.quantity,
            "placed_at": time.time(),
        }
        if side == Side.BUY:
            self._our_bid = record
        else:
            self._our_ask = record

    def _realized_vol(self) -> float:
        if len(self._mid_window) < 5:
            return 0.001
        returns = []
        prev = self._mid_window[0]
        for m in list(self._mid_window)[1:]:
            if prev > 0:
                returns.append(float((m - prev) / prev))
            prev = m
        if len(returns) < 2:
            return 0.001
        return max(0.0001, statistics.stdev(returns))

    async def on_fill(self, fill_event: dict[str, Any]) -> None:
        coid = fill_event.get("clientOrderId", "")
        if self._our_bid and self._our_bid.get("coid") == coid:
            self._our_bid = None
        if self._our_ask and self._our_ask.get("coid") == coid:
            self._our_ask = None
        log.info("yield_maker.fill", coid=coid,
                 side=fill_event.get("side"),
                 qty=fill_event.get("quantity"),
                 price=fill_event.get("price"))

    async def on_reject(self, order_id: str, reason: str) -> None:
        # Clear tracking for whichever quote was rejected — match by coid OR order_id
        if self._our_bid and self._our_bid.get("coid") in (order_id, reason):
            self._our_bid = None
        if self._our_ask and self._our_ask.get("coid") in (order_id, reason):
            self._our_ask = None
        log.warning("yield_maker.rejected", order_id=order_id, reason=reason)

    def tracked_client_order_ids(self) -> set[str]:
        coids = set()
        if self._our_bid:
            coids.add(self._our_bid["coid"])
        if self._our_ask:
            coids.add(self._our_ask["coid"])
        return coids
