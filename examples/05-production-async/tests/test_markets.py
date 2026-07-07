# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for tick/lot/decimal utility helpers."""

from decimal import Decimal

from dreamdex_bot.config import MarketSymbol
from dreamdex_bot.utils.markets import (
    decimal_to_raw, ensure_min_quantity, quote_to_raw, raw_to_decimal,
    round_to_lot, round_to_tick,
)


class TestRoundToTick:
    def test_rounds_down(self):
        # WETH:USDso tick is 0.01
        result = round_to_tick(Decimal("1234.567"), MarketSymbol.WETH_USDSO, direction="down")
        assert result == Decimal("1234.56")

    def test_rounds_up(self):
        result = round_to_tick(Decimal("1234.561"), MarketSymbol.WETH_USDSO, direction="up")
        assert result == Decimal("1234.57")

    def test_exact_value_unchanged(self):
        result = round_to_tick(Decimal("1234.50"), MarketSymbol.WETH_USDSO, direction="down")
        assert result == Decimal("1234.50")

    def test_nearest(self):
        # SOMI tick is 0.0001
        result = round_to_tick(Decimal("0.50005"), MarketSymbol.SOMI_USDSO, direction="nearest")
        # 0.50005 / 0.0001 = 5000.5, banker's rounding to even integer = 5000
        assert result == Decimal("0.5000")


class TestRoundToLot:
    def test_rounds_down_by_default(self):
        # SOMI lot is 0.01
        result = round_to_lot(Decimal("12.345"), MarketSymbol.SOMI_USDSO)
        assert result == Decimal("12.34")

    def test_below_lot_rounds_to_zero(self):
        result = round_to_lot(Decimal("0.005"), MarketSymbol.SOMI_USDSO)
        assert result == Decimal("0.00")


class TestEnsureMinQuantity:
    def test_above_min_returns_qty(self):
        # SOMI minQuantity is 1
        result = ensure_min_quantity(Decimal("5"), MarketSymbol.SOMI_USDSO)
        assert result == Decimal("5")

    def test_below_min_returns_none(self):
        result = ensure_min_quantity(Decimal("0.5"), MarketSymbol.SOMI_USDSO)
        assert result is None

    def test_at_exactly_min_returns_qty(self):
        result = ensure_min_quantity(Decimal("1"), MarketSymbol.SOMI_USDSO)
        assert result == Decimal("1")


class TestDecimalRawConversion:
    def test_usdso_6_decimals(self):
        # If a token were 6 decimals: 1.5 → 1_500_000
        assert decimal_to_raw(Decimal("1.5"), 6) == 1_500_000

    def test_usdso_18_decimals(self):
        # Real USDso is 18 decimals: 1.5 → 1_500_000_000_000_000_000
        assert decimal_to_raw(Decimal("1.5"), 18) == 1_500_000_000_000_000_000

    def test_round_trip(self):
        original = Decimal("123.456789")
        assert raw_to_decimal(decimal_to_raw(original, 18), 18) == original

    def test_quote_to_raw_uses_market_decimals(self):
        # USDC.e:USDso quote (USDso) has 18 decimals — that's the conversion basis
        raw = quote_to_raw(Decimal("1.0"), MarketSymbol.USDC_USDSO)
        assert raw == 10**18

    def test_truncation_not_rounding(self):
        # 1.999999... at 6 decimals should truncate to 1_999_999
        assert decimal_to_raw(Decimal("1.9999999"), 6) == 1_999_999
