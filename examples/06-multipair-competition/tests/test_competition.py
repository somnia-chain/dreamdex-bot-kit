# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for competition strategy helpers."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bot"))

from market_scanner import MarketScanner  # noqa: E402


class CompetitionLogicTests(unittest.TestCase):
    def _bot(self):
        market = SimpleNamespace(
            symbol="WETH:USDso",
            base="0xbase",
            quote="0xquote",
            base_is_native=False,
            quote_decimals=18,
            base_decimals=18,
            tick_size=100,
            min_quantity=1_000_000_000_000_000,
            quote_code="USDso",
            base_code="WETH",
        )
        bot = SimpleNamespace(
            cfg={
                "min_profitable_spread_bps": 12,
                "max_spread_bps": 80,
                "min_pair_score": 12,
                "maker_mode": "touch",
                "inventory_skew_bps": 200,
                "target_inventory_ratio": 0.5,
                "stablecoin_symbols": [],
            },
            markets_registry={"WETH:USDso": market},
            watch_symbols=["WETH:USDso"],
            market=market,
            reserve_native_wei=0,
        )
        bot._best_prices_for = MagicMock(return_value=(1000_000_000_000_000_000, 1012_000_000_000_000_000))
        bot._spread_bps = MagicMock(return_value=12)
        bot._maker_price_touch = MagicMock(side_effect=lambda is_bid, bid, ask, improve=0: bid if is_bid else ask)
        bot._inventory_quote_sides = MagicMock(return_value=(True, True))
        bot._spendable_quote_balance = MagicMock(return_value=100 * 10**18)
        bot._buy_quantity_from_balance = MagicMock(return_value=5 * 10**18)
        bot._sell_quantity_from_balance = MagicMock(return_value=0)
        bot._token_balance = MagicMock(return_value=0)
        bot.web3 = MagicMock()
        bot.web3.eth.get_balance = MagicMock(return_value=10**20)
        return bot

    def test_scan_all_respects_min_score(self) -> None:
        scanner = MarketScanner(self._bot())  # type: ignore[arg-type]
        self.assertIsNone(scanner.evaluate("WETH:USDso", min_score=999))
        opp = scanner.evaluate("WETH:USDso", min_score=10)
        self.assertIsNotNone(opp)

    def test_best_pulse_candidate_requires_wallet_action(self) -> None:
        bot = self._bot()
        bot._buy_quantity_from_balance = MagicMock(return_value=0)
        scanner = MarketScanner(bot)  # type: ignore[arg-type]
        self.assertIsNone(scanner.best_pulse_candidate(8))


class CompetitionStrategyTests(unittest.TestCase):
    def test_dynamic_spread_relaxes_when_idle(self) -> None:
        from strategies.competition import CompetitionStrategy

        bot = SimpleNamespace(
            cfg={
                "min_profitable_spread_bps": 12,
                "min_spread_floor_bps": 8,
                "idle_relax_hours": 18,
                "activity_pulse_hours": 20,
                "activity_pulse_size_fraction": 0.08,
                "volume_boost_edge_bps": 18,
                "volume_boost_size_fraction": 0.28,
                "min_pair_score": 12,
                "watch_opportunities": False,
            },
            watch_symbols=[],
        )
        strategy = CompetitionStrategy(bot)  # type: ignore[arg-type]
        self.assertEqual(strategy._dynamic_min_spread(0), 12)
        self.assertEqual(strategy._dynamic_min_spread(19 * 3600), 8)


if __name__ == "__main__":
    unittest.main()
