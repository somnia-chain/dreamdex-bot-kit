# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""IOC taker loop — alternating buy/sell for volume."""
import asyncio
import logging
import random
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from executor import LiveDreamDexBot

logger = logging.getLogger(__name__)


class TakerStrategy:
    def __init__(self, bot: "LiveDreamDexBot"):
        self.bot = bot

    def _record_fill(self, is_bid: bool, quantity_raw: int, price_raw: int, tx_hash: str) -> None:
        bot = self.bot
        bot.metrics["orders"] += 1
        if is_bid:
            bot.metrics["volume_in_raw"] += bot._quote_cost(quantity_raw, price_raw)
            bot.metrics["volume_out_raw"] += int(quantity_raw)
        else:
            bot.metrics["volume_in_raw"] += int(quantity_raw)
            bot.metrics["volume_out_raw"] += bot._quote_cost(quantity_raw, price_raw)
        bot._save_metrics()
        bot._save_state(tx_hash)
        bot._update_pnl_metrics()

    async def run(self) -> None:
        bot = self.bot
        if bot.volume_mode:
            logger.info(
                f"High-turnover taker: trade_fraction={bot.trade_fraction} "
                f"freq_sec={bot.freq_sec} order_type=IOC"
            )
            if bot.volume_target_quote_raw is not None:
                logger.info(f"Notional stop target (quote raw): {bot.volume_target_quote_raw}")

        bot._preflight_checks()
        bot._ensure_startup_allowances()

        order_count = 0
        order_type = bot.cfg.get("order_type_rebalance", "immediateOrCancel")
        logger.info(f"Starting taker loop (freq_sec={bot.freq_sec}, min_loop_sec={bot.min_loop_sec})")

        while True:
            loop_sleep = bot.freq_sec
            if bot.max_orders is not None and order_count >= int(bot.max_orders):
                logger.info("Reached max_orders; stopping.")
                break

            best_bid, best_ask = bot._best_prices()
            if best_bid is None or best_ask is None:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.warning("No book depth yet; retrying later.")
                await asyncio.sleep(bot.freq_sec)
                continue

            if bot._drawdown_exceeded(best_bid, best_ask):
                logger.error("Drawdown limit exceeded; stopping bot.")
                break

            is_bid = bot._choose_side(best_bid, best_ask)
            if is_bid is None:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.warning("Insufficient wallet balance for either side; retrying later.")
                await asyncio.sleep(bot.freq_sec)
                continue

            slippage = int(bot.cfg.get("slippage_bps_rebalance", bot.slippage_bps))
            price_raw = bot._price_for_order(is_bid, best_bid, best_ask, slippage_bps=slippage)
            if is_bid:
                quantity_raw = bot._buy_quantity_from_balance(bot._spendable_quote_balance(), price_raw)
            else:
                quantity_raw = bot._sell_quantity_from_balance(bot._spendable_base_balance())

            if quantity_raw < bot.market.min_quantity:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.warning("Computed trade size was below market minimum; retrying later.")
                await asyncio.sleep(bot.freq_sec)
                continue

            if not bot._can_afford(is_bid, quantity_raw, price_raw):
                bot.metrics["errors"] += 1
                bot._save_metrics()
                side = "buy" if is_bid else "sell"
                logger.warning(
                    f"Balance check failed for {side} qty={quantity_raw} price={price_raw}; retrying later."
                )
                await asyncio.sleep(bot.freq_sec)
                continue

            try:
                approval_tx = bot._ensure_order_allowance(is_bid, quantity_raw, price_raw)
                if approval_tx:
                    logger.info(f"Allowance tx: {approval_tx}")

                tx_hash, ok, _ = bot._submit_order(
                    is_bid, quantity_raw, price_raw, order_type_api=order_type
                )
                if not ok:
                    bot.metrics["errors"] += 1
                    bot._save_metrics()
                    logger.warning("Order simulation rejected; skipping this round.")
                    await asyncio.sleep(bot.freq_sec)
                    continue

                if not bot.dry_run:
                    receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
                    if receipt.status != 1:
                        raise RuntimeError(f"Order failed: {tx_hash}")

                self._record_fill(is_bid, quantity_raw, price_raw, tx_hash)
                order_count += 1
                side = "buy" if is_bid else "sell"
                vol_quote = bot._cumulative_volume_quote_raw() / (10 ** bot.market.quote_decimals)
                pnl = int(bot.metrics.get("pnl_quote_raw", 0)) / (10 ** bot.market.quote_decimals)
                logger.info(
                    f"order ok side={side} tx={tx_hash} qty={quantity_raw} price={price_raw} "
                    f"cumulative_notional≈{vol_quote:.2f} pnl≈{pnl:.4f}"
                )
                if (
                    bot.volume_target_quote_raw is not None
                    and bot._cumulative_volume_quote_raw() >= int(bot.volume_target_quote_raw)
                ):
                    logger.info("Notional stop target reached; stopping.")
                    break
                loop_sleep = bot.min_loop_sec
            except Exception as exc:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.error(f"order error: {exc}", exc_info=True)
                if "Connection" in type(exc).__name__ or "Connection" in str(exc):
                    logger.warning("RPC connection issue; backing off 60s")
                    await asyncio.sleep(60)
                    continue
                loop_sleep = bot.freq_sec

            await asyncio.sleep(max(0.5, random.uniform(loop_sleep * 0.85, loop_sleep * 1.15)))
