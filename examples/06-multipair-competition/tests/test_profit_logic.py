# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for profit-first maker pricing and inventory skew."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bot"))

from executor import LiveDreamDexBot  # noqa: E402


class StubBot(SimpleNamespace):
    market = SimpleNamespace(tick_size=100, base_decimals=18, quote_decimals=18)
    address = "0x0000000000000000000000000000000000000001"

    def _align_price(self, price_raw, is_bid):
        return LiveDreamDexBot._align_price(self, price_raw, is_bid)

    def _mid_price_raw(self, best_bid, best_ask):
        return LiveDreamDexBot._mid_price_raw(self, best_bid, best_ask)

    def _maker_price_touch(self, is_bid, best_bid, best_ask, improve_ticks=0):
        return LiveDreamDexBot._maker_price_touch(self, is_bid, best_bid, best_ask, improve_ticks)

    def _inventory_quote_sides(self, best_bid, best_ask, target_ratio, skew_bps):
        return LiveDreamDexBot._inventory_quote_sides(
            self, best_bid, best_ask, target_ratio, skew_bps
        )

    def _token_balance(self, token):
        return self.balances.get(token, 0)

    def _inventory_ratio(self, best_bid, best_ask):
        from decimal import Decimal

        quote_bal = self.balances.get("quote", 0)
        base_bal = self.balances.get("base", 0)
        mid = self._mid_price_raw(best_bid, best_ask)
        base_notional = int((Decimal(base_bal) * Decimal(mid)) / (Decimal(10) ** 18))
        total = quote_bal + base_notional
        if total <= 0:
            return 0.5
        return base_notional / total


class ProfitLogicTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bot = StubBot(balances={"quote": 500_000, "base": 500_000})

    def test_maker_touch_joins_book_without_crossing(self) -> None:
        bid = self.bot._maker_price_touch(True, 1000, 1200, improve_ticks=0)
        ask = self.bot._maker_price_touch(False, 1000, 1200, improve_ticks=0)
        self.assertEqual(bid, 1000)
        self.assertEqual(ask, 1200)
        self.assertLess(bid, ask)

    def test_maker_touch_improve_stays_post_only(self) -> None:
        bid = self.bot._maker_price_touch(True, 1000, 1300, improve_ticks=1)
        ask = self.bot._maker_price_touch(False, 1000, 1300, improve_ticks=1)
        self.assertLessEqual(bid, 1200)
        self.assertGreaterEqual(ask, 1100)
        self.assertLess(bid, ask)

    def test_inventory_skew_quotes_one_side_when_long_base(self) -> None:
        self.bot._inventory_ratio = lambda _b, _a: 0.75
        quote_bid, quote_ask = self.bot._inventory_quote_sides(1000, 1100, 0.5, 300)
        self.assertFalse(quote_bid)
        self.assertTrue(quote_ask)

    def test_inventory_skew_quotes_bid_when_long_quote(self) -> None:
        self.bot._inventory_ratio = lambda _b, _a: 0.20
        quote_bid, quote_ask = self.bot._inventory_quote_sides(1000, 1100, 0.5, 300)
        self.assertTrue(quote_bid)
        self.assertFalse(quote_ask)

    def test_balanced_inventory_quotes_both_sides(self) -> None:
        self.bot._inventory_ratio = lambda _b, _a: 0.50
        quote_bid, quote_ask = self.bot._inventory_quote_sides(1000, 1100, 0.5, 300)
        self.assertTrue(quote_bid)
        self.assertTrue(quote_ask)

    def test_always_two_sided_ignores_inventory_skew(self) -> None:
        from strategies.hybrid import HybridStrategy

        market = self.bot.market
        bot = self.bot
        bot.cfg = {
            "always_two_sided_mm": True,
            "maker_size_usdso": 30,
            "maker_min_size_usdso": 15,
            "funding_source_maker": "vault",
        }
        bot.funding_source_maker = "vault"
        bot._mm_inventory_balances_raw = lambda: (50 * 10**18, 2 * 10**18)
        bot._mid_price_raw = lambda _b, _a: 1000
        bot._maker_notional_quantity_raw = lambda n, _p, is_bid, _fs: (
            10**18 if n >= 15 else 0
        )
        bot.market = market
        market.min_quantity = 10**15
        hybrid = HybridStrategy(bot)  # type: ignore[arg-type]
        quote_bid, quote_ask = hybrid._quote_sides_for_mm(1000, 1100)
        self.assertTrue(quote_bid)
        self.assertTrue(quote_ask)


if __name__ == "__main__":
    unittest.main()
