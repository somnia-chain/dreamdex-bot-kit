#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Trace capital injections: (A) all USDso transfers FROM the tester/organizer
wallet (who is it funding?), (B) incoming USDso to t2 & t6 grouped by sender,
flagging non-pool senders (= capital top-ups, not trade proceeds). Read-only."""
import sys
sys.path.insert(0, "/app")
from web3 import Web3
from config import SOMNIA_RPC, MARKETS

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 35}))
m = MARKETS["WETH:USDso"]
usdso = Web3.to_checksum_address(m["quote"])
pool  = Web3.to_checksum_address(m["contract"]).lower()
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

TESTER = "0x837478C7256FFBB3fa6188c94e33599a28463280"
T2 = "0x43876c4668Ac0207F000C387eAf1eC8884f26BC7"
T6 = "0xf181221f2e6fb0a3c37558ee2e1f4bc93f161406"
names = {pool: "POOL", TESTER.lower(): "TESTER", T2.lower(): "t2", T6.lower(): "t6",
         "0x8f0a24ae910d4b89c4422b6884d71739dbc1ec86": "t3",
         "0x4258950186a12492bf805f2b9d7facd202921f34": "t4",
         "0xf4c825f3c2970153d78b407cf190861dd4e2b905": "us"}
def nm(a): return names.get(a.lower(), a)
def pad(a): return "0x" + "0"*24 + a[2:].lower()

latest = w3.eth.block_number
# estimate block time over 2000 blocks -> blocks for ~2h
t_now = w3.eth.get_block(latest)["timestamp"]
t_old = w3.eth.get_block(latest-2000)["timestamp"]
bt = max((t_now - t_old)/2000, 0.05)
WIN = int(2*3600/bt)
lo = latest - WIN
print(f"block time ~{bt:.2f}s -> 2h = {WIN} blocks. scanning {lo}..{latest}\n")

def scan(topics):
    out = []
    hi = latest
    while hi > lo:
        l = max(hi-999, lo)
        try:
            out += w3.eth.get_logs({"fromBlock": l, "toBlock": hi, "address": usdso, "topics": topics})
        except Exception:
            pass
        hi = l - 1
    return out

# (A) USDso sent FROM tester
print("== (A) USDso transfers FROM tester ==")
fr = scan([TRANSFER, pad(TESTER), None])
if not fr: print("  none in window")
for lg in fr:
    to = "0x"+lg["topics"][2].hex()[-40:]
    amt = int(lg["data"].hex(),16)/1e18
    print(f"  -> {nm(to):<6} ${amt:.2f}  blk{lg['blockNumber']}")

# (B) incoming USDso to t2 & t6, grouped by sender, non-POOL flagged
for who, addr in [("t2", T2), ("t6", T6)]:
    print(f"\n== (B) incoming USDso to {who}: senders (non-POOL = top-up) ==")
    ins = scan([TRANSFER, None, pad(addr)])
    agg = {}
    for lg in ins:
        frm = ("0x"+lg["topics"][1].hex()[-40:]).lower()
        amt = int(lg["data"].hex(),16)/1e18
        c,s = agg.get(frm,(0,0.0)); agg[frm] = (c+1, s+amt)
    for frm,(c,s) in sorted(agg.items(), key=lambda x:-x[1][1]):
        tag = "  <-- TOP-UP" if frm != pool else ""
        print(f"  {nm(frm):<8} x{c:<4} total ${s:.2f}{tag}")
