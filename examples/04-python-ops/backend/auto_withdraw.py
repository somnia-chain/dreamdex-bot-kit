#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/auto_withdraw.py
"""
Auto-withdraw: scans Wallet A's vault across all pools and pulls back any
balance above a small threshold. Designed to run on cron every few hours
so the burst never stalls from inventory accumulating in vault under the
custom native-SOMI sentinel (0x28f34De…).

Why this exists: dreamDEX BUY fills can deliver base token to the
pool vault instead of the EOA wallet. With the non-standard native
sentinel (0x28f34De…1694c00), our standard balance checks miss this
inventory and the burst can deadlock on the SELL side once wallet SOMI
runs out. Periodic vault sweep keeps wallet hot.

Cron usage (host):
  0 */2 * * * docker exec dreamdex-agent python3 /app/auto_withdraw.py \\
              >> /home/irony/dreamdex-agent/logs/auto_withdraw.log 2>&1
"""
import os
import sys
import time
import datetime
sys.path.insert(0, "/app")
from web3 import Web3
from eth_account import Account
from config import SOMNIA_RPC, PRIVATE_KEY, MARKETS, USDSO_ADDRESS

NATIVE_SENTINEL_FALLBACK = "0x0000000000000000000000000000000000000000"
# Per-pool min withdraw threshold in USD-equivalent terms
WITHDRAW_THRESHOLD_USD = 0.50

VAULT_ABI = [{
    "name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
    "inputs": [{"name": "u", "type": "address"}, {"name": "t", "type": "address"}],
    "outputs": [{"name": "", "type": "uint256"}],
}]
WITHDRAW_SEL = "0x" + Web3.keccak(text="withdraw(address,uint256)").hex()[:8]


def now_str():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_somi_price(w3):
    """Best-effort SOMI mid price for threshold calc. Default 0.15 on failure."""
    try:
        import requests
        r = requests.get("https://api.dreamdex.io/v0/orderbooks?symbols=SOMI:USDso",
                         timeout=10)
        bk = r.json()["orderbooks"][0]
        return (float(bk["bids"][0]["price"]) + float(bk["asks"][0]["price"])) / 2
    except Exception:
        return 0.15


def withdraw(w3, key, addr, pool, token, raw_amount, label):
    """Send a withdraw(token, amount) tx. Returns (status, hash, gas_used)."""
    data = (WITHDRAW_SEL
            + token.lower().replace("0x", "").rjust(64, "0")
            + format(raw_amount, "064x"))
    nonce = w3.eth.get_transaction_count(addr, "pending")
    tx = {
        "to": pool, "data": data, "value": 0,
        "nonce": nonce, "chainId": w3.eth.chain_id,
        "gas": 2_000_000, "gasPrice": w3.eth.gas_price,
    }
    signed = w3.eth.account.sign_transaction(tx, key)
    try:
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
    except Exception as e:
        print(f"  [{label}] broadcast err: {str(e)[:120]}")
        return None, None, None
    r = w3.eth.wait_for_transaction_receipt(h, timeout=60)
    return r.status, h.hex(), r.gasUsed


def main():
    w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 10}))
    if not PRIVATE_KEY:
        print(f"[{now_str()}] ERROR: PRIVATE_KEY not set in config")
        sys.exit(1)
    addr = Web3.to_checksum_address(Account.from_key(PRIVATE_KEY).address)

    somi_price = fetch_somi_price(w3)
    print(f"[{now_str()}] auto_withdraw scan — wallet {addr[:10]}…{addr[-6:]} "
          f"(SOMI ~${somi_price:.4f})")

    total_recovered_usd = 0.0
    total_txs = 0
    actions = []

    for pair, mkt in MARKETS.items():
        pool = Web3.to_checksum_address(mkt["contract"])
        # Use the pool's REGISTERED base address — handles non-standard sentinels
        base_hex = mkt.get("base") or NATIVE_SENTINEL_FALLBACK
        quote_hex = mkt.get("quote") or USDSO_ADDRESS
        base_addr = Web3.to_checksum_address(base_hex)
        quote_addr = Web3.to_checksum_address(quote_hex)
        base_dec = mkt.get("baseDecimals", 18)
        quote_dec = mkt.get("quoteDecimals", 18)
        base_sym = pair.split(":")[0]

        vc = w3.eth.contract(address=pool, abi=VAULT_ABI)

        # Base token vault balance
        try:
            b_raw = vc.functions.getWithdrawableBalance(addr, base_addr).call()
        except Exception as e:
            print(f"  [{pair}] base query err: {str(e)[:80]}")
            b_raw = 0
        # Quote token vault balance
        try:
            q_raw = vc.functions.getWithdrawableBalance(addr, quote_addr).call()
        except Exception as e:
            print(f"  [{pair}] quote query err: {str(e)[:80]}")
            q_raw = 0

        b_human = b_raw / (10 ** base_dec)
        q_human = q_raw / (10 ** quote_dec)

        # Estimate USD value for threshold comparison
        b_usd = b_human * (somi_price if base_sym == "SOMI" else
                           (1.0 if base_sym == "USDC.e" else 0))
        # (WETH/WBTC priced 0 here — only flagged if base is large; we don't
        # withdraw automatically without a confirmed price. Set them to a high
        # USD if you want to force-withdraw any WETH/WBTC vault hit.)
        if base_sym in ("WETH", "WBTC") and b_human > 0:
            b_usd = b_human * (2000 if base_sym == "WETH" else 70000)
        q_usd = q_human  # USDso ≈ $1

        # Withdraw base if above threshold
        if b_usd > WITHDRAW_THRESHOLD_USD:
            print(f"  [{pair}] BASE vault: {b_human:.6f} {base_sym} (~${b_usd:.2f}) → withdraw")
            status, h, gas = withdraw(w3, PRIVATE_KEY, addr, pool, base_addr, b_raw,
                                      f"{pair} {base_sym}")
            if status == 1:
                total_recovered_usd += b_usd
                total_txs += 1
                actions.append(f"{pair}:{base_sym}=${b_usd:.2f}")
                print(f"    ✓ status=1 gas={gas} tx={h[:20]}…")
            else:
                print(f"    ✗ status={status}")

        # Withdraw quote (USDso) if above threshold
        if q_usd > WITHDRAW_THRESHOLD_USD:
            print(f"  [{pair}] QUOTE vault: ${q_human:.4f} USDso → withdraw")
            status, h, gas = withdraw(w3, PRIVATE_KEY, addr, pool, quote_addr, q_raw,
                                      f"{pair} USDso")
            if status == 1:
                total_recovered_usd += q_usd
                total_txs += 1
                actions.append(f"{pair}:USDso=${q_usd:.2f}")
                print(f"    ✓ status=1 gas={gas} tx={h[:20]}…")
            else:
                print(f"    ✗ status={status}")

        if b_usd <= WITHDRAW_THRESHOLD_USD and q_usd <= WITHDRAW_THRESHOLD_USD:
            print(f"  [{pair}] vault below threshold (base=${b_usd:.4f}, quote=${q_usd:.4f}) — skip")

    print(f"[{now_str()}] DONE — recovered ${total_recovered_usd:.2f} via {total_txs} tx "
          f"({', '.join(actions) if actions else 'nothing'})")


if __name__ == "__main__":
    main()
