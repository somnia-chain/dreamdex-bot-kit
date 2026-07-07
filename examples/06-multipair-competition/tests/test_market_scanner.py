# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for multi-pair opportunity scoring."""
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bot"))

from market_scanner import MarketScanner  # noqa: E402


class MarketScannerTests(unittest.TestCase):
    def _scanner(self) -> MarketScanner:
        market = SimpleNamespace(
            symbol="USDC.e:USDso",
            base="0xbase",
            quote="0xquote",
            base_is_native=False,
            quote_decimals=18,
            base_decimals=18,
            tick_size=100,
            min_quantity=1_000_000,
            quote_code="USDso",
            base_code="USDC.e",
        )
        bot = SimpleNamespace(
            cfg={
                "min_profitable_spread_bps": 20,
                "max_spread_bps": 80,
                "min_pair_score": 20,
                "maker_mode": "touch",
                "inventory_skew_bps": 300,
                "target_inventory_ratio": 0.5,
                "stablecoin_symbols": ["USDC.e:USDso"],
                "stablecoin_target_price": "1.0",
            },
            markets_registry={"USDC.e:USDso": market},
            watch_symbols=["USDC.e:USDso"],
            market=market,
        )
        bot._best_prices_for = MagicMock(return_value=(990_000_000_000_000_000, 1_010_000_000_000_000_000))
        bot._spread_bps = MagicMock(return_value=50)
        bot._maker_price_touch = MagicMock(side_effect=lambda is_bid, bid, ask, improve=0: bid if is_bid else ask)
        bot._maker_price = MagicMock()
        bot._mid_price_raw = MagicMock(return_value=1_000_000_000_000_000_000)
        bot._inventory_quote_sides = MagicMock(return_value=(True, True))
        bot._spendable_quote_balance = MagicMock(return_value=0)
        bot._buy_quantity_from_balance = MagicMock(return_value=0)
        bot._sell_quantity_from_balance = MagicMock(return_value=0)
        bot._token_balance = MagicMock(return_value=0)
        bot.web3 = MagicMock()
        bot.web3.eth.get_balance = MagicMock(return_value=0)
        bot.reserve_native_wei = 0
        return MarketScanner(bot)  # type: ignore[arg-type]

    def test_evaluate_returns_opportunity_on_wide_spread(self) -> None:
        opp = self._scanner().evaluate("USDC.e:USDso")
        self.assertIsNotNone(opp)
        assert opp is not None
        self.assertGreater(opp.score, 0)
        self.assertEqual(opp.edge_bps, 200)

    def test_score_zero_when_spread_too_wide(self) -> None:
        scanner = self._scanner()
        scanner.bot._spread_bps = MagicMock(return_value=500)
        self.assertIsNone(scanner.evaluate("USDC.e:USDso"))

    def test_watch_reports_market_side_without_wallet_balance(self) -> None:
        scanner = self._scanner()
        scanner.bot._token_balance = MagicMock(return_value=0)
        scanner.bot._spendable_quote_balance = MagicMock(return_value=0)
        scanner.bot._buy_quantity_from_balance = MagicMock(return_value=0)
        scanner.bot._sell_quantity_from_balance = MagicMock(return_value=0)
        scanner.bot.web3 = MagicMock()
        scanner.bot.web3.eth.get_balance = MagicMock(return_value=0)
        scanner.bot.reserve_native_wei = 0

        report = scanner.watch_pair("USDC.e:USDso")
        self.assertIsNotNone(report)
        assert report is not None
        self.assertTrue(report.market_ok)
        self.assertTrue(report.market_buy)
        self.assertTrue(report.market_sell)
        self.assertFalse(report.wallet_buy)
        self.assertFalse(report.wallet_sell)

        summary = scanner.format_watch_summary([report])
        self.assertIn("market:OK", summary)
        self.assertIn("buy→", summary)
        self.assertIn("sell→", summary)


if __name__ == "__main__":
    unittest.main()
