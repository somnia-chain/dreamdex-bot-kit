# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Unit tests for bot core constants and helpers (no network)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bot"))

from executor import (  # noqa: E402
    NATIVE_BASE_BUY_GAS,
    ORDER_FOK,
    ORDER_IOC,
    ORDER_NORMAL,
    ORDER_POST_ONLY,
    ORDER_TYPE_API,
    ORDER_TYPE_ON_CHAIN,
)
from ws_book import OrderBookFeed  # noqa: E402


class OrderTypeTests(unittest.TestCase):
    def test_api_on_chain_roundtrip(self) -> None:
        for on_chain, api_name in ORDER_TYPE_API.items():
            self.assertEqual(ORDER_TYPE_ON_CHAIN[api_name], on_chain)

    def test_post_only_mapping(self) -> None:
        self.assertEqual(ORDER_TYPE_API[ORDER_POST_ONLY], "postOnly")
        self.assertEqual(ORDER_TYPE_ON_CHAIN["immediateOrCancel"], ORDER_IOC)

    def test_native_buy_gas_floor(self) -> None:
        self.assertGreaterEqual(NATIVE_BASE_BUY_GAS, 5_000_000)


class OrderBookFeedTests(unittest.TestCase):
    def test_apply_levels_updates_best_prices(self) -> None:
        feed = OrderBookFeed("USDC.e:USDso")
        feed._apply_levels("bid", [{"price": "1.00", "quantity": "10"}], quote_decimals=18)
        feed._apply_levels("ask", [{"price": "1.01", "quantity": "5"}], quote_decimals=18)
        bid, ask = feed.best_prices()
        self.assertEqual(bid, 10**18)
        self.assertEqual(ask, 101 * 10**16)

    def test_zero_quantity_removes_level(self) -> None:
        feed = OrderBookFeed("USDC.e:USDso")
        feed._apply_levels("bid", [{"price": "1.00", "quantity": "10"}], quote_decimals=18)
        feed._apply_levels("bid", [{"price": "1.00", "quantity": "0"}], quote_decimals=18)
        self.assertIsNone(feed.best_prices()[0])


if __name__ == "__main__":
    unittest.main()
