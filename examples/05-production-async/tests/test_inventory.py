# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for the InventoryTracker: balance updates, lock tracking, PnL math."""

from decimal import Decimal

import pytest

from dreamdex_bot.config import MarketSymbol
from dreamdex_bot.core.inventory import InventoryTracker
from dreamdex_bot.interfaces.strategy import Side


@pytest.fixture
def tracker():
    return InventoryTracker([MarketSymbol.SOMI_USDSO, MarketSymbol.USDC_USDSO])


class TestInitialBalances:
    def test_sets_initial_balances(self, tracker):
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("100"),
            vault_base=Decimal("20"), vault_quote=Decimal("200"),
        )
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.wallet_base == Decimal("10")
        assert s.vault_quote == Decimal("200")

    def test_other_market_unchanged(self, tracker):
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("10"), wallet_quote=Decimal("100"),
            vault_base=Decimal("20"), vault_quote=Decimal("200"),
        )
        other = tracker.get(MarketSymbol.USDC_USDSO)
        assert other.wallet_base == Decimal("0")
        assert other.vault_quote == Decimal("0")


class TestOrderLocks:
    def test_buy_order_locks_quote(self, tracker):
        # Resting buy at 0.50 for 100 SOMI locks 50 USDso
        tracker.on_order_placed(MarketSymbol.SOMI_USDSO, Side.BUY,
                                qty=Decimal("100"), price=Decimal("0.50"))
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.quote_locked_in_orders == Decimal("50.00")
        assert s.base_locked_in_orders == Decimal("0")

    def test_sell_order_locks_base(self, tracker):
        tracker.on_order_placed(MarketSymbol.SOMI_USDSO, Side.SELL,
                                qty=Decimal("100"), price=Decimal("0.55"))
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.base_locked_in_orders == Decimal("100")
        assert s.quote_locked_in_orders == Decimal("0")

    def test_cancel_releases_lock(self, tracker):
        tracker.on_order_placed(MarketSymbol.SOMI_USDSO, Side.BUY,
                                qty=Decimal("100"), price=Decimal("0.50"))
        # Cancel with full remaining → fully unlock
        tracker.on_order_cancelled(MarketSymbol.SOMI_USDSO, Side.BUY,
                                    remaining_qty=Decimal("100"), price=Decimal("0.50"))
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.quote_locked_in_orders == Decimal("0")

    def test_cancel_partial_releases_only_remaining(self, tracker):
        tracker.on_order_placed(MarketSymbol.SOMI_USDSO, Side.SELL,
                                qty=Decimal("100"), price=Decimal("0.50"))
        # 30 already filled, cancel releases remaining 70
        tracker.on_order_cancelled(MarketSymbol.SOMI_USDSO, Side.SELL,
                                    remaining_qty=Decimal("70"), price=Decimal("0.50"))
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.base_locked_in_orders == Decimal("30")

    def test_cancel_never_goes_negative(self, tracker):
        """Defensive: out-of-order events should never produce negative locks."""
        tracker.on_order_cancelled(MarketSymbol.SOMI_USDSO, Side.BUY,
                                    remaining_qty=Decimal("1000"), price=Decimal("1"))
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.quote_locked_in_orders >= Decimal("0")


class TestFillsAndPnL:
    def test_buy_fill_moves_balances(self, tracker):
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("100"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        # Wallet-funded buy: 50 SOMI at 0.50, paying 25 USDso
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("50"), price=Decimal("0.50"),
                        funding="wallet", is_maker=False)
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.wallet_base == Decimal("50")
        assert s.wallet_quote == Decimal("75")

    def test_sell_fill_moves_balances(self, tracker):
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("100"), wallet_quote=Decimal("0"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.SELL,
                        qty=Decimal("30"), price=Decimal("0.60"),
                        funding="wallet", is_maker=False)
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        assert s.wallet_base == Decimal("70")
        assert s.wallet_quote == Decimal("18")

    def test_maker_fill_releases_lock(self, tracker):
        # Set up a resting bid + maker fill should release that bid's lock
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("0"),
            vault_base=Decimal("0"), vault_quote=Decimal("100"),
        )
        tracker.on_order_placed(MarketSymbol.SOMI_USDSO, Side.BUY,
                                qty=Decimal("50"), price=Decimal("0.50"))
        assert tracker.get(MarketSymbol.SOMI_USDSO).quote_locked_in_orders == Decimal("25")

        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("50"), price=Decimal("0.50"),
                        funding="vault", is_maker=True)
        s = tracker.get(MarketSymbol.SOMI_USDSO)
        # Lock should be released
        assert s.quote_locked_in_orders == Decimal("0")
        assert s.vault_base == Decimal("50")
        assert s.vault_quote == Decimal("75")

    def test_realized_pnl_closing_long(self, tracker):
        """Buy at 0.50, sell at 0.60 → realized PnL = 0.10 * qty."""
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("1000"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("100"), price=Decimal("0.50"),
                        funding="wallet", is_maker=False)
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.SELL,
                        qty=Decimal("100"), price=Decimal("0.60"),
                        funding="wallet", is_maker=False)
        acct = tracker.get(MarketSymbol.SOMI_USDSO).account
        # Closed 100 units, made 0.10 per unit → 10 USDso PnL
        assert acct.realized_pnl_quote == Decimal("10.00")
        assert acct.position_base == Decimal("0")

    def test_realized_pnl_partial_close(self, tracker):
        """Buy 100 at 0.50, sell 40 at 0.60 → realized = 0.10 * 40 = 4."""
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("1000"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("100"), price=Decimal("0.50"),
                        funding="wallet", is_maker=False)
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.SELL,
                        qty=Decimal("40"), price=Decimal("0.60"),
                        funding="wallet", is_maker=False)
        acct = tracker.get(MarketSymbol.SOMI_USDSO).account
        assert acct.realized_pnl_quote == Decimal("4.00")
        assert acct.position_base == Decimal("60")
        assert acct.avg_entry_price == Decimal("0.50")

    def test_unrealized_pnl_at_mark(self, tracker):
        """Buy 100 at 0.50, mark at 0.55 → unrealized = 100 * 0.05 = 5."""
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("1000"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("100"), price=Decimal("0.50"),
                        funding="wallet", is_maker=False)
        unrealized = tracker.unrealized_pnl(MarketSymbol.SOMI_USDSO, Decimal("0.55"))
        assert unrealized == Decimal("5.00")

    def test_weighted_avg_entry_on_extend(self, tracker):
        """Buy 100 at 0.50, then buy 100 at 0.60 → avg entry = 0.55."""
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("1000"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("100"), price=Decimal("0.50"),
                        funding="wallet", is_maker=False)
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("100"), price=Decimal("0.60"),
                        funding="wallet", is_maker=False)
        acct = tracker.get(MarketSymbol.SOMI_USDSO).account
        assert acct.position_base == Decimal("200")
        assert acct.avg_entry_price == Decimal("0.55")


class TestStrategyView:
    def test_to_own_inventory_includes_unrealized(self, tracker):
        tracker.set_initial_balances(
            MarketSymbol.SOMI_USDSO,
            wallet_base=Decimal("0"), wallet_quote=Decimal("1000"),
            vault_base=Decimal("0"), vault_quote=Decimal("0"),
        )
        tracker.on_fill(MarketSymbol.SOMI_USDSO, Side.BUY,
                        qty=Decimal("100"), price=Decimal("0.50"),
                        funding="wallet", is_maker=False)
        view = tracker.to_strategy_view({
            MarketSymbol.SOMI_USDSO: Decimal("0.55"),
        })
        inv = view[MarketSymbol.SOMI_USDSO]
        assert inv.unrealized_pnl_usd == Decimal("5.00")
        assert inv.base_balance == Decimal("100")
