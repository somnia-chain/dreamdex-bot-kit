# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Read-only wallet/API preflight for DreamDEX.

Usage:
    python -m dreamdex_bot.preflight --config configs/mainnet.yaml

This command never prepares or broadcasts orders. It validates the configured
wallet, chain, market data, auth, gas balance, USDso balance, and unexpected
base inventory before a competition run.
"""

from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal
from pathlib import Path
from typing import Any

from eth_account import Account

from bots.main import load_yaml_config
from dreamdex_bot.config import MARKETS, MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer
from dreamdex_bot.utils.markets import raw_to_decimal


def _redact(address: str) -> str:
    return f"{address[:6]}...{address[-4:]}" if address else ""


async def _erc20_balance(signer: Signer, token: str, wallet: str) -> int:
    selector = "0x70a08231"
    addr = wallet.lower().removeprefix("0x").rjust(64, "0")
    raw = await signer.w3.eth.call({"to": token, "data": selector + addr})
    return int.from_bytes(raw, "big") if raw else 0


def _status(ok: bool) -> str:
    return "PASS" if ok else "WARN"


async def run(config_path: str | None, expected_usdso: Decimal, require_exact_usdso: bool) -> int:
    settings = Settings()
    cfg = load_yaml_config(config_path)
    markets = [MarketSymbol(s) for s in cfg["bot"]["markets_to_watch"]]
    for symbol in cfg.get("bootstrap", {}).get("candidate_markets", []):
        market = MarketSymbol(symbol)
        if market not in markets:
            markets.append(market)
    markets = [m for m in markets if settings.is_market_available(m)]

    print("DreamDEX preflight")
    print("network", settings.network.value)
    print("wallet", _redact(settings.wallet_address))
    print("config", config_path or "<defaults>")

    derived = Account.from_key(settings.private_key).address
    wallet_matches = derived.lower() == settings.wallet_address.lower()
    print(_status(wallet_matches), "private_key_matches_wallet", _redact(derived))

    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()
    rest = RestClient(api_base=settings.api_url, signer=signer)
    warnings = 0
    try:
        chain_id = await signer.w3.eth.chain_id
        native = raw_to_decimal(await signer.w3.eth.get_balance(settings.wallet_address), 18)
        print(_status(chain_id == settings.chain_id), "chain_id", chain_id)
        print(_status(native > 0), "native_gas_balance", native)
        if native <= 0:
            warnings += 1

        live_markets = await rest.get_markets()
        live_symbols = {m.get("symbol") for m in live_markets}
        missing = [m.value for m in markets if m.value not in live_symbols]
        print(_status(not missing), "markets_available", [m.value for m in markets])
        if missing:
            warnings += 1
            print("missing_markets", missing)

        await rest.ensure_auth()
        print("PASS", "auth_login")

        quote_token = settings.quote_token(MarketSymbol.SOMI_USDSO)
        quote_decimals = MARKETS[MarketSymbol.SOMI_USDSO].quote_decimals
        quote_raw = await _erc20_balance(signer, quote_token, settings.wallet_address)
        usdso = raw_to_decimal(quote_raw, quote_decimals)
        if require_exact_usdso:
            usdso_ok = usdso == expected_usdso
        else:
            usdso_ok = usdso >= expected_usdso
        print(_status(usdso_ok), "wallet_usdso", usdso, "expected", expected_usdso)
        if not usdso_ok:
            warnings += 1

        balances = await rest.get_account_balances(
            settings.wallet_address, markets=[m.value for m in markets],
        )
        print("PASS", "vault_balance_endpoint", balances)

        unexpected_base: dict[str, str] = {}
        for market in markets:
            spec = MARKETS[market]
            if spec.is_base_native:
                base = native
            else:
                raw = await _erc20_balance(signer, settings.base_token(market), settings.wallet_address)
                base = raw_to_decimal(raw, spec.base_decimals)
            if base > 0:
                unexpected_base[market.value] = str(base)
        if unexpected_base:
            print("WARN", "base_inventory_present", unexpected_base)
            warnings += 1
        else:
            print("PASS", "zero_base_inventory")

        for market in markets:
            book = await rest.get_orderbook(market.value, depth=5)
            bids = book.get("bids", [])
            asks = book.get("asks", [])
            ok = bool(bids and asks)
            print(
                _status(ok),
                "orderbook",
                market.value,
                "best_bid", bids[0]["price"] if bids else None,
                "best_ask", asks[0]["price"] if asks else None,
            )
            if not ok:
                warnings += 1
    finally:
        await rest.close()

    if not wallet_matches:
        warnings += 1
    print("warnings", warnings)
    return 0 if warnings == 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only DreamDEX preflight")
    parser.add_argument("--config", help="Config YAML path")
    parser.add_argument("--expected-usdso", default="50.00")
    parser.add_argument("--require-exact-usdso", action="store_true")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(
        run(
            config_path=args.config,
            expected_usdso=Decimal(args.expected_usdso),
            require_exact_usdso=args.require_exact_usdso,
        )
    ))


if __name__ == "__main__":
    main()
