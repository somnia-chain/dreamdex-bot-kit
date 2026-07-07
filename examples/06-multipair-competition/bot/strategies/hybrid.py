# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Hybrid maker (PostOnly) + IOC rebalance — profit-first for competition."""
import asyncio
import logging
import random
from decimal import Decimal
from typing import TYPE_CHECKING, Dict, Optional, Tuple

if TYPE_CHECKING:
    from executor import LiveDreamDexBot

logger = logging.getLogger(__name__)


class HybridStrategy:
    def __init__(self, bot: "LiveDreamDexBot"):
        self.bot = bot
        cfg = bot.cfg
        self.maker_mode = str(cfg.get("maker_mode", "touch"))
        self.maker_spread_ticks = int(cfg.get("maker_spread_ticks", 1))
        self.maker_improve_ticks = int(cfg.get("maker_improve_ticks", 0))
        self.min_profitable_spread_bps = int(cfg.get("min_profitable_spread_bps", 20))
        self.inventory_skew_bps = int(cfg.get("inventory_skew_bps", 300))
        self.rebalance_threshold_bps = int(cfg.get("rebalance_threshold_bps", 800))
        self.rebalance_size_fraction = float(cfg.get("rebalance_size_fraction", 0.5))
        self.max_spread_bps = int(cfg.get("max_spread_bps", 80))
        self.target_inventory_ratio = float(cfg.get("target_inventory_ratio", 0.5))
        self.order_type_maker = str(cfg.get("order_type_maker", "postOnly"))
        self.order_type_rebalance = str(cfg.get("order_type_rebalance", "immediateOrCancel"))
        self.slippage_rebalance = int(cfg.get("slippage_bps_rebalance", 12))
        self.maker_size_fraction = float(cfg.get("maker_size_fraction", 0.20))
        self.always_two_sided_mm = bool(cfg.get("always_two_sided_mm", False))
        self.maker_size_usdso = float(cfg.get("maker_size_usdso", 0) or 0)
        self.maker_min_size_usdso = float(cfg.get("maker_min_size_usdso", 10))
        self.maker_requote_ticks = int(cfg.get("maker_requote_ticks", 1))
        self.fill_rebalance_boost = float(cfg.get("fill_rebalance_boost", 1.5))
        self._last_bid_order_id: Optional[str] = None
        self._last_ask_order_id: Optional[str] = None

    def _price_raw_from_order(self, price_human: str) -> int:
        return int(Decimal(str(price_human)) * (Decimal(10) ** self.bot.market.quote_decimals))

    def _open_orders_by_side(self) -> Tuple[Optional[Dict], Optional[Dict]]:
        bid_order = None
        ask_order = None
        for order in self.bot._list_open_orders():
            if order.get("side") == "buy":
                bid_order = order
            elif order.get("side") == "sell":
                ask_order = order
        return bid_order, ask_order

    def _maker_prices(self, best_bid: int, best_ask: int) -> Tuple[int, int]:
        bot = self.bot
        if self.maker_mode == "touch":
            bid_price = bot._maker_price_touch(True, best_bid, best_ask, self.maker_improve_ticks)
            ask_price = bot._maker_price_touch(False, best_bid, best_ask, self.maker_improve_ticks)
        else:
            mid = bot._mid_price_raw(best_bid, best_ask)
            bid_price = bot._maker_price(True, mid, self.maker_spread_ticks)
            ask_price = bot._maker_price(False, mid, self.maker_spread_ticks)
        return bid_price, ask_price

    def _vault_inventory_ratio(self, best_bid: int, best_ask: int) -> float:
        """Inventory ratio for vault MM: wallet + vault + escrow (not vault-only)."""
        bot = self.bot
        if bot.funding_source_maker != "vault":
            return bot._inventory_ratio(best_bid, best_ask)
        return bot._mm_inventory_ratio(best_bid, best_ask)

    def _two_sided_from_vault_balance(self, best_bid: int, best_ask: int) -> Tuple[bool, bool]:
        """Quote both sides whenever vault can fund at least the floor notional."""
        bot = self.bot
        fs = bot.funding_source_maker
        mid = bot._mid_price_raw(best_bid, best_ask)
        floor = self.maker_min_size_usdso
        if self.maker_size_usdso > 0:
            can_bid = bot._maker_notional_quantity_raw(floor, mid, True, fs) >= bot.market.min_quantity
            can_ask = bot._maker_notional_quantity_raw(floor, mid, False, fs) >= bot.market.min_quantity
            return can_bid, can_ask
        quote_raw, base_raw = bot._mm_inventory_balances_raw()
        can_bid = quote_raw > 0 and bot._buy_quantity_from_balance(quote_raw, mid) >= bot.market.min_quantity
        can_ask = base_raw >= bot.market.min_quantity
        return can_bid, can_ask

    def _quote_sides_for_mm(self, best_bid: int, best_ask: int) -> Tuple[bool, bool]:
        bot = self.bot
        if self.always_two_sided_mm:
            return self._two_sided_from_vault_balance(best_bid, best_ask)
        if bot.funding_source_maker == "vault":
            quote_raw, base_raw = bot._mm_inventory_balances_raw()
            if base_raw < bot.market.min_quantity and quote_raw > 0:
                return True, False
            if quote_raw <= 0 and base_raw >= bot.market.min_quantity:
                return False, True
        ratio = self._vault_inventory_ratio(best_bid, best_ask)
        soft = self.inventory_skew_bps / 10_000.0
        target = self.target_inventory_ratio
        if ratio > target + soft:
            return False, True
        if ratio < target - soft:
            return True, False
        return True, True

    def _spread_profitable(self, best_bid: int, best_ask: int, min_spread_bps: Optional[int] = None) -> bool:
        threshold = self.min_profitable_spread_bps if min_spread_bps is None else min_spread_bps
        spread_bps = self.bot._spread_bps(best_bid, best_ask)
        if spread_bps < threshold:
            logger.info(
                f"Spread {spread_bps}bps < min profitable {threshold}bps; skipping quotes."
            )
            return False
        bid_price, ask_price = self._maker_prices(best_bid, best_ask)
        if bid_price <= 0 or ask_price <= 0 or ask_price <= bid_price:
            return False
        edge_bps = int((ask_price - bid_price) * 10_000 // max(1, (bid_price + ask_price) // 2))
        if edge_bps < threshold:
            logger.info(f"Quote edge {edge_bps}bps too thin (min {threshold}bps); skipping.")
            return False
        return True

    def _rebalance_quantity(self, is_bid: bool, best_bid: int, best_ask: int, price_raw: int) -> int:
        bot = self.bot
        quote_bal = bot._token_balance(bot.market.quote)
        base_bal = bot._token_balance(bot.market.base)
        mid = bot._mid_price_raw(best_bid, best_ask)
        base_notional = int((Decimal(base_bal) * Decimal(mid)) / (Decimal(10) ** bot.market.base_decimals))
        total = quote_bal + base_notional
        if total <= 0:
            return 0

        target_base_notional = int(total * self.target_inventory_ratio)
        delta_quote = target_base_notional - base_notional
        if delta_quote == 0:
            return 0

        if is_bid:
            partial_quote = int(abs(delta_quote) * self.rebalance_size_fraction)
            return bot._buy_quantity_from_balance(partial_quote, price_raw)
        partial_base = int(
            (Decimal(abs(delta_quote)) * (Decimal(10) ** bot.market.base_decimals)) / Decimal(mid)
        )
        partial_base = int(partial_base * self.rebalance_size_fraction)
        return bot._align_quantity_down(partial_base)

    async def _rebalance_if_needed(self, best_bid: int, best_ask: int) -> bool:
        bot = self.bot
        drift = bot._inventory_drift_bps(best_bid, best_ask, self.target_inventory_ratio)
        if drift < self.rebalance_threshold_bps:
            return False

        ratio = bot._inventory_ratio(best_bid, best_ask)
        is_bid = ratio < self.target_inventory_ratio
        price_raw = bot._price_for_order(is_bid, best_bid, best_ask, slippage_bps=self.slippage_rebalance)
        quantity_raw = self._rebalance_quantity(is_bid, best_bid, best_ask, price_raw)

        if quantity_raw < bot.market.min_quantity or not bot._can_afford(is_bid, quantity_raw, price_raw):
            return False

        logger.info(
            f"Partial rebalance drift={drift}bps side={'buy' if is_bid else 'sell'} "
            f"qty={quantity_raw} slippage={self.slippage_rebalance}bps"
        )
        approval_tx = bot._ensure_order_allowance(is_bid, quantity_raw, price_raw)
        if approval_tx:
            logger.info(f"Rebalance allowance tx: {approval_tx}")

        tx_hash, ok, _ = bot._submit_order(
            is_bid, quantity_raw, price_raw, order_type_api=self.order_type_rebalance
        )
        if not ok:
            return False
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Rebalance failed: {tx_hash}")
        bot.metrics["orders"] += 1
        bot._update_pnl_metrics(best_bid, best_ask)
        bot._save_metrics()
        bot._save_state(tx_hash)
        return True

    def _maker_notional_for_side(self, is_bid: bool, bid_filled: bool, ask_filled: bool) -> Optional[float]:
        if self.maker_size_usdso <= 0:
            return None
        notional = self.maker_size_usdso
        if is_bid and ask_filled and not bid_filled:
            notional = self.maker_size_usdso * self.fill_rebalance_boost
        elif not is_bid and bid_filled and not ask_filled:
            notional = self.maker_size_usdso * self.fill_rebalance_boost
        return notional

    def _maker_quantity(
        self,
        is_bid: bool,
        price_raw: int,
        size_fraction: Optional[float] = None,
        notional_usdso: Optional[float] = None,
    ) -> int:
        bot = self.bot
        fs = bot.funding_source_maker
        target_notional = notional_usdso
        if target_notional is None and self.maker_size_usdso > 0:
            target_notional = self.maker_size_usdso
        if target_notional is not None and target_notional > 0:
            qty = bot._maker_notional_quantity_raw(target_notional, price_raw, is_bid, fs)
            if qty >= bot.market.min_quantity:
                return qty
            if self.maker_min_size_usdso > 0:
                return bot._maker_notional_quantity_raw(self.maker_min_size_usdso, price_raw, is_bid, fs)
            return 0
        fraction = self.maker_size_fraction if size_fraction is None else size_fraction
        if is_bid:
            spendable = int(bot._spendable_quote_balance(fs) * fraction)
            return bot._buy_quantity_from_balance(spendable, price_raw)
        spendable = int(bot._spendable_base_balance(fs) * fraction)
        return bot._sell_quantity_from_balance(spendable)

    async def _ensure_maker_quote(
        self,
        is_bid: bool,
        target_price_raw: int,
        existing: Optional[Dict],
        size_fraction: Optional[float] = None,
        notional_usdso: Optional[float] = None,
    ) -> None:
        bot = self.bot
        if target_price_raw <= 0:
            return
        side = "buy" if is_bid else "sell"

        if existing:
            existing_price = self._price_raw_from_order(str(existing.get("price", "0")))
            tick = max(1, bot.market.tick_size)
            requote_band = tick * max(1, self.maker_requote_ticks)
            if abs(existing_price - target_price_raw) <= requote_band:
                return
            try:
                cancel_tx = bot._cancel_order(str(existing["id"]))
                if not bot.dry_run:
                    receipt = bot.web3.eth.wait_for_transaction_receipt(cancel_tx)
                    if receipt.status != 1:
                        logger.warning(f"Cancel failed for {existing['id']}: {cancel_tx}")
                        return
                logger.info(f"Cancelled stale {side} order {existing['id']}")
            except Exception as exc:
                logger.warning(f"Could not cancel order {existing.get('id')}: {exc}")
                return

        quantity_raw = self._maker_quantity(
            is_bid, target_price_raw, size_fraction=size_fraction, notional_usdso=notional_usdso
        )
        if quantity_raw < bot.market.min_quantity:
            logger.debug(f"Skip {side} maker — size below minimum")
            return
        fs = bot.funding_source_maker
        if not bot._can_afford(is_bid, quantity_raw, target_price_raw, funding_source=fs):
            logger.debug(f"Skip {side} maker — insufficient balance ({fs})")
            return

        approval_tx = bot._ensure_order_allowance(is_bid, quantity_raw, target_price_raw)
        if approval_tx:
            logger.info(f"Maker allowance tx: {approval_tx}")

        tx_hash, ok, order_id = bot._submit_order(
            is_bid,
            quantity_raw,
            target_price_raw,
            order_type_api=self.order_type_maker,
            funding_source=fs,
        )
        if not ok:
            logger.warning(f"Maker {side} simulation rejected")
            return
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Maker order failed: {tx_hash}")
        bot.metrics["orders"] += 1
        bot._save_metrics()
        bot._save_state(tx_hash)
        notional = (
            float(notional_usdso)
            if notional_usdso
            else float(quantity_raw) / (10 ** bot.market.base_decimals)
            * float(target_price_raw) / (10 ** bot.market.quote_decimals)
        )
        logger.info(
            f"Maker {side} placed tx={tx_hash} order_id={order_id} "
            f"qty={quantity_raw} price={target_price_raw} notional≈${notional:.2f}"
        )

    async def run_once(
        self,
        best_bid: Optional[int] = None,
        best_ask: Optional[int] = None,
        bid_price: Optional[int] = None,
        ask_price: Optional[int] = None,
        quote_bid: Optional[bool] = None,
        quote_ask: Optional[bool] = None,
        skip_spread_check: bool = False,
        min_spread_bps: Optional[int] = None,
        maker_size_fraction: Optional[float] = None,
    ) -> bool:
        bot = self.bot
        if best_bid is None or best_ask is None:
            best_bid, best_ask = bot._best_prices()
        if best_bid is None or best_ask is None:
            return False

        spread_bps = bot._spread_bps(best_bid, best_ask)
        if spread_bps > self.max_spread_bps:
            return False

        rebalanced = await self._rebalance_if_needed(best_bid, best_ask)
        if rebalanced:
            return True

        if not skip_spread_check and not self._spread_profitable(best_bid, best_ask, min_spread_bps):
            return False

        if bid_price is None or ask_price is None:
            bid_price, ask_price = self._maker_prices(best_bid, best_ask)
        if quote_bid is None or quote_ask is None:
            quote_bid, quote_ask = self._quote_sides_for_mm(best_bid, best_ask)

        native_low = bot.web3.eth.get_balance(bot.address) < bot.reserve_native_wei
        bid_order, ask_order = self._open_orders_by_side()
        prev_bid_id = self._last_bid_order_id
        prev_ask_id = self._last_ask_order_id
        bid_id = str(bid_order["id"]) if bid_order else None
        ask_id = str(ask_order["id"]) if ask_order else None
        bid_filled = bool(prev_bid_id and not bid_id)
        ask_filled = bool(prev_ask_id and not ask_id)
        acted = False

        if quote_bid and not native_low:
            bid_notional = self._maker_notional_for_side(True, bid_filled, ask_filled)
            before = bot.metrics["orders"]
            await self._ensure_maker_quote(
                True, bid_price, bid_order, size_fraction=maker_size_fraction, notional_usdso=bid_notional
            )
            if bot.metrics["orders"] > before:
                acted = True

        if quote_ask:
            ask_notional = self._maker_notional_for_side(False, bid_filled, ask_filled)
            before = bot.metrics["orders"]
            await self._ensure_maker_quote(
                False, ask_price, ask_order, size_fraction=maker_size_fraction, notional_usdso=ask_notional
            )
            if bot.metrics["orders"] > before:
                acted = True

        self._last_bid_order_id = bid_id
        self._last_ask_order_id = ask_id
        return acted

    async def run(self) -> None:
        bot = self.bot
        logger.info(
            f"Hybrid profit-first: mode={self.maker_mode} min_spread={self.min_profitable_spread_bps}bps "
            f"skew={self.inventory_skew_bps}bps rebalance_at={self.rebalance_threshold_bps}bps "
            f"two_sided={self.always_two_sided_mm} size_usdso={self.maker_size_usdso or 'fraction'}"
        )
        bot._preflight_checks()
        bot._ensure_startup_allowances()

        loop_count = 0
        while True:
            loop_sleep = bot.freq_sec
            if bot.max_orders is not None and loop_count >= int(bot.max_orders):
                logger.info("Reached max_orders; stopping.")
                break

            best_bid, best_ask = bot._best_prices()
            if best_bid is None or best_ask is None:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.warning("No book depth; waiting.")
                await asyncio.sleep(bot.freq_sec)
                continue

            if bot._drawdown_exceeded(best_bid, best_ask):
                logger.error("Drawdown limit exceeded; stopping bot.")
                break

            bot._update_pnl_metrics(best_bid, best_ask)

            try:
                acted = await self.run_once(best_bid=best_bid, best_ask=best_ask)
                if acted:
                    loop_count += 1
                    loop_sleep = bot.min_loop_sec

                spread_bps = bot._spread_bps(best_bid, best_ask)
                pnl = int(bot.metrics.get("pnl_quote_raw", 0)) / (10 ** bot.market.quote_decimals)
                ratio = bot._inventory_ratio(best_bid, best_ask)
                logger.info(
                    f"Hybrid tick {bot.market.symbol} spread={spread_bps}bps inv={ratio:.2%} "
                    f"pnl≈{pnl:.4f} acted={acted}"
                )
            except Exception as exc:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.error(f"hybrid loop error: {exc}", exc_info=True)
                if "Connection" in type(exc).__name__ or "Connection" in str(exc):
                    await asyncio.sleep(60)
                    continue
                loop_sleep = bot.freq_sec

            await asyncio.sleep(max(0.5, random.uniform(loop_sleep * 0.85, loop_sleep * 1.15)))
