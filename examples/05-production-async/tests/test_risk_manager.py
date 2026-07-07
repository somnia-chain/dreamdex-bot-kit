# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for the risk manager rules — each rule's evaluate() in isolation."""

import time
from decimal import Decimal

import pytest

from dreamdex_bot.config import MarketSymbol
from dreamdex_bot.core.risk_manager import (
    FailedTxStreakRule, InventoryDriftRule, MaxDrawdownRule,
    OpenOrdersCapRule, RealizedLossRule, RiskManager, WsStalenessRule,
)
from dreamdex_bot.interfaces.risk import AccountMetrics, RiskAction, Severity
from dreamdex_bot.interfaces.strategy import MarketState, OwnInventory


def make_metrics(**overrides):
    base = dict(
        total_value_usd=Decimal("50"),
        realized_pnl_usd=Decimal("0"),
        unrealized_pnl_usd=Decimal("0"),
        starting_capital_usd=Decimal("50"),
        drawdown_pct=Decimal("0"),
        open_order_count=0,
        failed_tx_streak=0,
        last_successful_tx_ts=time.time(),
        ws_last_message_ts=time.time(),
    )
    base.update(overrides)
    return AccountMetrics(**base)


class TestRealizedLossRule:
    def test_no_event_when_loss_within_bound(self):
        rule = RealizedLossRule("realized_loss", {"max_loss_usd": "12.50"})
        events = rule.evaluate({}, {}, make_metrics(realized_pnl_usd=Decimal("-5")))
        assert events == []

    def test_kill_switch_when_loss_exceeds_floor(self):
        rule = RealizedLossRule("realized_loss", {"max_loss_usd": "12.50"})
        events = rule.evaluate({}, {}, make_metrics(realized_pnl_usd=Decimal("-15")))
        assert len(events) == 1
        assert events[0].action == RiskAction.KILL_SWITCH
        assert events[0].severity == Severity.CRITICAL


class TestInventoryDriftRule:
    def test_no_event_when_within_drift(self):
        rule = InventoryDriftRule("inventory_drift", {
            "market": "SOMI:USDso", "max_drift_usd": "10.00",
            "target_base_usd": "12.50", "strategy": "yield_maker",
        })
        ms = MarketState(market=MarketSymbol.SOMI_USDSO,
                          best_bid=Decimal("0.5"), best_ask=Decimal("0.51"),
                          mid=Decimal("0.505"),
                          bid_depth_usd=Decimal("0"), ask_depth_usd=Decimal("0"),
                          last_trade_price=None, volatility_5m=None, ts=time.time())
        # Position value: 25 * 0.505 = 12.625 → diff vs target 12.5 = 0.125 (within drift)
        inv = OwnInventory(market=MarketSymbol.SOMI_USDSO,
                            base_balance=Decimal("25"), quote_balance=Decimal("0"),
                            base_locked_in_orders=Decimal("0"), quote_locked_in_orders=Decimal("0"),
                            realized_pnl_usd=Decimal("0"), unrealized_pnl_usd=Decimal("0"))
        events = rule.evaluate({MarketSymbol.SOMI_USDSO: ms},
                                {MarketSymbol.SOMI_USDSO: inv}, make_metrics())
        assert events == []

    def test_pauses_strategy_when_drift_exceeds_cap(self):
        rule = InventoryDriftRule("inventory_drift", {
            "market": "SOMI:USDso", "max_drift_usd": "10.00",
            "target_base_usd": "12.50", "strategy": "yield_maker",
        })
        ms = MarketState(market=MarketSymbol.SOMI_USDSO,
                          best_bid=Decimal("0.5"), best_ask=Decimal("0.51"),
                          mid=Decimal("0.505"),
                          bid_depth_usd=Decimal("0"), ask_depth_usd=Decimal("0"),
                          last_trade_price=None, volatility_5m=None, ts=time.time())
        # Position value: 100 * 0.505 = 50.5 → diff from target 12.5 = 38 (exceeds 10 cap)
        inv = OwnInventory(market=MarketSymbol.SOMI_USDSO,
                            base_balance=Decimal("100"), quote_balance=Decimal("0"),
                            base_locked_in_orders=Decimal("0"), quote_locked_in_orders=Decimal("0"),
                            realized_pnl_usd=Decimal("0"), unrealized_pnl_usd=Decimal("0"))
        events = rule.evaluate({MarketSymbol.SOMI_USDSO: ms},
                                {MarketSymbol.SOMI_USDSO: inv}, make_metrics())
        assert len(events) == 1
        assert events[0].action == RiskAction.PAUSE_STRATEGY
        assert events[0].strategy == "yield_maker"

    def test_native_base_reserve_is_excluded_from_drift(self):
        rule = InventoryDriftRule("inventory_drift", {
            "market": "SOMI:USDso", "max_drift_usd": "1.00",
            "target_base_usd": "0", "strategy": "yield_maker",
            "native_base_reserve_by_market": {"SOMI:USDso": "10"},
        })
        ms = MarketState(market=MarketSymbol.SOMI_USDSO,
                          best_bid=Decimal("0.5"), best_ask=Decimal("0.51"),
                          mid=Decimal("0.505"),
                          bid_depth_usd=Decimal("0"), ask_depth_usd=Decimal("0"),
                          last_trade_price=None, volatility_5m=None, ts=time.time())
        inv = OwnInventory(market=MarketSymbol.SOMI_USDSO,
                            base_balance=Decimal("10"), quote_balance=Decimal("0"),
                            base_locked_in_orders=Decimal("0"), quote_locked_in_orders=Decimal("0"),
                            realized_pnl_usd=Decimal("0"), unrealized_pnl_usd=Decimal("0"))

        events = rule.evaluate({MarketSymbol.SOMI_USDSO: ms},
                                {MarketSymbol.SOMI_USDSO: inv}, make_metrics())

        assert events == []


class TestFailedTxStreakRule:
    def test_fires_at_threshold(self):
        rule = FailedTxStreakRule("ftx", {"max_streak": 5})
        events = rule.evaluate({}, {}, make_metrics(failed_tx_streak=5))
        assert len(events) == 1
        assert events[0].action == RiskAction.PAUSE_ALL

    def test_does_not_fire_below(self):
        rule = FailedTxStreakRule("ftx", {"max_streak": 5})
        events = rule.evaluate({}, {}, make_metrics(failed_tx_streak=4))
        assert events == []


class TestWsStalenessRule:
    def test_zero_timestamp_is_not_measurable_yet(self):
        rule = WsStalenessRule("ws", {"max_silence_sec": 30.0})
        events = rule.evaluate({}, {}, make_metrics(ws_last_message_ts=0))
        assert events == []

    def test_fires_when_silent_too_long(self):
        rule = WsStalenessRule("ws", {"max_silence_sec": 30.0})
        events = rule.evaluate({}, {}, make_metrics(ws_last_message_ts=time.time() - 60))
        assert len(events) == 1
        assert events[0].action == RiskAction.CANCEL_ALL_ORDERS

    def test_quiet_when_fresh(self):
        rule = WsStalenessRule("ws", {"max_silence_sec": 30.0})
        events = rule.evaluate({}, {}, make_metrics(ws_last_message_ts=time.time()))
        assert events == []


class TestOpenOrdersCapRule:
    """Gap #5 regression test — must emit PAUSE_ALL not unscoped PAUSE_STRATEGY."""

    def test_fires_at_cap(self):
        rule = OpenOrdersCapRule("open_orders_cap", {"max_open": 8})
        events = rule.evaluate({}, {}, make_metrics(open_order_count=8))
        assert len(events) == 1
        assert events[0].action == RiskAction.PAUSE_ALL
        assert events[0].rule_name == "open_orders_cap"
        # Must NOT be a scoped pause that the engine ignores
        assert events[0].strategy is None

    def test_quiet_below_cap(self):
        rule = OpenOrdersCapRule("open_orders_cap", {"max_open": 8})
        events = rule.evaluate({}, {}, make_metrics(open_order_count=7))
        assert events == []


class TestMaxDrawdownRule:
    def test_fires_on_drawdown(self):
        rule = MaxDrawdownRule("dd", {"max_drawdown_pct": "30.0"})
        events = rule.evaluate({}, {}, make_metrics(drawdown_pct=Decimal("-35")))
        assert len(events) == 1
        assert events[0].action == RiskAction.KILL_SWITCH

    def test_quiet_within_bound(self):
        rule = MaxDrawdownRule("dd", {"max_drawdown_pct": "30.0"})
        events = rule.evaluate({}, {}, make_metrics(drawdown_pct=Decimal("-25")))
        assert events == []


class TestRiskManagerDefault:
    def test_default_builds_all_six_rules(self):
        mgr = RiskManager.default({})
        assert len(mgr.rules) == 6
        rule_names = {r.name for r in mgr.rules}
        assert "realized_loss" in rule_names
        assert "open_orders_cap" in rule_names
        assert "max_drawdown" in rule_names
