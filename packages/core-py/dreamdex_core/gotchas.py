# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Pre-flight guards. One per entry in docs/gotchas.md. Fail loudly in your own
code rather than letting the chain silently reject an order."""
from __future__ import annotations

import time

NS_PER_MS = 1_000_000
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


class OrderType:
    NORMAL = 0        # GTC — rests if it doesn't fully fill
    FILL_OR_KILL = 1
    IOC = 2           # taker default
    POST_ONLY = 3     # maker-only


class SelfMatch:
    CANCEL_TAKER = 0
    CANCEL_MAKER = 1


class GotchaError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code


def build_expire_ns(duration_ms: int) -> int:
    """A future nanosecond expiry. 0/past/now are all rejected — there is no
    'no expiry' sentinel."""
    if duration_ms <= 0:
        raise GotchaError("EXPIRE_MS_NONPOSITIVE", f"duration_ms must be > 0 (got {duration_ms}).")
    return (int(time.time() * 1000) + duration_ms) * NS_PER_MS


def assert_expire_ns(expire_ns: int) -> None:
    now_ns = int(time.time() * 1000) * NS_PER_MS
    if expire_ns <= now_ns:
        raise GotchaError("EXPIRE_NS_NOT_FUTURE", f"expireTimestampNs must be in the future (got {expire_ns}). 0 is NOT 'no expiry'.")


def assert_price_raw_nonzero(price_raw: int) -> None:
    if price_raw <= 0:
        raise GotchaError("PRICE_RAW_ZERO", "priceRaw must be > 0. priceRaw=0 is a literal price, not 'market' — it never crosses.")


def assert_builder_disabled(builder: str, builder_fee: int) -> None:
    if builder.lower() != ZERO_ADDRESS:
        raise GotchaError("BUILDER_NOT_ZERO", "builder must be the zero address at v1.0 (builder codes are gated off).")
    if builder_fee != 0:
        raise GotchaError("BUILDER_FEE_NOT_ZERO", "builderFeeBpsTimes1k must be 0 when builder is the zero address.")


def assert_qty_multiple_of_lot(qty_raw: int, lot_raw: int) -> None:
    if lot_raw <= 0:
        raise GotchaError("LOT_RAW_ZERO", "lotRaw must be > 0.")
    if qty_raw % lot_raw != 0:
        raise GotchaError("QTY_NOT_LOT_MULTIPLE", f"quantity {qty_raw} is not a multiple of lotSize {lot_raw}.")


def assert_qty_above_min(qty_raw: int, min_qty_raw: int) -> None:
    if qty_raw < min_qty_raw:
        raise GotchaError("QTY_BELOW_MIN", f"quantity {qty_raw} is below the market minimum {min_qty_raw}.")


def assert_price_multiple_of_tick(price_raw: int, tick_raw: int) -> None:
    if tick_raw <= 0:
        raise GotchaError("TICK_RAW_ZERO", "tickRaw must be > 0.")
    if price_raw % tick_raw != 0:
        raise GotchaError("PRICE_NOT_TICK_MULTIPLE", f"price {price_raw} is not a multiple of tickSize {tick_raw}.")
