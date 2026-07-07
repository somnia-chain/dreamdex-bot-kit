# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

from __future__ import annotations

import argparse
import asyncio
import time
from decimal import Decimal, ROUND_CEILING

import httpx

from dreamdex_bot.config import MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer


def _ceil_tick(value: Decimal, tick: Decimal = Decimal("0.0001")) -> Decimal:
    return (value / tick).to_integral_value(rounding=ROUND_CEILING) * tick


async def main() -> None:
    parser = argparse.ArgumentParser(description="Buy native SOMI with USDso for gas.")
    parser.add_argument("--quantity", default="10", help="SOMI quantity to buy")
    parser.add_argument("--max-cross-bps", default="100", help="Price buffer above best ask")
    args = parser.parse_args()

    qty = Decimal(args.quantity)
    max_cross_bps = Decimal(args.max_cross_bps)
    settings = Settings()
    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()
    rest = RestClient(api_base=settings.api_url, signer=signer)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{settings.api_url.rstrip('/')}/v0/orderbooks",
                params={"symbols": MarketSymbol.SOMI_USDSO.value, "depth": 10},
            )
            r.raise_for_status()
            data = r.json()
        books = data.get("orderbooks", [])
        book = next((b for b in books if b.get("symbol") == MarketSymbol.SOMI_USDSO.value), None)
        asks = (book or {}).get("asks") or []
        if not asks:
            raise SystemExit("No SOMI asks available; cannot buy gas token right now.")

        best_ask = Decimal(str(asks[0]["price"]))
        limit_price = _ceil_tick(best_ask * (Decimal("1") + max_cross_bps / Decimal("10000")))
        notional = qty * limit_price
        print(f"wallet={signer.address}")
        print(f"best_ask={best_ask} qty={qty} limit_price={limit_price} max_notional={notional}")

        prep = await rest.prepare_order(
            market=MarketSymbol.SOMI_USDSO.value,
            side="buy",
            order_type="ioc",
            quantity=str(qty),
            price=str(limit_price),
            funding="wallet",
            client_order_id=f"gas_somi_buy_{int(time.time())}",
            wallet_address=signer.address,
        )

        approval = prep.get("approval") if isinstance(prep, dict) else None
        if approval:
            token = str(approval.get("token", ""))
            amount = str(approval.get("amount", "0"))
            print(f"approval_required token={token} amount={amount}")
            approve_prep = await rest.prepare_vault_approve(
                MarketSymbol.SOMI_USDSO.value,
                signer.address,
                "USDso",
                amount,
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
                    to=approve_prep["to"],
                    data=approve_prep["data"],
                    value=value,
                    gas=gas,
                )
                print(f"approval_tx={approval_tx}")
                approval_receipt = await signer.wait_for_receipt(approval_tx, timeout=60)
                print(f"approval_status={approval_receipt.get('status')}")
                if int(approval_receipt.get("status", 0)) != 1:
                    raise SystemExit("Approval failed; aborting SOMI buy.")

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
            to=prep["to"],
            data=prep["data"],
            value=value,
            gas=gas,
        )
        print(f"simulation_success={success} order_id={order_id}")
        if success is False:
            raise SystemExit("Prepared SOMI buy simulated as rejected; not broadcasting.")

        tx = await signer.send_tx(to=prep["to"], data=prep["data"], value=value, gas=gas)
        print(f"buy_tx={tx}")
        receipt = await signer.wait_for_receipt(tx, timeout=60)
        logs_count = len(receipt.get("logs") or [])
        print(f"buy_status={receipt.get('status')} logs_count={logs_count}")
        if int(receipt.get("status", 0)) == 1 and logs_count > 0:
            print("SOMI gas top-up submitted and confirmed.")
        else:
            raise SystemExit("Buy tx confirmed without expected logs; check explorer before retrying.")
    finally:
        await rest.close()


if __name__ == "__main__":
    asyncio.run(main())
