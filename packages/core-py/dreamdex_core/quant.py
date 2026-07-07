# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tick/lot/decimal math in integer space (avoids float off-by-one-tick rejects)."""
from __future__ import annotations

from decimal import Decimal


def to_raw(human: float | str, decimals: int) -> int:
    """human value -> raw integer (value * 10**decimals), via Decimal for precision."""
    return int((Decimal(str(human)) * (Decimal(10) ** decimals)).to_integral_value())


def from_raw(raw: int, decimals: int) -> float:
    return float(Decimal(raw) / (Decimal(10) ** decimals))


def align_to_tick(price_raw: int, tick_raw: int, side: str) -> int:
    """Round DOWN for a bid, UP for an ask, to the nearest tick multiple."""
    if tick_raw <= 0:
        raise ValueError("tick_raw must be > 0")
    rem = price_raw % tick_raw
    if rem == 0:
        return price_raw
    return price_raw - rem if side == "bid" else price_raw - rem + tick_raw


def align_to_lot(qty_raw: int, lot_raw: int) -> int:
    """Round DOWN to the nearest lot multiple (never over-spend)."""
    if lot_raw <= 0:
        raise ValueError("lot_raw must be > 0")
    return qty_raw - (qty_raw % lot_raw)


def shift_bps(price: float, bps: float) -> float:
    return price * (1 + bps / 10_000)


def spread_bps(best_bid: float, best_ask: float) -> float:
    mid = (best_bid + best_ask) / 2
    return ((best_ask - best_bid) / mid) * 10_000 if mid > 0 else 0.0
