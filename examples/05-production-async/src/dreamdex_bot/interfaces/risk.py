# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Risk management interface.

Pattern adapted from chainstacklabs/hyperliquid-trading-bot (Apache 2.0):
each risk rule implements `evaluate()` and returns RiskEvents. The RiskManager
collects rules and reduces them to a list of actions for the engine to take.

DreamDEX-specific concrete rules live in core/risk_manager.py.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any

from dreamdex_bot.config import MarketSymbol
from dreamdex_bot.interfaces.strategy import MarketState, OwnInventory


class RiskAction(str, Enum):
    NONE = "none"
    CANCEL_ALL_ORDERS = "cancel_all_orders"
    CANCEL_STRATEGY_ORDERS = "cancel_strategy_orders"  # Just one strategy's orders
    PAUSE_STRATEGY = "pause_strategy"
    PAUSE_ALL = "pause_all"
    KILL_SWITCH = "kill_switch"  # Cancel everything, withdraw vault, exit


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class RiskEvent:
    rule_name: str
    action: RiskAction
    severity: Severity
    reason: str
    strategy: str | None = None  # If action is strategy-scoped
    market: MarketSymbol | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)


@dataclass
class AccountMetrics:
    """Aggregate account state, computed by the engine each tick."""
    total_value_usd: Decimal
    realized_pnl_usd: Decimal
    unrealized_pnl_usd: Decimal
    starting_capital_usd: Decimal
    drawdown_pct: Decimal  # Negative = loss
    open_order_count: int
    failed_tx_streak: int
    last_successful_tx_ts: float
    ws_last_message_ts: float


class RiskRule(ABC):
    def __init__(self, name: str, config: dict[str, Any]) -> None:
        self.name = name
        self.config = config
        self.enabled = bool(config.get("enabled", True))

    @abstractmethod
    def evaluate(
        self,
        market_state: dict[MarketSymbol, MarketState],
        inventory: dict[MarketSymbol, OwnInventory],
        metrics: AccountMetrics,
    ) -> list[RiskEvent]:
        """Return RiskEvents if rule fires. Empty list = OK."""
