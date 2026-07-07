# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Momentum / order-flow strategy for thin-spread pairs (WETH, WBTC).

Long-only flow follower: when recent aggressive BUY flow + a bid-side order book
wall agree, enter a small taker long, then exit on take-profit, stop-loss, or
timeout. Designed for pairs where spread market-making does not work.

Safety:
- glitch filter (skip when spread too wide or mid jumps vs rolling median)
- hard per-position USDso cap (small live sizing)
- cumulative realized-loss kill switch that disables momentum
"""
import logging
import time
from collections import deque
from decimal import Decimal
from typing import TYPE_CHECKING, Dict, Optional

if TYPE_CHECKING:
    from executor import LiveDreamDexBot
    from ws_trades import TradesFeed
    from price_ref import BinancePriceRef

logger = logging.getLogger(__name__)


class MomentumStrategy:
    def __init__(
        self,
        bot: "LiveDreamDexBot",
        trades_feed: Optional["TradesFeed"] = None,
        price_ref: Optional["BinancePriceRef"] = None,
    ):
        self.bot = bot
        self.trades = trades_feed
        self.price_ref = price_ref
        cfg = bot.cfg
        self.pairs = list(cfg.get("momentum_pairs", []))
        self.window_sec = float(cfg.get("momentum_window_sec", 45))
        self.flow_threshold = float(cfg.get("momentum_flow_threshold_usdso", 30))
        self.min_trades = int(cfg.get("momentum_min_trades", 2))
        self.imbalance_ratio = float(cfg.get("momentum_imbalance_ratio", 0.60))
        self.size_fraction = float(cfg.get("momentum_size_fraction", 0.06))
        self.max_usdso = float(cfg.get("momentum_max_usdso", 20))
        self.tp_bps = int(cfg.get("momentum_take_profit_bps", 40))
        self.stop_bps = int(cfg.get("momentum_stop_loss_bps", 25))
        self.max_hold_sec = float(cfg.get("momentum_max_hold_sec", 300))
        self.loss_cap = float(cfg.get("momentum_loss_cap_usdso", 10))
        self.max_spread_bps = int(cfg.get("momentum_max_spread_bps", 60))
        self.slippage_bps = int(cfg.get("momentum_slippage_bps", 15))
        self.order_type = str(cfg.get("momentum_order_type", "immediateOrCancel"))
        # Global (Binance) reference params
        self.global_max_dev_pct = float(cfg.get("global_max_deviation_pct", 2.0))
        self.global_lookback_sec = float(cfg.get("global_momentum_lookback_sec", 180))
        self.global_entry_bps = int(cfg.get("global_momentum_entry_bps", 15))
        self.global_lag_entry_bps = int(cfg.get("global_lag_entry_bps", 20))

        # symbol -> position dict | None
        self._positions: Dict[str, Optional[dict]] = {p: None for p in self.pairs}
        # symbol -> rolling good mids for glitch filter
        self._mids: Dict[str, deque] = {p: deque(maxlen=15) for p in self.pairs}
        self.realized_pnl_usdso = 0.0
        self._disabled = False

    # ---------- helpers ----------
    def _quote_dec(self, symbol: str) -> int:
        return self.bot.markets_registry[symbol].quote_decimals

    def _good_mid(self, symbol: str, best_bid: int, best_ask: int) -> Optional[int]:
        """Return mid if book looks sane, else None (glitch filter)."""
        spread = self.bot._spread_bps(best_bid, best_ask)
        if spread > self.max_spread_bps:
            return None
        mid = self.bot._mid_price_raw(best_bid, best_ask)
        quote_dec = self._quote_dec(symbol)
        mid_usd = mid / (10 ** quote_dec)
        # Global reference glitch filter (definitive): reject if DEX mid is far from Binance.
        if self.price_ref is not None and self.price_ref.connected:
            dev = self.price_ref.deviation_pct(symbol, mid_usd)
            if dev is not None and dev > self.global_max_dev_pct:
                return None
        history = self._mids[symbol]
        if history:
            med = sorted(history)[len(history) // 2]
            if med > 0 and abs(mid - med) / med > 0.20:  # >20% jump => glitch
                return None
        history.append(mid)
        return mid

    def _imbalance(self, symbol: str) -> Optional[float]:
        book = self.bot._ws_multi_book
        if book is None or not book.connected:
            return None
        bid_qty, ask_qty = book.top_depth(symbol, 5)
        total = bid_qty + ask_qty
        if total <= 0:
            return None
        return bid_qty / total

    # ---------- main step ----------
    async def step(self) -> int:
        if self._disabled or not self.pairs:
            return 0
        acted = 0
        for symbol in self.pairs:
            try:
                acted += await self._step_symbol(symbol)
            except Exception as exc:
                logger.error(f"momentum {symbol} error: {exc}", exc_info=True)
        return acted

    async def _step_symbol(self, symbol: str) -> int:
        bot = self.bot
        market = bot.markets_registry.get(symbol)
        if market is None:
            return 0
        best_bid, best_ask = bot._best_prices_for(market)
        if not best_bid or not best_ask:
            return 0
        mid = self._good_mid(symbol, best_bid, best_ask)
        if mid is None:
            return 0  # glitchy book; do nothing

        position = self._positions.get(symbol)
        if position is not None:
            return await self._maybe_exit(symbol, position, best_bid, best_ask, mid)
        return await self._maybe_enter(symbol, best_bid, best_ask, mid)

    def _signal_bullish(self, symbol: str, mid: int) -> bool:
        imb = self._imbalance(symbol)
        imb_ok = imb is not None and imb >= 0.50  # book not against us

        # --- On-DEX aggressive flow + wall (original signal) ---
        flow_ok = False
        flow_desc = "flow:n/a"
        if self.trades is not None and self.trades.connected:
            flow = self.trades.recent_flow(symbol, self.window_sec)
            flow_desc = f"flow_net={flow['net_quote']:.1f} n={flow['n']}"
            if (
                flow["n"] >= self.min_trades
                and flow["net_quote"] >= self.flow_threshold
                and imb is not None and imb >= self.imbalance_ratio
            ):
                flow_ok = True

        # --- Global (Binance) momentum + lag arbitrage ---
        global_ok = False
        global_desc = "global:n/a"
        if self.price_ref is not None and self.price_ref.connected:
            mom = self.price_ref.momentum_bps(symbol, self.global_lookback_sec)
            gp = self.price_ref.global_price(symbol)
            mid_usd = mid / (10 ** self._quote_dec(symbol))
            lag_bps = None
            if gp and gp > 0:
                lag_bps = int((gp - mid_usd) * 10_000 // gp)  # +ve => DEX below global
            global_desc = f"global_mom={mom}bps lag={lag_bps}bps"
            # up-momentum with book support, OR DEX lagging a higher global price
            if mom is not None and mom >= self.global_entry_bps and imb_ok:
                global_ok = True
            elif lag_bps is not None and lag_bps >= self.global_lag_entry_bps and imb_ok:
                global_ok = True

        if flow_ok or global_ok:
            logger.info(
                f"Momentum signal {symbol}: {flow_desc} | {global_desc} | "
                f"imb={imb:.2f} (flow_ok={flow_ok} global_ok={global_ok})"
            )
            return True
        return False

    async def _maybe_enter(self, symbol: str, best_bid: int, best_ask: int, mid: int) -> int:
        bot = self.bot
        if not self._signal_bullish(symbol, mid):
            return 0
        bot._set_active_market(symbol)
        quote_dec = bot.market.quote_decimals
        usdso_bal = bot._token_balance(bot.market.quote) / (10 ** quote_dec)
        size_usdso = min(usdso_bal * self.size_fraction, self.max_usdso)
        if size_usdso < 1:
            logger.info(f"Momentum {symbol}: size too small (USDso={usdso_bal:.2f}); skip")
            return 0
        size_quote_raw = int(Decimal(str(size_usdso)) * (Decimal(10) ** quote_dec))
        price_raw = bot._price_for_order(True, best_bid, best_ask, slippage_bps=self.slippage_bps)
        qty_raw = bot._buy_quantity_from_balance(size_quote_raw, price_raw)
        if qty_raw < bot.market.min_quantity or not bot._can_afford(True, qty_raw, price_raw):
            logger.info(f"Momentum {symbol}: qty below min or unaffordable; skip")
            return 0

        approval_tx = bot._ensure_order_allowance(True, qty_raw, price_raw)
        if approval_tx:
            logger.info(f"Momentum allowance tx: {approval_tx}")
        tx_hash, ok, _ = bot._submit_order(True, qty_raw, price_raw, order_type_api=self.order_type)
        if not ok:
            logger.warning(f"Momentum {symbol} entry simulation rejected")
            return 0
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Momentum entry failed: {tx_hash}")

        entry_cost = bot._quote_cost(qty_raw, price_raw) / (10 ** quote_dec)
        self._positions[symbol] = {
            "entry_mid": mid,
            "qty_raw": qty_raw,
            "opened_ts": time.time(),
            "entry_cost_usdso": entry_cost,
        }
        bot.metrics["orders"] += 1
        bot._save_state(tx_hash)
        logger.info(
            f"Momentum LONG {symbol} qty={qty_raw} ~{size_usdso:.2f} USDso "
            f"entry_mid={mid/(10**quote_dec):.6f} tx={tx_hash[:10]}…"
        )
        return 1

    async def _maybe_exit(self, symbol: str, position: dict, best_bid: int, best_ask: int, mid: int) -> int:
        bot = self.bot
        entry_mid = position["entry_mid"]
        pnl_bps = int((mid - entry_mid) * 10_000 // max(1, entry_mid))
        held_sec = time.time() - position["opened_ts"]

        reason = None
        if pnl_bps >= self.tp_bps:
            reason = "take-profit"
        elif pnl_bps <= -self.stop_bps:
            reason = "stop-loss"
        elif held_sec >= self.max_hold_sec:
            reason = "timeout"
        if reason is None:
            return 0

        bot._set_active_market(symbol)
        quote_dec = bot.market.quote_decimals
        qty_raw = bot._align_quantity_down(min(position["qty_raw"], bot._spendable_base_balance()))
        if qty_raw < bot.market.min_quantity:
            # nothing sellable (already gone); clear position
            self._positions[symbol] = None
            return 0
        price_raw = bot._price_for_order(False, best_bid, best_ask, slippage_bps=self.slippage_bps)

        approval_tx = bot._ensure_order_allowance(False, qty_raw, price_raw)
        if approval_tx:
            logger.info(f"Momentum exit allowance tx: {approval_tx}")
        tx_hash, ok, _ = bot._submit_order(False, qty_raw, price_raw, order_type_api=self.order_type)
        if not ok:
            logger.warning(f"Momentum {symbol} exit simulation rejected")
            return 0
        if not bot.dry_run:
            receipt = bot.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status != 1:
                raise RuntimeError(f"Momentum exit failed: {tx_hash}")

        exit_value = bot._quote_cost(qty_raw, price_raw) / (10 ** quote_dec)
        trade_pnl = exit_value - position["entry_cost_usdso"]
        self.realized_pnl_usdso += trade_pnl
        self._positions[symbol] = None
        bot.metrics["orders"] += 1
        bot._save_state(tx_hash)
        logger.info(
            f"Momentum EXIT {symbol} [{reason}] pnl_bps={pnl_bps} "
            f"trade_pnl={trade_pnl:+.3f} USDso cum={self.realized_pnl_usdso:+.3f} tx={tx_hash[:10]}…"
        )

        if self.realized_pnl_usdso <= -self.loss_cap:
            self._disabled = True
            logger.error(
                f"Momentum DISABLED — cumulative loss {self.realized_pnl_usdso:.2f} "
                f"<= -{self.loss_cap} USDso kill switch"
            )
        return 1
