# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""dreamdex_core — shared DreamDEX client (Python).

    from dreamdex_core import create_chain_context, Pool, OrderType
    ctx = create_chain_context()
    pool = Pool.load(ctx, "SOMI:USDso")
    tob = pool.top_of_book()
    pool.place(is_bid=True, price=tob.best_ask * 1.0005, qty=1)  # IOC, crosses the ask
"""
from .config import Network, MarketMeta, NETWORKS, MARKETS, NATIVE_SENTINEL, get_network
from .client import ChainContext, create_chain_context
from .contract import SPOT_POOL_ABI, ERC20_ABI, TOPIC, PoolParams, read_pool_params, read_book_levels
from .execute import PlaceParams, PlaceResult, place_order, cancel_order, ensure_allowance, NATIVE_BASE_BUY_GAS
from .pool import Pool, TopOfBook
from .nonce import NonceManager, is_nonce_too_low
from .gotchas import (
    OrderType, SelfMatch, GotchaError, ZERO_ADDRESS, build_expire_ns,
    assert_expire_ns, assert_price_raw_nonzero, assert_qty_above_min,
)
from .quant import to_raw, from_raw, align_to_tick, align_to_lot, shift_bps, spread_bps

__all__ = [
    "Network", "MarketMeta", "NETWORKS", "MARKETS", "NATIVE_SENTINEL", "get_network",
    "ChainContext", "create_chain_context",
    "SPOT_POOL_ABI", "ERC20_ABI", "TOPIC", "PoolParams", "read_pool_params", "read_book_levels",
    "PlaceParams", "PlaceResult", "place_order", "cancel_order", "ensure_allowance", "NATIVE_BASE_BUY_GAS",
    "Pool", "TopOfBook", "NonceManager", "is_nonce_too_low",
    "OrderType", "SelfMatch", "GotchaError", "ZERO_ADDRESS", "build_expire_ns",
    "assert_expire_ns", "assert_price_raw_nonzero", "assert_qty_above_min",
    "to_raw", "from_raw", "align_to_tick", "align_to_lot", "shift_bps", "spread_bps",
]
