# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""SpotPool ABI (modern, post-June-2026-upgrade), event topics, and read helpers.

Only what a bot needs. `placeOrder` is the single payable entry point — the old
`placeTakerOrderWithoutVault` was removed. Full reference: docs.dreamdex.io.
"""
from __future__ import annotations

from dataclasses import dataclass

_order_inputs = [
    {"name": "isBid", "type": "bool"},
    {"name": "userData", "type": "uint64"},
    {"name": "price", "type": "uint256"},
    {"name": "quantity", "type": "uint256"},
    {"name": "expireTimestampNs", "type": "uint64"},
    {"name": "orderType", "type": "uint8"},
    {"name": "selfMatchingOption", "type": "uint8"},
    {"name": "builder", "type": "address"},
    {"name": "builderFeeBpsTimes1k", "type": "uint96"},
]

SPOT_POOL_ABI = [
    {"type": "function", "name": "placeOrder", "stateMutability": "payable", "inputs": _order_inputs,
     "outputs": [{"name": "success", "type": "bool"}, {"name": "orderId", "type": "uint128"}]},
    {"type": "function", "name": "cancelOrder", "stateMutability": "nonpayable",
     "inputs": [{"name": "orderId", "type": "uint128"}], "outputs": []},
    {"type": "function", "name": "deposit", "stateMutability": "nonpayable",
     "inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "depositNative", "stateMutability": "payable", "inputs": [], "outputs": []},
    {"type": "function", "name": "withdraw", "stateMutability": "nonpayable",
     "inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}], "outputs": []},
    # getPoolParams: 7 returns — maker before taker, and tick -> minQuantity -> lot.
    {"type": "function", "name": "getPoolParams", "stateMutability": "view", "inputs": [], "outputs": [
        {"name": "baseToken_", "type": "address"}, {"name": "quoteToken_", "type": "address"},
        {"name": "makerFeeBpsTimes1k_", "type": "uint256"}, {"name": "takerFeeBpsTimes1k_", "type": "uint256"},
        {"name": "tickSize_", "type": "uint256"}, {"name": "minQuantity_", "type": "uint256"}, {"name": "lotSize_", "type": "uint256"}]},
    {"type": "function", "name": "getBookLevels", "stateMutability": "view",
     "inputs": [{"name": "isBid", "type": "bool"}, {"name": "numLevels", "type": "uint64"}],
     "outputs": [{"name": "", "type": "tuple[]", "components": [{"name": "price", "type": "uint256"}, {"name": "quantity", "type": "uint256"}]}]},
    {"type": "function", "name": "getWithdrawableBalance", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "token", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "getOwnOpenOrders", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "uint128[]"}]},
    {"type": "function", "name": "getAutoPullRequirement", "stateMutability": "view", "inputs": [
        {"name": "owner", "type": "address"}, {"name": "isBid", "type": "bool"}, {"name": "price", "type": "uint256"},
        {"name": "quantity", "type": "uint256"}, {"name": "builderFeeBpsTimes1k", "type": "uint96"}],
     "outputs": [{"name": "inputToken", "type": "address"}, {"name": "requiredAmount", "type": "uint256"}, {"name": "delta", "type": "uint256"}]},
]

ERC20_ABI = [
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}], "outputs": [{"name": "", "type": "bool"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"name": "account", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
]

# Pin topic0 from the docs — do NOT hand-roll from a signature string (OrderFilled
# gained `fillPrice` in the June 2026 upgrade, so its topic0 changed).
TOPIC = {
    "OrderPlaced": "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d",
    "OrderFilled": "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399",
    "OrderCancelled": "0x06ff08ed6b6987bb7df963009d8b54dc03988f4e465c009924929bb010fe03e7",
    "OrderExpired": "0x6003d149bc2c6baa0780d4302ad5f925fef5715780d3b6f7d2da5476548da101",
}


@dataclass
class PoolParams:
    base_token: str
    quote_token: str
    maker_fee_bps_times1k: int
    taker_fee_bps_times1k: int
    tick_size: int
    min_quantity: int
    lot_size: int


def read_pool_params(pool_contract) -> PoolParams:
    r = pool_contract.functions.getPoolParams().call()
    return PoolParams(r[0], r[1], r[2], r[3], r[4], r[5], r[6])


def read_book_levels(pool_contract, is_bid: bool, depth: int = 5) -> list[tuple[int, int]]:
    """(price_raw, size_raw) per level. getBookLevels returns an empty list on an
    empty book (it does NOT revert), so real RPC/ABI errors are allowed to
    propagate instead of being masked as an empty book."""
    levels = pool_contract.functions.getBookLevels(is_bid, depth).call()
    return [(lvl[0], lvl[1]) for lvl in levels]
