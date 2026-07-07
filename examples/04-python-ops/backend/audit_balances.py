#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/audit_balances.py
"""
Comprehensive multi-wallet balance auditor.

Checks every place value could be hiding for one or more wallets:
- Wallet ERC20 holdings (USDso, USDC.e, WETH, WBTC)
- Native SOMI in wallet
- Vault holdings in every pool: both quote (USDso) AND base (SOMI/USDC.e/WETH/WBTC)
- Live mid-prices from REST orderbook for USD valuation

Use:
  cd backend && python audit_balances.py                     # A + B (defaults)
  cd backend && python audit_balances.py 0xWalletA 0xWalletB # explicit list
  cd backend && python audit_balances.py --start 50          # per-wallet start cap

Inside Docker:
  docker exec dreamdex-agent python /app/audit_balances.py
"""
import argparse
import os
import sys
import requests
from web3 import Web3
from config import SOMNIA_RPC, MY_ADDRESS, MARKETS, USDSO_ADDRESS, ENV

DEFAULT_WALLETS = [
    ("Wallet A", MY_ADDRESS),
    ("Wallet B", os.environ.get("WALLET_B_ADDRESS") or
                 "0x75716940c2c9e4F40C1fEB1664706A3c5904A638"),
]

ERC20_ABI = [{
    "name": "balanceOf", "type": "function", "stateMutability": "view",
    "inputs": [{"name": "a", "type": "address"}],
    "outputs": [{"name": "", "type": "uint256"}],
}]
VAULT_ABI = [{
    "name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
    "inputs": [{"name": "u", "type": "address"}, {"name": "t", "type": "address"}],
    "outputs": [{"name": "", "type": "uint256"}],
}]

NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000"


def fetch_prices():
    """Mid-price per base token from the live REST orderbook."""
    prices = {"USDso": 1.0, "USDC.e": 1.0}
    for pair in ["SOMI:USDso", "WETH:USDso", "WBTC:USDso", "USDC.e:USDso"]:
        try:
            r = requests.get(
                f"https://api.dreamdex.io/v0/orderbooks?symbols={pair}",
                timeout=10,
            )
            books = r.json().get("orderbooks") or []
            if not books or not books[0].get("bids") or not books[0].get("asks"):
                continue
            bid = float(books[0]["bids"][0]["price"])
            ask = float(books[0]["asks"][0]["price"])
            prices[pair.split(":")[0]] = (bid + ask) / 2
        except Exception:
            pass
    return prices


def audit(w3, name, addr, prices):
    addr = Web3.to_checksum_address(addr)
    usdso = Web3.to_checksum_address(USDSO_ADDRESS)
    print(f"\n━━━ {name} ({addr[:10]}…{addr[-6:]}) ━━━")

    # Wallet token balances
    usdso_wallet = w3.eth.contract(address=usdso, abi=ERC20_ABI).functions.balanceOf(addr).call() / 1e18
    somi = w3.eth.get_balance(addr) / 1e18
    somi_px = prices.get("SOMI", 0)
    somi_value = somi * somi_px

    print(f"  USDso wallet:  ${usdso_wallet:.4f}")
    print(f"  SOMI native:   {somi:.4f}  (${somi_value:.2f})")

    other_value = 0.0
    for pair, mkt in MARKETS.items():
        base_hex = mkt.get("base") or ""
        if not base_hex or int(base_hex, 16) == 0:
            continue
        sym = pair.split(":")[0]
        if sym == "SOMI":
            continue
        try:
            base_addr = Web3.to_checksum_address(base_hex)
            decimals = mkt.get("baseDecimals", 18)
            bal = w3.eth.contract(address=base_addr, abi=ERC20_ABI).functions.balanceOf(addr).call() / (10 ** decimals)
            if bal > 1e-8:
                px = prices.get(sym, 0)
                val = bal * px
                other_value += val
                print(f"  {sym} wallet:   {bal:.8f}  (${val:.2f})")
        except Exception:
            continue

    # Vault balances (BASE + QUOTE per pool)
    vault_total = 0.0
    vault_lines = []
    for pair, mkt in MARKETS.items():
        pool_hex = mkt.get("contract")
        if not pool_hex:
            continue
        try:
            pool = Web3.to_checksum_address(pool_hex)
            base_hex = mkt.get("base") or NATIVE_SENTINEL
            quote_hex = mkt.get("quote") or USDSO_ADDRESS
            base_addr = Web3.to_checksum_address(base_hex)
            quote_addr = Web3.to_checksum_address(quote_hex)
            base_dec = mkt.get("baseDecimals", 18)
            quote_dec = mkt.get("quoteDecimals", 18)
            base_sym = pair.split(":")[0]
            quote_sym = pair.split(":")[1]

            vc = w3.eth.contract(address=pool, abi=VAULT_ABI)
            b = vc.functions.getWithdrawableBalance(addr, base_addr).call() / (10 ** base_dec)
            q = vc.functions.getWithdrawableBalance(addr, quote_addr).call() / (10 ** quote_dec)
            b_val = b * prices.get(base_sym, 0)
            q_val = q * prices.get(quote_sym, 0)
            if b > 1e-8 or q > 1e-4:
                vault_lines.append(
                    f"  {pair} vault: {base_sym}={b:.8f} (${b_val:.4f})  {quote_sym}=${q:.4f}"
                )
                vault_total += b_val + q_val
        except Exception:
            continue

    if vault_lines:
        print("  Vaults:")
        for line in vault_lines:
            print(line)
    else:
        print("  Vaults:        (all empty)")

    total = usdso_wallet + somi_value + other_value + vault_total
    print(f"  >> TOTAL: ${total:.2f}")
    return total


def main():
    p = argparse.ArgumentParser(description="DreamDEX comprehensive balance auditor")
    p.add_argument("wallets", nargs="*",
                   help="0x addresses to audit. Default: A + B.")
    p.add_argument("--start", type=float, default=50.0,
                   help="Per-wallet starting capital (default $50)")
    args = p.parse_args()

    wallets = ([(f"Wallet {i+1}", a) for i, a in enumerate(args.wallets)]
               if args.wallets else DEFAULT_WALLETS)

    w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 10}))
    if not w3.is_connected():
        print(f"RPC unreachable: {SOMNIA_RPC}", file=sys.stderr)
        sys.exit(1)

    prices = fetch_prices()
    print(f"━━━ Balance audit ({ENV.upper()}) — block {w3.eth.block_number} ━━━")
    print("Prices: " + ", ".join(f"{k}=${v:.4f}" for k, v in prices.items()))

    grand = 0.0
    for name, addr in wallets:
        grand += audit(w3, name, addr, prices)

    print("\n" + "━" * 60)
    print(f"COMBINED TOTAL: ${grand:.2f}")
    expected = args.start * len(wallets)
    diff = grand - expected
    sign = "+" if diff >= 0 else ""
    print(f"vs starting (${args.start:.0f} × {len(wallets)} = ${expected:.0f}): "
          f"{sign}${diff:.2f}")


if __name__ == "__main__":
    main()
