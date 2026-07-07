# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Risk Manager — owns the pluggable rules and aggregates their verdicts.

Pattern adapted from chainstacklabs/hyperliquid-trading-bot (Apache 2.0).
Concrete rules below are DreamDEX-specific:

  - RealizedLossRule: kill switch if closed P&L drops below -$X
  - InventoryDriftRule: pause yield maker if SOMI inventory drifts beyond cap
  - FailedTxStreakRule: pause all if N consecutive txs fail (likely RPC degraded)
  - WsStalenessRule: cancel everything if WS hasn't ticked in 60s (book is stale)
  - OpenOrdersCapRule: stop placing if too many open orders (back-pressure)
  - MaxDrawdownRule: kill switch on percent drawdown (covers unrealized too)
"""

from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from dreamdex_bot.config import MARKETS, MarketSymbol
from dreamdex_bot.interfaces.risk import (
    AccountMetrics, RiskAction, RiskEvent, RiskRule, Severity,
)
from dreamdex_bot.interfaces.strategy import MarketState, OwnInventory
from dreamdex_bot.utils.logger import get_logger


log = get_logger(__name__)


# ────────────────────────────────────────────────────────────────────
# Concrete rules
# ────────────────────────────────────────────────────────────────────

class RealizedLossRule(RiskRule):
    """Kill switch when realized P&L breaches a hard floor."""

    def evaluate(self, market_state, inventory, metrics):
        floor = Decimal(str(self.config.get("max_loss_usd", "12.50"))) * -1
        if metrics.realized_pnl_usd <= floor:
            return [RiskEvent(
                rule_name=self.name,
                action=RiskAction.KILL_SWITCH,
                severity=Severity.CRITICAL,
                reason=f"Realized P&L {metrics.realized_pnl_usd} ≤ floor {floor}",
                metadata={"realized_pnl": str(metrics.realized_pnl_usd), "floor": str(floor)},
            )]
        return []


class InventoryDriftRule(RiskRule):
    """Pause yield maker (or specified strategy) if inventory drift exceeds cap.

    For SOMI:USDso maker: target inventory = ~$12.50 of SOMI, ~$12.50 of USDso.
    If actual base value drifts more than max_drift_usd from target, pause."""

    def evaluate(self, market_state, inventory, metrics):
        events = []
        market = MarketSymbol(self.config["market"])
        max_drift = Decimal(str(self.config.get("max_drift_usd", "10.00")))
        target_base_usd = Decimal(str(self.config.get("target_base_usd", "12.50")))
        scoped_strategy = self.config.get("strategy")

        inv = inventory.get(market)
        ms = market_state.get(market)
        if inv is None or ms is None or ms.mid is None:
            return events
        base_balance = self._risk_base_balance(market, inv)
        base_value_usd = base_balance * ms.mid
        drift = abs(base_value_usd - target_base_usd)
        if drift > max_drift:
            events.append(RiskEvent(
                rule_name=self.name,
                action=RiskAction.PAUSE_STRATEGY if scoped_strategy else RiskAction.PAUSE_ALL,
                severity=Severity.HIGH,
                reason=f"Inventory drift {drift} > cap {max_drift} on {market.value}",
                strategy=scoped_strategy,
                market=market,
                metadata={
                    "base_value_usd": str(base_value_usd),
                    "base_balance": str(base_balance),
                    "raw_base_balance": str(inv.base_balance),
                    "target_usd": str(target_base_usd),
                    "drift_usd": str(drift),
                },
            ))
        return events

    def _risk_base_balance(self, market: MarketSymbol, inv: OwnInventory) -> Decimal:
        if not MARKETS[market].is_base_native:
            return inv.base_balance
        reserve_by_market = self.config.get("native_base_reserve_by_market", {})
        reserve = Decimal(str(reserve_by_market.get(market.value, "0")))
        return max(Decimal("0"), inv.base_balance - min(inv.base_balance, reserve))


class FailedTxStreakRule(RiskRule):
    """Pause everything when consecutive tx failures exceed threshold.
    Most likely cause: RPC degraded or wrong nonce."""

    def evaluate(self, market_state, inventory, metrics):
        max_streak = int(self.config.get("max_streak", 5))
        if metrics.failed_tx_streak >= max_streak:
            return [RiskEvent(
                rule_name=self.name,
                action=RiskAction.PAUSE_ALL,
                severity=Severity.HIGH,
                reason=f"Failed tx streak = {metrics.failed_tx_streak} ≥ {max_streak}",
                metadata={"streak": metrics.failed_tx_streak},
            )]
        return []


class WsStalenessRule(RiskRule):
    """Cancel all orders if WebSocket feed has gone silent.
    Without a live book, we can't safely quote or take."""

    def evaluate(self, market_state, inventory, metrics):
        if metrics.ws_last_message_ts <= 0:
            return []
        max_silence_sec = float(self.config.get("max_silence_sec", 60.0))
        silence = time.time() - metrics.ws_last_message_ts
        if silence > max_silence_sec:
            return [RiskEvent(
                rule_name=self.name,
                action=RiskAction.CANCEL_ALL_ORDERS,
                severity=Severity.HIGH,
                reason=f"WS silent for {silence:.1f}s > {max_silence_sec}s",
                metadata={"silence_sec": silence},
            )]
        return []


class OpenOrdersCapRule(RiskRule):
    """Back-pressure: prevent placing more orders if too many are already open.

    Fix for gap #5: emits PAUSE_ALL (not unscoped PAUSE_STRATEGY which the
    engine was ignoring). The pause is automatically released the next tick
    once open_order_count drops below the cap, because the engine clears the
    paused_all flag whenever the rule stops firing.
    """

    def evaluate(self, market_state, inventory, metrics):
        cap = int(self.config.get("max_open", 8))
        if metrics.open_order_count >= cap:
            return [RiskEvent(
                rule_name=self.name,
                action=RiskAction.PAUSE_ALL,
                severity=Severity.MEDIUM,
                reason=f"Open orders {metrics.open_order_count} ≥ cap {cap}",
                metadata={"open": metrics.open_order_count, "cap": cap},
            )]
        return []


class MaxDrawdownRule(RiskRule):
    """Kill switch on total drawdown (realized + unrealized)."""

    def evaluate(self, market_state, inventory, metrics):
        max_dd_pct = Decimal(str(self.config.get("max_drawdown_pct", "30.0")))
        if metrics.drawdown_pct <= -max_dd_pct:
            return [RiskEvent(
                rule_name=self.name,
                action=RiskAction.KILL_SWITCH,
                severity=Severity.CRITICAL,
                reason=f"Drawdown {metrics.drawdown_pct}% ≤ -{max_dd_pct}%",
                metadata={"drawdown_pct": str(metrics.drawdown_pct)},
            )]
        return []


# ────────────────────────────────────────────────────────────────────
# Manager
# ────────────────────────────────────────────────────────────────────

class RiskManager:
    def __init__(self, rules: list[RiskRule]) -> None:
        self.rules = [r for r in rules if r.enabled]

    def evaluate(
        self,
        market_state: dict[MarketSymbol, MarketState],
        inventory: dict[MarketSymbol, OwnInventory],
        metrics: AccountMetrics,
    ) -> list[RiskEvent]:
        """Run every enabled rule, return concatenated events."""
        all_events: list[RiskEvent] = []
        for rule in self.rules:
            try:
                events = rule.evaluate(market_state, inventory, metrics)
                all_events.extend(events)
            except Exception as e:
                log.error("risk.rule_failed", rule=rule.name, error=str(e))
        return all_events

    @classmethod
    def default(cls, config: dict[str, Any]) -> RiskManager:
        """Build the default ruleset from a config dict."""
        rules: list[RiskRule] = [
            RealizedLossRule("realized_loss", config.get("realized_loss", {})),
            InventoryDriftRule("inventory_drift", config.get("inventory_drift", {
                "market": "SOMI:USDso", "max_drift_usd": "10.00", "target_base_usd": "12.50",
                "strategy": "yield_maker",
            })),
            FailedTxStreakRule("failed_tx_streak", config.get("failed_tx_streak", {"max_streak": 5})),
            WsStalenessRule("ws_staleness", config.get("ws_staleness", {"max_silence_sec": 60.0})),
            OpenOrdersCapRule("open_orders_cap", config.get("open_orders_cap", {"max_open": 8})),
            MaxDrawdownRule("max_drawdown", config.get("max_drawdown", {"max_drawdown_pct": "30.0"})),
        ]
        return cls(rules)
