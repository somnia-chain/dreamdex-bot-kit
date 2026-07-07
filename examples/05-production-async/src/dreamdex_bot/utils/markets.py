# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Market-data helpers: tick/lot rounding, decimal-vs-raw-unit conversion.

The dreamDEX docs flag two systematic gotchas:
  - REST uses decimal strings; contracts use raw on-chain units. Mixing them
    silently produces orders at the wrong size by 10^decimals.
  - Price must be a multiple of tickSize, quantity must be a multiple of lotSize
    and >= minQuantity. Submitting off-grid values is a rejection class we want
    to handle defensively *and* probe deliberately (see probes/tick_precision.py).

All math here uses Decimal — never float, never int division on price ratios.
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Literal

from dreamdex_bot.config import MARKETS, MarketSymbol


def round_to_tick(
    price: Decimal,
    market: MarketSymbol,
    direction: Literal["down", "up", "nearest"] = "nearest",
) -> Decimal:
    """Round a price to the market's tick size."""
    tick = MARKETS[market].tick_size
    quotient = price / tick
    if direction == "down":
        quotient = quotient.to_integral_value(rounding=ROUND_DOWN)
    elif direction == "up":
        quotient = quotient.to_integral_value(rounding=ROUND_UP)
    else:
        quotient = quotient.quantize(Decimal("1"))
    return quotient * tick


def round_to_lot(
    quantity: Decimal,
    market: MarketSymbol,
    direction: Literal["down", "up"] = "down",
) -> Decimal:
    """Round a quantity DOWN to the lot size (default; conservative for size)."""
    lot = MARKETS[market].lot_size
    quotient = quantity / lot
    if direction == "down":
        quotient = quotient.to_integral_value(rounding=ROUND_DOWN)
    else:
        quotient = quotient.to_integral_value(rounding=ROUND_UP)
    return quotient * lot


def ensure_min_quantity(quantity: Decimal, market: MarketSymbol) -> Decimal | None:
    """Return quantity if it's >= the market's minQuantity, else None.
    Caller decides what to do with None (typically: skip the signal)."""
    min_q = MARKETS[market].min_quantity
    return quantity if quantity >= min_q else None


def decimal_to_raw(amount: Decimal, decimals: int) -> int:
    """Convert a human-readable Decimal to the raw on-chain integer.
    e.g. 1.5 USDso (6 decimals) → 1_500_000"""
    return int((amount * Decimal(10) ** decimals).to_integral_value(rounding=ROUND_DOWN))


def raw_to_decimal(raw: int, decimals: int) -> Decimal:
    """Inverse of decimal_to_raw."""
    return Decimal(raw) / (Decimal(10) ** decimals)


def quote_to_raw(price: Decimal, market: MarketSymbol) -> int:
    """Price field on chain — confirm whether dreamDEX stores prices as
    quote_raw_per_base or quote_decimal_per_base. The docs imply the former
    but we VERIFY on startup with a known orderbook entry."""
    spec = MARKETS[market]
    return decimal_to_raw(price, spec.quote_decimals)
