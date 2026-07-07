# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Generic one-shot IOC-sell to flatten stranded base inventory into USDso.

Use this whenever the bot has leftover base tokens it won't trade on its
own (e.g. you dropped a market from volume_mill but the wallet still
holds that pair's base). Mirrors tools/sell_wbtc.py but parameterized by
market + base currency.

Usage:
    python -m tools.flatten_inventory --market USDC.e:USDso --currency USDC.e
    python -m tools.flatten_inventory --market WBTC:USDso --currency WBTC --quantity 0.0003
    python -m tools.flatten_inventory --market USDC.e:USDso --currency USDC.e --dry-run

Token addresses + decimals are read from `dreamdex_bot.config.MARKETS`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import ssl
import time
import urllib.request
import urllib.parse as up
from decimal import Decimal, ROUND_DOWN

import certifi
import httpx

from dreamdex_bot.config import MARKETS, MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer


def _floor_lot(value: Decimal, lot: Decimal) -> Decimal:
    return (value / lot).to_integral_value(rounding=ROUND_DOWN) * lot


def _floor_tick(value: Decimal, tick: Decimal) -> Decimal:
    return (value / tick).to_integral_value(rounding=ROUND_DOWN) * tick


async def _read_wallet_base(signer: Signer, token_addr: str, decimals: int) -> Decimal:
    addr = signer.address.lower().replace("0x", "").zfill(64)
    data = "0x70a08231" + addr
    result = await signer.w3.eth.call({"to": token_addr, "data": data})
    raw_hex = result.hex() if hasattr(result, "hex") else str(result)
    if raw_hex.startswith("0x"):
        raw_hex = raw_hex[2:]
    raw = int(raw_hex, 16) if raw_hex else 0
    return Decimal(raw) / Decimal(10 ** decimals)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Flatten stranded base inventory to USDso.")
    parser.add_argument("--market", required=True, help="Market symbol (e.g. USDC.e:USDso)")
    parser.add_argument("--currency", required=True, help="Base token symbol to sell")
    parser.add_argument("--quantity", default=None, help="Base qty to sell (default: full on-chain balance)")
    parser.add_argument("--max-cross-bps", default="50", help="Discount below best bid (bps)")
    parser.add_argument("--dry-run", action="store_true", help="Print plan but don't broadcast")
    args = parser.parse_args()

    max_cross_bps = Decimal(args.max_cross_bps)
    settings = Settings()
    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()
    rest = RestClient(api_base=settings.api_url, signer=signer)

    try:
        market = MarketSymbol(args.market)
        spec = MARKETS[market]
        # Pull base token address from settings (handles testnet vs mainnet).
        token_addr = settings.base_token(market)
        decimals = spec.base_decimals
        tick = spec.tick_size
        lot = spec.lot_size
        min_qty = spec.min_quantity

        if args.quantity is not None:
            qty = Decimal(args.quantity)
            print(f"wallet={signer.address} qty_override={qty}")
        else:
            qty = await _read_wallet_base(signer, token_addr, decimals)
            print(f"wallet={signer.address} on_chain_{args.currency}={qty}")

        if qty <= 0:
            print(f"Nothing to sell — wallet {args.currency} balance is zero.")
            return

        qty = _floor_lot(qty, lot)
        if qty < min_qty:
            print(f"Quantity {qty} below {market.value} minimum ({min_qty}). Nothing to do.")
            return

        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{settings.api_url.rstrip('/')}/v0/orderbooks",
                params={"symbols": market.value, "depth": 10},
            )
            r.raise_for_status()
            data = r.json()
        books = data.get("orderbooks", [])
        book = next((b for b in books if b.get("symbol") == market.value), None)
        bids = (book or {}).get("bids") or []
        if not bids:
            raise SystemExit(f"No bids on {market.value}; cannot sell right now.")

        best_bid = Decimal(str(bids[0]["price"]))
        limit_price = _floor_tick(best_bid * (Decimal("1") - max_cross_bps / Decimal("10000")), tick)
        proceeds = qty * limit_price
        print(f"best_bid={best_bid} qty={qty} limit_price={limit_price} expected_proceeds=${proceeds:.4f}")

        if args.dry_run:
            print("Dry run — exiting before any tx.")
            return

        prep = await rest.prepare_order(
            market=market.value,
            side="sell",
            order_type="ioc",
            quantity=str(qty),
            price=str(limit_price),
            funding="wallet",
            client_order_id=f"flatten_{args.currency}_{int(time.time())}",
            wallet_address=signer.address,
        )
        approval = prep.get("approval") if isinstance(prep, dict) else None
        if approval:
            token = str(approval.get("token", ""))
            amount = str(approval.get("amount", "0"))
            print(f"approval_required token={token} amount={amount}")
            approve_prep = await rest.prepare_vault_approve(
                market.value, signer.address, args.currency, amount,
            )
            if approve_prep is not None:
                value = int(approve_prep.get("value", 0))
                gas = int(approve_prep.get("gasLimit", approve_prep.get("gas", 0)) or 0)
                if gas <= 0:
                    estimated = await signer.w3.eth.estimate_gas({
                        "from": signer.address,
                        "to": approve_prep["to"],
                        "data": approve_prep["data"],
                        "value": value,
                    })
                    gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), 200_000)
                approval_tx = await signer.send_tx(
                    to=approve_prep["to"], data=approve_prep["data"],
                    value=value, gas=gas,
                )
                print(f"approval_tx={approval_tx}")
                receipt = await signer.wait_for_receipt(approval_tx, timeout=60)
                print(f"approval_status={receipt.get('status')}")
                if int(receipt.get("status", 0)) != 1:
                    raise SystemExit("Approval failed; aborting flatten.")

        value = int(prep.get("value", 0))
        gas = int(prep.get("gasLimit", prep.get("gas", 0)) or 0)
        if gas <= 0:
            estimated = await signer.w3.eth.estimate_gas({
                "from": signer.address,
                "to": prep["to"],
                "data": prep["data"],
                "value": value,
            })
            gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), 500_000)

        success, order_id = await signer.simulate_order_tx(
            to=prep["to"], data=prep["data"], value=value, gas=gas,
        )
        print(f"simulation_success={success} order_id={order_id}")
        if success is False:
            raise SystemExit("Simulation rejected; not broadcasting.")

        tx = await signer.send_tx(to=prep["to"], data=prep["data"], value=value, gas=gas)
        print(f"sell_tx={tx}")
        receipt = await signer.wait_for_receipt(tx, timeout=60)
        logs_count = len(receipt.get("logs") or [])
        print(f"sell_status={receipt.get('status')} logs_count={logs_count}")
        if int(receipt.get("status", 0)) == 1 and logs_count > 0:
            print(f"Flatten complete: {qty} {args.currency} swept.")
        else:
            raise SystemExit("Sell confirmed without expected logs; check explorer before retry.")
    finally:
        await rest.close()


if __name__ == "__main__":
    asyncio.run(main())
