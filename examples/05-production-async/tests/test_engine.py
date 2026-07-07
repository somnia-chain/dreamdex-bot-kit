# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Engine integration tests for the gap-fix regressions.

These cover the wirings that the local audit flagged:
  - Gap #4: cancel-all actually broadcasts (signer.send_tx is invoked)
  - Gap #5: OpenOrdersCapRule pause is soft and auto-releases next tick
  - Gap #9: WS reconnect triggers REST refresh of orders + balances
  - Gap #10: KILL_SWITCH cancels + stops but does NOT auto-withdraw vault
"""

from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest

from dreamdex_bot.config import MarketSymbol
from dreamdex_bot.core.engine import Engine
from dreamdex_bot.interfaces.risk import (
    AccountMetrics, RiskAction, RiskEvent, Severity,
)
from dreamdex_bot.interfaces.strategy import (
    CancelIntent, FundingSource, OrderIntent, OrderType, Side, SignalAction, TradingSignal,
)


@pytest.fixture
def fake_components(mock_settings):
    """Build an Engine with all dependencies stubbed."""
    signer = MagicMock()
    signer.address = "0x" + "1" * 40
    signer.send_tx = AsyncMock(return_value="0xdeadbeef")
    signer.wait_for_receipt = AsyncMock(return_value={"status": 1, "blockNumber": 1})
    signer.simulate_order_tx = AsyncMock(return_value=(None, None))
    signer.w3.eth.get_balance = AsyncMock(return_value=0)
    signer.w3.eth.call = AsyncMock(return_value=bytes(32))
    signer.w3.eth.estimate_gas = AsyncMock(return_value=600_000)

    rest = MagicMock()
    rest.get_orderbook = AsyncMock(return_value={"bids": [], "asks": []})
    rest.get_my_orders = AsyncMock(return_value=[])
    rest.get_account_balances = AsyncMock(return_value={})
    rest.prepare_cancel = AsyncMock(return_value={
        "to": "0xpool", "data": "0xcafe", "value": 0, "gas": 200_000,
    })
    rest.prepare_order = AsyncMock(return_value={
        "to": "0xpool", "data": "0xfeed", "value": 0, "gas": 500_000,
    })

    ws = MagicMock()
    ws.last_message_ts = 0.0
    ws.subscribe = MagicMock()
    ws.subscribe_order = AsyncMock()
    ws.unsubscribe_order = AsyncMock()
    ws.on_reconnect = MagicMock()

    risk = MagicMock()
    risk.evaluate = MagicMock(return_value=[])

    engine = Engine(
        settings=mock_settings, signer=signer, rest=rest, ws=ws,
        strategies=[], risk=risk,
        starting_capital_usd=Decimal("50"),
        markets_to_watch=[MarketSymbol.SOMI_USDSO],
    )
    return engine, signer, rest, ws, risk


class TestKillSwitchHonesty:
    """Gap #10: kill switch should cancel + stop, and NOT touch the vault."""

    @pytest.mark.asyncio
    async def test_kill_switch_cancels_orders_and_stops(self, fake_components):
        engine, signer, rest, ws, risk = fake_components
        # Seed an open order so cancel-all has something to do
        engine.open_orders = {"order-1": {
            "orderId": "order-1", "market": "SOMI:USDso", "side": "buy",
            "price": "0.5", "remainingQuantity": "10",
        }}
        ev = RiskEvent(
            rule_name="realized_loss", action=RiskAction.KILL_SWITCH,
            severity=Severity.CRITICAL, reason="loss threshold", metadata={},
        )
        await engine._handle_risk_events([ev])
        # The cancel must have been broadcast (gap #4)
        rest.prepare_cancel.assert_awaited_once_with("SOMI:USDso", "order-1")
        signer.send_tx.assert_awaited_once()
        # Persistent pause + stopped
        assert engine.paused_all is True
        assert engine._stopped is True
        # No vault-withdraw method should have been invoked
        for attr in dir(rest):
            if "withdraw" in attr.lower():
                method = getattr(rest, attr)
                if hasattr(method, "await_count"):
                    assert method.await_count == 0, f"vault {attr} should not be invoked on kill switch"


class TestCancelAllBroadcasts:
    """Gap #4: _cancel_all_orders prepares AND broadcasts each tx."""

    @pytest.mark.asyncio
    async def test_cancel_all_broadcasts_each(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        engine.open_orders = {
            "order-1": {"orderId": "order-1", "market": "SOMI:USDso", "side": "buy",
                        "price": "0.5", "remainingQuantity": "10"},
            "order-2": {"orderId": "order-2", "market": "SOMI:USDso", "side": "sell",
                        "price": "0.6", "remainingQuantity": "5"},
        }
        await engine._cancel_all_orders()
        assert rest.prepare_cancel.await_count == 2
        assert signer.send_tx.await_count == 2

    @pytest.mark.asyncio
    async def test_cancel_all_handles_individual_failures(self, fake_components):
        """One failed cancel shouldn't stop the rest from being attempted."""
        engine, signer, rest, _, _ = fake_components
        engine.open_orders = {
            "order-1": {"orderId": "order-1", "market": "SOMI:USDso", "side": "buy",
                        "price": "0.5", "remainingQuantity": "10"},
            "order-2": {"orderId": "order-2", "market": "SOMI:USDso", "side": "sell",
                        "price": "0.6", "remainingQuantity": "5"},
        }
        # First cancel raises, second succeeds
        rest.prepare_cancel.side_effect = [Exception("boom"), {
            "to": "0xpool", "data": "0xfeed", "value": 0, "gas": 200_000,
        }]
        await engine._cancel_all_orders()
        # Both prep attempts were made; only the successful one was broadcast
        assert rest.prepare_cancel.await_count == 2
        assert signer.send_tx.await_count == 1


class TestSoftPauseCycle:
    """Gap #5: OpenOrdersCapRule emits PAUSE_ALL which is treated as a soft (tick-scoped)
    pause and auto-releases the next tick when the cap is no longer hit."""

    @pytest.mark.asyncio
    async def test_open_orders_cap_is_soft_pause(self, fake_components):
        engine, _, _, _, risk = fake_components
        ev = RiskEvent(
            rule_name="open_orders_cap", action=RiskAction.PAUSE_ALL,
            severity=Severity.MEDIUM, reason="cap hit", metadata={},
        )
        await engine._handle_risk_events([ev])
        # Should be a SOFT pause, not the persistent one
        assert engine.soft_paused_all is True
        assert engine.paused_all is False

    @pytest.mark.asyncio
    async def test_other_pause_all_is_persistent(self, fake_components):
        engine, _, _, _, _ = fake_components
        ev = RiskEvent(
            rule_name="failed_tx_streak", action=RiskAction.PAUSE_ALL,
            severity=Severity.HIGH, reason="streak", metadata={},
        )
        await engine._handle_risk_events([ev])
        # Non-allowlisted rules escalate to persistent
        assert engine.paused_all is True

    @pytest.mark.asyncio
    async def test_soft_pause_resets_each_tick(self, fake_components):
        """The soft_paused_all flag is reset at the start of each tick. Persistent
        paused_all is not. This is what makes auto-release possible."""
        engine, _, _, _, risk = fake_components
        # Pre-set soft pause from a previous tick
        engine.soft_paused_all = True
        engine.paused_all = False
        # No rules fire this tick
        risk.evaluate.return_value = []
        await engine._tick()
        # Soft pause must have been cleared at tick start
        assert engine.soft_paused_all is False
        assert engine.paused_all is False


class TestBalanceRiskGating:
    """Startup balance fetch can be unavailable; balance-dependent kill rules
    should not stop the engine until balances are confirmed."""

    @pytest.mark.asyncio
    async def test_drawdown_kill_is_gated_until_balances_loaded(self, fake_components):
        engine, _, _, _, risk = fake_components
        engine.balances_loaded = False
        risk.evaluate.return_value = [RiskEvent(
            rule_name="max_drawdown", action=RiskAction.KILL_SWITCH,
            severity=Severity.CRITICAL, reason="unknown balances look like drawdown",
            metadata={},
        )]

        await engine._tick()

        assert engine._stopped is False
        assert engine.paused_all is False

    @pytest.mark.asyncio
    async def test_balance_refresh_marks_confirmed_when_market_keys_present(self, fake_components):
        engine, _, rest, _, _ = fake_components
        rest.get_account_balances.return_value = {
            "SOMI:USDso": {
                "walletBase": "0", "walletQuote": "0",
                "vaultBase": "0", "vaultQuote": "50",
            }
        }

        await engine._refresh_balances()

        assert engine.balances_loaded is True
        state = engine.inventory_tracker.get(MarketSymbol.SOMI_USDSO)
        assert state.vault_quote == Decimal("50")


class TestCancelIdResolution:
    """Strategies may track client IDs; engine resolves to server IDs when known."""

    @pytest.mark.asyncio
    async def test_cancel_uses_server_order_id_when_mapping_exists(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        engine.client_order_to_order_id["client-1"] = "184467440737101"

        await engine._cancel_order(CancelIntent(
            market=MarketSymbol.SOMI_USDSO,
            order_id="client-1",
            reason="requote",
        ))

        rest.prepare_cancel.assert_awaited_once_with("SOMI:USDso", "184467440737101")
        signer.send_tx.assert_awaited_once()


class TestReconnectReconciliation:
    """Gap #9: After WS reconnect, engine refreshes open orders + balances from REST."""

    @pytest.mark.asyncio
    async def test_on_ws_reconnect_refetches_state(self, fake_components):
        engine, _, rest, _, _ = fake_components
        # Reset call counts (initialize() may have called them)
        rest.get_my_orders.reset_mock()
        rest.get_account_balances.reset_mock()

        await engine._on_ws_reconnect()
        rest.get_my_orders.assert_awaited()
        rest.get_account_balances.assert_awaited()

    @pytest.mark.asyncio
    async def test_register_ws_handlers_registers_reconnect_hook(self, fake_components):
        engine, _, _, ws, _ = fake_components
        engine.register_ws_handlers()
        # Engine must register a reconnect callback so reconciliation runs after gap recovery
        ws.on_reconnect.assert_called_once()
        # And subscribe to the per-market public book + trade channels.
        channel_names = [c.args[0] for c in ws.subscribe.call_args_list]
        assert any("orderbook.SOMI:USDso" in c for c in channel_names)
        assert "trades.SOMI:USDso" in channel_names


class TestInventoryWiring:
    """Gap #1/#2: fills now update inventory through InventoryTracker."""

    @pytest.mark.asyncio
    async def test_fill_event_updates_inventory(self, fake_components):
        engine, _, _, _, _ = fake_components
        # Seed initial balances so the BUY has quote to spend
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("100"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        await engine._on_my_fill({
            "market": "SOMI:USDso", "side": "buy",
            "quantity": "50", "price": "0.50",
            "funding": "wallet", "isMaker": False,
        })
        state = engine.inventory_tracker.get(MarketSymbol.SOMI_USDSO)
        # Should have actually applied the fill to balances
        assert state.wallet_base == Decimal("50")
        assert state.wallet_quote == Decimal("75")
        # Position bookkeeping
        assert state.account.position_base == Decimal("50")
        assert state.account.avg_entry_price == Decimal("0.50")

    @pytest.mark.asyncio
    async def test_cancel_event_releases_lock(self, fake_components):
        engine, _, _, _, _ = fake_components
        # Seed an open order with a quote lock
        engine.inventory_tracker.on_order_placed(
            MarketSymbol.SOMI_USDSO, Side.BUY,
            qty=Decimal("100"), price=Decimal("0.50"),
        )
        engine.open_orders = {"o1": {
            "orderId": "o1", "market": "SOMI:USDso", "side": "buy",
            "price": "0.50", "remainingQuantity": "100",
        }}
        assert engine.inventory_tracker.get(MarketSymbol.SOMI_USDSO).quote_locked_in_orders == Decimal("50")

        await engine._on_my_order_update({
            "orderId": "o1", "market": "SOMI:USDso", "side": "buy",
            "status": "cancelled", "remainingQuantity": "100", "price": "0.50",
        })
        state = engine.inventory_tracker.get(MarketSymbol.SOMI_USDSO)
        assert state.quote_locked_in_orders == Decimal("0")
        assert "o1" not in engine.open_orders

    @pytest.mark.asyncio
    async def test_terminal_filled_order_unsubscribes_and_releases_lock(self, fake_components):
        engine, _, _, ws, _ = fake_components
        engine.inventory_tracker.on_order_placed(
            MarketSymbol.SOMI_USDSO, Side.BUY,
            qty=Decimal("100"), price=Decimal("0.50"),
        )
        engine.open_orders = {"o1": {
            "orderId": "o1", "market": "SOMI:USDso", "side": "buy",
            "price": "0.50", "remainingQuantity": "100",
        }}

        await engine._on_my_order_update({
            "id": "o1", "market": "SOMI:USDso", "side": "buy",
            "status": "filled", "remainingQuantity": "0", "price": "0.50",
        })

        assert "o1" not in engine.open_orders
        ws.unsubscribe_order.assert_awaited_once_with("o1")


class TestBootstrapInventory:
    @pytest.mark.asyncio
    async def test_bootstrap_buys_base_when_wallet_is_quote_only(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        engine.bootstrap_config = {
            "enabled": True,
            "candidate_markets": ["SOMI:USDso"],
            "min_quote_balance_usd": "5",
            "target_quote_to_spend_usd": "10",
            "max_quote_fraction": "0.40",
            "reserve_quote_usd": "5",
            "min_base_value_usd": "1",
            "min_ask_depth_usd": "5",
            "max_spread_bps": "100",
        }
        engine.market_state[MarketSymbol.SOMI_USDSO] = engine._book_to_state(
            MarketSymbol.SOMI_USDSO,
            {
                "bids": [{"price": "0.499", "quantity": "100"}],
                "asks": [{"price": "0.501", "quantity": "100"}],
            },
        )
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signer.simulate_order_tx.return_value = (True, 123)

        await engine._bootstrap_initial_inventory()

        rest.prepare_order.assert_awaited_once()
        kwargs = rest.prepare_order.await_args.kwargs
        assert kwargs["market"] == "SOMI:USDso"
        assert kwargs["side"] == "buy"
        assert kwargs["order_type"] == "ioc"
        assert kwargs["funding"] == "wallet"
        assert Decimal(kwargs["quantity"]) == Decimal("19.96")
        signer.send_tx.assert_awaited_once()
        signer.wait_for_receipt.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_bootstrap_skips_when_base_already_available(self, fake_components):
        engine, _, rest, _, _ = fake_components
        engine.bootstrap_config = {
            "enabled": True,
            "candidate_markets": ["SOMI:USDso"],
            "min_base_value_usd": "1",
        }
        engine.market_state[MarketSymbol.SOMI_USDSO] = engine._book_to_state(
            MarketSymbol.SOMI_USDSO,
            {
                "bids": [{"price": "0.499", "quantity": "100"}],
                "asks": [{"price": "0.501", "quantity": "100"}],
            },
        )
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )

        await engine._bootstrap_initial_inventory()

        rest.prepare_order.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_bootstrap_continues_after_native_gas_candidate(self, fake_components):
        """Native SOMI gas should not prevent bootstrapping another quote-only market."""
        from dreamdex_bot.core.inventory import InventoryTracker

        engine, signer, rest, _, _ = fake_components
        engine.markets_to_watch = [MarketSymbol.SOMI_USDSO, MarketSymbol.WETH_USDSO]
        engine.inventory_tracker = InventoryTracker(engine.markets_to_watch)
        engine.bootstrap_config = {
            "enabled": True,
            "candidate_markets": ["SOMI:USDso", "WETH:USDso"],
            "min_quote_balance_usd": "5",
            "target_quote_to_spend_usd": "10",
            "max_quote_fraction": "0.40",
            "reserve_quote_usd": "5",
            "min_base_value_usd": "1",
            "min_ask_depth_usd": "5",
            "max_spread_bps": "100",
        }
        engine.market_state[MarketSymbol.SOMI_USDSO] = engine._book_to_state(
            MarketSymbol.SOMI_USDSO,
            {
                "bids": [{"price": "0.1709", "quantity": "1000"}],
                "asks": [{"price": "0.1711", "quantity": "1000"}],
            },
        )
        engine.market_state[MarketSymbol.WETH_USDSO] = engine._book_to_state(
            MarketSymbol.WETH_USDSO,
            {
                "bids": [{"price": "2118.00", "quantity": "1"}],
                "asks": [{"price": "2118.50", "quantity": "1"}],
            },
        )
        # SOMI native balance represents gas/base already available, while WETH
        # is quote-only. Bootstrap should skip SOMI and still buy WETH.
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.WETH_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signer.simulate_order_tx.return_value = (True, 123)

        await engine._bootstrap_initial_inventory()

        rest.prepare_order.assert_awaited_once()
        kwargs = rest.prepare_order.await_args.kwargs
        assert kwargs["market"] == "WETH:USDso"
        assert kwargs["side"] == "buy"
        assert kwargs["order_type"] == "ioc"
        assert Decimal(kwargs["quantity"]) == Decimal("0.0047")

    @pytest.mark.asyncio
    async def test_bootstrap_skips_candidate_below_min_quantity(self, fake_components):
        engine, _, rest, _, _ = fake_components
        engine.bootstrap_config = {
            "enabled": True,
            "candidate_markets": ["WBTC:USDso"],
            "min_quote_balance_usd": "5",
            "target_quote_to_spend_usd": "3",
            "max_quote_fraction": "0.10",
            "reserve_quote_usd": "45",
            "min_base_value_usd": "1",
            "min_ask_depth_usd": "5",
            "max_spread_bps": "100",
        }
        engine.market_state[MarketSymbol.WBTC_USDSO] = engine._book_to_state(
            MarketSymbol.WBTC_USDSO,
            {
                "bids": [{"price": "75227.8", "quantity": "0.01"}],
                "asks": [{"price": "75242.9", "quantity": "0.01"}],
            },
        )
        from dreamdex_bot.core.inventory import InventoryTracker

        engine.markets_to_watch = [MarketSymbol.WBTC_USDSO]
        engine.inventory_tracker = InventoryTracker(engine.markets_to_watch)
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.WBTC_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )

        await engine._bootstrap_initial_inventory()

        rest.prepare_order.assert_not_awaited()


class TestPreparedOrderGas:
    @pytest.mark.asyncio
    async def test_place_order_estimates_gas_when_api_omits_limit(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        rest.prepare_order.return_value = {
            "to": "0xpool", "data": "0xfeed", "value": 0,
        }
        signer.simulate_order_tx.return_value = (True, 1)
        await engine._place_order("test", OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ))

        signer.w3.eth.estimate_gas.assert_awaited_once()
        signer.simulate_order_tx.assert_awaited_once_with(
            to="0xpool", data="0xfeed", value=0, gas=750_000,
        )
        signer.send_tx.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_resting_order_subscribes_to_per_order_ws_after_simulation(self, fake_components):
        engine, signer, _, ws, _ = fake_components
        signer.simulate_order_tx.return_value = (True, 123)

        await engine._place_order("test", OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.POST_ONLY,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ))

        ws.subscribe_order.assert_awaited_once_with("123", engine._on_my_order_update)

    @pytest.mark.asyncio
    async def test_ioc_order_does_not_subscribe_to_per_order_ws(self, fake_components):
        engine, signer, _, ws, _ = fake_components
        signer.simulate_order_tx.return_value = (True, 123)

        await engine._place_order("test", OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ))

        ws.subscribe_order.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_waited_order_reports_empty_receipt_logs(self, fake_components):
        engine, signer, _, _, _ = fake_components
        engine._report = MagicMock()
        signer.simulate_order_tx.return_value = (True, 123)
        signer.wait_for_receipt.return_value = {"status": 1, "blockNumber": 10, "logs": []}

        await engine._place_order("test", OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ), wait_for_receipt=True)

        events = [call.kwargs.get("event") for call in engine._report.call_args_list]
        assert "order_receipt_empty_logs" in events
        confirmed = [
            call.kwargs for call in engine._report.call_args_list
            if call.kwargs.get("event") == "order_confirmed"
        ]
        assert confirmed[-1]["logs_count"] == 0
        assert confirmed[-1]["placed"] is False

    @pytest.mark.asyncio
    async def test_place_order_does_not_broadcast_when_simulation_raises(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        signer.simulate_order_tx.side_effect = Exception("execution reverted")

        result = await engine._place_order("test", OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ))

        assert result is None
        signer.send_tx.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_failed_approval_receipt_is_not_cached(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        rest.prepare_vault_approve = AsyncMock(return_value={
            "to": "0xtoken", "data": "0xapprove", "value": 0, "gas": 200_000,
        })
        signer.wait_for_receipt.return_value = {"status": 0, "blockNumber": 10}

        await engine._submit_approval(MarketSymbol.SOMI_USDSO, {
            "token": engine.settings.quote_token(MarketSymbol.SOMI_USDSO),
            "amount": "1000000000000000000",
        })

        assert ("SOMI:USDso", "USDso") not in engine._submitted_approvals

    @pytest.mark.asyncio
    async def test_successful_approval_receipt_is_cached(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        rest.prepare_vault_approve = AsyncMock(return_value={
            "to": "0xtoken", "data": "0xapprove", "value": 0, "gas": 200_000,
        })
        signer.wait_for_receipt.return_value = {"status": 1, "blockNumber": 10}

        await engine._submit_approval(MarketSymbol.SOMI_USDSO, {
            "token": engine.settings.quote_token(MarketSymbol.SOMI_USDSO),
            "amount": "1000000000000000000",
        })

        assert engine._submitted_approvals[("SOMI:USDso", "USDso")] == Decimal("1000000000000000000")

    @pytest.mark.asyncio
    async def test_existing_onchain_allowance_skips_approval_tx(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        signer.w3.eth.call.return_value = (2 * 10**18).to_bytes(32, "big")
        rest.prepare_vault_approve = AsyncMock()

        key, amount = await engine._submit_approval(MarketSymbol.SOMI_USDSO, {
            "token": engine.settings.quote_token(MarketSymbol.SOMI_USDSO),
            "amount": "1000000000000000000",
        })

        assert key == ("SOMI:USDso", "USDso")
        assert amount == Decimal("1000000000000000000")
        rest.prepare_vault_approve.assert_not_awaited()
        signer.send_tx.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_max_approval_mode_requests_reusable_allowance(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        engine.approval_config = {"mode": "max"}
        rest.prepare_vault_approve = AsyncMock(return_value={
            "to": "0xtoken", "data": "0xapprove", "value": 0, "gas": 200_000,
        })
        signer.wait_for_receipt.return_value = {"status": 1, "blockNumber": 10}

        await engine._submit_approval(MarketSymbol.SOMI_USDSO, {
            "token": engine.settings.quote_token(MarketSymbol.SOMI_USDSO),
            "amount": "1000000000000000000",
        })

        max_allowance = str(2**256 - 1)
        rest.prepare_vault_approve.assert_awaited_once_with(
            "SOMI:USDso", signer.address, "USDso", max_allowance,
        )
        assert engine._submitted_approvals[("SOMI:USDso", "USDso")] == Decimal(max_allowance)

    @pytest.mark.asyncio
    async def test_place_order_consumes_finite_approval_cache(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        rest.prepare_order = AsyncMock(return_value={
            "to": "0xpool",
            "data": "0xfeed",
            "value": 0,
            "gas": 500_000,
            "approval": {
                "token": engine.settings.quote_token(MarketSymbol.SOMI_USDSO),
                "amount": "1000000000000000000",
            },
        })
        rest.prepare_vault_approve = AsyncMock(return_value={
            "to": "0xtoken", "data": "0xapprove", "value": 0, "gas": 200_000,
        })
        signer.wait_for_receipt.return_value = {"status": 1, "blockNumber": 10}

        order = OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        )

        await engine._place_order("test", order)
        assert ("SOMI:USDso", "USDso") not in engine._submitted_approvals

        await engine._place_order("test", order)
        assert rest.prepare_vault_approve.await_count == 2

    @pytest.mark.asyncio
    async def test_place_order_clears_cached_spent_token_when_prepare_omits_approval(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        rest.prepare_order = AsyncMock(return_value={
            "to": "0xpool",
            "data": "0xfeed",
            "value": 0,
            "gas": 500_000,
        })
        engine._submitted_approvals[("SOMI:USDso", "USDso")] = Decimal("1000000000000000000")

        await engine._place_order("test", OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ))

        assert ("SOMI:USDso", "USDso") not in engine._submitted_approvals

    @pytest.mark.asyncio
    async def test_place_order_clears_cached_base_approval_on_erc20_sell(self, fake_components):
        engine, signer, rest, _, _ = fake_components
        rest.prepare_order = AsyncMock(return_value={
            "to": "0xpool",
            "data": "0xfeed",
            "value": 0,
            "gas": 500_000,
        })
        engine._submitted_approvals[("WETH:USDso", "WETH")] = Decimal("1000000000000000")

        await engine._place_order("test", OrderIntent(
            market=MarketSymbol.WETH_USDSO,
            side=Side.SELL,
            order_type=OrderType.IOC,
            quantity=Decimal("0.001"),
            price=Decimal("2000"),
            funding=FundingSource.WALLET,
            client_order_id="coid",
        ))

        assert ("WETH:USDso", "WETH") not in engine._submitted_approvals


class TestAccountMetrics:
    def test_compute_metrics_counts_shared_wallet_quote_once(self, fake_components):
        engine, _, _, _, _ = fake_components
        from dreamdex_bot.core.inventory import InventoryTracker

        engine.markets_to_watch = [MarketSymbol.SOMI_USDSO, MarketSymbol.WETH_USDSO]
        engine.inventory_tracker = InventoryTracker(engine.markets_to_watch)
        engine.market_state[MarketSymbol.SOMI_USDSO] = engine._book_to_state(
            MarketSymbol.SOMI_USDSO,
            {
                "bids": [{"price": "0.49", "quantity": "1"}],
                "asks": [{"price": "0.51", "quantity": "1"}],
            },
        )
        engine.market_state[MarketSymbol.WETH_USDSO] = engine._book_to_state(
            MarketSymbol.WETH_USDSO,
            {
                "bids": [{"price": "1999", "quantity": "1"}],
                "asks": [{"price": "2001", "quantity": "1"}],
            },
        )
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.WETH_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        inv_view = engine.inventory_tracker.to_strategy_view({
            MarketSymbol.SOMI_USDSO: Decimal("0.50"),
            MarketSymbol.WETH_USDSO: Decimal("2000"),
        })

        metrics = engine._compute_metrics(inv_view)

        assert metrics.total_value_usd == Decimal("55.00")


class TestTickBalanceReservation:
    def test_shared_quote_token_is_reserved_across_markets(self, fake_components):
        engine, _, _, _, _ = fake_components
        from dreamdex_bot.core.inventory import InventoryTracker

        engine.markets_to_watch = [MarketSymbol.SOMI_USDSO, MarketSymbol.WETH_USDSO]
        engine.inventory_tracker = InventoryTracker(engine.markets_to_watch)
        for market in engine.markets_to_watch:
            engine.inventory_tracker.set_initial_balances(
                market,
                wallet_base=Decimal("0"), wallet_quote=Decimal("10"),
                vault_base=Decimal("0"), vault_quote=Decimal("0"),
            )

        reserved_quote: dict[str, Decimal] = {}
        reserved_base: dict[str, Decimal] = {}
        first = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("10"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="first",
        ))
        second = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.WETH_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("0.01"),
            price=Decimal("600"),
            funding=FundingSource.WALLET,
            client_order_id="second",
        ))

        assert engine._reserve_tick_balance(first, reserved_quote, reserved_base) is True
        assert engine._reserve_tick_balance(second, reserved_quote, reserved_base) is False


class TestUnattendedSafeguards:
    def test_buy_is_blocked_below_native_gas_floor(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"min_native_somi": "3"}
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("2.9"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signal = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="gas-floor",
        ))

        assert engine._reserve_tick_balance(signal, {}, {}) is False

    def test_buy_is_blocked_below_liquid_quote_floor(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"min_liquid_usdso": "25"}
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("24.9"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signal = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="quote-floor",
        ))

        assert engine._reserve_tick_balance(signal, {}, {}) is False

    def test_buy_is_blocked_when_projected_quote_crosses_floor(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"min_liquid_usdso": "25"}
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("32"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signal = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("12"),
            price=Decimal("1"),
            funding=FundingSource.WALLET,
            client_order_id="projected-quote-floor",
        ))

        assert engine._reserve_tick_balance(signal, {}, {}) is False

    def test_buy_is_blocked_when_same_tick_reservations_cross_floor(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"min_liquid_usdso": "25"}
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("35"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signal = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("0.002"),
            price=Decimal("2000"),
            funding=FundingSource.WALLET,
            client_order_id="reserved-quote-floor",
        ))
        quote_token = engine.settings.quote_token(MarketSymbol.SOMI_USDSO).lower()

        assert engine._reserve_tick_balance(
            signal, {quote_token: Decimal("7")}, {},
        ) is False

    def test_sell_is_allowed_below_floors(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"min_native_somi": "3", "min_liquid_usdso": "25"}
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("2"), wallet_quote=Decimal("1"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signal = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.SELL,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="sell-through-floor",
        ))

        assert engine._reserve_tick_balance(signal, {}, {}) is True

    def test_drawdown_requires_repeated_snapshots(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"drawdown_confirmations": 3}
        event = RiskEvent(
            rule_name="max_drawdown", action=RiskAction.KILL_SWITCH,
            severity=Severity.CRITICAL, reason="temporary stale balance",
        )

        assert engine._confirm_drawdown_events([event]) == []
        assert engine._confirm_drawdown_events([event]) == []
        assert engine._confirm_drawdown_events([event]) == [event]

    def test_drawdown_pending_blocks_new_buys(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine._drawdown_pending = True
        engine.inventory_tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("50"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        signal = TradingSignal(action=SignalAction.PLACE, order=OrderIntent(
            market=MarketSymbol.SOMI_USDSO,
            side=Side.BUY,
            order_type=OrderType.IOC,
            quantity=Decimal("1"),
            price=Decimal("0.5"),
            funding=FundingSource.WALLET,
            client_order_id="drawdown-pending",
        ))

        assert engine._reserve_tick_balance(signal, {}, {}) is False

    @pytest.mark.asyncio
    async def test_max_drawdown_requests_flatten_without_stopping_worker(self, fake_components):
        engine, _, _, _, _ = fake_components
        event = RiskEvent(
            rule_name="max_drawdown", action=RiskAction.KILL_SWITCH,
            severity=Severity.CRITICAL, reason="drawdown threshold",
        )

        await engine._handle_risk_events([event])

        assert engine.paused_all is True
        assert engine._safe_exit_requested is True
        assert engine._safe_exit_reason == "max_drawdown"
        assert engine._safe_exit_stop_when_flat is False
        assert engine._stopped is False

    @pytest.mark.asyncio
    async def test_handled_max_drawdown_is_not_dispatched_again(self, fake_components):
        engine, _, _, _, _ = fake_components
        event = RiskEvent(
            rule_name="max_drawdown", action=RiskAction.KILL_SWITCH,
            severity=Severity.CRITICAL, reason="drawdown threshold",
        )

        await engine._handle_risk_events([event])

        assert engine._max_drawdown_handled is True
        assert engine._confirm_drawdown_events([event]) == []

    def test_runtime_limit_requests_safe_exit(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"max_runtime_sec": 1}
        engine._started_ts -= 2

        engine._check_unattended_limits()

        assert engine._safe_exit_requested is True
        assert engine._safe_exit_reason == "max_runtime_reached"

    def test_order_cap_requests_safe_exit(self, fake_components):
        engine, _, _, _, _ = fake_components
        engine.unattended_config = {"max_submitted_orders": 2}
        engine._submitted_order_count = 2

        engine._check_unattended_limits()

        assert engine._safe_exit_requested is True
        assert engine._safe_exit_reason == "max_submitted_orders_reached"


class TestRestBookReconcile:
    """Phase 2 Finding 1 mitigation: REST poll replaces a stale WS book."""

    def _state(self, engine, bid: str, ask: str):
        book = {
            "bids": [{"price": bid, "quantity": "1"}],
            "asks": [{"price": ask, "quantity": "1"}],
        }
        return engine._book_to_state(MarketSymbol.SOMI_USDSO, book)

    def test_drift_zero_when_books_agree(self, fake_components):
        engine, *_ = fake_components
        ws_state = self._state(engine, "0.1000", "0.1002")
        rest_state = self._state(engine, "0.1000", "0.1002")
        assert engine._bbo_drift_bps(ws_state, rest_state) == Decimal("0")

    def test_drift_detects_stale_bbo(self, fake_components):
        engine, *_ = fake_components
        # WS book 5 bps below the real BBO — the documented staleness case.
        ws_state = self._state(engine, "0.09995", "0.10015")
        rest_state = self._state(engine, "0.1000", "0.1002")
        drift = engine._bbo_drift_bps(ws_state, rest_state)
        assert drift is not None and drift > Decimal("4")

    def test_drift_none_when_ws_side_missing(self, fake_components):
        engine, *_ = fake_components
        rest_state = self._state(engine, "0.1000", "0.1002")
        assert engine._bbo_drift_bps(None, rest_state) is None

    @pytest.mark.asyncio
    async def test_reconcile_replaces_stale_book(self, fake_components):
        engine, signer, rest, ws, risk = fake_components
        market = MarketSymbol.SOMI_USDSO
        stale = {
            "bids": [{"price": "0.09995", "quantity": "1"}],
            "asks": [{"price": "0.10015", "quantity": "1"}],
        }
        fresh = {
            "bids": [{"price": "0.1000", "quantity": "1"}],
            "asks": [{"price": "0.1002", "quantity": "1"}],
        }
        engine._books[market] = stale
        engine.market_state[market] = engine._book_to_state(market, stale)
        rest.get_orderbook = AsyncMock(return_value=fresh)
        engine._reconcile_interval_sec = 0.01

        import asyncio as _asyncio
        task = _asyncio.create_task(engine._rest_book_reconcile_loop())
        await _asyncio.sleep(0.05)
        engine._stopped = True
        task.cancel()
        try:
            await task
        except _asyncio.CancelledError:
            pass

        assert engine.market_state[market].best_bid == Decimal("0.1000")
        assert engine.market_state[market].best_ask == Decimal("0.1002")
        assert engine._tick_event.is_set()


class TestPauseCancelsRestingOrders:
    """A sticky PAUSE_STRATEGY must not strand resting quotes on the book."""

    @pytest.mark.asyncio
    async def test_pause_strategy_cancels_open_orders(self, fake_components):
        engine, signer, rest, ws, risk = fake_components
        engine.open_orders = {"order-7": {
            "orderId": "order-7", "market": "SOMI:USDso", "side": "buy",
            "price": "0.5", "remainingQuantity": "10",
        }}
        ev = RiskEvent(
            rule_name="inventory_drift", action=RiskAction.PAUSE_STRATEGY,
            severity=Severity.HIGH, reason="drift cap", metadata={},
            strategy="yield_maker",
        )
        await engine._handle_risk_events([ev])
        assert "yield_maker" in engine.paused_strategies
        rest.prepare_cancel.assert_awaited_once_with("SOMI:USDso", "order-7")

        # Re-firing the same event while already paused must not re-cancel.
        rest.prepare_cancel.reset_mock()
        await engine._handle_risk_events([ev])
        assert rest.prepare_cancel.await_count == 0


class TestEquityCountsLockedCollateral:
    """Order-locked collateral is invisible to wallet/vault reads; equity
    must add it back or requote windows read as phantom drawdowns."""

    def test_open_buy_order_collateral_counts(self, fake_components):
        engine, *_ = fake_components
        engine.open_orders = {"order-1": {
            "orderId": "order-1", "market": "SOMI:USDso", "side": "buy",
            "price": "0.5", "remainingQuantity": "40",
        }}
        metrics = engine._compute_metrics({})
        assert metrics.total_value_usd == Decimal("20")

    def test_open_sell_order_marks_at_mid(self, fake_components):
        engine, *_ = fake_components
        market = MarketSymbol.SOMI_USDSO
        book = {
            "bids": [{"price": "0.4998", "quantity": "100"}],
            "asks": [{"price": "0.5002", "quantity": "100"}],
        }
        engine.market_state[market] = engine._book_to_state(market, book)
        engine.open_orders = {"order-2": {
            "orderId": "order-2", "market": "SOMI:USDso", "side": "sell",
            "price": "0.5002", "remainingQuantity": "40",
        }}
        metrics = engine._compute_metrics({})
        assert metrics.total_value_usd == Decimal("20")  # 40 × mid 0.5


class TestCancelUnresolvedIdGuard:
    """A cancel whose coid never resolved to a numeric exchange id must be
    dropped, not DELETEd (the API 400s on non-numeric ids)."""

    @pytest.mark.asyncio
    async def test_unresolved_coid_cancel_is_skipped(self, fake_components):
        engine, signer, rest, *_ = fake_components
        cancel = CancelIntent(
            market=MarketSymbol.SOMI_USDSO,
            order_id="ym_buy_phantom1", reason="requote",
        )
        await engine._cancel_order(cancel)
        rest.prepare_cancel.assert_not_awaited()
        signer.send_tx.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_resolved_coid_cancel_proceeds(self, fake_components):
        engine, signer, rest, *_ = fake_components
        engine.client_order_to_order_id["ym_buy_real1234"] = "147573952589684098111"
        cancel = CancelIntent(
            market=MarketSymbol.SOMI_USDSO,
            order_id="ym_buy_real1234", reason="requote",
        )
        await engine._cancel_order(cancel)
        rest.prepare_cancel.assert_awaited_once_with(
            "SOMI:USDso", "147573952589684098111")


class TestNotifyRejectDispatch:
    """Simulation failures must clear the owning strategy's quote tracking."""

    @pytest.mark.asyncio
    async def test_notify_reject_reaches_named_strategy(self, fake_components):
        engine, *_ = fake_components
        strat = MagicMock()
        strat.name = "yield_maker"
        strat.on_reject = AsyncMock()
        engine.strategies = [strat]
        await engine._notify_reject("yield_maker", "ym_buy_abc12345", "order_simulation_failed")
        strat.on_reject.assert_awaited_once_with("ym_buy_abc12345", "order_simulation_failed")


class TestIdleReconcile:
    """Idle reconciliation clears strategy quote-tracking for orders that
    vanished without a WS event — the recovery path for a missed fill/cancel
    that otherwise leaves the strategy believing it is quoting nothing."""

    def _strat_tracking(self, *coids):
        strat = MagicMock()
        strat.name = "yield_maker"
        strat.tracked_client_order_ids = MagicMock(return_value=set(coids))
        strat.on_reject = AsyncMock()
        return strat

    @pytest.mark.asyncio
    async def test_no_reconcile_when_recently_active(self, fake_components):
        engine, _, rest, _, _ = fake_components
        engine._idle_reconcile_after_sec = 45.0
        engine.last_successful_tx_ts = __import__("time").time()  # just traded
        await engine._maybe_idle_reconcile()
        rest.get_my_orders.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_vanished_order_cleared_after_threshold(self, fake_components):
        engine, _, rest, _, _ = fake_components
        engine._idle_reconcile_after_sec = 45.0
        engine._idle_reconcile_miss_threshold = 2
        engine.last_successful_tx_ts = 0.0  # long idle
        strat = self._strat_tracking("ym_buy_ghost01")
        engine.strategies = [strat]
        rest.get_my_orders = AsyncMock(return_value=[])  # exchange shows nothing

        # First idle pass: missing once — below threshold, not cleared yet.
        await engine._maybe_idle_reconcile()
        strat.on_reject.assert_not_awaited()
        assert engine._order_miss_counts.get("ym_buy_ghost01") == 1

        # Force the cadence gate open and run again: second miss → cleared.
        engine._last_idle_reconcile_ts = 0.0
        await engine._maybe_idle_reconcile()
        strat.on_reject.assert_awaited_once_with("ym_buy_ghost01", "idle_reconcile_vanished")

    @pytest.mark.asyncio
    async def test_recovered_order_resets_miss_count(self, fake_components):
        engine, _, rest, _, _ = fake_components
        engine._idle_reconcile_after_sec = 45.0
        engine._idle_reconcile_miss_threshold = 2
        engine.last_successful_tx_ts = 0.0
        strat = self._strat_tracking("ym_buy_real01")
        engine.strategies = [strat]
        rest.get_my_orders = AsyncMock(return_value=[])

        await engine._maybe_idle_reconcile()
        assert engine._order_miss_counts.get("ym_buy_real01") == 1

        # Listing recovers (Finding 11 transient gap): order is back.
        engine._last_idle_reconcile_ts = 0.0
        rest.get_my_orders = AsyncMock(return_value=[{
            "orderId": "111", "clientOrderId": "ym_buy_real01",
            "market": "SOMI:USDso", "side": "buy", "price": "0.5",
            "remainingQuantity": "10",
        }])
        await engine._maybe_idle_reconcile()
        strat.on_reject.assert_not_awaited()
        assert "ym_buy_real01" not in engine._order_miss_counts
