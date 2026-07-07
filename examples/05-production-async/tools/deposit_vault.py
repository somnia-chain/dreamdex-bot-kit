# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
One-shot vault deposit for the yield-maker test.

The dreamDEX collateral-yield mechanism only rewards open interest from
POST_ONLY / GTC orders, which require vault funding. This script deposits
USDso from the wallet into the protocol vault so yield_maker can post
resting maker orders.

Mirrors the proven flow from tools/buy_somi_gas.py:
    prepare_vault_approve (if needed) → broadcast approval → wait for receipt
    prepare_vault_deposit → broadcast deposit → wait for receipt

Usage:
    python -m tools.deposit_vault --market USDC.e:USDso --currency USDso --amount 15
    python -m tools.deposit_vault --market USDC.e:USDso --currency USDC.e --amount 5
    python -m tools.deposit_vault --currency USDso --amount 15 --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal

from dreamdex_bot.config import MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer


async def main() -> None:
    parser = argparse.ArgumentParser(description="Deposit a token into the dreamDEX vault.")
    parser.add_argument("--market", default="USDC.e:USDso", help="Market the vault belongs to")
    parser.add_argument("--currency", required=True, help="Token symbol to deposit (e.g. USDso, USDC.e)")
    parser.add_argument("--amount", required=True, help="Amount in token units (e.g. 15 for 15 USDso)")
    parser.add_argument("--dry-run", action="store_true", help="Print plan but don't broadcast")
    args = parser.parse_args()

    amount = Decimal(args.amount)
    settings = Settings()
    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()
    rest = RestClient(api_base=settings.api_url, signer=signer)

    try:
        market = MarketSymbol(args.market)
        print(f"wallet={signer.address}")
        print(f"plan: deposit {amount} {args.currency} into {market.value} vault")

        if args.dry_run:
            print("Dry run — exiting before any tx.")
            return

        # Approval (some tokens need an allowance bump to the vault contract).
        approve_prep = await rest.prepare_vault_approve(
            market.value, signer.address, args.currency, str(amount)
        )
        if approve_prep is not None and approve_prep.get("to"):
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
            receipt = await signer.wait_for_receipt(approval_tx, timeout=60)
            print(f"approval_status={receipt.get('status')}")
            if int(receipt.get("status", 0)) != 1:
                raise SystemExit("Vault approval failed; aborting deposit.")
        else:
            print("No approval required (native token or pre-approved).")

        # Deposit itself.
        deposit_prep = await rest.prepare_vault_deposit(
            market.value, signer.address, args.currency, str(amount)
        )
        if deposit_prep is None:
            raise SystemExit("prepare_vault_deposit returned None")
        value = int(deposit_prep.get("value", 0))
        gas = int(deposit_prep.get("gasLimit", deposit_prep.get("gas", 0)) or 0)
        if gas <= 0:
            estimated = await signer.w3.eth.estimate_gas({
                "from": signer.address,
                "to": deposit_prep["to"],
                "data": deposit_prep["data"],
                "value": value,
            })
            gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), 400_000)
        deposit_tx = await signer.send_tx(
            to=deposit_prep["to"],
            data=deposit_prep["data"],
            value=value,
            gas=gas,
        )
        print(f"deposit_tx={deposit_tx}")
        receipt = await signer.wait_for_receipt(deposit_tx, timeout=60)
        logs_count = len(receipt.get("logs") or [])
        print(f"deposit_status={receipt.get('status')} logs_count={logs_count}")
        if int(receipt.get("status", 0)) != 1 or logs_count == 0:
            raise SystemExit("Deposit tx did not produce expected logs; check explorer.")
        print("Vault deposit confirmed.")
    finally:
        await rest.close()


if __name__ == "__main__":
    asyncio.run(main())
