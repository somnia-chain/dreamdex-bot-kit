#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Sell all ERC20 base-token wallet balances back to USDso.
Skips SOMI (native — can't sell dust below minQty anyway).
Safe to run dry-first: set DRY_RUN=1 to only print what would happen.

Usage (inside Docker or with venv):
  cd backend
  DREAMDEX_ENV=mainnet DRY_RUN=1 python liquidate_to_usdso.py   # dry run
  DREAMDEX_ENV=mainnet python liquidate_to_usdso.py              # live

Or inside the container:
  docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python /app/liquidate_to_usdso.py
"""
import os, sys, time
# Support both Docker (/app) and local (backend/) execution
sys.path.insert(0, "/app")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from web3 import Web3
from eth_account import Account
from config import MARKETS, SOMNIA_RPC, CHAIN_ID, PRIVATE_KEY, MY_ADDRESS

DRY_RUN = os.environ.get("DRY_RUN", "0") not in ("0", "false", "False", "")
KEY = os.environ.get("MAINNET_PRIVATE_KEY") or PRIVATE_KEY
if not KEY:
    raise SystemExit("set MAINNET_PRIVATE_KEY in env or .env")

acct = Account.from_key(KEY)
w3   = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 15}))
if not w3.is_connected():
    raise SystemExit(f"RPC unreachable: {SOMNIA_RPC}")

print(f"[liquidate] wallet={acct.address}  chainId={CHAIN_ID}  block={w3.eth.block_number}")
print(f"[liquidate] DRY_RUN={DRY_RUN}")

# ── ABIs ──────────────────────────────────────────────────────────────────────
POOL_ABI = [
    {"inputs":[
        {"name":"isBid","type":"bool"},
        {"name":"userData","type":"uint64"},
        {"name":"price","type":"uint256"},
        {"name":"quantity","type":"uint256"},
        {"name":"expireTimestampNs","type":"uint64"},
        {"name":"orderType","type":"uint8"},
        {"name":"selfMatchingOption","type":"uint8"},
        {"name":"builder","type":"address"},
        {"name":"builderFeeBpsTimes1k","type":"uint96"},
     ],"name":"placeTakerOrderWithoutVault","outputs":[
        {"name":"success","type":"bool"},
        {"name":"orderId","type":"uint128"},
     ],"stateMutability":"payable","type":"function"},
    {"inputs":[],"name":"getPoolParams","outputs":[
        {"name":"baseToken","type":"address"},
        {"name":"quoteToken","type":"address"},
        {"name":"makerFeeBpsTimes1k","type":"uint256"},
        {"name":"takerFeeBpsTimes1k","type":"uint256"},
        {"name":"tickSize","type":"uint256"},
        {"name":"minQuantity","type":"uint256"},
        {"name":"lotSize","type":"uint256"},
     ],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"numLevels","type":"uint64"}],
     "name":"getBookLevels","outputs":[{"components":[
        {"name":"price","type":"uint256"},
        {"name":"quantity","type":"uint256"},
     ],"name":"","type":"tuple[]"}],
     "stateMutability":"view","type":"function"},
]
ERC20_ABI = [
    {"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],
     "name":"approve","outputs":[{"type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],
     "name":"allowance","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"account","type":"address"}],
     "name":"balanceOf","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def ensure_approve(pool_addr, token_addr, label):
    c = w3.eth.contract(address=Web3.to_checksum_address(token_addr), abi=ERC20_ABI)
    pool = Web3.to_checksum_address(pool_addr)
    cur = c.functions.allowance(acct.address, pool).call()
    if cur >= 2**128:
        print(f"  [approve/{label}] already ok")
        return
    if DRY_RUN:
        print(f"  [approve/{label}] DRY — would approve 2^256-1")
        return
    nonce = w3.eth.get_transaction_count(acct.address, "pending")
    tx = c.functions.approve(pool, 2**256 - 1).build_transaction({
        "from": acct.address, "nonce": nonce,
        "gas": 2_000_000, "gasPrice": w3.eth.gas_price, "chainId": CHAIN_ID,
    })
    s = w3.eth.account.sign_transaction(tx, KEY)
    h = w3.eth.send_raw_transaction(s.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=60)
    print(f"  [approve/{label}] tx={h.hex()} status={r.status}")


def sell_base(pair, mkt, qty_raw):
    """Send a single IOC SELL for qty_raw base units. Returns receipt or None."""
    pool_addr = Web3.to_checksum_address(mkt["contract"])
    c_pool = w3.eth.contract(address=pool_addr, abi=POOL_ABI)

    # Fetch book top for slippage
    bids = c_pool.functions.getBookLevels(True, 1).call()
    if not bids:
        print(f"  [sell/{pair}] bid side empty — skip")
        return None
    top_bid = bids[0][0]
    params  = c_pool.functions.getPoolParams().call()
    tick    = params[4]

    # SELL: price at bid − 3 ticks to guarantee crossing
    price_raw = max(1, top_bid - 3 * tick)
    expire_ns = (int(time.time()) + 3600) * 1_000_000_000

    print(f"  [sell/{pair}] qty_raw={qty_raw}  price_raw={price_raw}  top_bid={top_bid}  tick={tick}")

    if DRY_RUN:
        print(f"  [sell/{pair}] DRY — would broadcast SELL")
        return None

    nonce = w3.eth.get_transaction_count(acct.address, "pending")
    tx = c_pool.functions.placeTakerOrderWithoutVault(
        False,      # isBid = False → SELL
        0,          # userData
        price_raw,
        qty_raw,
        expire_ns,
        2,          # IOC
        1,          # CancelMaker (don't self-match)
        "0x0000000000000000000000000000000000000000",
        0,
    ).build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "gas": 2_000_000,
        "gasPrice": w3.eth.gas_price,
        "chainId": CHAIN_ID,
        "value": 0,
    })
    s = w3.eth.account.sign_transaction(tx, KEY)
    h = w3.eth.send_raw_transaction(s.raw_transaction)
    print(f"  [sell/{pair}] broadcast tx={h.hex()} — waiting receipt...")
    r = w3.eth.wait_for_transaction_receipt(h, timeout=60)
    print(f"  [sell/{pair}] status={r.status}  gasUsed={r.gasUsed}")
    return r


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    total_usdso_before = (
        w3.eth.contract(
            address=Web3.to_checksum_address(
                next(m for m in MARKETS.values() if not m.get("native"))["quote"]
            ),
            abi=ERC20_ABI,
        ).functions.balanceOf(acct.address).call() / 1e18
    )
    print(f"\n[liquidate] USDso wallet before: ${total_usdso_before:.4f}\n")

    pairs_to_sell = []
    for pair, mkt in MARKETS.items():
        sym = pair.split(":")[0]
        if mkt.get("native") or sym == "SOMI":
            print(f"[{pair}] skip — native SOMI (gas token, keep it)")
            continue

        base_addr = Web3.to_checksum_address(mkt["base"])
        base_dec  = int(mkt["baseDecimals"])
        c_base    = w3.eth.contract(address=base_addr, abi=ERC20_ABI)
        bal_raw   = c_base.functions.balanceOf(acct.address).call()
        bal_human = bal_raw / (10 ** base_dec)

        # minQty from contract
        pool_addr = Web3.to_checksum_address(mkt["contract"])
        c_pool    = w3.eth.contract(address=pool_addr, abi=POOL_ABI)
        params    = c_pool.functions.getPoolParams().call()
        min_qty   = params[5]
        lot       = params[6]

        print(f"[{pair}] bal={bal_human:.8f}  bal_raw={bal_raw}  minQty_raw={min_qty}  lot_raw={lot}")

        if bal_raw < min_qty:
            print(f"[{pair}] below minQty — can't sell, leaving as dust")
            continue

        # Floor quantity down to lot boundary
        qty_raw = (bal_raw // lot) * lot
        if qty_raw < min_qty:
            print(f"[{pair}] lot-floored qty {qty_raw} still below minQty {min_qty} — skip")
            continue

        pairs_to_sell.append((pair, mkt, qty_raw, bal_human))

    if not pairs_to_sell:
        print("\n[liquidate] nothing to sell — wallet is already all USDso + SOMI")
        return

    print(f"\n[liquidate] will sell {len(pairs_to_sell)} token(s):\n")
    for pair, mkt, qty_raw, bal_human in pairs_to_sell:
        sym = pair.split(":")[0]
        print(f"  {sym}: {bal_human:.8f}  (qty_raw={qty_raw})")

    print()
    for pair, mkt, qty_raw, bal_human in pairs_to_sell:
        sym = pair.split(":")[0]
        print(f"\n── {pair} ──")
        ensure_approve(mkt["contract"], mkt["base"], sym)
        sell_base(pair, mkt, qty_raw)
        time.sleep(2)  # brief pause between pairs so nonce clears

    if not DRY_RUN:
        time.sleep(5)
        total_usdso_after = (
            w3.eth.contract(
                address=Web3.to_checksum_address(
                    next(m for m in MARKETS.values() if not m.get("native"))["quote"]
                ),
                abi=ERC20_ABI,
            ).functions.balanceOf(acct.address).call() / 1e18
        )
        gained = total_usdso_after - total_usdso_before
        print(f"\n[liquidate] USDso wallet after: ${total_usdso_after:.4f}  (gained ${gained:+.4f})")


if __name__ == "__main__":
    main()
