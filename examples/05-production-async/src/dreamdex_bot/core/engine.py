# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Trading Engine — orchestrates the bot.

Tick model: event-driven (WS updates trigger ticks) plus a 1s wall-clock fallback.

This rewrite fixes the gaps the local audit flagged:
  - Inventory is now populated at startup and updated on every fill / order event
    via InventoryTracker (gaps #1, #2).
  - Cancel-all actually signs and broadcasts each cancel tx (gap #4).
  - WS reconnect triggers a state refresh: open orders, balances, vault snapshot
    are all re-read from REST (gap #9).
  - Kill switch comment matches behavior: cancels open orders and stops; it does
    NOT auto-withdraw the vault (gap #10).
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from decimal import Decimal
from typing import Any

from web3 import Web3

from dreamdex_bot.config import MARKETS, MarketSymbol, Settings
from dreamdex_bot.core.inventory import InventoryTracker
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.risk_manager import RiskManager
from dreamdex_bot.core.signer import Signer
from dreamdex_bot.core.ws_client import WsClient
from dreamdex_bot.interfaces.risk import AccountMetrics, RiskAction, RiskEvent
from dreamdex_bot.interfaces.strategy import (
    FundingSource, MarketState, OrderIntent, OrderType, Side, SignalAction,
    TradingSignal, TradingStrategy,
)
from dreamdex_bot.utils.logger import EvidenceLog, get_logger
from dreamdex_bot.utils.markets import ensure_min_quantity, raw_to_decimal, round_to_lot, round_to_tick


log = get_logger(__name__)


class Engine:
    def __init__(
        self,
        settings: Settings,
        signer: Signer,
        rest: RestClient,
        ws: WsClient,
        strategies: list[TradingStrategy],
        risk: RiskManager,
        starting_capital_usd: Decimal,
        markets_to_watch: list[MarketSymbol],
        bootstrap_config: dict[str, Any] | None = None,
        approval_config: dict[str, Any] | None = None,
        unattended_config: dict[str, Any] | None = None,
        reporter: EvidenceLog | None = None,
        book_reconcile_config: dict[str, Any] | None = None,
    ) -> None:
        self.settings = settings
        self.signer = signer
        self.rest = rest
        self.ws = ws
        self.strategies = strategies
        self.risk = risk
        self.starting_capital_usd = starting_capital_usd
        self.markets_to_watch = markets_to_watch
        self.bootstrap_config = bootstrap_config or {}
        self.approval_config = approval_config or {}
        self.unattended_config = unattended_config or {}
        self.reporter = reporter

        self.market_state: dict[MarketSymbol, MarketState] = {}
        self._books: dict[MarketSymbol, dict[str, list[dict[str, Any]]]] = {}
        self.inventory_tracker = InventoryTracker(markets_to_watch)
        self.open_orders: dict[str, dict[str, Any]] = {}  # order_id → order details
        self.client_order_to_order_id: dict[str, str] = {}
        self.balances_loaded: bool = False
        self.failed_tx_streak = 0
        self.last_successful_tx_ts: float = time.time()
        self.paused_strategies: set[str] = set()
        self.paused_all: bool = False  # Persistent (set by KILL_SWITCH / hard PAUSE_ALL)
        self.soft_paused_all: bool = False  # Tick-scoped (e.g. OpenOrdersCapRule)
        self._stopped = False
        self._tick_event = asyncio.Event()
        self._last_balance_refresh_ts: float = 0.0
        self._balance_refresh_min_interval_sec: float = float(
            (unattended_config or {}).get("balance_refresh_min_interval_sec", 5.0)
        )
        # Phase 2 Finding 1 mitigation: the WS orderbook channel can go
        # silently stale per-symbol while other symbols keep streaming, so the
        # global ws_staleness risk rule never trips. Poll REST and replace the
        # in-memory book when the two disagree at the BBO.
        reconcile_cfg = book_reconcile_config or {}
        self._reconcile_enabled: bool = bool(reconcile_cfg.get("enabled", True))
        self._reconcile_interval_sec: float = float(reconcile_cfg.get("interval_sec", 4.0))
        self._reconcile_max_drift_bps: Decimal = Decimal(
            str(reconcile_cfg.get("max_drift_bps", "1.5"))
        )
        # Idle state reconciliation: balances refresh only after our own txs
        # and order tracking only updates from per-order WS events. If the bot
        # misses a fill/cancel event while idle, the strategy keeps believing
        # it has resting quotes and never requotes — silently stuck (observed
        # 2026-06-10: 4+ hours of book-poll-only with 0 open orders on-chain).
        # When no tx has happened for idle_after_sec, re-read balances + open
        # orders from REST and tell strategies which tracked orders vanished.
        self._idle_reconcile_after_sec: float = float(
            reconcile_cfg.get("idle_after_sec", 45.0)
        )
        self._last_idle_reconcile_ts: float = 0.0
        # Finding 11: the open-orders listing can transiently omit a live
        # order. Require an order to be missing on N consecutive polls before
        # telling the strategy to drop it, so a flaky listing can't trick us
        # into double-quoting. coid -> consecutive-miss count.
        self._order_miss_counts: dict[str, int] = {}
        self._idle_reconcile_miss_threshold: int = int(
            reconcile_cfg.get("idle_miss_threshold", 2)
        )
        self._submitted_approvals: dict[tuple[str, str], Decimal] = {}
        self._started_ts = time.time()
        self._submitted_order_count = 0
        self._safe_exit_requested = False
        self._safe_exit_reason: str | None = None
        self._safe_exit_stop_when_flat = True
        self._safe_exit_complete_reported = False
        self._drawdown_breach_count = 0
        self._drawdown_pending = False
        self._max_drawdown_handled = False

    # ────────────────────────────────────────────────────────────────
    # Setup
    # ────────────────────────────────────────────────────────────────

    async def initialize(self) -> None:
        """Bootstrap market state, balances, and open orders from REST + chain."""
        # Books
        for m in self.markets_to_watch:
            try:
                book = await self.rest.get_orderbook(m.value, depth=20)
                self._books[m] = {"bids": book.get("bids", []), "asks": book.get("asks", [])}
                self.market_state[m] = self._book_to_state(m, book)
                self._report_liquidity_snapshot(m)
            except Exception as e:
                log.error("engine.book_fetch_failed", market=m.value, error=str(e))
                self.market_state[m] = self._empty_state(m)

        # Balances (wallet ERC-20s + native + vault)
        await self._refresh_balances()

        # Open orders (in case the bot is restarting mid-session)
        await self._refresh_open_orders()

        # If competition capital arrives quote-only (USDso), acquire a small
        # base inventory before the normal buy/sell strategies start.
        await self._bootstrap_initial_inventory()

        log.info("engine.initialized",
                 markets=[m.value for m in self.markets_to_watch],
                 open_orders=len(self.open_orders))
        self._report(
            event="engine_initialized",
            category="startup",
            markets=[m.value for m in self.markets_to_watch],
            open_orders=len(self.open_orders),
        )

    def _report(self, **kwargs: Any) -> None:
        if self.reporter:
            self.reporter.record(**kwargs)

    def _report_liquidity_snapshot(self, market: MarketSymbol) -> None:
        ms = self.market_state.get(market)
        if not ms:
            return
        self._report(
            event="liquidity_snapshot",
            category="market",
            market=market.value,
            best_bid=str(ms.best_bid) if ms.best_bid is not None else None,
            best_ask=str(ms.best_ask) if ms.best_ask is not None else None,
            bid_depth_usd=str(ms.bid_depth_usd),
            ask_depth_usd=str(ms.ask_depth_usd),
            spread_bps=str(self._spread_bps(ms)) if self._spread_bps(ms) is not None else None,
        )

    async def _bootstrap_initial_inventory(self) -> None:
        cfg = self.bootstrap_config
        if not cfg.get("enabled", True):
            self._report(event="bootstrap_disabled", category="bootstrap")
            return
        if self.open_orders:
            log.info("bootstrap.skipped_open_orders", count=len(self.open_orders))
            self._report(
                event="bootstrap_skipped_open_orders",
                category="bootstrap",
                open_orders=len(self.open_orders),
            )
            return

        candidates = [
            MarketSymbol(m)
            for m in cfg.get("candidate_markets", [m.value for m in self.markets_to_watch])
            if MarketSymbol(m) in self.markets_to_watch
        ]
        if not candidates:
            log.warning("bootstrap.no_candidate_markets")
            self._report(event="bootstrap_no_candidate_markets", category="bootstrap")
            return

        min_quote = Decimal(str(cfg.get("min_quote_balance_usd", "5")))
        target_quote = Decimal(str(cfg.get("target_quote_to_spend_usd", "15")))
        max_quote_pct = Decimal(str(cfg.get("max_quote_fraction", "0.40")))
        min_base_value = Decimal(str(cfg.get("min_base_value_usd", "1")))
        reserve_quote = Decimal(str(cfg.get("reserve_quote_usd", "5")))
        max_spread_bps = Decimal(str(cfg.get("max_spread_bps", "50")))
        min_ask_depth = Decimal(str(cfg.get("min_ask_depth_usd", "5")))

        best: tuple[Decimal, MarketSymbol, Decimal, Decimal, Decimal] | None = None
        base_available_markets: list[dict[str, str]] = []
        for market in candidates:
            state = self.inventory_tracker.get(market)
            ms = self.market_state.get(market)
            if not ms or ms.best_ask is None:
                continue
            base_value = state.free_base * ms.best_ask
            if base_value >= min_base_value:
                base_available_markets.append({
                    "market": market.value,
                    "base_value_usd": str(base_value),
                })
                log.info(
                    "bootstrap.skipped_base_already_available",
                    market=market.value, base_value_usd=str(base_value),
                )
                self._report(
                    event="bootstrap_skipped_base_already_available",
                    category="bootstrap",
                    market=market.value,
                    base_value_usd=str(base_value),
                )
                continue
            free_quote = state.free_quote
            if free_quote < min_quote:
                continue
            if free_quote <= reserve_quote:
                continue
            if ms.bid_depth_usd <= 0 or ms.ask_depth_usd < min_ask_depth:
                continue
            spread_bps = self._spread_bps(ms)
            if spread_bps is None or spread_bps > max_spread_bps:
                continue
            spend_quote = min(target_quote, free_quote * max_quote_pct, free_quote - reserve_quote)
            if spend_quote <= 0:
                continue
            qty = round_to_lot(spend_quote / ms.best_ask, market, direction="down")
            if ensure_min_quantity(qty, market) is None:
                log.info(
                    "bootstrap.candidate_too_small",
                    market=market.value,
                    spend_quote=str(spend_quote),
                    min_quantity=str(MARKETS[market].min_quantity),
                )
                self._report(
                    event="bootstrap_candidate_too_small",
                    category="bootstrap",
                    market=market.value,
                    spend_quote=str(spend_quote),
                    min_quantity=str(MARKETS[market].min_quantity),
                )
                continue
            score = ms.ask_depth_usd - spread_bps
            if best is None or score > best[0]:
                best = (score, market, spend_quote, ms.best_ask, spread_bps)

        if best is None:
            log.warning(
                "bootstrap.no_suitable_market",
                candidates=[m.value for m in candidates],
                min_quote=str(min_quote), max_spread_bps=str(max_spread_bps),
                min_ask_depth_usd=str(min_ask_depth),
            )
            self._report(
                event="bootstrap_no_suitable_market",
                category="bootstrap",
                candidates=[m.value for m in candidates],
                base_available_markets=base_available_markets,
                min_quote=str(min_quote),
                max_spread_bps=str(max_spread_bps),
                min_ask_depth_usd=str(min_ask_depth),
            )
            return

        _, market, spend_quote, limit_price, spread_bps = best
        qty = round_to_lot(spend_quote / limit_price, market, direction="down")
        qty = ensure_min_quantity(qty, market)
        if qty is None:
            log.warning(
                "bootstrap.qty_too_small",
                market=market.value, spend_quote=str(spend_quote), price=str(limit_price),
            )
            self._report(
                event="bootstrap_qty_too_small",
                category="bootstrap",
                market=market.value,
                spend_quote=str(spend_quote),
                price=str(limit_price),
            )
            return

        order = OrderIntent(
            market=market,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=qty,
            price=limit_price,
            funding=FundingSource.WALLET,
            client_order_id=f"bootstrap-buy-{int(time.time())}",
            reason="bootstrap quote-only USDso into base inventory",
        )
        log.info(
            "bootstrap.buying_base",
            market=market.value, qty=str(qty), price=str(limit_price),
            spend_quote=str(qty * limit_price), spread_bps=str(spread_bps),
        )
        self._report(
            event="bootstrap_buying_base",
            category="bootstrap",
            market=market.value,
            qty=str(qty),
            price=str(limit_price),
            spend_quote=str(qty * limit_price),
            spread_bps=str(spread_bps),
        )
        tx_hash = await self._place_order("bootstrap", order, wait_for_receipt=True)
        if tx_hash:
            await self._refresh_balances()

    def _spread_bps(self, ms: MarketState) -> Decimal | None:
        if ms.best_bid is None or ms.best_ask is None:
            return None
        mid = (ms.best_bid + ms.best_ask) / 2
        if mid <= 0:
            return None
        return (ms.best_ask - ms.best_bid) / mid * Decimal("10000")

    def register_ws_handlers(self) -> None:
        """Wire WS channels to engine handlers."""
        for m in self.markets_to_watch:
            self.ws.subscribe(f"orderbook.{m.value}", self._on_book_update)
            self.ws.subscribe(f"trades.{m.value}", self._on_trade)
        self.ws.on_reconnect(self._on_ws_reconnect)

    async def _on_ws_reconnect(self) -> None:
        """When WS reconnects, our local view of orders / balances may be stale.
        Re-fetch from REST so we're aligned with chain state before resuming."""
        log.warning("engine.ws_reconnect_refresh")
        try:
            await self._refresh_open_orders()
            await self._refresh_balances()
            self._tick_event.set()
        except Exception as e:
            log.error("engine.reconcile_failed", error=str(e))

    # ────────────────────────────────────────────────────────────────
    # State refresh (initial + post-reconnect)
    # ────────────────────────────────────────────────────────────────

    async def _refresh_balances(self) -> None:
        """Re-read wallet + vault balances from chain for each market.

        For the testnet shakedown this can be approximated by fetching account
        balances from the REST API (/v0/accounts/{address}/balances if it
        exists). When that endpoint is unavailable or the addresses are not
        confirmed, we fall back to ERC-20 balanceOf via web3 — but that requires
        the ERC-20 ABI. To keep the bot startable without ABIs, we attempt the
        REST path first and log a warning if balances stay at zero.
        """
        try:
            # Hypothetical REST endpoint — the dreamDEX team may publish
            # this under /v0/accounts or /v0/vault depending on final API.
            # If 404, RestClient returns {}, which we treat as unknown balances.
            balances = await self.rest.get_account_balances(
                self.signer.address,
                markets=[m.value for m in self.markets_to_watch],
            )
        except Exception as e:
            log.warning("engine.balance_fetch_failed", error=str(e),
                        note="Balances remain unconfirmed. Balance-dependent risk rules are gated.")
            self.balances_loaded = False
            return

        watched_symbols = {m.value for m in self.markets_to_watch}
        self.balances_loaded = any(symbol in balances for symbol in watched_symbols)
        if not self.balances_loaded:
            log.warning(
                "engine.balances_unconfirmed",
                markets=sorted(watched_symbols),
                note="Balance endpoint returned no watched market balances. "
                     "Strategies will idle on zero balances; drawdown/loss kill rules are gated.",
            )

        async def _fetch_market_balances(m):
            spec = MARKETS[m]
            wallet_base, wallet_quote = await asyncio.gather(
                self._wallet_token_balance(
                    token=self.settings.base_token(m),
                    decimals=spec.base_decimals,
                    is_native=spec.is_base_native,
                ),
                self._wallet_token_balance(
                    token=self.settings.quote_token(m),
                    decimals=spec.quote_decimals,
                    is_native=False,
                ),
            )
            vault_base = Decimal(str(balances.get(spec.symbol.value, {}).get("vaultBase", "0")))
            vault_quote = Decimal(str(balances.get(spec.symbol.value, {}).get("vaultQuote", "0")))
            return m, wallet_base, wallet_quote, vault_base, vault_quote

        results = await asyncio.gather(
            *(_fetch_market_balances(m) for m in self.markets_to_watch),
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, BaseException):
                log.warning("engine.balance_fetch_failed", error=str(r),
                            note="Balances default to zero. Strategies relying on free balance will idle.")
                continue
            m, wallet_base, wallet_quote, vault_base, vault_quote = r
            if wallet_base > 0 or wallet_quote > 0 or vault_base > 0 or vault_quote > 0:
                self.balances_loaded = True
            self.inventory_tracker.set_initial_balances(
                m, wallet_base, wallet_quote, vault_base, vault_quote,
            )

    async def _wallet_token_balance(self, token: str, decimals: int, is_native: bool) -> Decimal:
        if is_native:
            raw = await self.signer.w3.eth.get_balance(self.signer.address)
            return raw_to_decimal(int(raw), decimals)
        if not token:
            return Decimal(0)
        addr = self.signer.address.lower().removeprefix("0x").rjust(64, "0")
        data = "0x70a08231" + addr
        raw_bytes = await self.signer.w3.eth.call({
            "to": Web3.to_checksum_address(token),
            "data": data,
        })
        raw_hex = raw_bytes.hex() if hasattr(raw_bytes, "hex") else str(raw_bytes)
        raw_int = int(raw_hex, 16) if raw_hex not in {"0x", ""} else 0
        return raw_to_decimal(raw_int, decimals)

    async def _refresh_open_orders(self) -> None:
        """Re-fetch the list of our open orders. Re-lock the funds they reserve."""
        try:
            orders = await self.rest.get_my_orders(markets=[m.value for m in self.markets_to_watch])
        except Exception as e:
            log.warning("engine.orders_fetch_failed", error=str(e))
            return

        # Clear locks and rebuild from fresh data
        for m in self.markets_to_watch:
            st = self.inventory_tracker.get(m)
            st.base_locked_in_orders = Decimal(0)
            st.quote_locked_in_orders = Decimal(0)

        self.open_orders = {}
        self.client_order_to_order_id = {}
        for o in orders:
            order_id = o.get("orderId") or o.get("id")
            if not order_id:
                continue
            order_id = str(order_id)
            self.open_orders[order_id] = o
            client_order_id = self._client_order_id(o)
            if client_order_id:
                self.client_order_to_order_id[client_order_id] = order_id
            try:
                m = MarketSymbol(o["market"])
                side = Side(o["side"].lower())
                remaining = Decimal(str(o.get("remainingQuantity", o.get("quantity", "0"))))
                price = Decimal(str(o["price"]))
                self.inventory_tracker.on_order_placed(m, side, remaining, price)
            except (ValueError, KeyError) as e:
                log.warning("engine.order_parse_failed", order=o, error=str(e))

    # ────────────────────────────────────────────────────────────────
    # WS handlers
    # ────────────────────────────────────────────────────────────────

    async def _on_book_update(self, data: dict[str, Any]) -> None:
        try:
            market = MarketSymbol(data.get("symbol") or data.get("market", ""))
        except ValueError:
            return
        if market not in self.market_state:
            return
        msg_type = str(data.get("type", "snapshot")).lower()
        if msg_type == "update":
            book = self._merge_book_update(market, data)
        else:
            book = {"bids": data.get("bids", []), "asks": data.get("asks", [])}
            self._books[market] = book
        self.market_state[market] = self._book_to_state(market, book)
        self._tick_event.set()

    async def _on_trade(self, data: dict[str, Any]) -> None:
        try:
            market = MarketSymbol(data.get("symbol") or data.get("market", ""))
        except ValueError:
            return
        if market in self.market_state:
            price = data.get("price")
            if price is not None:
                self.market_state[market].last_trade_price = Decimal(str(price))

    def _merge_book_update(self, market: MarketSymbol, update: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        current = self._books.setdefault(market, {"bids": [], "asks": []})

        def merge_side(side: str, reverse: bool) -> None:
            levels = {Decimal(str(level["price"])): dict(level) for level in current.get(side, [])}
            for level in update.get(side, []) or []:
                price = Decimal(str(level["price"]))
                quantity = Decimal(str(level["quantity"]))
                if quantity == 0:
                    levels.pop(price, None)
                else:
                    levels[price] = dict(level)
            current[side] = [
                levels[p] for p in sorted(levels.keys(), reverse=reverse)
            ]

        merge_side("bids", reverse=True)
        merge_side("asks", reverse=False)
        return current

    async def _on_my_order_update(self, data: dict[str, Any]) -> None:
        """An order's status changed (resting, partial, filled, cancelled, expired, rejected)."""
        raw_order_id = data.get("orderId") or data.get("id", "")
        client_order_id = self._client_order_id(data)
        order_id = str(raw_order_id or self.client_order_to_order_id.get(client_order_id or "", ""))
        status = (data.get("status") or "").lower()
        if not order_id:
            return
        if client_order_id:
            self.client_order_to_order_id[client_order_id] = order_id

        terminal_statuses = {"cancelled", "canceled", "expired", "rejected", "filled", "closed"}
        if status in terminal_statuses:
            old = self.open_orders.pop(order_id, None)
            if client_order_id:
                self.client_order_to_order_id.pop(client_order_id, None)
            if old:
                # Free locks for the unfilled remainder
                try:
                    m = MarketSymbol(old.get("market", ""))
                    side = Side(old.get("side", "").lower())
                    remaining = Decimal(str(data.get("remainingQuantity", old.get("remainingQuantity", "0"))))
                    price = Decimal(str(old.get("price", "0")))
                    self.inventory_tracker.on_order_cancelled(m, side, remaining, price)
                except (ValueError, KeyError):
                    pass
            if status == "rejected":
                reject_id = client_order_id or order_id
                for strat in self.strategies:
                    await strat.on_reject(reject_id, data.get("reason", ""))
            await self._unsubscribe_order_updates(order_id)
        else:
            self.open_orders[order_id] = {**self.open_orders.get(order_id, {}), **data}
        self._tick_event.set()

    async def _subscribe_order_updates(self, order_id: str, order: Any) -> None:
        subscribe_order = getattr(self.ws, "subscribe_order", None)
        if not callable(subscribe_order):
            return
        try:
            await subscribe_order(order_id, self._on_my_order_update)
            self._report(
                event="order_ws_subscribed",
                category="ws",
                market=order.market.value,
                order_id=order_id,
                client_order_id=order.client_order_id,
            )
        except Exception as e:
            log.warning("engine.order_ws_subscribe_failed", order_id=order_id, error=str(e))
            self._report(
                event="order_ws_subscribe_failed",
                category="ws",
                market=order.market.value,
                order_id=order_id,
                client_order_id=order.client_order_id,
                error=str(e),
            )

    async def _unsubscribe_order_updates(self, order_id: str) -> None:
        unsubscribe_order = getattr(self.ws, "unsubscribe_order", None)
        if not callable(unsubscribe_order):
            return
        try:
            await unsubscribe_order(order_id)
            self._report(
                event="order_ws_unsubscribed",
                category="ws",
                order_id=order_id,
            )
        except Exception as e:
            log.warning("engine.order_ws_unsubscribe_failed", order_id=order_id, error=str(e))
            self._report(
                event="order_ws_unsubscribe_failed",
                category="ws",
                order_id=order_id,
                error=str(e),
            )

    def _client_order_id(self, order: dict[str, Any]) -> str | None:
        client_order_id = (
            order.get("clientOrderId")
            or order.get("client_order_id")
            or order.get("clientId")
            or order.get("client_id")
        )
        return str(client_order_id) if client_order_id else None

    async def _on_my_fill(self, data: dict[str, Any]) -> None:
        """A fill against one of our orders."""
        try:
            market = MarketSymbol(data.get("market", ""))
            side = Side(data.get("side", "").lower())
            qty = Decimal(str(data["quantity"]))
            price = Decimal(str(data["price"]))
            funding = data.get("funding", "vault")
            is_maker = bool(data.get("isMaker", True))
        except (ValueError, KeyError) as e:
            log.warning("engine.fill_parse_failed", fill=data, error=str(e))
            return

        self.inventory_tracker.on_fill(market, side, qty, price, funding, is_maker)
        self._report(
            event="fill",
            category="trade",
            market=market.value,
            side=side.value,
            quantity=str(qty),
            price=str(price),
            notional=str(qty * price),
            funding=funding,
            is_maker=is_maker,
        )

        log.info("engine.fill",
                 market=market.value, side=side.value,
                 qty=str(qty), price=str(price), is_maker=is_maker)
        for strat in self.strategies:
            await strat.on_fill(data)
        self._tick_event.set()

    def _book_to_state(self, market: MarketSymbol, book: dict[str, Any]) -> MarketState:
        bids = book.get("bids", [])
        asks = book.get("asks", [])
        best_bid = Decimal(str(bids[0]["price"])) if bids else None
        best_ask = Decimal(str(asks[0]["price"])) if asks else None
        mid = (best_bid + best_ask) / 2 if (best_bid and best_ask) else None

        def depth_usd(levels: list[dict[str, Any]], n: int = 5) -> Decimal:
            total = Decimal(0)
            for l in levels[:n]:
                total += Decimal(str(l["price"])) * Decimal(str(l["quantity"]))
            return total

        return MarketState(
            market=market,
            best_bid=best_bid, best_ask=best_ask, mid=mid,
            bid_depth_usd=depth_usd(bids), ask_depth_usd=depth_usd(asks),
            last_trade_price=None, volatility_5m=None, ts=time.time(),
        )

    def _empty_state(self, market: MarketSymbol) -> MarketState:
        return MarketState(
            market=market, best_bid=None, best_ask=None, mid=None,
            bid_depth_usd=Decimal(0), ask_depth_usd=Decimal(0),
            last_trade_price=None, volatility_5m=None, ts=time.time(),
        )

    # ────────────────────────────────────────────────────────────────
    # REST book reconciliation (Phase 2 Finding 1 mitigation)
    # ────────────────────────────────────────────────────────────────

    def _bbo_drift_bps(
        self, ws_state: MarketState | None, rest_state: MarketState,
    ) -> Decimal | None:
        """Worst-case BBO disagreement between WS and REST views, in bps of
        the REST mid. None means the WS view is missing a side REST has —
        treat that as unconditionally stale."""
        if rest_state.mid is None or rest_state.mid <= 0:
            return Decimal("0")  # REST book empty/one-sided: nothing to compare
        if (
            ws_state is None
            or ws_state.best_bid is None or ws_state.best_ask is None
            or rest_state.best_bid is None or rest_state.best_ask is None
        ):
            return None
        bid_drift = abs(ws_state.best_bid - rest_state.best_bid)
        ask_drift = abs(ws_state.best_ask - rest_state.best_ask)
        return max(bid_drift, ask_drift) / rest_state.mid * Decimal("10000")

    async def _rest_book_reconcile_loop(self) -> None:
        while not self._stopped:
            for m in self.markets_to_watch:
                if self._stopped:
                    return
                try:
                    book = await self.rest.get_orderbook(m.value, depth=20)
                except Exception as e:
                    log.warning("engine.book_reconcile_fetch_failed",
                                market=m.value, error=str(e))
                    continue
                rest_state = self._book_to_state(m, book)
                drift = self._bbo_drift_bps(self.market_state.get(m), rest_state)
                if drift is not None and drift <= self._reconcile_max_drift_bps:
                    continue
                self._books[m] = {
                    "bids": book.get("bids", []), "asks": book.get("asks", []),
                }
                self.market_state[m] = rest_state
                log.warning(
                    "engine.ws_book_stale_replaced",
                    market=m.value,
                    drift_bps=str(drift) if drift is not None else "ws_side_missing",
                    max_drift_bps=str(self._reconcile_max_drift_bps),
                )
                self._report(
                    event="ws_book_stale_replaced",
                    category="market_data",
                    market=m.value,
                    drift_bps=str(drift) if drift is not None else "ws_side_missing",
                )
                self._tick_event.set()
            await self._maybe_idle_reconcile()
            await asyncio.sleep(self._reconcile_interval_sec)

    async def _maybe_idle_reconcile(self) -> None:
        """When the bot has been idle (no tx) for a while, re-read balances and
        open orders from REST and clear strategy quote-tracking for orders that
        have vanished. This is the recovery path for a missed fill/cancel WS
        event, which otherwise leaves a strategy believing it is quoting when
        it holds nothing on the book."""
        if self._idle_reconcile_after_sec <= 0:
            return
        now = time.time()
        idle_for = now - self.last_successful_tx_ts
        if idle_for < self._idle_reconcile_after_sec:
            return
        if now - self._last_idle_reconcile_ts < self._idle_reconcile_after_sec:
            return
        self._last_idle_reconcile_ts = now

        try:
            await self._refresh_balances()
            await self._refresh_open_orders()
        except Exception as e:
            log.warning("engine.idle_reconcile_failed", error=str(e))
            return

        live_coids = set(self.client_order_to_order_id.keys())
        # Drop miss-counts for orders that came back so a recovered listing
        # resets the confirmation counter.
        for coid in list(self._order_miss_counts.keys()):
            if coid in live_coids:
                del self._order_miss_counts[coid]

        cleared = 0
        for strat in self.strategies:
            for coid in strat.tracked_client_order_ids():
                if coid in live_coids:
                    continue
                # Finding 11: confirm the order is missing on consecutive
                # polls before acting, so a transient listing gap doesn't
                # clear a genuinely-resting quote.
                self._order_miss_counts[coid] = self._order_miss_counts.get(coid, 0) + 1
                if self._order_miss_counts[coid] < self._idle_reconcile_miss_threshold:
                    continue
                self._order_miss_counts.pop(coid, None)
                await self._notify_reject(strat.name, coid, "idle_reconcile_vanished")
                cleared += 1

        if cleared:
            log.warning("engine.idle_reconcile_cleared_stale_quotes",
                        idle_for_sec=f"{idle_for:.0f}", cleared=cleared)
            self._report(
                event="idle_reconcile_cleared_stale_quotes",
                category="market_data",
                cleared=cleared,
            )
            self._tick_event.set()

    # ────────────────────────────────────────────────────────────────
    # Main tick loop
    # ────────────────────────────────────────────────────────────────

    async def run(self) -> None:
        log.info("engine.starting")
        reconcile_task: asyncio.Task[None] | None = None
        if self._reconcile_enabled:
            reconcile_task = asyncio.create_task(self._rest_book_reconcile_loop())
            log.info("engine.book_reconcile_started",
                     interval_sec=self._reconcile_interval_sec,
                     max_drift_bps=str(self._reconcile_max_drift_bps))
        try:
            while not self._stopped:
                try:
                    await asyncio.wait_for(self._tick_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
                self._tick_event.clear()
                try:
                    self._check_unattended_limits()
                    await self._tick()
                except Exception as e:
                    log.error("engine.tick_failed", error=str(e))
        finally:
            if reconcile_task is not None:
                reconcile_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await reconcile_task

    async def _tick(self) -> None:
        # Reset tick-scoped soft pauses; persistent pauses (paused_all from
        # KILL_SWITCH) remain set across ticks.
        self.soft_paused_all = False

        # 1. Strategy view of inventory (with unrealized PnL filled in)
        mark_prices = {m: ms.mid for m, ms in self.market_state.items() if ms.mid is not None}
        strategy_inventory = self.inventory_tracker.to_strategy_view(mark_prices)

        # 2. Compute account metrics
        metrics = self._compute_metrics(strategy_inventory)

        # 3. Risk evaluation
        risk_events = self.risk.evaluate(self.market_state, strategy_inventory, metrics)
        risk_events = self._confirm_drawdown_events(risk_events)
        if risk_events and not self.balances_loaded:
            gated_rules = {"realized_loss", "max_drawdown"}
            gated = [ev for ev in risk_events if ev.rule_name in gated_rules]
            risk_events = [ev for ev in risk_events if ev.rule_name not in gated_rules]
            for ev in gated:
                log.warning(
                    "risk.event_gated_until_balances_loaded",
                    rule=ev.rule_name, action=ev.action.value, reason=ev.reason,
                )
                self._report(
                    event="risk_event_gated",
                    category="risk",
                    rule=ev.rule_name,
                    action=ev.action.value,
                    reason=ev.reason,
                )
        if risk_events:
            await self._handle_risk_events(risk_events)

        if self._safe_exit_requested:
            await self._flatten_erc20_inventory()
            if not self._has_tradable_erc20_inventory():
                if not self._safe_exit_complete_reported:
                    log.warning("engine.safe_exit_complete", reason=self._safe_exit_reason)
                    self._report(
                        event="safe_exit_complete",
                        category="safety",
                        reason=self._safe_exit_reason,
                    )
                    self._safe_exit_complete_reported = True
                if self._safe_exit_stop_when_flat:
                    self.stop()
            return

        if self.paused_all or self.soft_paused_all or self._stopped:
            return

        # 4. Run each enabled, unpaused strategy
        tick_quote_reserved_by_token: dict[str, Decimal] = {}
        tick_base_reserved_by_token: dict[str, Decimal] = {}
        for strat in self.strategies:
            if not strat.enabled or strat.name in self.paused_strategies:
                continue
            try:
                signals = await strat.generate_signals(self.market_state, strategy_inventory)
            except Exception as e:
                log.error("engine.strategy_failed", strategy=strat.name, error=str(e))
                continue
            if not signals:
                skip_reason = getattr(strat, "last_skip_reason", None)
                if skip_reason:
                    self._report(
                        event="strategy_skipped",
                        category="strategy",
                        strategy=strat.name,
                        reason=skip_reason,
                    )
            for sig in signals:
                if not self._reserve_tick_balance(
                    sig, tick_quote_reserved_by_token, tick_base_reserved_by_token,
                ):
                    continue
                await self._execute_signal(strat.name, sig)

    def _reserve_tick_balance(
        self,
        signal: TradingSignal,
        quote_reserved_by_token: dict[str, Decimal],
        base_reserved_by_token: dict[str, Decimal],
    ) -> bool:
        order = signal.order
        if signal.action != SignalAction.PLACE or order is None:
            return True
        if order.funding != FundingSource.WALLET:
            return True

        state = self.inventory_tracker.get(order.market)
        if order.side == Side.BUY:
            if order.price is None:
                return True
            token = self.settings.quote_token(order.market).lower()
            needed = order.quantity * order.price
            reserved = quote_reserved_by_token.get(token, Decimal(0))
            reason = self._buy_block_reason(projected_quote_spend=needed + reserved)
            if reason is not None:
                log.warning(
                    "engine.buy_blocked",
                    market=order.market.value, coid=order.client_order_id, reason=reason,
                )
                self._report(
                    event="buy_blocked",
                    category="safety",
                    market=order.market.value,
                    client_order_id=order.client_order_id,
                    reason=reason,
                )
                return False
            available = state.free_quote - reserved
            if needed > available:
                log.warning(
                    "engine.tick_order_skipped_insufficient_quote",
                    market=order.market.value, coid=order.client_order_id,
                    needed=str(needed), available=str(available),
                )
                self._report(
                    event="order_skipped_insufficient_quote",
                    category="order",
                    market=order.market.value,
                    client_order_id=order.client_order_id,
                    needed=str(needed),
                    available=str(available),
                )
                return False
            quote_reserved_by_token[token] = quote_reserved_by_token.get(token, Decimal(0)) + needed
            return True

        token = self.settings.base_token(order.market).lower()
        needed = order.quantity
        available = state.free_base - base_reserved_by_token.get(token, Decimal(0))
        if needed > available:
            log.warning(
                "engine.tick_order_skipped_insufficient_base",
                market=order.market.value, coid=order.client_order_id,
                needed=str(needed), available=str(available),
            )
            self._report(
                event="order_skipped_insufficient_base",
                category="order",
                market=order.market.value,
                client_order_id=order.client_order_id,
                needed=str(needed),
                available=str(available),
            )
            return False
        base_reserved_by_token[token] = base_reserved_by_token.get(token, Decimal(0)) + needed
        return True

    def _compute_metrics(self, inv_view: dict[MarketSymbol, Any]) -> AccountMetrics:
        total_value = Decimal(0)
        wallet_quote_by_token: dict[str, Decimal] = {}
        for m, state in self.inventory_tracker.states.items():
            mark = self.market_state.get(m)
            mark_price = mark.mid if mark and mark.mid else Decimal(1)
            total_value += (state.wallet_base + state.vault_base) * mark_price
            total_value += state.vault_quote
            quote_token = self.settings.quote_token(m).lower()
            wallet_quote_by_token[quote_token] = max(
                wallet_quote_by_token.get(quote_token, Decimal(0)),
                state.wallet_quote,
            )
        total_value += sum(wallet_quote_by_token.values(), Decimal(0))
        # Collateral locked in resting orders is pulled into the pool
        # contract at placement and is invisible to wallet AND vault balance
        # reads. Count it, or a requote window (new bid placed before the
        # old bid's cancel refund lands) reads as a capital loss — observed
        # live 2026-06-10 as a phantom -90% drawdown that tripped the kill
        # switch while all funds were safely locked in two resting bids.
        for order in self.open_orders.values():
            try:
                market = MarketSymbol(str(order.get("market") or order.get("symbol", "")))
            except ValueError:
                continue
            remaining = Decimal(str(
                order.get("remainingQuantity", order.get("quantity", "0")) or "0"
            ))
            if remaining <= 0:
                continue
            side = str(order.get("side", "")).lower()
            if side == "buy":
                price = Decimal(str(order.get("price", "0") or "0"))
                total_value += remaining * price
            elif side == "sell":
                mark = self.market_state.get(market)
                if mark is not None and mark.mid:
                    total_value += remaining * mark.mid
        realized = sum((inv.realized_pnl_usd for inv in inv_view.values()), Decimal(0))
        unrealized = sum((inv.unrealized_pnl_usd for inv in inv_view.values()), Decimal(0))
        drawdown = ((total_value - self.starting_capital_usd) / self.starting_capital_usd * 100
                    if self.starting_capital_usd > 0 else Decimal(0))
        return AccountMetrics(
            total_value_usd=total_value,
            realized_pnl_usd=realized, unrealized_pnl_usd=unrealized,
            starting_capital_usd=self.starting_capital_usd,
            drawdown_pct=drawdown,
            open_order_count=len(self.open_orders),
            failed_tx_streak=self.failed_tx_streak,
            last_successful_tx_ts=self.last_successful_tx_ts,
            ws_last_message_ts=self.ws.last_message_ts,
        )

    def _confirm_drawdown_events(self, events: list[RiskEvent]) -> list[RiskEvent]:
        drawdown_events = [ev for ev in events if ev.rule_name == "max_drawdown"]
        if self._max_drawdown_handled:
            return [ev for ev in events if ev.rule_name != "max_drawdown"]
        if not drawdown_events:
            self._drawdown_breach_count = 0
            self._drawdown_pending = False
            return events
        self._drawdown_pending = True
        self._drawdown_breach_count += 1
        required = int(self.unattended_config.get("drawdown_confirmations", 3))
        if self._drawdown_breach_count >= required:
            return events
        for ev in drawdown_events:
            log.warning(
                "risk.drawdown_pending_confirmation",
                count=self._drawdown_breach_count, required=required, reason=ev.reason,
            )
        return [ev for ev in events if ev.rule_name != "max_drawdown"]

    def _check_unattended_limits(self) -> None:
        if self._safe_exit_requested:
            return
        max_runtime_sec = float(self.unattended_config.get("max_runtime_sec", 0))
        if max_runtime_sec > 0 and time.time() - self._started_ts >= max_runtime_sec:
            self._request_safe_exit("max_runtime_reached")
            return
        max_orders = int(self.unattended_config.get("max_submitted_orders", 0))
        if max_orders > 0 and self._submitted_order_count >= max_orders:
            self._request_safe_exit("max_submitted_orders_reached")

    def _request_safe_exit(self, reason: str, *, stop_when_flat: bool = True) -> None:
        if self._safe_exit_requested:
            return
        self._safe_exit_requested = True
        self._safe_exit_reason = reason
        self._safe_exit_stop_when_flat = stop_when_flat
        self._safe_exit_complete_reported = False
        log.warning("engine.safe_exit_requested", reason=reason)
        self._report(event="safe_exit_requested", category="safety", reason=reason)
        self._tick_event.set()

    def request_safe_exit(self, reason: str) -> None:
        self._request_safe_exit(reason)

    def _buy_block_reason(self, projected_quote_spend: Decimal = Decimal(0)) -> str | None:
        if self._safe_exit_requested:
            return self._safe_exit_reason or "safe_exit_requested"
        if self._drawdown_pending:
            return "drawdown_pending_confirmation"
        native_floor = Decimal(str(self.unattended_config.get("min_native_somi", "0")))
        native_state = self.inventory_tracker.states.get(MarketSymbol.SOMI_USDSO)
        if native_floor > 0 and native_state and native_state.wallet_base < native_floor:
            return f"native_somi_below_floor:{native_state.wallet_base}<{native_floor}"
        quote_floor = Decimal(str(self.unattended_config.get("min_liquid_usdso", "0")))
        wallet_quote = max(
            (state.wallet_quote for state in self.inventory_tracker.states.values()),
            default=Decimal(0),
        )
        projected_quote = wallet_quote - projected_quote_spend
        if quote_floor > 0 and projected_quote < quote_floor:
            return (
                f"projected_liquid_usdso_below_floor:"
                f"{wallet_quote}-{projected_quote_spend}={projected_quote}<{quote_floor}"
            )
        return None

    def _has_tradable_erc20_inventory(self) -> bool:
        for market, state in self.inventory_tracker.states.items():
            if MARKETS[market].is_base_native:
                continue
            if ensure_min_quantity(state.free_base, market) is not None:
                return True
        return False

    async def _flatten_erc20_inventory(self) -> None:
        for market, state in self.inventory_tracker.states.items():
            if MARKETS[market].is_base_native:
                continue
            ms = self.market_state.get(market)
            if ms is None or ms.best_bid is None or ms.bid_depth_usd <= 0:
                continue
            qty = round_to_lot(state.free_base, market, direction="down")
            qty = ensure_min_quantity(qty, market)
            if qty is None:
                continue
            price = round_to_tick(ms.best_bid * Decimal("0.9995"), market, direction="down")
            await self._place_order(
                "safe_exit",
                OrderIntent(
                    market=market,
                    side=Side.SELL,
                    order_type=OrderType.IOC,
                    quantity=qty,
                    price=price,
                    funding=FundingSource.WALLET,
                    client_order_id=f"safe_exit_{market.value}_{int(time.time())}",
                    reason=f"safe exit: {self._safe_exit_reason}",
                ),
            )

    async def _handle_risk_events(self, events: list[RiskEvent]) -> None:
        for ev in events:
            log.warning("risk.event_fired",
                        rule=ev.rule_name, action=ev.action.value,
                        severity=ev.severity.value, reason=ev.reason)
            self._report(
                event="risk_event_fired",
                category="risk",
                rule=ev.rule_name,
                action=ev.action.value,
                severity=ev.severity.value,
                reason=ev.reason,
            )
            if ev.action == RiskAction.KILL_SWITCH:
                # Cancel all orders, then stop. Does NOT auto-withdraw the vault —
                # vault recovery is left for manual review post-shutdown.
                self.paused_all = True
                await self._cancel_all_orders()
                if ev.rule_name == "max_drawdown":
                    self._max_drawdown_handled = True
                    self._request_safe_exit("max_drawdown", stop_when_flat=False)
                else:
                    self._stopped = True
            elif ev.action == RiskAction.PAUSE_ALL:
                # OpenOrdersCapRule and a few others want to back-pressure for
                # one tick only. We identify "soft" pauses by rule_name. Anything
                # not in this set escalates to a persistent pause.
                if ev.rule_name in {"open_orders_cap"}:
                    self.soft_paused_all = True
                else:
                    self.paused_all = True
            elif ev.action == RiskAction.PAUSE_STRATEGY:
                if ev.strategy:
                    newly_paused = ev.strategy not in self.paused_strategies
                    self.paused_strategies.add(ev.strategy)
                    # A paused strategy can no longer manage its resting
                    # quotes, and the pause is sticky until restart. Leaving
                    # quotes on the book means unmanaged fills at stale
                    # prices, so cancel everything once on pause entry.
                    if newly_paused and self.open_orders:
                        log.warning(
                            "engine.pause_cancels_resting_orders",
                            strategy=ev.strategy, count=len(self.open_orders),
                        )
                        await self._cancel_all_orders()
                else:
                    # Unscoped pause → escalate to pause-all
                    self.paused_all = True
            elif ev.action == RiskAction.CANCEL_ALL_ORDERS:
                await self._cancel_all_orders()

    async def _cancel_all_orders(self) -> None:
        log.warning("engine.cancelling_all_orders", count=len(self.open_orders))
        for order_id in list(self.open_orders.keys()):
            try:
                order = self.open_orders.get(order_id, {})
                market = order.get("market") or order.get("symbol")
                if not market:
                    log.warning("engine.cancel_skipped_no_market", order_id=order_id)
                    continue
                prep = await self.rest.prepare_cancel(str(market), order_id)
                # Actually sign and broadcast the cancel tx
                tx_hash = await self.signer.send_tx(
                    to=prep["to"], data=prep["data"],
                    value=int(prep.get("value", 0)),
                    gas=int(prep.get("gasLimit", prep.get("gas", 200_000))),
                )
                log.info("engine.cancel_broadcast", order_id=order_id, tx_hash=tx_hash)
                self._report(
                    event="cancel_submitted",
                    category="order",
                    market=str(market),
                    order_id=order_id,
                    tx_hash=tx_hash,
                )
            except Exception as e:
                log.error("engine.cancel_failed", order_id=order_id, error=str(e))
                self._report(
                    event="cancel_failed",
                    category="order",
                    order_id=order_id,
                    error=str(e),
                )

    # ────────────────────────────────────────────────────────────────
    # Signal execution
    # ────────────────────────────────────────────────────────────────

    async def _execute_signal(self, strategy_name: str, signal: TradingSignal) -> None:
        try:
            if signal.action == SignalAction.PLACE and signal.order is not None:
                await self._place_order(strategy_name, signal.order)
            elif signal.action == SignalAction.CANCEL and signal.cancel is not None:
                await self._cancel_order(signal.cancel)
        except Exception as e:
            err_str = str(e)
            # F9 fix companion: "nonce too low" was already auto-recovered by
            # signer.resync_from_chain. The next acquire() will land on the
            # correct nonce. Don't count these toward failed_tx_streak — they
            # are transient races under concurrent submission, not signs of a
            # broken bot. Counting them would cause pause_all to trip during
            # normal Layer-3-style parallel operation.
            if "nonce too low" in err_str.lower():
                log.warning("engine.transient_nonce_race",
                            strategy=strategy_name, error=err_str)
            else:
                self.failed_tx_streak += 1
                log.error("engine.execute_failed",
                          strategy=strategy_name, error=err_str,
                          streak=self.failed_tx_streak)

    async def _place_order(
        self,
        strategy_name: str,
        order: Any,
        wait_for_receipt: bool = False,
    ) -> str | None:
        prep = await self.rest.prepare_order(
            market=order.market.value, side=order.side.value,
            order_type=order.order_type.value,
            quantity=str(order.quantity), price=str(order.price) if order.price else None,
            funding=order.funding.value, client_order_id=order.client_order_id,
            wallet_address=self.signer.address,
        )
        approval = prep.get("approval") if isinstance(prep, dict) else None
        approval_key: tuple[str, str] | None = None
        approval_amount = Decimal(0)
        if approval:
            approval_key, approval_amount = await self._submit_approval(order.market, approval)

        value = int(prep.get("value", 0))
        gas = await self._gas_limit_for_prepared_tx(prep, value)
        simulated_order_id: str | None = None
        try:
            success, order_id = await self.signer.simulate_order_tx(
                to=prep["to"], data=prep["data"], value=value, gas=gas,
            )
            if success is False:
                log.warning(
                    "engine.order_simulation_rejected",
                    strategy=strategy_name, coid=order.client_order_id,
                    market=order.market.value, side=order.side.value,
                )
                self._report(
                    event="order_simulation_rejected",
                    category="order",
                    strategy=strategy_name,
                    market=order.market.value,
                    side=order.side.value,
                    client_order_id=order.client_order_id,
                )
                await self._notify_reject(
                    strategy_name, order.client_order_id, "order_simulation_rejected",
                )
                return None
            if order_id:
                simulated_order_id = str(order_id)
                self.client_order_to_order_id[order.client_order_id] = simulated_order_id
        except AttributeError:
            pass
        except Exception as e:
            log.warning("engine.order_simulation_failed", error=str(e), coid=order.client_order_id)
            self._report(
                event="order_simulation_failed",
                category="order",
                strategy=strategy_name,
                market=order.market.value,
                side=order.side.value,
                client_order_id=order.client_order_id,
                error=str(e),
            )
            await self._notify_reject(
                strategy_name, order.client_order_id, "order_simulation_failed",
            )
            return None

        tx_hash = await self.signer.send_tx(
            to=prep["to"], data=prep["data"],
            value=value,
            gas=gas,
        )
        if approval_key is not None and approval_amount > 0:
            self._consume_cached_approval(approval_key, approval_amount)
        else:
            self._clear_spent_approval_cache(order)

        # Tentatively lock funds for the new resting order. The WS order-update
        # event will confirm-or-reject and adjust if needed.
        if order.order_type.value in {"gtc", "post_only"} and order.price is not None:
            self.inventory_tracker.on_order_placed(
                order.market, order.side, order.quantity, order.price,
            )
            if simulated_order_id:
                self.open_orders[simulated_order_id] = {
                    "orderId": simulated_order_id,
                    "market": order.market.value,
                    "side": order.side.value,
                    "price": str(order.price),
                    "quantity": str(order.quantity),
                    "remainingQuantity": str(order.quantity),
                    "clientOrderId": order.client_order_id,
                    "txHash": tx_hash,
                }
                await self._subscribe_order_updates(simulated_order_id, order)

        log.info("engine.order_submitted",
                 strategy=strategy_name, coid=order.client_order_id,
                 tx_hash=tx_hash, market=order.market.value, side=order.side.value)
        self._submitted_order_count += 1
        self._report(
            event="order_submitted",
            category="order",
            strategy=strategy_name,
            market=order.market.value,
            side=order.side.value,
            order_type=order.order_type.value,
            quantity=str(order.quantity),
            price=str(order.price) if order.price is not None else None,
            notional=str(order.quantity * order.price) if order.price is not None else None,
            funding=order.funding.value,
            client_order_id=order.client_order_id,
            order_id=simulated_order_id,
            tx_hash=tx_hash,
            gas=gas,
            value=value,
        )
        self.failed_tx_streak = 0
        self.last_successful_tx_ts = time.time()
        if wait_for_receipt:
            try:
                receipt = await self.signer.wait_for_receipt(tx_hash, timeout=45)
                logs_count = len(receipt.get("logs") or [])
                log.info(
                    "engine.order_confirmed",
                    strategy=strategy_name, coid=order.client_order_id,
                    tx_hash=tx_hash, status=receipt.get("status"),
                    block_number=receipt.get("blockNumber"),
                    logs_count=logs_count,
                )
                self._report(
                    event="order_confirmed",
                    category="order",
                    strategy=strategy_name,
                    market=order.market.value,
                    client_order_id=order.client_order_id,
                    tx_hash=tx_hash,
                    status=receipt.get("status"),
                    block_number=receipt.get("blockNumber"),
                    logs_count=logs_count,
                    placed=logs_count > 0,
                )
                if int(receipt.get("status", 0)) == 1 and logs_count == 0:
                    log.warning(
                        "engine.order_receipt_empty_logs",
                        strategy=strategy_name, coid=order.client_order_id,
                        tx_hash=tx_hash,
                    )
                    self._report(
                        event="order_receipt_empty_logs",
                        category="order",
                        strategy=strategy_name,
                        market=order.market.value,
                        client_order_id=order.client_order_id,
                        tx_hash=tx_hash,
                        note="Receipt status is 1, but docs say empty logs mean no OrderPlaced event.",
                    )
            except Exception as e:
                log.warning("engine.order_receipt_wait_failed", tx_hash=tx_hash, error=str(e))
                self._report(
                    event="order_receipt_wait_failed",
                    category="order",
                    strategy=strategy_name,
                    market=order.market.value,
                    client_order_id=order.client_order_id,
                    tx_hash=tx_hash,
                    error=str(e),
                )
        await self._refresh_balances_after_tx(order)
        return tx_hash

    async def _refresh_balances_after_tx(self, order: Any) -> None:
        """Debounced reconciliation after a broadcast.

        Strategies already reserve balances pessimistically within a tick. This
        refresh keeps the next ticks aligned with chain/indexed state without
        hammering RPC/REST during high-frequency IOC loops.
        """
        now = time.time()
        if now - self._last_balance_refresh_ts < self._balance_refresh_min_interval_sec:
            self._report(
                event="balance_refresh_debounced",
                category="balance",
                market=order.market.value,
                min_interval_sec=self._balance_refresh_min_interval_sec,
            )
            return
        self._last_balance_refresh_ts = now
        try:
            await self._refresh_balances()
            self._report(
                event="balance_refreshed_after_tx",
                category="balance",
                market=order.market.value,
                side=order.side.value,
            )
        except Exception as e:
            log.warning("engine.balance_refresh_after_tx_failed", error=str(e))
            self._report(
                event="balance_refresh_after_tx_failed",
                category="balance",
                market=order.market.value,
                error=str(e),
            )

    async def _gas_limit_for_prepared_tx(self, prep: dict[str, Any], value: int) -> int:
        explicit = prep.get("gasLimit", prep.get("gas"))
        if explicit is not None:
            return int(explicit)
        try:
            estimated = await self.signer.w3.eth.estimate_gas({
                "from": self.signer.address,
                "to": prep["to"],
                "data": prep["data"],
                "value": value,
            })
            gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), 500_000)
            log.info("engine.gas_estimated", estimated=int(estimated), gas=gas)
            self._report(
                event="gas_estimated",
                category="order",
                estimated=int(estimated),
                gas=gas,
            )
            return gas
        except Exception as e:
            log.warning("engine.gas_estimate_failed", error=str(e), fallback_gas=8_000_000)
            self._report(
                event="gas_estimate_failed",
                category="order",
                error=str(e),
                fallback_gas=8_000_000,
            )
            return 8_000_000

    async def _submit_approval(
        self,
        market: MarketSymbol,
        approval: dict[str, Any],
    ) -> tuple[tuple[str, str] | None, Decimal]:
        token = str(approval.get("token", "")).lower()
        amount = str(approval.get("amount", "0"))
        required_amount = Decimal(amount)
        base_code, quote_code = market.value.split(":", 1)
        if token == self.settings.base_token(market).lower():
            currency = base_code
        elif token == self.settings.quote_token(market).lower():
            currency = quote_code
        else:
            log.warning("engine.approval_unknown_token", market=market.value, token=approval.get("token"))
            return None, Decimal(0)
        approval_key = (market.value, currency)
        cached_amount = self._submitted_approvals.get(approval_key, Decimal(0))
        if cached_amount >= required_amount:
            log.info("engine.approval_skipped_cached", market=market.value, currency=currency)
            self._report(
                event="approval_skipped_cached",
                category="approval",
                market=market.value,
                currency=currency,
                cached_amount=str(cached_amount),
                required_amount=str(required_amount),
            )
            return approval_key, required_amount

        spender = self.settings.pool_address(market)
        try:
            allowance = await self._wallet_allowance(token, spender)
        except Exception as e:
            allowance = Decimal(0)
            log.warning(
                "engine.allowance_fetch_failed",
                market=market.value, currency=currency, error=str(e),
            )
            self._report(
                event="allowance_fetch_failed",
                category="approval",
                market=market.value,
                currency=currency,
                error=str(e),
            )
        if allowance >= required_amount:
            self._submitted_approvals[approval_key] = allowance
            log.info(
                "engine.approval_skipped_onchain",
                market=market.value, currency=currency, allowance=str(allowance),
            )
            self._report(
                event="approval_skipped_onchain",
                category="approval",
                market=market.value,
                currency=currency,
                allowance=str(allowance),
                required_amount=str(required_amount),
            )
            return approval_key, required_amount

        approve_amount = required_amount
        if self.approval_config.get("mode", "exact") == "max":
            approve_amount = Decimal(2**256 - 1)
        prep = await self.rest.prepare_vault_approve(
            market.value, self.signer.address, currency, str(approve_amount),
        )
        if prep is None:
            log.info("engine.approval_skipped_native", market=market.value, currency=currency)
            return None, Decimal(0)
        value = int(prep.get("value", 0))
        gas = await self._approval_gas_limit(prep, value)
        tx_hash = await self.signer.send_tx(
            to=prep["to"], data=prep["data"],
            value=value,
            gas=gas,
        )
        log.info("engine.approval_submitted", market=market.value, currency=currency, tx_hash=tx_hash)
        self._report(
            event="approval_submitted",
            category="approval",
            market=market.value,
            currency=currency,
            tx_hash=tx_hash,
        )
        try:
            receipt = await self.signer.wait_for_receipt(tx_hash, timeout=45)
            self._report(
                event="approval_confirmed",
                category="approval",
                market=market.value,
                currency=currency,
                tx_hash=tx_hash,
                status=receipt.get("status"),
                block_number=receipt.get("blockNumber"),
            )
            if int(receipt.get("status", 0)) == 1:
                self._submitted_approvals[approval_key] = max(cached_amount, approve_amount)
                return approval_key, required_amount
            else:
                log.warning(
                    "engine.approval_failed_receipt",
                    market=market.value, currency=currency,
                    tx_hash=tx_hash, status=receipt.get("status"),
                )
                self._report(
                    event="approval_failed_receipt",
                    category="approval",
                    market=market.value,
                    currency=currency,
                    tx_hash=tx_hash,
                    status=receipt.get("status"),
                )
        except Exception as e:
            log.warning("engine.approval_receipt_wait_failed", tx_hash=tx_hash, error=str(e))
            self._report(
                event="approval_receipt_wait_failed",
                category="approval",
                market=market.value,
                currency=currency,
                tx_hash=tx_hash,
                error=str(e),
            )
        return None, Decimal(0)

    async def _wallet_allowance(self, token: str, spender: str) -> Decimal:
        owner_arg = self.signer.address.lower().removeprefix("0x").rjust(64, "0")
        spender_arg = spender.lower().removeprefix("0x").rjust(64, "0")
        data = "0xdd62ed3e" + owner_arg + spender_arg
        raw_bytes = await self.signer.w3.eth.call({"to": token, "data": data})
        raw_hex = raw_bytes.hex() if hasattr(raw_bytes, "hex") else str(raw_bytes)
        return Decimal(int(raw_hex, 16) if raw_hex not in {"0x", ""} else 0)

    def _consume_cached_approval(self, approval_key: tuple[str, str], amount: Decimal) -> None:
        cached_amount = self._submitted_approvals.get(approval_key, Decimal(0))
        remaining = cached_amount - amount
        if remaining > 0:
            self._submitted_approvals[approval_key] = remaining
        else:
            self._submitted_approvals.pop(approval_key, None)

    def _clear_spent_approval_cache(self, order: Any) -> None:
        if order.funding != FundingSource.WALLET:
            return
        base_code, quote_code = order.market.value.split(":", 1)
        spec = MARKETS[order.market]
        if order.side == Side.BUY:
            self._submitted_approvals.pop((order.market.value, quote_code), None)
        elif not spec.is_base_native:
            self._submitted_approvals.pop((order.market.value, base_code), None)

    async def _approval_gas_limit(self, prep: dict[str, Any], value: int) -> int:
        explicit = int(prep.get("gasLimit", prep.get("gas", 0)) or 0)
        try:
            estimated = await self.signer.w3.eth.estimate_gas({
                "from": self.signer.address,
                "to": prep["to"],
                "data": prep["data"],
                "value": value,
            })
            gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), explicit, 200_000)
            log.info("engine.approval_gas_estimated", estimated=int(estimated), gas=gas)
            self._report(
                event="approval_gas_estimated",
                category="approval",
                estimated=int(estimated),
                explicit=explicit,
                gas=gas,
            )
            return gas
        except Exception as e:
            fallback = max(explicit, 3_000_000)
            log.warning("engine.approval_gas_estimate_failed", error=str(e), fallback_gas=fallback)
            self._report(
                event="approval_gas_estimate_failed",
                category="approval",
                error=str(e),
                explicit=explicit,
                fallback_gas=fallback,
            )
            return fallback

    async def _notify_reject(self, strategy_name: str, coid: str, reason: str) -> None:
        """Tell the owning strategy its order never reached the book, so it
        clears quote tracking instead of later trying to cancel a phantom."""
        for strat in self.strategies:
            if strat.name == strategy_name:
                try:
                    await strat.on_reject(coid, reason)
                except Exception as e:
                    log.error("engine.on_reject_hook_failed",
                              strategy=strategy_name, error=str(e))
                return

    async def _cancel_order(self, cancel: Any) -> None:
        order_id = self.client_order_to_order_id.get(cancel.order_id, cancel.order_id)
        if not str(order_id).isdigit():
            # A coid that never resolved to an exchange id means the order
            # never reached the book (simulation failure or reject race).
            # The cancel endpoint only accepts numeric ids — a DELETE here
            # 400s and bumps failed_tx_streak for a nonexistent order.
            log.warning("engine.cancel_skipped_unresolved_id",
                        requested_id=str(cancel.order_id))
            return
        prep = await self.rest.prepare_cancel(cancel.market.value, order_id)
        tx_hash = await self.signer.send_tx(
            to=prep["to"], data=prep["data"],
            value=int(prep.get("value", 0)),
            gas=int(prep.get("gasLimit", prep.get("gas", 200_000))),
        )
        log.info("engine.cancel_submitted", order_id=order_id,
                 requested_id=cancel.order_id, tx_hash=tx_hash)

    def stop(self) -> None:
        self._stopped = True
        self._tick_event.set()
