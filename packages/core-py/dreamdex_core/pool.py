# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Ergonomic Pool handle — human-unit reads and quantized writes over the safe
execute path. Strategies use this, not raw ABIs. Mirrors the TS core's pool.ts."""
from __future__ import annotations

from dataclasses import dataclass

from web3 import Web3

from .client import ChainContext
from .config import MARKETS, NATIVE_SENTINEL
from .contract import SPOT_POOL_ABI, ERC20_ABI, PoolParams, read_pool_params, read_book_levels
from .execute import PlaceParams, PlaceResult, place_order, cancel_order
from .gotchas import OrderType, build_expire_ns
from .nonce import NonceManager
from .quant import to_raw, from_raw, align_to_tick, align_to_lot


@dataclass
class TopOfBook:
    best_bid: float | None
    best_ask: float | None
    mid: float | None


class Pool:
    def __init__(self, ctx: ChainContext, meta, params: PoolParams) -> None:
        self.ctx = ctx
        self.symbol = meta.symbol
        self.address = Web3.to_checksum_address(meta.pool)
        self.base_is_native = meta.base_is_native
        self.base_decimals = meta.base_decimals
        self.quote_decimals = meta.quote_decimals
        self.params = params
        self.nm = NonceManager(ctx.w3, ctx.address)
        self._contract = ctx.w3.eth.contract(address=self.address, abi=SPOT_POOL_ABI)

    @classmethod
    def load(cls, ctx: ChainContext, symbol: str) -> "Pool":
        markets = MARKETS[ctx.net.name]
        if symbol not in markets:
            raise ValueError(f'Unknown market "{symbol}" on {ctx.net.name}.')
        meta = markets[symbol]
        contract = ctx.w3.eth.contract(address=Web3.to_checksum_address(meta.pool), abi=SPOT_POOL_ABI)
        return cls(ctx, meta, read_pool_params(contract))

    @property
    def tick(self) -> float:
        return from_raw(self.params.tick_size, self.quote_decimals)

    @property
    def lot(self) -> float:
        return from_raw(self.params.lot_size, self.base_decimals)

    @property
    def min_qty(self) -> float:
        return from_raw(self.params.min_quantity, self.base_decimals)

    def top_of_book(self, depth: int = 1) -> TopOfBook:
        bids = read_book_levels(self._contract, True, depth)
        asks = read_book_levels(self._contract, False, depth)
        best_bid = from_raw(bids[0][0], self.quote_decimals) if bids else None
        best_ask = from_raw(asks[0][0], self.quote_decimals) if asks else None
        mid = (best_bid + best_ask) / 2 if best_bid is not None and best_ask is not None else (best_bid or best_ask)
        return TopOfBook(best_bid, best_ask, mid)

    def place(self, *, is_bid: bool, price: float, qty: float, order_type: int = OrderType.IOC, expire_ms: int = 60 * 60_000) -> PlaceResult:
        side = "bid" if is_bid else "ask"
        price_raw = align_to_tick(to_raw(price, self.quote_decimals), self.params.tick_size, side)
        qty_raw = align_to_lot(to_raw(qty, self.base_decimals), self.params.lot_size)
        return place_order(self.ctx, self.nm, PlaceParams(
            pool=self.address, base_is_native=self.base_is_native, is_bid=is_bid,
            price_raw=price_raw, quantity_raw=qty_raw, tick_raw=self.params.tick_size,
            lot_raw=self.params.lot_size, min_qty_raw=self.params.min_quantity,
            expire_ns=build_expire_ns(expire_ms), order_type=order_type,
        ))

    def cancel(self, order_id: int) -> str:
        return cancel_order(self.ctx, self.nm, self.address, order_id)

    def vault_base(self) -> float:
        token = NATIVE_SENTINEL if self.base_is_native else self.params.base_token
        raw = self._contract.functions.getWithdrawableBalance(self.ctx.address, Web3.to_checksum_address(token)).call()
        return from_raw(raw, self.base_decimals)

    def wallet_base(self) -> float:
        """Base held in the WALLET — ERC-20 balanceOf, or the native balance for a
        native-base pool. Under the default auto-pull/auto-deliver mode fills settle
        to the wallet (the vault reads ~0), so THIS reflects live inventory for
        skew/hedging. Use vault_base() only in manual-vault mode."""
        if self.base_is_native:
            return from_raw(self.ctx.w3.eth.get_balance(self.ctx.address), self.base_decimals)
        erc = self.ctx.w3.eth.contract(address=Web3.to_checksum_address(self.params.base_token), abi=ERC20_ABI)
        return from_raw(erc.functions.balanceOf(self.ctx.address).call(), self.base_decimals)
