#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""sweep_b_to_h.py — move wallet B's USDso + native SOMI to wallet H (main).

One-off. Key read from container env WALLET_B_PRIVATE_KEY (never passed on CLI).
USDso first (consumes a little of B's SOMI for gas), then sweep remaining SOMI
to H minus a small dust buffer.
"""
import os
import sys
import time

sys.path.insert(0, "/app")
from web3 import Web3
from eth_account import Account
from config import SOMNIA_RPC, CHAIN_ID

KEY = os.environ["WALLET_B_PRIVATE_KEY"]
H = Web3.to_checksum_address("0xF4c825F3C2970153d78B407CF190861dd4E2b905")
USDSO = Web3.to_checksum_address("0x00000022dA000002656c64D9eA6011ea952D008A")
SOMI_DUST = float(os.environ.get("SWEEP_DUST", "0.01"))  # leave this in B

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 30}))
acct = Account.from_key(KEY)
B = acct.address
print("B =", B, "-> H =", H)

ERC20 = [
    {"inputs": [{"name": "a", "type": "address"}], "name": "balanceOf",
     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}],
     "name": "transfer", "outputs": [{"name": "", "type": "bool"}],
     "stateMutability": "nonpayable", "type": "function"},
]
usdso = w3.eth.contract(address=USDSO, abi=ERC20)
gp = w3.eth.gas_price


def _raw(signed):
    return getattr(signed, "raw_transaction", None) or signed.rawTransaction


def _send(tx, label):
    s = w3.eth.account.sign_transaction(tx, KEY)
    h = w3.eth.send_raw_transaction(_raw(s))
    print(f"{label} tx {h.hex()}")
    r = w3.eth.wait_for_transaction_receipt(h, timeout=120)
    print(f"  {label} status={r.status} block={r.blockNumber} gasUsed={r.gasUsed}")
    return r.status


# 1) USDso -> H (full balance)
ubal = usdso.functions.balanceOf(B).call()
print("USDso in B =", ubal / 1e18)
if ubal > 0:
    nonce = w3.eth.get_transaction_count(B)
    tx = usdso.functions.transfer(H, ubal).build_transaction(
        {"from": B, "nonce": nonce, "chainId": CHAIN_ID, "gas": 200000, "gasPrice": gp})
    _send(tx, "USDso")
    time.sleep(2)

# 2) Sweep native SOMI -> H, leaving dust + this tx's fee
bal = w3.eth.get_balance(B)
fee = gp * 21000
keep = int(SOMI_DUST * 1e18)
send = bal - fee - keep
print("SOMI in B =", bal / 1e18, "| sending", (send / 1e18) if send > 0 else 0)
if send > 0:
    nonce = w3.eth.get_transaction_count(B)
    tx = {"from": B, "to": H, "value": send, "nonce": nonce,
          "chainId": CHAIN_ID, "gas": 21000, "gasPrice": gp}
    _send(tx, "SOMI")
else:
    print("nothing to sweep (balance <= dust+fee)")

print("done. H SOMI now =", w3.eth.get_balance(H) / 1e18)
