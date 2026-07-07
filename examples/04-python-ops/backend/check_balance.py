# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/check_balance.py
"""
Quick balance check — shows STT, USDso, and vault deposits per pool.

Run:  cd backend && python check_balance.py
"""
from web3 import Web3
from config import SOMNIA_RPC, MY_ADDRESS, MARKETS, USDSO_ADDRESS, ENV

ERC20_ABI = [
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "account", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "symbol",    "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "string"}]},
]
VAULT_ABI = [
    {"name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "user", "type": "address"}, {"name": "token", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
]

w3  = Web3(Web3.HTTPProvider(SOMNIA_RPC))
me  = Web3.to_checksum_address(MY_ADDRESS)
usdso_addr = Web3.to_checksum_address(USDSO_ADDRESS)

print(f"\n{'━'*48}")
print(f"  Balance Check  ({ENV.upper()})")
print(f"  Wallet: {me}")
print(f"{'━'*48}\n")

# ── Wallet balances ──────────────────────────────────────
stt_raw   = w3.eth.get_balance(me)
stt       = stt_raw / 1e18

usdso_contract = w3.eth.contract(address=usdso_addr, abi=ERC20_ABI)
usdso_raw = usdso_contract.functions.balanceOf(me).call()
usdso     = usdso_raw / 1e18

print(f"  {'STT (native)':20s}  {stt:.6f} STT")
print(f"  {'USDso (wallet)':20s}  {usdso:.6f} USDso")

# ── Vault balances per pool ──────────────────────────────
print(f"\n  {'─'*44}")
print(f"  {'Pool':20s}  {'Vault USDso':>14s}")
print(f"  {'─'*44}")

total_vault = 0.0
for pair, mkt in MARKETS.items():
    try:
        pool = w3.eth.contract(
            address=Web3.to_checksum_address(mkt["contract"]), abi=VAULT_ABI
        )
        raw   = pool.functions.getWithdrawableBalance(me, usdso_addr).call()
        vault = raw / 1e18
        total_vault += vault
        print(f"  {pair:20s}  {vault:>14.6f} USDso")
    except Exception as e:
        print(f"  {pair:20s}  error: {e}")

print(f"  {'─'*44}")
print(f"  {'TOTAL USDso':20s}  {usdso + total_vault:>14.6f} USDso")
print(f"  {'  (wallet + vaults)':20s}")
print(f"\n{'━'*48}\n")
