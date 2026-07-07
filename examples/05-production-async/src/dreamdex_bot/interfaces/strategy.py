# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Trading strategy interface.

Pattern adapted from chainstacklabs/hyperliquid-trading-bot (Apache 2.0):
strategies emit `TradingSignal` lists from `generate_signals()`, and the engine
executes them through the order executor. Differences from chainstack:
  - Signals can be IOC, FOK, GTC, PostOnly (DreamDEX order types)
  - Signals carry the funding source (wallet vs vault)
  - Signals are async-aware (strategies can suspend on book state)
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any

from dreamdex_bot.config import MarketSymbol


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    """DreamDEX order types. See /trading/common/order-types.md in the docs."""
    GTC = "gtc"          # Good-til-cancelled (rests on book; needs vault funding)
    IOC = "ioc"          # Immediate-or-cancel (wallet OR vault funding)
    FOK = "fok"          # Fill-or-kill (wallet OR vault funding)
    POST_ONLY = "post_only"  # Maker only; rejects if would cross. Needs vault funding.


class FundingSource(str, Enum):
    WALLET = "wallet"  # Only valid for IOC/FOK. Direct from EOA.
    VAULT = "vault"    # Required for GTC/POST_ONLY. Funds pre-deposited.


class SignalAction(str, Enum):
    PLACE = "place"
    CANCEL = "cancel"
    REPLACE = "replace"


@dataclass
class OrderIntent:
    """A single order to place. Engine converts this to a tx via the executor."""
    market: MarketSymbol
    side: Side
    order_type: OrderType
    quantity: Decimal       # In base-token units (will be rounded to lot_size)
    price: Decimal | None   # In quote-per-base; None for market-style IOC
    funding: FundingSource
    client_order_id: str    # Strategy-assigned ID for tracking
    reason: str = ""        # Human-readable explanation for the log
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class CancelIntent:
    market: MarketSymbol
    order_id: str
    reason: str = ""


@dataclass
class TradingSignal:
    action: SignalAction
    order: OrderIntent | None = None
    cancel: CancelIntent | None = None


@dataclass
class MarketState:
    """Snapshot of one market for strategy consumption."""
    market: MarketSymbol
    best_bid: Decimal | None
    best_ask: Decimal | None
    mid: Decimal | None
    bid_depth_usd: Decimal  # Total USD value at top 5 levels
    ask_depth_usd: Decimal
    last_trade_price: Decimal | None
    volatility_5m: Decimal | None  # Realized vol over last 5 min, annualized fraction
    ts: float                       # epoch seconds


@dataclass
class OwnInventory:
    """Bot's current position in one market."""
    market: MarketSymbol
    base_balance: Decimal           # In base-token units (vault + free wallet)
    quote_balance: Decimal          # In quote-token units
    base_locked_in_orders: Decimal  # Locked by open sell orders
    quote_locked_in_orders: Decimal # Locked by open buy orders
    realized_pnl_usd: Decimal       # Closed P&L since session start
    unrealized_pnl_usd: Decimal     # Mark-to-market of current inventory vs entry


class TradingStrategy(ABC):
    """Base class for all strategies.

    Each strategy implements `generate_signals()`, which the engine calls on a
    tick (driven by WS updates or a wall-clock timer). The engine handles
    execution, retries, nonce ordering, and risk checks.
    """

    def __init__(self, name: str, config: dict[str, Any]) -> None:
        self.name = name
        self.config = config
        self.enabled = bool(config.get("enabled", True))

    @abstractmethod
    async def generate_signals(
        self,
        market_state: dict[MarketSymbol, MarketState],
        inventory: dict[MarketSymbol, OwnInventory],
    ) -> list[TradingSignal]:
        """Return signals to execute. Empty list = no-op this tick."""

    async def on_fill(self, fill_event: dict[str, Any]) -> None:
        """Optional hook: called when one of this strategy's orders fills."""
        return None

    async def on_reject(self, order_id: str, reason: str) -> None:
        """Optional hook: called when one of this strategy's orders is rejected."""
        return None

    def tracked_client_order_ids(self) -> set[str]:
        """Client order ids the strategy currently believes are resting on the
        book. The engine uses this to detect orders that vanished without a
        WS event (missed fill/cancel) and notify the strategy via on_reject.
        Strategies that hold no resting state return an empty set."""
        return set()
