# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Order execution — the safe placeOrder lifecycle (mirrors the TS core's execute.ts):
guard -> fund (getAutoPullRequirement) -> simulate -> broadcast -> verify OrderPlaced
-> read orderId from the receipt. Native-base buys get the >=5M gas floor.
"""
from __future__ import annotations

from dataclasses import dataclass

from web3 import Web3

from .client import ChainContext
from .config import NATIVE_SENTINEL
from .contract import SPOT_POOL_ABI, ERC20_ABI, TOPIC
from .gotchas import (
    OrderType, SelfMatch, ZERO_ADDRESS, GotchaError,
    assert_expire_ns, assert_price_raw_nonzero, assert_builder_disabled,
    assert_qty_above_min, assert_qty_multiple_of_lot, assert_price_multiple_of_tick,
)
from .nonce import NonceManager

NATIVE_BASE_BUY_GAS = 5_000_000
DEFAULT_GAS = 700_000


@dataclass
class PlaceParams:
    pool: str
    base_is_native: bool
    is_bid: bool
    price_raw: int
    quantity_raw: int
    tick_raw: int
    lot_raw: int
    min_qty_raw: int
    expire_ns: int
    order_type: int = OrderType.IOC


@dataclass
class PlaceResult:
    tx_hash: str
    order_id: int | None
    gas_used: int


def place_order(ctx: ChainContext, nm: NonceManager, p: PlaceParams) -> PlaceResult:
    # 1. Guards.
    assert_expire_ns(p.expire_ns)
    assert_price_raw_nonzero(p.price_raw)
    assert_price_multiple_of_tick(p.price_raw, p.tick_raw)
    assert_qty_above_min(p.quantity_raw, p.min_qty_raw)
    assert_qty_multiple_of_lot(p.quantity_raw, p.lot_raw)
    assert_builder_disabled(ZERO_ADDRESS, 0)

    pool = ctx.w3.eth.contract(address=Web3.to_checksum_address(p.pool), abi=SPOT_POOL_ABI)
    args = [p.is_bid, 0, p.price_raw, p.quantity_raw, p.expire_ns, p.order_type,
            SelfMatch.CANCEL_TAKER, ZERO_ADDRESS, 0]

    # 2. Funding: ask the pool exactly what it will pull.
    input_token, required, _delta = pool.functions.getAutoPullRequirement(
        ctx.address, p.is_bid, p.price_raw, p.quantity_raw, 0
    ).call()
    value = 0
    if input_token.lower() == NATIVE_SENTINEL.lower():
        value = required
    else:
        ensure_allowance(ctx, nm, input_token, p.pool, required)

    # 3. Simulate. A revert here (or success=False) means don't broadcast.
    try:
        ok, _sim_id = pool.functions.placeOrder(*args).call({"from": ctx.address, "value": value})
    except Exception as err:
        raise GotchaError("SIM_REVERT", f"placeOrder simulation reverted: {err}") from err
    if not ok:
        raise GotchaError("SIM_FALSE", "placeOrder simulation returned success=False (would silently reject).")

    # Gas: estimate for real, apply headroom + a floor. Native ops are gas-heavy;
    # native buys must clear the >=5M payout guard.
    gas = _pick_gas(ctx, pool, args, value, p.base_is_native, p.is_bid)

    tx = pool.functions.placeOrder(*args).build_transaction({
        "from": ctx.address, "nonce": nm.reserve(), "gas": gas, "value": value,
        "chainId": ctx.net.chain_id, **nm.gas_fields(),
    })
    receipt = _sign_send_wait(ctx, nm, tx)
    if receipt["status"] != 1:
        raise GotchaError("TX_REVERTED", f"placeOrder tx reverted: {receipt['transactionHash'].hex()}")

    # 4/5. Confirm OrderPlaced and read the real orderId from the receipt.
    order_id = None
    for log in receipt["logs"]:
        topics = log["topics"]
        if topics and topics[0].hex().lower().lstrip("0x") == TOPIC["OrderPlaced"].lower().lstrip("0x"):
            order_id = int(topics[1].hex(), 16)
            break
    if order_id is None:
        raise GotchaError("SILENT_REJECTION", "tx mined but no OrderPlaced log — order was rejected.")

    return PlaceResult(receipt["transactionHash"].hex(), order_id, receipt["gasUsed"])


def cancel_order(ctx: ChainContext, nm: NonceManager, pool_addr: str, order_id: int) -> str:
    pool = ctx.w3.eth.contract(address=Web3.to_checksum_address(pool_addr), abi=SPOT_POOL_ABI)
    # Cancelling a NATIVE-base maker order is gas-heavy — a fixed 700k reverts.
    # Estimate, with a generous floor/fallback.
    try:
        est = pool.functions.cancelOrder(order_id).estimate_gas({"from": ctx.address})
        gas = max(int(est * 1.3), 2_000_000)
    except Exception:
        gas = 6_000_000
    tx = pool.functions.cancelOrder(order_id).build_transaction({
        "from": ctx.address, "nonce": nm.reserve(), "gas": gas,
        "chainId": ctx.net.chain_id, **nm.gas_fields(),
    })
    receipt = _sign_send_wait(ctx, nm, tx)
    return receipt["transactionHash"].hex()


def ensure_allowance(ctx: ChainContext, nm: NonceManager, token: str, spender: str, amount: int) -> None:
    erc = ctx.w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI)
    current = erc.functions.allowance(ctx.address, Web3.to_checksum_address(spender)).call()
    if current >= amount:
        return
    tx = erc.functions.approve(Web3.to_checksum_address(spender), amount * 8).build_transaction({
        "from": ctx.address, "nonce": nm.reserve(), "gas": DEFAULT_GAS,
        "chainId": ctx.net.chain_id, **nm.gas_fields(),
    })
    _sign_send_wait(ctx, nm, tx)


def _pick_gas(ctx: ChainContext, pool, args, value: int, base_is_native: bool, is_bid: bool) -> int:
    # native BUY needs the 5M payout headroom; native SELL is still gas-heavy;
    # ERC-20 ops are light.
    floor = (NATIVE_BASE_BUY_GAS if is_bid else 2_000_000) if base_is_native else DEFAULT_GAS
    try:
        est = pool.functions.placeOrder(*args).estimate_gas({"from": ctx.address, "value": value})
        return max(int(est * 1.3), floor)
    except Exception:
        return max(floor, 2_000_000)


def _sign_send_wait(ctx: ChainContext, nm: NonceManager, tx: dict):
    try:
        signed = ctx.account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        h = ctx.w3.eth.send_raw_transaction(raw)
        return ctx.w3.eth.wait_for_transaction_receipt(h, timeout=120)
    except Exception:
        nm.reset()  # burn the nonce; force a fresh sync next time
        raise
