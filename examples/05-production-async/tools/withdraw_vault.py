# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Inverse of tools/deposit_vault.py — pull collateral out of a market's
vault back into the wallet.

Used to recover idle USDso left behind after a yield_maker test so it
can fund IOC cycling in the wallet.

Usage:
    python -m tools.withdraw_vault --market USDC.e:USDso --currency USDso --amount 10
    python -m tools.withdraw_vault --market USDC.e:USDso --currency USDso --amount 10 --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal

from dreamdex_bot.config import MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer


async def main() -> None:
    parser = argparse.ArgumentParser(description="Withdraw a token from the dreamDEX vault.")
    parser.add_argument("--market", default="USDC.e:USDso", help="Market the vault belongs to")
    parser.add_argument("--currency", required=True, help="Token symbol (e.g. USDso, USDC.e)")
    parser.add_argument("--amount", required=True, help="Amount in token units")
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
        print(f"plan: withdraw {amount} {args.currency} from {market.value} vault")

        if args.dry_run:
            print("Dry run — exiting before any tx.")
            return

        prep = await rest.prepare_vault_withdraw(
            market.value, signer.address, args.currency, str(amount),
        )
        if prep is None:
            raise SystemExit("prepare_vault_withdraw returned None")
        value = int(prep.get("value", 0))
        gas = int(prep.get("gasLimit", prep.get("gas", 0)) or 0)
        if gas <= 0:
            estimated = await signer.w3.eth.estimate_gas({
                "from": signer.address,
                "to": prep["to"],
                "data": prep["data"],
                "value": value,
            })
            gas = max(int(Decimal(int(estimated)) * Decimal("1.25")), 400_000)
        tx = await signer.send_tx(
            to=prep["to"], data=prep["data"], value=value, gas=gas,
        )
        print(f"withdraw_tx={tx}")
        receipt = await signer.wait_for_receipt(tx, timeout=60)
        logs_count = len(receipt.get("logs") or [])
        print(f"withdraw_status={receipt.get('status')} logs_count={logs_count}")
        if int(receipt.get("status", 0)) != 1 or logs_count == 0:
            raise SystemExit("Withdraw tx did not produce expected logs; check explorer.")
        print(f"Vault withdraw confirmed: {amount} {args.currency} back in wallet.")
    finally:
        await rest.close()


if __name__ == "__main__":
    asyncio.run(main())
