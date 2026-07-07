# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Volume Mill — wallet-funded IOC ping-pong for max volume on the leaderboard.

Default market is USDC.e:USDso on mainnet (pegged USDC.e ≈ $1 ≈ USDso) which
keeps inventory risk near zero between cycles. On testnet USDC.e:USDso doesn't
exist, so for shakedown the market is configurable — typically SOMI:USDso with
a smaller cycle size and an inventory cap.

Fix for gap #2: the strategy is now resilient to startup-zero inventory.
If `free_quote` looks zero (no balance fetched yet), the strategy logs a
warning once and returns no-op signals instead of being permanently stuck.
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from decimal import Decimal
from typing import Any

from dreamdex_bot.config import MARKETS, MarketSymbol
from dreamdex_bot.interfaces.strategy import (
    FundingSource, MarketState, OrderIntent, OrderType, OwnInventory,
    Side, SignalAction, TradingSignal, TradingStrategy,
)
from dreamdex_bot.utils.logger import get_logger
from dreamdex_bot.utils.markets import ensure_min_quantity, round_to_lot, round_to_tick


log = get_logger(__name__)


class VolumeMill(TradingStrategy):
    """Wallet-funded IOC ping-pong volume generator."""

    def __init__(self, config: dict[str, Any]) -> None:
        # Market is configurable — default is the mainnet preferred pair.
        market_str = config.get("market", "USDC.e:USDso")
        self.market = MarketSymbol(market_str)
        super().__init__(name=f"volume_mill:{self.market.value}", config=config)

        self.cycle_interval_sec = float(config.get("cycle_interval_sec", 2.0))
        size_by_market = config.get("size_per_cycle_usd_by_market", {})
        self.size_per_cycle_usd = Decimal(str(
            size_by_market.get(self.market.value, config.get("size_per_cycle_usd", "20.00"))
        ))
        # Efficiency floor. Order size ≈ 95% of free quote, so as capital bleeds
        # the cycle shrinks toward the exchange min-order (~$1.80 on WETH), where
        # gas-per-volume blows up ~10x. The leaderboard proved this: our $/fill
        # was $13.67 vs the field's $22-35 because thousands of late cycles ran
        # at the floor, doubling our tx count for the same volume. Below this
        # threshold we PAUSE the buy (skip, keep cycling once refueled) instead
        # of placing a tiny, gas-wasteful order. 0 = disabled (drain-to-dust).
        self.min_cycle_usd = Decimal(str(config.get("min_cycle_usd", "0")))
        self.max_inventory_imbalance = Decimal(str(config.get("max_inventory_imbalance", "0.50")))
        self.max_inventory_imbalance_usd = Decimal(
            str(config.get("max_inventory_imbalance_usd", "0"))
        )
        # Per-market spread gate: pairs live at very different spread floors
        # (WETH/WBTC pinned at ~2bp, SOMI at 9-19bp). A single global gate
        # either silently skips the wide pair forever or lets the tight pairs
        # cycle through expensive spread flickers.
        spread_by_market = config.get("max_spread_bps_by_market", {})
        self.max_spread_bps = Decimal(str(
            spread_by_market.get(self.market.value, config.get("max_spread_bps", "100"))
        ))
        self.min_side_depth_usd = Decimal(str(config.get("min_side_depth_usd", "1.00")))
        self.depth_usage_fraction = Decimal(str(config.get("depth_usage_fraction", "0.50")))
        self.ioc_cross_bps = Decimal(str(config.get("ioc_cross_bps", "5.0")))
        self.profit_aware_exit_enabled = bool(config.get("profit_aware_exit_enabled", False))
        self.take_profit_bps = Decimal(str(config.get("take_profit_bps", "0")))
        self.max_hold_sec = float(config.get("max_hold_sec", 0))
        self.entry_max_spread_bps = Decimal(str(
            config.get("entry_max_spread_bps", self.max_spread_bps)
        ))
        reserve_by_market = config.get("native_base_reserve_by_market", {})
        self.native_base_reserve = Decimal(str(
            reserve_by_market.get(
                self.market.value,
                config.get("native_base_reserve", "0"),
            )
        ))

        # Momentum gate: only OPEN a new buy cycle when the recent price trend is
        # flat-to-up. Each round trip pays the spread regardless, but milling
        # *into a downtrend* adds adverse selection (our sell fills a tick lower
        # as price slides) — measured ~12bp burn on a falling WETH vs ~6-7bp
        # flat. Pausing buys on downtrends keeps the USDso bleed down while still
        # generating ranking volume on flat/up moves. Sells are never gated, so a
        # mid-cycle position always flattens. min_change_bps = the minimum price
        # change over the lookback window required to allow a buy (0 = flat-to-up
        # only; a small negative tolerates noise; positive = strict uptrend).
        self.momentum_gate_enabled = bool(config.get("momentum_gate_enabled", False))
        self.momentum_lookback_sec = float(config.get("momentum_lookback_sec", 45.0))
        self.momentum_min_change_bps = Decimal(str(config.get("momentum_min_change_bps", "0")))
        self._mid_history: deque[tuple[float, Decimal]] = deque()

        self._last_cycle_ts: float = 0
        self._last_action: Side | None = None
        self._entry_price: Decimal | None = None
        self._entry_ts: float | None = None
        self._warned_no_balance: bool = False
        self.last_skip_reason: str | None = None

    async def generate_signals(
        self,
        market_state: dict[MarketSymbol, MarketState],
        inventory: dict[MarketSymbol, OwnInventory],
    ) -> list[TradingSignal]:
        if time.time() - self._last_cycle_ts < self.cycle_interval_sec:
            return []

        ms = market_state.get(self.market)
        inv = inventory.get(self.market)
        if ms is None or inv is None:
            return []
        if ms.best_bid is None or ms.best_ask is None:
            self._skip("one_sided_or_empty_book", market=self.market.value)
            return []
        self._record_mid(ms)
        if not self._book_is_tradeable(ms):
            return []

        # Wallet-funded IOC pulls from total balance (wallet, not vault).
        # If balance is zero, we can't trade — warn once and idle until funded.
        free_quote = inv.quote_balance - inv.quote_locked_in_orders
        tradable_base = self._tradable_base_balance(inv)
        if free_quote <= 0 and tradable_base <= 0:
            if not self._warned_no_balance:
                log.warning("volume_mill.no_balance",
                            market=self.market.value,
                            wallet_quote=str(inv.quote_balance),
                            wallet_base=str(inv.base_balance),
                            tradable_base=str(tradable_base),
                            note="Fund the wallet (or wait for inventory refresh) to begin trading.")
                self._warned_no_balance = True
            return []
        # Once we see balance, allow the warning to reset for future zero-states
        if free_quote > 0 or tradable_base > 0:
            self._warned_no_balance = False
        if tradable_base <= 0:
            self._clear_entry()

        # A restart can occur after a buy but before the matching sell. The
        # in-memory action state is then lost, so flatten discovered base
        # inventory before starting a fresh cycle.
        if self._last_action is None and tradable_base > 0:
            sell = self._sell_all_signal(ms, tradable_base)
            if sell:
                return sell

        # If we hold base above the imbalance threshold, sell to flatten.
        max_base_units = self.max_inventory_imbalance
        if self.max_inventory_imbalance_usd > 0:
            max_base_units = self.max_inventory_imbalance_usd / ms.best_bid
        if tradable_base > max_base_units:
            qty_checked = self._sell_qty_for_depth(tradable_base, ms.best_bid, ms.bid_depth_usd)
            if qty_checked is None or qty_checked <= 0:
                self._skip("sell_qty_too_small_after_depth_cap", market=self.market.value)
                return []
            self._last_cycle_ts = time.time()
            self._last_action = Side.SELL
            return [self._sell_signal(qty_checked, self._sell_cross_price(ms.best_bid))]

        # If a sell was rejected or failed simulation, we may still hold the
        # prior buy while quote is too small to start another cycle. Keep
        # working out of base instead of getting stuck in buy-size skips.
        if self._last_action == Side.SELL and tradable_base > 0:
            sell = self._sell_all_signal(ms, tradable_base)
            if sell:
                return sell

        min_buy_notional = MARKETS[self.market].min_quantity * ms.best_ask
        if tradable_base > 0 and free_quote < min_buy_notional:
            sell = self._sell_all_signal(ms, tradable_base)
            if sell:
                return sell

        # Otherwise ping-pong: if last action was BUY, sell remaining base.
        # Otherwise (or if nothing held) buy fresh.
        if self._last_action == Side.BUY and tradable_base > 0:
            if self.profit_aware_exit_enabled:
                sell = self._profit_aware_sell_signal(ms, tradable_base)
                if sell is not None:
                    return [sell]
                return []
            sell = self._sell_all_signal(ms, tradable_base)
            if sell:
                return sell
            # Otherwise buy didn't actually fill — try buying again
        return self._buy_cycle(ms, free_quote)

    def _record_mid(self, ms: MarketState) -> None:
        """Sample the mid price into a rolling window for the momentum gate."""
        if ms.mid is None or ms.mid <= 0:
            return
        now = time.time()
        self._mid_history.append((now, ms.mid))
        cutoff = now - self.momentum_lookback_sec
        while self._mid_history and self._mid_history[0][0] < cutoff:
            self._mid_history.popleft()

    def _trend_bps(self) -> Decimal | None:
        """Price change (bps) across the lookback window, oldest->newest. Returns
        None until the window spans at least half the lookback, so we never gate
        on a single fresh sample right after startup/reconnect."""
        if len(self._mid_history) < 2:
            return None
        oldest_ts, ref = self._mid_history[0]
        newest_ts, cur = self._mid_history[-1]
        if ref <= 0 or newest_ts - oldest_ts < self.momentum_lookback_sec * 0.5:
            return None
        return (cur - ref) / ref * Decimal(10000)

    def _buy_cycle(self, ms: MarketState, free_quote: Decimal) -> list[TradingSignal]:
        assert ms.best_ask is not None
        if self.momentum_gate_enabled:
            trend = self._trend_bps()
            if trend is not None and trend < self.momentum_min_change_bps:
                self._skip(
                    "buy_paused_downtrend",
                    market=self.market.value,
                    trend_bps=str(round(trend, 2)),
                    min_change_bps=str(self.momentum_min_change_bps),
                )
                return []
        if self.profit_aware_exit_enabled:
            spread_bps = self._spread_bps(ms)
            if spread_bps is not None and spread_bps > self.entry_max_spread_bps:
                self._skip(
                    "entry_spread_too_wide",
                    market=self.market.value,
                    spread_bps=str(spread_bps),
                    entry_max_spread_bps=str(self.entry_max_spread_bps),
                )
                return []
        usable_ask_depth = ms.ask_depth_usd * self.depth_usage_fraction
        target_usd = min(self.size_per_cycle_usd, free_quote * Decimal("0.95"), usable_ask_depth)
        if target_usd <= 0:
            self._skip(
                "buy_target_zero_after_depth_cap",
                market=self.market.value,
                ask_depth_usd=str(ms.ask_depth_usd),
                free_quote=str(free_quote),
            )
            return []
        if self.min_cycle_usd > 0 and target_usd < self.min_cycle_usd:
            self._skip(
                "buy_below_min_cycle",
                market=self.market.value,
                target_usd=str(target_usd),
                min_cycle_usd=str(self.min_cycle_usd),
                free_quote=str(free_quote),
            )
            return []
        qty_base = target_usd / ms.best_ask
        qty_base = round_to_lot(qty_base, self.market, direction="down")
        qty_checked = ensure_min_quantity(qty_base, self.market)
        if qty_checked is None or qty_checked <= 0:
            log.debug("volume_mill.qty_too_small",
                      target_usd=str(target_usd), min_qty=str(MARKETS[self.market].min_quantity))
            self._skip(
                "buy_qty_too_small",
                market=self.market.value,
                target_usd=str(target_usd),
                min_qty=str(MARKETS[self.market].min_quantity),
            )
            return []
        self._last_cycle_ts = time.time()
        self._last_action = Side.BUY
        price = self._buy_cross_price(ms.best_ask)
        self._record_entry(price)
        return [self._buy_signal(qty_checked, price)]

    def _buy_signal(self, qty: Decimal, price: Decimal) -> TradingSignal:
        return TradingSignal(
            action=SignalAction.PLACE,
            order=OrderIntent(
                market=self.market,
                side=Side.BUY,
                order_type=OrderType.IOC,
                quantity=qty,
                price=price,
                funding=FundingSource.WALLET,
                client_order_id=f"vm_buy_{uuid.uuid4().hex[:8]}",
                reason="volume_mill cycle buy",
            ),
        )

    def _book_is_tradeable(self, ms: MarketState) -> bool:
        spread_bps = self._spread_bps(ms)
        if spread_bps is None:
            self._skip("spread_unavailable", market=self.market.value)
            return False
        if spread_bps > self.max_spread_bps:
            self._skip(
                "spread_too_wide",
                market=self.market.value,
                spread_bps=str(spread_bps),
                max_spread_bps=str(self.max_spread_bps),
            )
            return False
        if ms.bid_depth_usd < self.min_side_depth_usd:
            self._skip(
                "bid_depth_too_thin",
                market=self.market.value,
                bid_depth_usd=str(ms.bid_depth_usd),
                min_side_depth_usd=str(self.min_side_depth_usd),
            )
            return False
        if ms.ask_depth_usd < self.min_side_depth_usd:
            self._skip(
                "ask_depth_too_thin",
                market=self.market.value,
                ask_depth_usd=str(ms.ask_depth_usd),
                min_side_depth_usd=str(self.min_side_depth_usd),
            )
            return False
        self.last_skip_reason = None
        return True

    def _spread_bps(self, ms: MarketState) -> Decimal | None:
        if ms.best_bid is None or ms.best_ask is None:
            return None
        mid = (ms.best_bid + ms.best_ask) / 2
        if mid <= 0:
            return None
        return (ms.best_ask - ms.best_bid) / mid * Decimal("10000")

    def _cap_qty_to_depth(self, qty: Decimal, price: Decimal, side_depth_usd: Decimal) -> Decimal:
        if price <= 0:
            return Decimal(0)
        depth_qty = side_depth_usd * self.depth_usage_fraction / price
        return round_to_lot(min(qty, depth_qty), self.market, direction="down")

    def _tradable_base_balance(self, inv: OwnInventory) -> Decimal:
        if not MARKETS[self.market].is_base_native:
            return inv.base_balance
        reserved = min(inv.base_balance, self.native_base_reserve)
        return max(Decimal("0"), inv.base_balance - reserved)

    def _record_entry(self, price: Decimal) -> None:
        if not self.profit_aware_exit_enabled:
            return
        self._entry_price = price
        self._entry_ts = time.time()

    def _clear_entry(self) -> None:
        self._entry_price = None
        self._entry_ts = None

    def _skip(self, reason: str, **fields: Any) -> None:
        self.last_skip_reason = reason
        log.info("volume_mill.skip", reason=reason, **fields)

    def _buy_cross_price(self, best_ask: Decimal) -> Decimal:
        multiplier = Decimal("1") + self.ioc_cross_bps / Decimal("10000")
        return round_to_tick(best_ask * multiplier, self.market, direction="up")

    def _sell_cross_price(self, best_bid: Decimal) -> Decimal:
        multiplier = Decimal("1") - self.ioc_cross_bps / Decimal("10000")
        return round_to_tick(best_bid * multiplier, self.market, direction="down")

    def _profit_target_price(self) -> Decimal | None:
        if self._entry_price is None:
            return None
        multiplier = Decimal("1") + self.take_profit_bps / Decimal("10000")
        return round_to_tick(self._entry_price * multiplier, self.market, direction="down")

    def _profit_aware_sell_signal(
        self,
        ms: MarketState,
        base_balance: Decimal,
    ) -> TradingSignal | None:
        assert ms.best_bid is not None
        target = self._profit_target_price()
        if target is None:
            sell = self._sell_all_signal(ms, base_balance)
            return sell[0] if sell else None

        if ms.best_bid >= target:
            qty = self._sell_qty_for_depth(base_balance, ms.best_bid, ms.bid_depth_usd)
            if qty is None:
                return None
            self._last_cycle_ts = time.time()
            self._last_action = Side.SELL
            return self._sell_signal(qty, target)

        held_sec = time.time() - self._entry_ts if self._entry_ts is not None else 0
        if self.max_hold_sec > 0 and held_sec >= self.max_hold_sec:
            sell = self._sell_all_signal(ms, base_balance)
            if sell:
                log.info(
                    "volume_mill.profit_exit_timeout",
                    market=self.market.value,
                    best_bid=str(ms.best_bid),
                    target=str(target),
                    held_sec=f"{held_sec:.1f}",
                )
                return sell[0]
            return None

        self._skip(
            "profit_target_not_reached",
            market=self.market.value,
            best_bid=str(ms.best_bid),
            target=str(target),
        )
        return None

    def _sell_all_signal(self, ms: MarketState, base_balance: Decimal) -> list[TradingSignal]:
        assert ms.best_bid is not None
        qty_checked = self._sell_qty_for_depth(base_balance, ms.best_bid, ms.bid_depth_usd)
        if qty_checked and qty_checked > 0:
            self._last_cycle_ts = time.time()
            self._last_action = Side.SELL
            return [self._sell_signal(qty_checked, self._sell_cross_price(ms.best_bid))]
        self._skip("sell_qty_too_small_after_depth_cap", market=self.market.value)
        return []

    def _sell_qty_for_depth(
        self,
        base_balance: Decimal,
        best_bid: Decimal,
        bid_depth_usd: Decimal,
    ) -> Decimal | None:
        qty = round_to_lot(base_balance, self.market, direction="down")
        qty = self._cap_qty_to_depth(qty, best_bid, bid_depth_usd)
        return ensure_min_quantity(qty, self.market)

    def _sell_signal(self, qty: Decimal, price: Decimal) -> TradingSignal:
        return TradingSignal(
            action=SignalAction.PLACE,
            order=OrderIntent(
                market=self.market,
                side=Side.SELL,
                order_type=OrderType.IOC,
                quantity=qty,
                price=price,
                funding=FundingSource.WALLET,
                client_order_id=f"vm_sell_{uuid.uuid4().hex[:8]}",
                reason="volume_mill cycle sell",
            ),
        )

    async def on_fill(self, fill_event: dict[str, Any]) -> None:
        log.info("volume_mill.fill",
                 side=fill_event.get("side"),
                 qty=fill_event.get("quantity"),
                 price=fill_event.get("price"))

    async def on_reject(self, order_id: str, reason: str) -> None:
        log.warning("volume_mill.rejected", order_id=order_id, reason=reason)
        # Back off one cycle on reject
        self._last_cycle_ts = time.time()
