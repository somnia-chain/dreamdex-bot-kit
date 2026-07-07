# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Central configuration for dreamdex-bot.

Reads environment via pydantic-settings and exposes typed accessors for:
  - network (testnet/mainnet) → RPC + API URLs + chain ID
  - market metadata (tick, lot, min size, decimals) — pre-populated from
    /v0/markets on both testnet and mainnet (snapshot taken at build time).
    The engine still calls /v0/markets at startup and uses that as the
    canonical source of truth, treating these as fallback / sanity-check.

Symbols follow the dreamDEX convention: `BASE:USDso` (colon, not slash).
"""

from __future__ import annotations

from decimal import Decimal
from enum import Enum
from typing import Literal

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class Network(str, Enum):
    TESTNET = "testnet"
    MAINNET = "mainnet"


class MarketSymbol(str, Enum):
    """Dynamic markets. Symbol values are the dreamDEX canonical form."""
    WETH_USDSO = "WETH:USDso"
    SOMI_USDSO = "SOMI:USDso"
    USDC_USDSO = "USDC.e:USDso"   # Mainnet only as of build time
    WBTC_USDSO = "WBTC:USDso"


class MarketSpec(BaseModel):
    """Static market metadata. Validate against /v0/markets on startup."""
    symbol: MarketSymbol
    base_decimals: int
    quote_decimals: int
    tick_size: Decimal
    lot_size: Decimal
    min_quantity: Decimal
    pool_address_testnet: str
    pool_address_mainnet: str
    base_token_testnet: str
    base_token_mainnet: str
    quote_token_testnet: str
    quote_token_mainnet: str
    stop_registry_testnet: str
    stop_registry_mainnet: str
    is_base_native: bool = False
    mainnet_only: bool = False


# ────────────────────────────────────────────────────────────────────
# Live market data fetched from /v0/markets on May 23, 2026.
# These are authoritative at build time but the engine will re-fetch
# at startup and warn on any drift.
# ────────────────────────────────────────────────────────────────────

USDSO_MAINNET = "0x00000022dA000002656c64D9eA6011ea952D008A"  # 18 decimals
USDSO_TESTNET = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171"  # 18 decimals

MARKETS: dict[MarketSymbol, MarketSpec] = {
    MarketSymbol.WETH_USDSO: MarketSpec(
        symbol=MarketSymbol.WETH_USDSO,
        base_decimals=18,
        quote_decimals=18,
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.0001"),
        min_quantity=Decimal("0.001"),
        pool_address_mainnet="0xa936da11B57b50A344e1293AAaE5232885ea2bDE",
        pool_address_testnet="0xD180195da5459C7a0DEA188ed61216ec43682b50",
        base_token_mainnet="0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8",
        base_token_testnet="0x4d8E02BBfCf205828A8352Af4376b165E123D7b0",
        quote_token_mainnet=USDSO_MAINNET,
        quote_token_testnet=USDSO_TESTNET,
        stop_registry_mainnet="0x9653a7355849B7691802A6AA49fDe18eF5ba633d",
        stop_registry_testnet="0xf822D4Cb94902d667c9650e702aA5f096cc7598F",
        is_base_native=False,
    ),
    MarketSymbol.SOMI_USDSO: MarketSpec(
        symbol=MarketSymbol.SOMI_USDSO,
        base_decimals=18,
        quote_decimals=18,
        tick_size=Decimal("0.0001"),
        lot_size=Decimal("0.01"),
        min_quantity=Decimal("1"),
        pool_address_mainnet="0x035De7403eac6872787779CCA7CCF1b4CDb61379",
        pool_address_testnet="0x259fD6559214dd5aD3752322426eA9F9fABEFff4",
        base_token_mainnet="0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00",
        base_token_testnet="0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00",
        quote_token_mainnet=USDSO_MAINNET,
        quote_token_testnet=USDSO_TESTNET,
        stop_registry_mainnet="0x68c8f6fb1EA19A28F25358Ff00b8Ed8E1216df30",
        stop_registry_testnet="0xEb97349Aa62A68507c0bE535eD88B0d028a47E1e",
        is_base_native=True,  # SOMI is the native gas token
    ),
    MarketSymbol.USDC_USDSO: MarketSpec(
        symbol=MarketSymbol.USDC_USDSO,
        base_decimals=6,
        quote_decimals=18,
        tick_size=Decimal("0.0001"),
        lot_size=Decimal("0.01"),
        min_quantity=Decimal("1"),
        pool_address_mainnet="0x47fD2f18426f67106DBaC82F6d21D446c5F2120b",
        pool_address_testnet="",  # USDC.e:USDso is NOT deployed on testnet
        base_token_mainnet="0x28BEc7E30E6faee657a03e19Bf1128AaD7632A00",
        base_token_testnet="",
        quote_token_mainnet=USDSO_MAINNET,
        quote_token_testnet=USDSO_TESTNET,
        stop_registry_mainnet="0xD53E3F3b73513F2147377ef8f573f649cF60100c",
        stop_registry_testnet="",
        is_base_native=False,
        mainnet_only=True,
    ),
    MarketSymbol.WBTC_USDSO: MarketSpec(
        symbol=MarketSymbol.WBTC_USDSO,
        base_decimals=8,
        quote_decimals=18,
        tick_size=Decimal("0.1"),
        lot_size=Decimal("0.00001"),
        min_quantity=Decimal("0.0001"),
        pool_address_mainnet="0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA",
        pool_address_testnet="0x3605f28aA7C50e7441211e77Cb0762d49539326C",
        base_token_mainnet="0xC5098b3cA516784323872F17235fa074E167D3D2",
        base_token_testnet="0x4e85DC48a70DA1298489d5B6FC2492767d98f384",
        quote_token_mainnet=USDSO_MAINNET,
        quote_token_testnet=USDSO_TESTNET,
        stop_registry_mainnet="0xed32F048D6a47923D38eCeD868d6f8b0eB4852bd",
        stop_registry_testnet="0x53d5B2b0791b3992a1F3b5e0b0277Ee2e08B7aaD",
        is_base_native=False,
    ),
}


class Settings(BaseSettings):
    """Environment-driven settings."""
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    network: Network = Network.TESTNET
    wallet_address: str
    private_key: str  # NEVER log. __repr__ suppresses.

    testnet_rpc: str = "https://dream-rpc.somnia.network"
    mainnet_rpc: str = "https://api.infra.mainnet.somnia.network/"
    testnet_api: str = "https://stg.api.dreamdex.io"
    mainnet_api: str = "https://api.dreamdex.io"
    testnet_ws: str = "wss://stg.api.dreamdex.io/v0/ws/public"
    mainnet_ws: str = "wss://api.dreamdex.io/v0/ws/public"

    enable_volume_mill: bool = True
    enable_yield_maker: bool = True
    enable_qa_prober: bool = False

    max_realized_loss_usd: Decimal = Decimal("12.50")
    max_inventory_drift_usd: Decimal = Decimal("10.00")
    max_failed_tx_streak: int = 5
    max_open_orders: int = 8

    log_level: str = "INFO"
    log_dir: str = "./logs"

    @property
    def chain_id(self) -> int:
        return 50312 if self.network == Network.TESTNET else 5031

    @property
    def rpc_url(self) -> str:
        return self.testnet_rpc if self.network == Network.TESTNET else self.mainnet_rpc

    @property
    def api_url(self) -> str:
        return self.testnet_api if self.network == Network.TESTNET else self.mainnet_api

    @property
    def ws_url(self) -> str:
        return self.testnet_ws if self.network == Network.TESTNET else self.mainnet_ws

    def pool_address(self, market: MarketSymbol) -> str:
        s = MARKETS[market]
        return s.pool_address_testnet if self.network == Network.TESTNET else s.pool_address_mainnet

    def base_token(self, market: MarketSymbol) -> str:
        s = MARKETS[market]
        return s.base_token_testnet if self.network == Network.TESTNET else s.base_token_mainnet

    def quote_token(self, market: MarketSymbol) -> str:
        s = MARKETS[market]
        return s.quote_token_testnet if self.network == Network.TESTNET else s.quote_token_mainnet

    def stop_registry(self, market: MarketSymbol) -> str:
        s = MARKETS[market]
        return s.stop_registry_testnet if self.network == Network.TESTNET else s.stop_registry_mainnet

    def is_market_available(self, market: MarketSymbol) -> bool:
        """Returns True if this market is deployed on the active network."""
        s = MARKETS[market]
        if self.network == Network.TESTNET:
            return bool(s.pool_address_testnet) and not s.mainnet_only
        return bool(s.pool_address_mainnet)

    def available_markets(self) -> list[MarketSymbol]:
        return [m for m in MarketSymbol if self.is_market_available(m)]

    def __repr__(self) -> str:
        return f"Settings(network={self.network}, wallet={self.wallet_address[:10]}…)"


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
