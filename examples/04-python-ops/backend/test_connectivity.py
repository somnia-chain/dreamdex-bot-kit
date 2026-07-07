# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/test_connectivity.py
"""
Connectivity test suite — run before starting the main bot.

Tests (all non-trading, read-only):
  1. RPC connection (Somnia testnet/mainnet)
  2. Wallet balance
  3. DreamDEX REST: GET /v0/markets
  4. DreamDEX REST: GET /v0/markets/{symbol}/tickers for all pairs
  5. SpotPool getPoolParams() via on-chain call for each pair
  6. SIWE auth + JWT token

Usage:
  cd backend
  # Keys are loaded from .env automatically — just run:
  python test_connectivity.py
  # (fill in OPENAI_KEY in .env only if testing brain.py)
"""
import os, sys, time, json, requests
from web3 import Web3
from config import (
    ENV, SOMNIA_RPC, DREAMDEX_HTTP, CHAIN_ID,
    MY_ADDRESS, MARKETS, USDSO_ADDRESS
)

PASS = "✅"
FAIL = "❌"
WARN = "⚠️ "

GET_POOL_PARAMS_ABI = [
    {
        "name": "getPoolParams",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [
            {"name": "baseToken_",          "type": "address"},
            {"name": "quoteToken_",         "type": "address"},
            {"name": "makerFeeBpsTimes1k_", "type": "uint256"},
            {"name": "takerFeeBpsTimes1k_", "type": "uint256"},
            {"name": "tickSize_",           "type": "uint256"},
            {"name": "minQuantity_",        "type": "uint256"},
            {"name": "lotSize_",            "type": "uint256"},
        ],
    }
]

BALANCE_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs":  [{"name": "account", "type": "address"}],
        "outputs": [{"name": "",        "type": "uint256"}],
    }
]


def hr(title=""):
    print(f"\n{'─'*50}")
    if title:
        print(f"  {title}")
        print(f"{'─'*50}")


def test_rpc():
    hr("TEST 1: RPC Connection")
    w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC))
    connected = w3.is_connected()
    if connected:
        block = w3.eth.block_number
        cid   = w3.eth.chain_id
        print(f"{PASS} Connected to {SOMNIA_RPC}")
        print(f"   Chain ID:    {cid}  (expected {CHAIN_ID})")
        print(f"   Latest block: {block}")
        if cid != CHAIN_ID:
            print(f"{WARN} Chain ID mismatch!")
    else:
        print(f"{FAIL} Cannot connect to {SOMNIA_RPC}")
    return connected


def test_wallet_balance(w3):
    hr("TEST 2: Wallet Balances")
    me = Web3.to_checksum_address(MY_ADDRESS)
    print(f"   Address: {me}")

    # Native balance
    native = w3.eth.get_balance(me)
    print(f"{PASS} STT/SOMI balance: {native/1e18:.4f}")

    # USDso ERC-20
    try:
        usdso = Web3.to_checksum_address(USDSO_ADDRESS)
        c = w3.eth.contract(address=usdso, abi=BALANCE_ABI)
        bal = c.functions.balanceOf(me).call()
        print(f"{PASS} USDso balance:    {bal/1e18:.4f}")
    except Exception as e:
        print(f"{WARN} USDso balance error: {e}")


def test_rest_markets():
    hr("TEST 3: REST /v0/markets")
    try:
        r = requests.get(f"{DREAMDEX_HTTP}/v0/markets", timeout=10)
        if r.status_code == 200:
            data = r.json()
            mkts = data.get("markets", data) if isinstance(data, dict) else data
            print(f"{PASS} HTTP 200 — {len(mkts)} markets returned")
            for m in mkts[:5]:
                sym = m.get("symbol", m.get("name", "?"))
                print(f"   • {sym}")
        else:
            print(f"{FAIL} HTTP {r.status_code}: {r.text[:200]}")
    except Exception as e:
        print(f"{FAIL} Request error: {e}")


def test_rest_tickers():
    hr("TEST 4: REST /v0/markets/{symbol}/tickers")
    session = requests.Session()  # fresh session — no auth headers
    for pair in MARKETS:
        try:
            r = session.get(f"{DREAMDEX_HTTP}/v0/markets/{pair}/tickers", timeout=5)
            if r.status_code == 200:
                data = r.json()
                syms = data.get("symbols", [data]) if isinstance(data, dict) else data
                d = syms[0] if syms else {}
                close = d.get("close", "0")
                vol   = d.get("volume", "0")
                print(f"{PASS} {pair:16s} close={close}  vol={vol}")
            else:
                print(f"{WARN} {pair:16s} HTTP {r.status_code}: {r.text[:100]}")
        except Exception as e:
            print(f"{FAIL} {pair:16s} error: {e}")


def test_pool_params(w3):
    hr("TEST 5: On-chain getPoolParams() per pool")
    for pair, mkt in MARKETS.items():
        contract = mkt["contract"]
        try:
            pool = w3.eth.contract(
                address=Web3.to_checksum_address(contract),
                abi=GET_POOL_PARAMS_ABI,
            )
            result = pool.functions.getPoolParams().call()
            base_tok, quote_tok, maker_fee, taker_fee, tick, min_qty, lot = result
            print(f"{PASS} {pair}")
            print(f"     base={base_tok[:10]}...  quote={quote_tok[:10]}...")
            print(f"     tick={tick/1e18:.6f} USDso  minQty={min_qty/1e18:.6f}  lot={lot/1e18:.8f}")
        except Exception as e:
            print(f"{FAIL} {pair}: {e}")


def test_siwe_auth():
    hr("TEST 6: SIWE Auth → JWT")
    from config import PRIVATE_KEY
    if not PRIVATE_KEY:
        print(f"{WARN} Wallet key not set — skipping auth test")
        return

    try:
        from trading.dreamdex import DreamDEX
        dex = DreamDEX()
        dex._login()
        print(f"{PASS} Auth successful — token obtained")
    except Exception as e:
        print(f"{FAIL} Auth failed: {e}")


def main():
    print("="*55)
    print(f"  DreamDEX Connectivity Tests ({ENV.upper()})")
    print("="*55)

    ok_rpc = test_rpc()
    w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC))

    if ok_rpc:
        test_wallet_balance(w3)
        test_pool_params(w3)
    else:
        print(f"{WARN} Skipping on-chain tests (no RPC)")

    test_rest_markets()
    test_rest_tickers()
    test_siwe_auth()

    print(f"\n{'='*55}")
    print("  Done. Fix any ❌ before starting main.py.")
    print("="*55)


if __name__ == "__main__":
    main()
