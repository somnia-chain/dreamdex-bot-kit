# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Competition mode: PnL-weighted volume, 24/7 multi-pair, activity guard."""
import asyncio
import logging
import random
from typing import TYPE_CHECKING, Optional

from market_scanner import MarketScanner

if TYPE_CHECKING:
    from executor import LiveDreamDexBot

from strategies.hybrid import HybridStrategy

logger = logging.getLogger(__name__)


class CompetitionStrategy:
    def __init__(self, bot: "LiveDreamDexBot"):
        self.bot = bot
        cfg = bot.cfg
        self.scanner = MarketScanner(bot)
        self.hybrid = HybridStrategy(bot)
        self.watch_opportunities = bool(cfg.get("watch_opportunities", True))
        self.min_spread_bps = int(cfg.get("min_profitable_spread_bps", 12))
        self.min_spread_floor_bps = int(cfg.get("min_spread_floor_bps", 8))
        self.min_pair_score = float(cfg.get("min_pair_score", 12))
        self.idle_relax_sec = int(cfg.get("idle_relax_hours", 18)) * 3600
        self.activity_pulse_sec = int(cfg.get("activity_pulse_hours", 20)) * 3600
        self.pulse_size_fraction = float(cfg.get("activity_pulse_size_fraction", 0.08))
        self.volume_boost_edge_bps = int(cfg.get("volume_boost_edge_bps", 18))
        self.volume_boost_size_fraction = float(cfg.get("volume_boost_size_fraction", 0.28))

        # Momentum (order-flow) overlay for thin-spread pairs (WETH/WBTC).
        self.momentum_pairs = list(cfg.get("momentum_pairs", []))
        self.scalp_pairs = list(cfg.get("scalp_pairs", [])) if cfg.get("scalp_enabled", False) else []
        # Hybrid maker-making layer. Disabled by default now: scalp generates the
        # volume, and leaving MM on would let it quote SOMI (native escrow risk).
        self.mm_enabled = bool(cfg.get("mm_enabled", False))
        skip = set(cfg.get("skip_pairs", cfg.get("mm_skip_pairs", [])))
        explicit_trade = cfg.get("trade_pairs")
        if explicit_trade is not None:
            self.trade_pairs = list(explicit_trade)
        else:
            self.trade_pairs = [s for s in bot.watch_symbols if s not in skip]
        mm_skip = skip | set(cfg.get("mm_skip_pairs", []))
        explicit_mm = cfg.get("mm_pairs")
        if explicit_mm is not None:
            self.mm_pairs = list(explicit_mm)
        elif self.mm_enabled:
            self.mm_pairs = [
                s for s in self.trade_pairs
                if s not in self.scalp_pairs and s not in mm_skip
            ]
        else:
            self.mm_pairs = []
        self.scalp = None

        # Low-risk volume harvest (post-only, balanced inventory) for MM pairs.
        self.harvest_enabled = bool(cfg.get("volume_harvest_enabled", False))
        self.harvest_min_spread = int(cfg.get("volume_harvest_min_spread_bps", 7))
        self.harvest_size = float(cfg.get("volume_harvest_size_fraction", 0.05))
        self.harvest_max_skew = float(cfg.get("volume_harvest_max_skew", 0.15))
        self.trades_feed = None
        self.momentum = None
        self.price_ref = None

        # Stale-order reaper: safety net against orphaned escrow (invisible inventory).
        # max_age MUST exceed scalp_max_hold_sec so active legs are never killed.
        self.reaper_enabled = bool(cfg.get("reaper_enabled", True))
        self.reaper_max_age_sec = float(cfg.get("reaper_max_age_sec", 90))
        self.reaper_interval_sec = float(cfg.get("reaper_interval_sec", 30))
        self._last_reap_ts = 0.0
        self.mm_min_spread_bps = int(cfg.get("mm_min_spread_bps", 0))
        self.preserve_mode = bool(cfg.get("preserve_mode", False))

    def _dynamic_min_spread(self, idle_sec: float) -> int:
        if idle_sec >= self.idle_relax_sec:
            return self.min_spread_floor_bps
        return self.min_spread_bps

    def _maker_size_for(self, symbol: str, edge_bps: int) -> Optional[float]:
        pair_sizes = self.bot.cfg.get("pair_maker_size_fraction", {})
        if symbol in pair_sizes:
            return float(pair_sizes[symbol])
        if edge_bps >= self.volume_boost_edge_bps:
            return self.volume_boost_size_fraction
        return None

    def _min_spread_for(self, symbol: str, default: int) -> int:
        return self.scanner._min_spread_for(symbol, default)

    def _log_competition_status(self, acted: int, opp_count: int, min_spread: int, idle_sec: float) -> None:
        stats = self.bot.competition_stats()
        mode = "preserve" if self.preserve_mode else (
            "pulse" if idle_sec >= self.activity_pulse_sec else (
                "relaxed" if idle_sec >= self.idle_relax_sec else "normal"
            )
        )
        logger.info(
            f"Competition [{mode}] spread>={min_spread}bps "
            f"opps={opp_count} acted={acted} | "
            f"pnl={stats['pnl_usdso']:.2f} ({stats['pnl_pct']:+.1f}%) "
            f"raw_vol={stats['raw_volume_usdso']:.0f} "
            f"eff_vol={stats['effective_volume_usdso']:.0f} "
            f"tx={stats['tx_count']} idle={stats['idle_hours']:.1f}h"
        )

    async def _activity_pulse(self, min_spread: int) -> bool:
        candidate = self.scanner.best_pulse_candidate(min_spread, symbols=self.trade_pairs)
        if candidate is None:
            return False

        self.bot._set_active_market(candidate.symbol)
        logger.info(
            f"Activity pulse on {candidate.symbol} edge={candidate.edge_bps}bps "
            f"(idle guard, min={min_spread}bps)"
        )
        return await self.hybrid.run_once(
            best_bid=candidate.best_bid,
            best_ask=candidate.best_ask,
            bid_price=candidate.bid_price,
            ask_price=candidate.ask_price,
            quote_bid=candidate.quote_bid,
            quote_ask=candidate.quote_ask,
            skip_spread_check=True,
            min_spread_bps=min_spread,
            maker_size_fraction=self.pulse_size_fraction,
        )

    async def _start_price_ref(self) -> None:
        """Start the external (Binance) price reference for ALL watched symbols so
        portfolio/PnL valuation is glitch-proof — independent of momentum being on.
        The WBTC/WETH DEX book is prone to 2x glitches that otherwise corrupt PnL."""
        bot = self.bot
        if self.price_ref is not None or not bool(bot.cfg.get("price_ref_enabled", True)):
            return
        try:
            import os
            from price_ref import BinancePriceRef, build_map

            mapping = build_map(
                list(bot.watch_symbols), bot.markets_registry,
                overrides=bot.cfg.get("price_ref_map"),
            )
            if not mapping:
                return
            cg_key = os.getenv(bot.cfg.get("coinglass_api_key_env", "COINGLASS_API_KEY"))
            self.price_ref = BinancePriceRef(
                mapping,
                refresh_sec=float(bot.cfg.get("price_ref_refresh_sec", 5)),
                history_sec=float(bot.cfg.get("global_momentum_lookback_sec", 180)) + 120,
                coinglass_api_key=cg_key,
            )
            await self.price_ref.start()
            bot._price_ref = self.price_ref  # used by portfolio valuation (glitch-proof PnL)
            logger.info(
                f"Price reference enabled (Binance): {mapping} "
                f"coinglass={'on' if cg_key else 'off'}"
            )
        except Exception as exc:
            logger.warning(f"Price reference unavailable: {exc}")
            self.price_ref = None

    async def _start_momentum(self) -> None:
        if not self.momentum_pairs:
            return
        bot = self.bot
        try:
            from ws_trades import TradesFeed
            from strategies.momentum import MomentumStrategy

            ws_url = bot.cfg.get("ws_url", "wss://api.dreamdex.io/v0/ws/public")
            window = float(bot.cfg.get("momentum_window_sec", 45))
            self.trades_feed = TradesFeed(self.momentum_pairs, ws_url=ws_url, window_sec=max(60.0, window))
            await self.trades_feed.start()

            self.momentum = MomentumStrategy(
                bot, trades_feed=self.trades_feed, price_ref=self.price_ref
            )
            logger.info(
                f"Momentum overlay enabled: pairs={self.momentum_pairs} "
                f"tp={self.momentum.tp_bps}bps stop={self.momentum.stop_bps}bps "
                f"size={self.momentum.size_fraction} cap={self.momentum.max_usdso}USDso "
                f"global_entry={self.momentum.global_entry_bps}bps"
            )
        except Exception as exc:
            logger.warning(f"Momentum overlay unavailable: {exc}")
            self.trades_feed = None
            self.momentum = None

    async def _harvest_volume(self, min_spread: int) -> int:
        """Post-only round-trips on MM pairs when spread is positive-but-thin and
        inventory is balanced. Never crosses the spread => ~break-even volume."""
        if not self.harvest_enabled:
            return 0
        bot = self.bot
        acted = 0
        for symbol in self.mm_pairs:
            market = bot.markets_registry.get(symbol)
            if market is None:
                continue
            best_bid, best_ask = bot._best_prices_for(market)
            if not best_bid or not best_ask:
                continue
            spread = bot._spread_bps(best_bid, best_ask)
            if spread < self.harvest_min_spread or spread >= min_spread:
                continue
            bot._set_active_market(symbol)
            ratio = bot._inventory_ratio(best_bid, best_ask)
            if abs(ratio - 0.5) > self.harvest_max_skew:
                continue  # too skewed -> skip, don't build a position just for volume
            a = await self.hybrid.run_once(
                best_bid=best_bid,
                best_ask=best_ask,
                skip_spread_check=True,
                min_spread_bps=self.harvest_min_spread,
                maker_size_fraction=self.harvest_size,
            )
            if a:
                acted += 1
        return acted

    async def _run_mm_quotes(self, min_spread: int) -> int:
        """Keep resting vault maker quotes on MM pairs (yield harvest), independent of scanner score."""
        if not self.mm_pairs:
            return 0
        bot = self.bot
        acted = 0
        for symbol in self.mm_pairs:
            market = bot.markets_registry.get(symbol)
            if market is None:
                continue
            best_bid, best_ask = bot._best_prices_for(market)
            if not best_bid or not best_ask:
                continue
            spread = bot._spread_bps(best_bid, best_ask)
            mm_min = self.mm_min_spread_bps
            if spread < mm_min or spread > int(bot.cfg.get("max_spread_bps", 80)):
                continue
            bot._set_active_market(symbol)
            if await self.hybrid.run_once(
                best_bid=best_bid,
                best_ask=best_ask,
                skip_spread_check=True,
                min_spread_bps=min_spread,
            ):
                acted += 1
        return acted

    async def run(self) -> None:
        bot = self.bot
        logger.info(
            f"Competition mode: trade_pairs={self.trade_pairs} MM_pairs={self.mm_pairs} "
            f"scalp_pairs={self.scalp_pairs} momentum_pairs={self.momentum_pairs} "
            f"min_spread={self.min_spread_bps}bps floor={self.min_spread_floor_bps}bps "
            f"boost@{self.volume_boost_edge_bps}bps size={self.volume_boost_size_fraction}"
            + (" PRESERVE=on (no new quotes)" if self.preserve_mode else "")
        )
        bot._preflight_checks()
        bot._ensure_startup_allowances()
        bot._ensure_vault_ready(force=True)
        bot._log_inventory_reconciliation("startup")
        await self._start_price_ref()
        await self._start_momentum()
        if self.scalp_pairs:
            from strategies.scalp import ScalpStrategy
            self.scalp = ScalpStrategy(bot)
            logger.info(
                f"Scalp enabled: pairs={self.scalp_pairs} "
                f"tiers=${self.scalp.micro_size_usdso:.0f}(9-11)/"
                f"${self.scalp.small_size_usdso:.0f}(12-17)/"
                f"${self.scalp.size_usdso:.0f}(18-23)/"
                f"${self.scalp.boost_size_usdso:.0f}(24+) USDso "
                f"sell-first>={self.scalp.sell_first_ratio:.0%}"
            )

        loop_count = 0
        while True:
            loop_sleep = bot.freq_sec
            if bot.max_orders is not None and loop_count >= int(bot.max_orders):
                logger.info("Reached max_orders; stopping.")
                break

            if bot.drawdown_stop and bot._drawdown_exceeded():
                logger.error("Drawdown limit exceeded; stopping bot.")
                break

            acted_total = 0
            try:
                bot._update_pnl_metrics()

                import time as _time
                if self.reaper_enabled and (_time.time() - self._last_reap_ts) >= self.reaper_interval_sec:
                    reaped = bot._reap_stale_orders(self.reaper_max_age_sec)
                    self._last_reap_ts = _time.time()
                    if reaped:
                        logger.warning(f"Reaper freed {reaped} stale order(s) back to wallet")

                bot._ensure_vault_ready()

                idle_sec = bot.seconds_since_last_activity()
                min_spread = self._dynamic_min_spread(idle_sec)

                if self.preserve_mode:
                    self._log_competition_status(0, 0, min_spread, idle_sec)
                    loop_sleep = bot.freq_sec
                else:
                    min_score = max(8.0, self.min_pair_score - (4.0 if idle_sec >= self.idle_relax_sec else 0.0))

                    if self.watch_opportunities:
                        watch_reports = self.scanner.scan_watch()
                        if watch_reports:
                            logger.info(f"Pair watch: {self.scanner.format_watch_summary(watch_reports)}")

                    opportunities = self.scanner.scan_all(
                        min_spread_bps=min_spread, min_score=min_score, symbols=self.trade_pairs
                    )

                    if self.momentum is not None:
                        acted_total += await self.momentum.step()

                    if self.mm_enabled and self.mm_pairs:
                        acted_total += await self._run_mm_quotes(min_spread)

                    if self.scalp is not None:
                        acted_total += await self.scalp.step()

                    if opportunities:
                        for opp in opportunities:
                            bot._set_active_market(opp.symbol)
                            opp_min_spread = self._min_spread_for(opp.symbol, min_spread)
                            size_fraction = self._maker_size_for(opp.symbol, opp.edge_bps)
                            acted = await self.hybrid.run_once(
                                best_bid=opp.best_bid,
                                best_ask=opp.best_ask,
                                bid_price=opp.bid_price,
                                ask_price=opp.ask_price,
                                quote_bid=opp.quote_bid,
                                quote_ask=opp.quote_ask,
                                skip_spread_check=True,
                                min_spread_bps=opp_min_spread,
                                maker_size_fraction=size_fraction,
                            )
                            if acted:
                                acted_total += 1
                                loop_count += 1

                    elif idle_sec >= self.activity_pulse_sec:
                        if await self._activity_pulse(self.min_spread_floor_bps):
                            acted_total += 1
                            loop_count += 1

                    if acted_total == 0:
                        harvested = await self._harvest_volume(min_spread)
                        if harvested:
                            acted_total += harvested
                            loop_count += harvested

                    self._log_competition_status(acted_total, len(opportunities), min_spread, idle_sec)
                    loop_sleep = bot.min_loop_sec if acted_total else bot.freq_sec

            except Exception as exc:
                bot.metrics["errors"] += 1
                bot._save_metrics()
                logger.error(f"competition loop error: {exc}", exc_info=True)
                if "Connection" in type(exc).__name__ or "Connection" in str(exc):
                    await asyncio.sleep(60)
                    continue
                loop_sleep = bot.freq_sec

            await asyncio.sleep(max(0.5, random.uniform(loop_sleep * 0.85, loop_sleep * 1.15)))
