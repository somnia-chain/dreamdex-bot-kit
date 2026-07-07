# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Network + market configuration. Mirrors packages/core/src/config in the TS core.

The chain ID must agree in two places: the id you SIGN txs with, and the
`Chain ID` in the SIWE login message. See docs/gotchas.md.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

# GOTCHA: the native SOMI sentinel. Native SOMI has no ERC-20 contract; its
# vault-balance side is keyed by this sentinel, NOT address(0).
NATIVE_SENTINEL = "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00"


@dataclass(frozen=True)
class Network:
    name: str
    chain_id: int
    native_symbol: str
    rpc_url: str
    rest_api: str  # includes /v0
    ws_url: str


NETWORKS: dict[str, Network] = {
    "mainnet": Network(
        name="mainnet",
        chain_id=5031,
        native_symbol="SOMI",
        rpc_url=os.environ.get("RPC_URL", "https://api.infra.mainnet.somnia.network"),
        rest_api=os.environ.get("REST_API_URL", "https://api.dreamdex.io/v0"),
        ws_url=os.environ.get("WS_URL", "wss://api.dreamdex.io/v0/ws/public"),
    ),
    "testnet": Network(
        name="testnet",
        chain_id=50312,
        native_symbol="STT",
        rpc_url=os.environ.get("RPC_URL", "https://dream-rpc.somnia.network"),
        rest_api=os.environ.get("REST_API_URL", "https://stg.api.dreamdex.io/v0"),
        ws_url=os.environ.get("WS_URL", "wss://stg.api.dreamdex.io/v0/ws/public"),
    ),
}


def get_network() -> Network:
    raw = os.environ.get("NETWORK", "testnet").lower()
    if raw not in NETWORKS:
        raise ValueError(f'Invalid NETWORK="{raw}". Use "mainnet" or "testnet".')
    return NETWORKS[raw]


@dataclass(frozen=True)
class MarketMeta:
    symbol: str
    pool: str
    base_decimals: int
    quote_decimals: int  # USDso is 18 everywhere
    base_is_native: bool


# Convenience table. The canonical source is GET /v0/markets and getPoolParams();
# query them at runtime rather than trusting this list.
MARKETS: dict[str, dict[str, MarketMeta]] = {
    "mainnet": {
        "SOMI:USDso": MarketMeta("SOMI:USDso", "0x035De7403eac6872787779CCA7CCF1b4CDb61379", 18, 18, True),
        "USDC.e:USDso": MarketMeta("USDC.e:USDso", "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b", 6, 18, False),
        "WBTC:USDso": MarketMeta("WBTC:USDso", "0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA", 8, 18, False),
        "WETH:USDso": MarketMeta("WETH:USDso", "0xa936da11B57b50A344e1293AAaE5232885ea2bDE", 18, 18, False),
    },
    "testnet": {
        "SOMI:USDso": MarketMeta("SOMI:USDso", "0x259fD6559214dd5aD3752322426eA9F9fABEFff4", 18, 18, True),
        "WBTC:USDso": MarketMeta("WBTC:USDso", "0x3605f28aA7C50e7441211e77Cb0762d49539326C", 8, 18, False),
        "WETH:USDso": MarketMeta("WETH:USDso", "0xD180195da5459C7a0DEA188ed61216ec43682b50", 18, 18, False),
    },
}
