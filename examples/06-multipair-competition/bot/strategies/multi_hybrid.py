# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Scan all USDso pairs and quote on every profitable market each tick."""
import asyncio
import logging
import random
from typing import TYPE_CHECKING

from market_scanner import MarketScanner

if TYPE_CHECKING:
    from executor import LiveDreamDexBot

from strategies.hybrid import HybridStrategy

logger = logging.getLogger(__name__)


class MultiHybridStrategy:
    def __init__(self, bot: "LiveDreamDexBot"):
        self.bot = bot
        self.scanner = MarketScanner(bot)
        self.hybrid = HybridStrategy(bot)
        self.watch_opportunities = bool(
            bot.cfg.get("watch_opportunities", bot.cfg.get("dry_run", False))
        )

    async def run(self) -> None:
        bot = self.bot
        logger.info(
            f"Multi-pair hybrid watching: {bot.watch_symbols} "
            f"(min_score={self.scanner.min_pair_score}, "
            f"watch_opportunities={self.watch_opportunities})"
        )
        bot._preflight_checks()
        bot._ensure_startup_allowances()

        loop_count = 0
        while True:
            loop_sleep = bot.freq_sec
            if bot.max_orders is not None and loop_count >= int(bot.max_orders):
                logger.info("Reached max_orders; stopping.")
                break

            if bot._drawdown_exceeded():
                logger.error("Drawdown limit exceeded; stopping bot.")
                break

            bot._update_pnl_metrics()
            watch_reports = self.scanner.scan_watch() if self.watch_opportunities else []
            if watch_reports:
                logger.info(f"Pair watch: {self.scanner.format_watch_summary(watch_reports)}")

            opportunities = self.scanner.scan_all()
            summary = self.scanner.format_cross_summary(opportunities)

            if not opportunities:
                if watch_reports:
                    logger.info("No actionable pairs for this wallet (see Pair watch above)")
                else:
                    logger.info(f"No profitable pairs right now — {summary}")
                await asyncio.sleep(bot.freq_sec)
                continue

            acted_total = 0
            try:
                for opp in opportunities:
                    bot._set_active_market(opp.symbol)
                    acted = await self.hybrid.run_once(
                        best_bid=opp.best_bid,
                        best_ask=opp.best_ask,
                        bid_price=opp.bid_price,
                        ask_price=opp.ask_price,
                        quote_bid=opp.quote_bid,
                        quote_ask=opp.quote_ask,
                        skip_spread_check=True,
                    )
                    if acted:
                        acted_total += 1
                        loop_count += 1

                pnl = int(bot.metrics.get("pnl_quote_raw", 0)) / (
                    10 ** next(iter(bot.markets_registry.values())).quote_decimals
                )
                logger.info(
                    f"Multi scan: {summary} | acted={acted_total}/{len(opportunities)} pnl≈{pnl:.4f}"
                )
                loop_sleep = bot.min_loop_sec if acted_total else bot.freq_sec
            except Exception as exc:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.error(f"multi hybrid error: {exc}", exc_info=True)
                if "Connection" in type(exc).__name__ or "Connection" in str(exc):
                    await asyncio.sleep(60)
                    continue
                loop_sleep = bot.freq_sec

            await asyncio.sleep(max(0.5, random.uniform(loop_sleep * 0.85, loop_sleep * 1.15)))
