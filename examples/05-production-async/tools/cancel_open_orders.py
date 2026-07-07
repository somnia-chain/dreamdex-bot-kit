# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Cancel every open order on a given market for the bot wallet.

Used to unwind the yield_maker test cleanly before switching back to
volume_mill (otherwise the resting maker orders self-match against the
incoming IOC stream and cancelTaker STP silently drops every IOC).

Mirrors the prepare/sign/broadcast/await-receipt flow used by the engine
in `_cancel_order` so it behaves identically to an in-bot cancel.

Usage:
    python -m tools.cancel_open_orders --market USDC.e:USDso
    python -m tools.cancel_open_orders --market USDC.e:USDso --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal

from dreamdex_bot.config import MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer


async def main() -> None:
    parser = argparse.ArgumentParser(description="Cancel every open order on a market.")
    parser.add_argument("--market", default="USDC.e:USDso", help="Market symbol")
    parser.add_argument("--dry-run", action="store_true", help="List orders without cancelling")
    args = parser.parse_args()

    settings = Settings()
    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()
    rest = RestClient(api_base=settings.api_url, signer=signer)

    try:
        market = MarketSymbol(args.market)
        orders = await rest.get_my_orders(market=market.value, status="open")
        print(f"wallet={signer.address}")
        print(f"market={market.value}")
        print(f"open_orders={len(orders)}")

        if not orders:
            print("Nothing to cancel.")
            return

        for o in orders:
            oid = str(o.get("order_id") or o.get("id") or "")
            side = o.get("side", "?")
            price = o.get("price", "?")
            qty = o.get("quantity", o.get("amount", "?"))
            print(f"  id={oid} side={side} price={price} qty={qty}")

        if args.dry_run:
            print("Dry run — exiting before any cancel tx.")
            return

        for o in orders:
            oid = str(o.get("order_id") or o.get("id") or "")
            if not oid or not oid.isdigit():
                print(f"  skip non-numeric id: {oid}")
                continue
            try:
                prep = await rest.prepare_cancel(market.value, oid)
            except Exception as e:
                print(f"  cancel_prepare_failed id={oid} error={e}")
                continue
            value = int(prep.get("value", 0))
            gas = int(prep.get("gasLimit", prep.get("gas", 0)) or 0)
            if gas <= 0:
                try:
                    estimated = await signer.w3.eth.estimate_gas({
                        "from": signer.address,
                        "to": prep["to"],
                        "data": prep["data"],
                        "value": value,
                    })
                    gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), 200_000)
                except Exception:
                    gas = 500_000
            try:
                tx_hash = await signer.send_tx(
                    to=prep["to"], data=prep["data"], value=value, gas=gas,
                )
                print(f"  cancel_submitted id={oid} tx={tx_hash}")
                receipt = await signer.wait_for_receipt(tx_hash, timeout=60)
                print(f"  cancel_status id={oid} status={receipt.get('status')}")
            except Exception as e:
                print(f"  cancel_broadcast_failed id={oid} error={e}")

        # Verify
        remaining = await rest.get_my_orders(market=market.value, status="open")
        print(f"remaining_open_orders={len(remaining)}")
    finally:
        await rest.close()


if __name__ == "__main__":
    asyncio.run(main())
