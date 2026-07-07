#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""One-way SELL of native SOMI -> USDso on SOMI:USDso (taker IOC, sends SOMI as
msg.value). Converts emrey's free SOMI gas-grants into USDso capital, masked as
normal pool trading (USDso arrives from the pool, not an external transfer).

Usage: sell_somi.py [SOMI_AMOUNT]   (default: sell down to KEEP_SOMI reserve)
Env: KEEP_SOMI (default 1.2) — SOMI left behind for the maker + this tx's gas.
"""
import os, sys, time
sys.path.insert(0, "/app")
from web3 import Web3
from eth_account import Account
from config import SOMNIA_RPC, MARKETS, CHAIN_ID

KEY = os.environ.get("MAINNET_PRIVATE_KEY") or os.environ.get("PROFIT_PRIVATE_KEY")
acct = Account.from_key(KEY)
w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 15}))
m = MARKETS["SOMI:USDso"]
pool = Web3.to_checksum_address(m["contract"])
quote = Web3.to_checksum_address(m["quote"])

POOL_ABI = [
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"userData","type":"uint64"},
        {"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"},
        {"name":"expireTimestampNs","type":"uint64"},{"name":"orderType","type":"uint8"},
        {"name":"selfMatchingOption","type":"uint8"},{"name":"builder","type":"address"},
        {"name":"builderFeeBpsTimes1k","type":"uint96"}],
     "name":"placeTakerOrderWithoutVault","outputs":[{"name":"success","type":"bool"},
        {"name":"orderId","type":"uint128"}],"stateMutability":"payable","type":"function"},
    {"inputs":[],"name":"getPoolParams","outputs":[{"name":"b","type":"address"},
        {"name":"q","type":"address"},{"name":"mf","type":"uint256"},{"name":"tf","type":"uint256"},
        {"name":"tick","type":"uint256"},{"name":"minq","type":"uint256"},
        {"name":"lot","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels",
     "outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],
        "name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"},
]
ERC20 = [{"name":"balanceOf","type":"function","stateMutability":"view",
          "inputs":[{"name":"a","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]

c = w3.eth.contract(address=pool, abi=POOL_ABI)
uc = w3.eth.contract(address=quote, abi=ERC20)
pp = c.functions.getPoolParams().call()
tick, minq, lot = pp[4], pp[5], pp[6]
top_bid = c.functions.getBookLevels(True, 1).call()[0][0]

KEEP = float(os.environ.get("KEEP_SOMI", "1.2"))
bal = w3.eth.get_balance(acct.address) / 1e18
want = float(sys.argv[1]) if len(sys.argv) > 1 else (bal - KEEP)
sell = min(want, bal - KEEP)
if sell < minq / 1e18:
    print(f"nothing to sell (bal {bal:.3f}, keep {KEEP}, minQty {minq/1e18})"); sys.exit(0)
sell_raw = (int(sell * 1e18) // lot) * lot
price_raw = max(top_bid - 3 * tick, tick)
expire = (int(time.time()) + 3600) * 1_000_000_000

ub = uc.functions.balanceOf(acct.address).call() / 1e18
fn = c.functions.placeTakerOrderWithoutVault(False, 0, int(price_raw), int(sell_raw), expire, 2, 1,
        "0x0000000000000000000000000000000000000000", 0)
tx = fn.build_transaction({"from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
        "gas": 2_000_000, "gasPrice": w3.eth.gas_price, "chainId": CHAIN_ID, "value": int(sell_raw)})
s = w3.eth.account.sign_transaction(tx, KEY)
h = w3.eth.send_raw_transaction(s.raw_transaction)
r = w3.eth.wait_for_transaction_receipt(h, timeout=90)
time.sleep(2)
ua = uc.functions.balanceOf(acct.address).call() / 1e18
print(f"SELL {sell_raw/1e18:.3f} SOMI  status={r.status} gas={r.gasUsed}")
print(f"USDso {ub:.3f} -> {ua:.3f}  (+{ua-ub:.3f})")
print(f"SOMI left: {w3.eth.get_balance(acct.address)/1e18:.3f}")
