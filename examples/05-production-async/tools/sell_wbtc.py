# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
One-shot WBTC → USDso flush for Phase 2 survival-mode transition.

After dropping WBTC from `volume_mill.markets`, any residual WBTC inventory
sits stranded because no strategy manages it. This script does a single
wallet-funded IOC sell of whatever WBTC is in the wallet, mirroring the
proven flow from `tools/buy_somi_gas.py` (approval if required → simulate →
broadcast → wait for receipt).

Usage:
    python -m tools.sell_wbtc                # auto-detects on-chain WBTC balance
    python -m tools.sell_wbtc --quantity 0.0003
    python -m tools.sell_wbtc --max-cross-bps 200   # wider safety margin

The default 50 bps cross is generous for a 2-bps book and ensures the IOC
fills in one shot.
"""
from __future__ import annotations

import argparse
import asyncio
import time
from decimal import Decimal, ROUND_DOWN

import httpx

from dreamdex_bot.config import MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer


WBTC_TOKEN = "0xC5098b3cA516784323872F17235fa074E167D3D2"
WBTC_DECIMALS = 8


def _floor_tick(value: Decimal, tick: Decimal = Decimal("0.1")) -> Decimal:
    return (value / tick).to_integral_value(rounding=ROUND_DOWN) * tick


async def _read_wallet_wbtc(signer: Signer) -> Decimal:
    """Read on-chain WBTC balance via balanceOf(address)."""
    addr = signer.address.lower().replace("0x", "").zfill(64)
    data = "0x70a08231" + addr
    result = await signer.w3.eth.call({"to": WBTC_TOKEN, "data": data})
    raw_hex = result.hex() if hasattr(result, "hex") else str(result)
    if raw_hex.startswith("0x"):
        raw_hex = raw_hex[2:]
    raw = int(raw_hex, 16) if raw_hex else 0
    return Decimal(raw) / Decimal(10 ** WBTC_DECIMALS)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Sell WBTC inventory back to USDso.")
    parser.add_argument("--quantity", default=None, help="WBTC quantity to sell (default: auto-detect)")
    parser.add_argument("--max-cross-bps", default="50", help="Price discount below best bid (bps)")
    parser.add_argument("--dry-run", action="store_true", help="Print plan but don't broadcast")
    args = parser.parse_args()

    max_cross_bps = Decimal(args.max_cross_bps)
    settings = Settings()
    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()
    rest = RestClient(api_base=settings.api_url, signer=signer)

    try:
        if args.quantity is not None:
            qty = Decimal(args.quantity)
            print(f"wallet={signer.address} qty_override={qty}")
        else:
            qty = await _read_wallet_wbtc(signer)
            print(f"wallet={signer.address} on_chain_wbtc={qty}")

        if qty <= 0:
            print("Nothing to sell — wallet WBTC balance is zero.")
            return

        # Lot size for WBTC:USDso is 0.00001 — round qty down to lot
        qty = (qty / Decimal("0.00001")).to_integral_value(rounding=ROUND_DOWN) * Decimal("0.00001")
        # Min quantity on WBTC:USDso is 0.0001
        if qty < Decimal("0.0001"):
            print(f"Quantity {qty} below WBTC:USDso minimum (0.0001). Nothing to do.")
            return

        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{settings.api_url.rstrip('/')}/v0/orderbooks",
                params={"symbols": MarketSymbol.WBTC_USDSO.value, "depth": 10},
            )
            r.raise_for_status()
            data = r.json()
        books = data.get("orderbooks", [])
        book = next((b for b in books if b.get("symbol") == MarketSymbol.WBTC_USDSO.value), None)
        bids = (book or {}).get("bids") or []
        if not bids:
            raise SystemExit("No WBTC bids available; cannot sell right now.")

        best_bid = Decimal(str(bids[0]["price"]))
        # Sell at best_bid * (1 - cross), rounded DOWN to tick (0.1 for WBTC)
        limit_price = _floor_tick(best_bid * (Decimal("1") - max_cross_bps / Decimal("10000")))
        proceeds_usd = qty * limit_price
        print(f"best_bid={best_bid} qty={qty} limit_price={limit_price} expected_proceeds=${proceeds_usd:.4f}")

        if args.dry_run:
            print("Dry run — exiting before any tx is built.")
            return

        prep = await rest.prepare_order(
            market=MarketSymbol.WBTC_USDSO.value,
            side="sell",
            order_type="ioc",
            quantity=str(qty),
            price=str(limit_price),
            funding="wallet",
            client_order_id=f"flush_wbtc_{int(time.time())}",
            wallet_address=signer.address,
        )

        # Approval: when selling wallet-funded, the WBTC token needs to be approved
        # to the orderbook contract. The REST prepare_order response tells us if so.
        approval = prep.get("approval") if isinstance(prep, dict) else None
        if approval:
            token = str(approval.get("token", ""))
            amount = str(approval.get("amount", "0"))
            print(f"approval_required token={token} amount={amount}")
            approve_prep = await rest.prepare_vault_approve(
                MarketSymbol.WBTC_USDSO.value,
                signer.address,
                "WBTC",
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
                    raise SystemExit("Approval failed; aborting WBTC sell.")

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
            raise SystemExit("Prepared WBTC sell simulated as rejected; not broadcasting.")

        tx = await signer.send_tx(to=prep["to"], data=prep["data"], value=value, gas=gas)
        print(f"sell_tx={tx}")
        receipt = await signer.wait_for_receipt(tx, timeout=60)
        logs_count = len(receipt.get("logs") or [])
        print(f"sell_status={receipt.get('status')} logs_count={logs_count}")
        if int(receipt.get("status", 0)) == 1 and logs_count > 0:
            print("WBTC flush submitted and confirmed.")
        else:
            raise SystemExit("Sell tx confirmed without expected logs; check explorer before re-running.")
    finally:
        await rest.close()


if __name__ == "__main__":
    asyncio.run(main())
