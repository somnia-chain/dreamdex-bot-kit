# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Wide-spread round-trip scalp: large size when edge is clear, exit with profit.

When spread >= threshold, buy ~$100 at the bid (post-only), then sell at the ask
after fill — capturing the spread in one round-trip. Falls back to IOC exit on
timeout/stop so inventory does not linger.
"""
import logging
import time
from decimal import Decimal
from typing import TYPE_CHECKING, Dict, Optional

if TYPE_CHECKING:
    from executor import LiveDreamDexBot

logger = logging.getLogger(__name__)


class ScalpStrategy:
    def __init__(self, bot: "LiveDreamDexBot"):
        self.bot = bot
        cfg = bot.cfg
        self.pairs = list(cfg.get("scalp_pairs", []))
        self.size_usdso = float(cfg.get("scalp_size_usdso", 100))
        self.min_spread_bps = int(cfg.get("scalp_min_spread_bps", 9))
        self.micro_size_usdso = float(cfg.get("scalp_micro_size_usdso", 35))
        self.small_min_spread_bps = int(cfg.get("scalp_small_min_spread_bps", 12))
        self.small_max_spread_bps = int(cfg.get("scalp_small_max_spread_bps", 18))
        self.small_size_usdso = float(cfg.get("scalp_small_size_usdso", 45))
        self.main_min_spread_bps = int(cfg.get("scalp_main_min_spread_bps", 18))
        self.sell_first_ratio = float(cfg.get("scalp_sell_first_ratio", 0.46))
        self.tp_bps = int(cfg.get("scalp_take_profit_bps", 10))
        self.stop_bps = int(cfg.get("scalp_stop_loss_bps", 25))
        self.max_hold_sec = float(cfg.get("scalp_max_hold_sec", 180))
        self.cooldown_sec = float(cfg.get("scalp_cooldown_sec", 15))
        self.use_taker_entry = bool(cfg.get("scalp_use_taker_entry", False))
        self.taker_min_spread_bps = int(cfg.get("scalp_taker_min_spread_bps", 22))
        self.slippage_bps = int(cfg.get("scalp_slippage_bps", 8))
        self.maker_order_type = str(cfg.get("scalp_order_type_maker", "postOnly"))
        self.taker_order_type = str(cfg.get("scalp_order_type_taker", "immediateOrCancel"))
        self.max_spread_bps = int(cfg.get("scalp_max_spread_bps", 80))
        self.boost_spread_bps = int(cfg.get("scalp_boost_spread_bps", 24))
        self.boost_size_usdso = float(cfg.get("scalp_boost_size_usdso", 120))
        self.max_inventory_ratio = float(cfg.get("scalp_max_inventory_ratio", 0.50))
        self.max_spend_fraction = float(cfg.get("scalp_max_spend_fraction", 0.75))
        self.pair_params: dict = dict(cfg.get("scalp_pair_params", {}))
        self.usd_only = bool(cfg.get("scalp_usd_only", False))

        # symbol -> state dict | None
        self._state: Dict[str, Optional[dict]] = {p: None for p in self.pairs}
        self._cooldown_until: Dict[str, float] = {p: 0.0 for p in self.pairs}
        self.round_trips = 0
        self.realized_pnl_usdso = 0.0

    async def step(self) -> int:
        if not self.pairs:
            return 0
        acted = 0
        for symbol in self.pairs:
            try:
                acted += await self._step_symbol(symbol)
            except Exception as exc:
                logger.error(f"scalp {symbol} error: {exc}", exc_info=True)
        return acted

    async def _step_symbol(self, symbol: str) -> int:
        bot = self.bot
        if time.time() < self._cooldown_until.get(symbol, 0):
            return 0

        market = bot.markets_registry.get(symbol)
        if market is None:
            return 0

        best_bid, best_ask = bot._best_prices_for(market)
        if not best_bid or not best_ask:
            return 0

        spread = bot._spread_bps(best_bid, best_ask)
        if spread > self.max_spread_bps:
            return 0

        # USD-only: flatten stray base before any new entry.
        if self.usd_only and await self._flatten_base_if_any(symbol, best_bid, best_ask):
            return 1

        state = self._state.get(symbol)
        if state is None:
            return await self._maybe_enter(symbol, best_bid, best_ask, spread)
        return await self._advance(symbol, state, best_bid, best_ask)

    def _pair_param(self, symbol: str, key: str, default):
        overrides = self.pair_params.get(symbol, {})
        return overrides.get(key, default)

    def _min_spread(self, symbol: str) -> int:
        return int(self._pair_param(symbol, "min_spread_bps", self.min_spread_bps))

    def _target_size_usdso(self, spread: int, symbol: str) -> float:
        micro = float(self._pair_param(symbol, "micro_size_usdso", self.micro_size_usdso))
        small = float(self._pair_param(symbol, "small_size_usdso", self.small_size_usdso))
        main = float(self._pair_param(symbol, "size_usdso", self.size_usdso))
        boost = float(self._pair_param(symbol, "boost_size_usdso", self.boost_size_usdso))
        main_min = int(self._pair_param(symbol, "main_min_spread_bps", self.main_min_spread_bps))
        small_min = int(self._pair_param(symbol, "small_min_spread_bps", self.small_min_spread_bps))
        boost_sp = int(self._pair_param(symbol, "boost_spread_bps", self.boost_spread_bps))
        floor = self._min_spread(symbol)

        if spread >= boost_sp:
            return boost
        if spread >= main_min:
            return main
        if spread >= small_min:
            return small
        if spread >= floor:
            return micro
        return 0.0

    def _tier_label(self, spread: int, symbol: str) -> str:
        if spread >= int(self._pair_param(symbol, "boost_spread_bps", self.boost_spread_bps)):
            return "large"
        if spread >= int(self._pair_param(symbol, "main_min_spread_bps", self.main_min_spread_bps)):
            return "main"
        if spread >= int(self._pair_param(symbol, "small_min_spread_bps", self.small_min_spread_bps)):
            return "small"
        if spread >= self._min_spread(symbol):
            return "micro"
        return "none"

    def _sell_qty_raw(self, symbol: str, price_raw: int, spread: int) -> int:
        bot = self.bot
        market = bot.markets_registry[symbol]
        dec = market.quote_decimals
        target = self._target_size_usdso(spread, symbol)
        if target <= 0:
            return 0
        approx_base = int(
            (Decimal(str(target)) * (Decimal(10) ** market.base_decimals))
            / (Decimal(price_raw) / (Decimal(10) ** dec))
        )
        spendable = bot._spendable_base_balance()
        if market.base_is_native:
            spendable = max(0, spendable - bot.reserve_native_wei)
        qty = bot._align_quantity_down(min(approx_base, spendable))
        return qty

    def _size_quote_raw(self, symbol: str, price_raw: int, spread: int) -> int:
        bot = self.bot
        market = bot.markets_registry[symbol]
        dec = market.quote_decimals
        spendable = bot._spendable_quote_balance() / (10 ** dec)
        target = min(self._target_size_usdso(spread, symbol), spendable * self.max_spend_fraction)
        if target < 5:
            return 0
        return int(Decimal(str(target)) * (Decimal(10) ** dec))

    def _base_raw(self, symbol: str) -> int:
        market = self.bot.markets_registry[symbol]
        return self.bot._token_balance(market.base)

    async def _maybe_enter(self, symbol: str, best_bid: int, best_ask: int, spread: int) -> int:
        if self._target_size_usdso(spread, symbol) <= 0:
            return 0
        if spread < self._min_spread(symbol):
            return 0
        if self.use_taker_entry and spread < self.taker_min_spread_bps:
            return 0

        bot = self.bot
        bot._set_active_market(symbol)
        inv_ratio = bot._inventory_ratio(best_bid, best_ask)
        sell_thresh = float(self._pair_param(symbol, "sell_first_ratio", self.sell_first_ratio))
        market = bot.markets_registry[symbol]
        holding_base = self._base_raw(symbol) >= market.min_quantity

        # If any base is already held, always sell it first (never stack).
        if holding_base and inv_ratio >= sell_thresh:
            return await self._maybe_enter_sell_first(symbol, best_bid, best_ask, spread, inv_ratio)

        # Flat (USDso-only): buy then sell back => round-trip, ends in USDso.
        max_inv = float(self._pair_param(symbol, "max_inventory_ratio", self.max_inventory_ratio))
        if inv_ratio >= max_inv:
            return 0

        return await self._maybe_enter_buy_first(symbol, best_bid, best_ask, spread, inv_ratio)

    async def _flatten_base_if_any(self, symbol: str, best_bid: int, best_ask: int) -> bool:
        """IOC dump any held base so wallet returns to USDso-only."""
        bot = self.bot
        market = bot.markets_registry.get(symbol)
        if market is None or self._state.get(symbol) is not None:
            return False
        bal = self._base_raw(symbol)
        if market.base_is_native:
            return False
        qty = bot._align_quantity_down(bal)
        if qty < market.min_quantity:
            return False
        bot._set_active_market(symbol)
        price = bot._price_for_order(False, best_bid, best_ask, slippage_bps=self.slippage_bps)
        logger.warning(f"Scalp FLATTEN {symbol} qty={qty} (USD-only mode)")
        approval = bot._ensure_order_allowance(False, qty, price)
        if approval and not bot.dry_run:
            bot.web3.eth.wait_for_transaction_receipt(approval)
        tx, ok, _ = bot._submit_order(False, qty, price, order_type_api=self.taker_order_type)
        if not ok:
            return False
        if not bot.dry_run:
            bot.web3.eth.wait_for_transaction_receipt(tx)
        bot.metrics["orders"] += 1
        bot._save_state(tx)
        return True

    async def _maybe_enter_buy_first(
        self, symbol: str, best_bid: int, best_ask: int, spread: int, inv_ratio: float
    ) -> int:
        bot = self.bot
        quote_dec = bot.market.quote_decimals

        if self.use_taker_entry and spread >= self.taker_min_spread_bps:
            price_raw = bot._price_for_order(True, best_bid, best_ask, slippage_bps=self.slippage_bps)
            order_type = self.taker_order_type
        else:
            price_raw = bot._maker_price_touch(True, best_bid, best_ask, 0)
            order_type = self.maker_order_type

        if price_raw <= 0:
            return 0

        size_quote_raw = self._size_quote_raw(symbol, price_raw, spread)
        qty_raw = bot._buy_quantity_from_balance(size_quote_raw, price_raw)
        if qty_raw < bot.market.min_quantity or not bot._can_afford(True, qty_raw, price_raw):
            return 0

        base_before = self._base_raw(symbol)
        approval_tx = bot._ensure_order_allowance(True, qty_raw, price_raw)
        if approval_tx:
            logger.info(f"Scalp allowance tx: {approval_tx}")

        tx_hash, ok, _ = bot._submit_order(True, qty_raw, price_raw, order_type_api=order_type)
        if not ok:
            return 0
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Scalp entry failed: {tx_hash}")

        entry_cost = bot._quote_cost(qty_raw, price_raw) / (10 ** quote_dec)
        mode = "TAKER" if order_type == self.taker_order_type else "MAKER"
        target = self._target_size_usdso(spread, symbol)
        tier = self._tier_label(spread, symbol)
        self._state[symbol] = {
            "direction": "buy_first",
            "phase": "holding" if order_type == self.taker_order_type else "buy_pending",
            "entry_price_raw": price_raw,
            "qty_raw": qty_raw,
            "base_before": base_before,
            "entry_cost_usdso": entry_cost,
            "opened_ts": time.time(),
            "mode": mode,
        }
        bot.metrics["orders"] += 1
        bot._save_state(tx_hash)
        logger.info(
            f"Scalp BUY [{mode}/{tier}] {symbol} ~{entry_cost:.2f} USDso (target={target:.0f}) "
            f"spread={spread}bps inv={inv_ratio:.2f} qty={qty_raw} tx={tx_hash[:10]}…"
        )
        return 1

    async def _maybe_enter_sell_first(
        self, symbol: str, best_bid: int, best_ask: int, spread: int, inv_ratio: float
    ) -> int:
        """Sell at ask first, then buy back at bid — works when inventory is already high."""
        bot = self.bot
        quote_dec = bot.market.quote_decimals
        ask_price = bot._maker_price_touch(False, best_bid, best_ask, 0)
        if ask_price <= 0:
            return 0

        qty_raw = self._sell_qty_raw(symbol, ask_price, spread)
        if qty_raw < bot.market.min_quantity or not bot._can_afford(False, qty_raw, ask_price):
            return 0

        base_before = self._base_raw(symbol)
        approval_tx = bot._ensure_order_allowance(False, qty_raw, ask_price)
        if approval_tx:
            logger.info(f"Scalp sell-first allowance tx: {approval_tx}")

        tx_hash, ok, _ = bot._submit_order(False, qty_raw, ask_price, order_type_api=self.maker_order_type)
        if not ok:
            return 0
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Scalp sell-first failed: {tx_hash}")

        target = self._target_size_usdso(spread, symbol)
        tier = self._tier_label(spread, symbol)
        self._state[symbol] = {
            "direction": "sell_first",
            "phase": "sf_sell_pending",
            "entry_price_raw": ask_price,
            "qty_raw": qty_raw,
            "base_before": base_before,
            "entry_cost_usdso": 0.0,
            "opened_ts": time.time(),
            "mode": "MAKER",
        }
        bot.metrics["orders"] += 1
        bot._save_state(tx_hash)
        logger.info(
            f"Scalp SELL-FIRST [{tier}] {symbol} ~{target:.0f} USDso "
            f"spread={spread}bps inv={inv_ratio:.2f} qty={qty_raw} tx={tx_hash[:10]}…"
        )
        return 1

    async def _advance(self, symbol: str, state: dict, best_bid: int, best_ask: int) -> int:
        if state.get("direction") == "sell_first":
            return await self._advance_sell_first(symbol, state, best_bid, best_ask)
        return await self._advance_buy_first(symbol, state, best_bid, best_ask)

    async def _advance_buy_first(self, symbol: str, state: dict, best_bid: int, best_ask: int) -> int:
        bot = self.bot
        bot._set_active_market(symbol)
        quote_dec = bot.market.quote_decimals
        base_now = self._base_raw(symbol)
        held_sec = time.time() - state["opened_ts"]
        mid = bot._mid_price_raw(best_bid, best_ask)
        pnl_bps = int((mid - state["entry_price_raw"]) * 10_000 // max(1, state["entry_price_raw"]))

        # --- wait for maker buy fill ---
        if state["phase"] == "buy_pending":
            filled = base_now >= state["base_before"] + int(state["qty_raw"] * 0.85)
            if not filled:
                if held_sec >= self.max_hold_sec:
                    await self._cancel_open_side(True)
                    self._reset(symbol, cooldown=True)
                    logger.info(f"Scalp {symbol}: buy not filled in {self.max_hold_sec:.0f}s; cancelled")
                return 0
            state["phase"] = "holding"
            state["qty_raw"] = min(base_now - state["base_before"], state["qty_raw"])
            state["opened_ts"] = time.time()
            logger.info(f"Scalp {symbol}: buy filled, placing profit sell")

        # --- place profit sell at ask (spread capture) ---
        if state["phase"] == "holding":
            ask_price = bot._maker_price_touch(False, best_bid, best_ask, 0)
            if ask_price <= state["entry_price_raw"]:
                ask_price = bot._align_price(
                    state["entry_price_raw"] + max(1, bot.market.tick_size), False
                )

            # Emergency: stop-loss or timeout => IOC dump at bid
            if pnl_bps <= -self.stop_bps or held_sec >= self.max_hold_sec:
                return await self._exit_ioc(symbol, state, best_bid, best_ask, pnl_bps, "stop/timeout")

            # Fast profit: bid already above entry + tp => IOC sell
            min_exit = state["entry_price_raw"] * (10_000 + self.tp_bps) // 10_000
            if best_bid >= min_exit:
                return await self._exit_ioc(symbol, state, best_bid, best_ask, pnl_bps, "take-profit")

            qty_raw = bot._align_quantity_down(
                min(state["qty_raw"], bot._spendable_base_balance())
            )
            if qty_raw < bot.market.min_quantity:
                self._reset(symbol, cooldown=True)
                return 0

            approval_tx = bot._ensure_order_allowance(False, qty_raw, ask_price)
            if approval_tx:
                logger.info(f"Scalp sell allowance tx: {approval_tx}")

            tx_hash, ok, _ = bot._submit_order(
                False, qty_raw, ask_price, order_type_api=self.maker_order_type
            )
            if not ok:
                return 0
            if not bot.dry_run:
                receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
                if receipt.status != 1:
                    raise RuntimeError(f"Scalp sell failed: {tx_hash}")

            state["phase"] = "sell_pending"
            state["sell_price_raw"] = ask_price
            state["opened_ts"] = time.time()
            bot.metrics["orders"] += 1
            bot._save_state(tx_hash)
            logger.info(
                f"Scalp SELL [MAKER] {symbol} @ {ask_price/(10**quote_dec):.6f} "
                f"edge~{pnl_bps}bps tx={tx_hash[:10]}…"
            )
            return 1

        # --- wait for sell fill ---
        if state["phase"] == "sell_pending":
            sold = base_now <= state["base_before"] + int(state["qty_raw"] * 0.15)
            if not sold:
                if held_sec >= self.max_hold_sec:
                    await self._cancel_open_side(False)
                    return await self._exit_ioc(symbol, state, best_bid, best_ask, pnl_bps, "sell-timeout")
                return 0

            exit_value = bot._quote_cost(state["qty_raw"], state.get("sell_price_raw", best_bid))
            exit_value /= 10 ** quote_dec
            trade_pnl = exit_value - state["entry_cost_usdso"]
            self.realized_pnl_usdso += trade_pnl
            self.round_trips += 1
            self._reset(symbol, cooldown=True)
            logger.info(
                f"Scalp DONE {symbol} pnl={trade_pnl:+.3f} USDso "
                f"cum={self.realized_pnl_usdso:+.3f} trips={self.round_trips}"
            )
            return 1

        return 0

    async def _advance_sell_first(self, symbol: str, state: dict, best_bid: int, best_ask: int) -> int:
        bot = self.bot
        bot._set_active_market(symbol)
        quote_dec = bot.market.quote_decimals
        base_now = self._base_raw(symbol)
        held_sec = time.time() - state["opened_ts"]
        qty_raw = state["qty_raw"]

        if state["phase"] == "sf_sell_pending":
            sold = base_now <= state["base_before"] - int(qty_raw * 0.85)
            if not sold:
                if held_sec >= self.max_hold_sec:
                    await self._cancel_open_side(False)
                    self._reset(symbol, cooldown=True)
                    logger.info(f"Scalp {symbol}: sell-first not filled; cancelled")
                return 0
            sold_qty = state["base_before"] - base_now
            state["qty_raw"] = bot._align_quantity_down(sold_qty)
            state["phase"] = "sf_buy_pending"
            state["opened_ts"] = time.time()
            logger.info(f"Scalp {symbol}: sell-first filled, buying back at bid")

        if state["phase"] == "sf_buy_pending":
            if held_sec >= self.max_hold_sec:
                await self._cancel_open_side(True)
                self._reset(symbol, cooldown=True)
                logger.info(f"Scalp {symbol}: buy-back timeout; cancelled")
                return 0

            bid_price = bot._maker_price_touch(True, best_bid, best_ask, 0)
            if bid_price <= 0:
                return 0
            buy_qty = state["qty_raw"]
            size_quote = bot._quote_cost(buy_qty, bid_price)
            if not bot._can_afford(True, buy_qty, bid_price):
                self._reset(symbol, cooldown=True)
                return 0

            approval_tx = bot._ensure_order_allowance(True, buy_qty, bid_price)
            if approval_tx:
                logger.info(f"Scalp buy-back allowance tx: {approval_tx}")

            tx_hash, ok, _ = bot._submit_order(
                True, buy_qty, bid_price, order_type_api=self.maker_order_type
            )
            if not ok:
                return 0
            if not bot.dry_run:
                receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
                if receipt.status != 1:
                    raise RuntimeError(f"Scalp buy-back failed: {tx_hash}")

            state["phase"] = "sf_buy_wait"
            state["buy_price_raw"] = bid_price
            state["entry_cost_usdso"] = size_quote / (10 ** quote_dec)
            state["opened_ts"] = time.time()
            bot.metrics["orders"] += 1
            bot._save_state(tx_hash)
            logger.info(
                f"Scalp BUY-BACK {symbol} @ {bid_price/(10**quote_dec):.6f} tx={tx_hash[:10]}…"
            )
            return 1

        if state["phase"] == "sf_buy_wait":
            rebought = base_now >= state["base_before"] - int(qty_raw * 0.15)
            if not rebought:
                if held_sec >= self.max_hold_sec:
                    await self._cancel_open_side(True)
                    self._reset(symbol, cooldown=True)
                return 0

            sell_value = bot._quote_cost(state["qty_raw"], state["entry_price_raw"]) / (10 ** quote_dec)
            buy_cost = state["entry_cost_usdso"]
            trade_pnl = sell_value - buy_cost
            self.realized_pnl_usdso += trade_pnl
            self.round_trips += 1
            self._reset(symbol, cooldown=True)
            logger.info(
                f"Scalp DONE [sell-first] {symbol} pnl={trade_pnl:+.3f} USDso "
                f"cum={self.realized_pnl_usdso:+.3f} trips={self.round_trips}"
            )
            return 1

        return 0

    async def _exit_ioc(
        self, symbol: str, state: dict, best_bid: int, best_ask: int, pnl_bps: int, reason: str
    ) -> int:
        bot = self.bot
        quote_dec = bot.market.quote_decimals
        await self._cancel_open_side(False)

        qty_raw = bot._align_quantity_down(
            min(state["qty_raw"], bot._spendable_base_balance())
        )
        if qty_raw < bot.market.min_quantity:
            self._reset(symbol, cooldown=True)
            return 0

        price_raw = bot._price_for_order(False, best_bid, best_ask, slippage_bps=self.slippage_bps)
        approval_tx = bot._ensure_order_allowance(False, qty_raw, price_raw)
        if approval_tx:
            logger.info(f"Scalp exit allowance tx: {approval_tx}")

        tx_hash, ok, _ = bot._submit_order(
            False, qty_raw, price_raw, order_type_api=self.taker_order_type
        )
        if not ok:
            return 0
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Scalp exit failed: {tx_hash}")

        exit_value = bot._quote_cost(qty_raw, price_raw) / (10 ** quote_dec)
        trade_pnl = exit_value - state["entry_cost_usdso"]
        self.realized_pnl_usdso += trade_pnl
        self.round_trips += 1
        self._reset(symbol, cooldown=True)
        bot.metrics["orders"] += 1
        bot._save_state(tx_hash)
        logger.info(
            f"Scalp EXIT [{reason}] {symbol} pnl_bps={pnl_bps} "
            f"trade_pnl={trade_pnl:+.3f} USDso tx={tx_hash[:10]}…"
        )
        return 1

    async def _cancel_open_side(self, is_bid: bool) -> None:
        bot = self.bot
        side = "buy" if is_bid else "sell"
        for order in bot._list_open_orders():
            if order.get("side") == side:
                try:
                    cancel_tx = bot._cancel_order(str(order["id"]))
                    if not bot.dry_run:
                        bot.web3.eth.wait_for_transaction_receipt(cancel_tx)
                except Exception as exc:
                    logger.warning(f"Scalp cancel {side} failed: {exc}")

    def _reset(self, symbol: str, cooldown: bool = False) -> None:
        self._state[symbol] = None
        if cooldown:
            self._cooldown_until[symbol] = time.time() + self.cooldown_sec

    def is_busy(self, symbol: str) -> bool:
        return self._state.get(symbol) is not None
