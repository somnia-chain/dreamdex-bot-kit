#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""TRUE capital per trader from on-chain dreamDEX (NOT leaderboard): native SOMI +
wallet USDso/WETH + VAULT USDso/WETH (getWithdrawableBalance). Read-only."""
import sys
sys.path.insert(0, "/app")
from web3 import Web3
from config import SOMNIA_RPC, MARKETS

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 25}))
m = MARKETS["WETH:USDso"]
pool  = Web3.to_checksum_address(m["contract"])
weth  = Web3.to_checksum_address(m["base"])
usdso = Web3.to_checksum_address(m["quote"])
E = [{"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]
V = [{"name":"getWithdrawableBalance","type":"function","stateMutability":"view","inputs":[{"name":"u","type":"address"},{"name":"t","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]
P = [{"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels","outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],"name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"}]

pc = w3.eth.contract(address=pool, abi=P)
b = pc.functions.getBookLevels(True,1).call(); a = pc.functions.getBookLevels(False,1).call()
px = ((b[0][0]+a[0][0])/2)/1e18
ec = w3.eth.contract(address=usdso, abi=E); wc = w3.eth.contract(address=weth, abi=E)
vc = w3.eth.contract(address=pool, abi=V)

OPP = [
    ("us(t9)", "0xF4c825F3C2970153d78B407CF190861dd4E2b905"),
    ("t2",     "0x43876c4668Ac0207F000C387eAf1eC8884f26BC7"),
    ("t3",     "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86"),
    ("t4",     "0x4258950186a12492Bf805f2B9D7facd202921F34"),
    ("t6",     "0xf181221f2e6fb0a3c37558ee2e1f4bc93f161406"),
]
print(f"WETH px={px:.0f}\n{'trader':<8}{'SOMI':>7}{'wUSDso':>9}{'wWETH$':>9}{'vUSDso':>9}{'vWETH$':>9}{'CAPITAL$':>10}")
for name, addr in OPP:
    A = Web3.to_checksum_address(addr)
    somi = w3.eth.get_balance(A)/1e18
    wu = ec.functions.balanceOf(A).call()/1e18
    ww = wc.functions.balanceOf(A).call()/1e18
    try: vu = vc.functions.getWithdrawableBalance(A, usdso).call()/1e18
    except Exception: vu = -1
    try: vw = vc.functions.getWithdrawableBalance(A, weth).call()/1e18
    except Exception: vw = -1
    cap = wu + ww*px + max(vu,0) + max(vw,0)*px
    print(f"{name:<8}{somi:>7.2f}{wu:>9.2f}{ww*px:>9.2f}{vu:>9.2f}{vw*px:>9.2f}{cap:>10.2f}")
