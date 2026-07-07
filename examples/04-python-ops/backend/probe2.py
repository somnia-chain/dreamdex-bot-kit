#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Identify t2's order method (selector 0x4e978373) by decoding raw input into
32-byte words and matching candidate signatures; also deeper scan for t4. RO."""
import sys
sys.path.insert(0, "/app")
from web3 import Web3
from eth_utils import keccak
from config import SOMNIA_RPC, MARKETS

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 35}))
m = MARKETS["WETH:USDso"]
weth = Web3.to_checksum_address(m["base"]); qd = int(m.get("quoteDecimals",18)); bd = int(m.get("baseDecimals",18))
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

def selof(sig): return "0x"+keccak(text=sig)[:4].hex()
PARAMS = "(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)"
cands = ["placeOrder","placeTakerOrder","placeTakerOrderWithoutVault","placeMakerOrder",
         "placeMakerOrderWithoutVault","placeLimitOrder","placeMarketOrder","placeOrderWithoutVault"]
sigmap = {selof(c+PARAMS): c+PARAMS for c in cands}
# also a couple alt shapes
for s in ["swap(bool,uint256,uint256)","placeOrder(uint8,bool,uint256,uint256,uint64,uint8,uint8,address,uint96)",
          "placeTakerOrderWithoutVault(uint8,bool,uint256,uint256,uint64,uint8,uint8,address,uint96)"]:
    sigmap[selof(s)] = s

def words(inp):
    h = inp[10:] if inp.startswith("0x") else inp[8:]
    return [h[i:i+64] for i in range(0, len(h), 64)]

def sample(addr, win):
    ap = "0x" + "0"*24 + addr[2:].lower(); hs=[]
    latest = w3.eth.block_number
    for k in range(win//1000):
        hi = latest-k*1000; lo=hi-999
        for t in ([TRANSFER,ap,None],[TRANSFER,None,ap]):
            try:
                for l in w3.eth.get_logs({"fromBlock":lo,"toBlock":hi,"address":weth,"topics":t}):
                    hs.append(l["transactionHash"].hex())
            except Exception: pass
        if len(set(hs))>=4: break
    return list(dict.fromkeys(hs))[:3]

print("selector map:")
for s,n in sigmap.items(): print(f"  {s} = {n}")
print()

for name, addr, win in [("trader-2","0x43876c4668Ac0207F000C387eAf1eC8884f26BC7",200000),
                        ("trader-4","0x4258950186a12492Bf805f2B9D7facd202921F34",900000)]:
    print(f"== {name} (win={win}) ==")
    for h in sample(addr, win):
        tx = w3.eth.get_transaction(h)
        inp = tx["input"] if isinstance(tx["input"],str) else tx["input"].hex()
        if not inp.startswith("0x"): inp="0x"+inp
        sel = inp[:10]; nm = sigmap.get(sel, "UNKNOWN")
        ws = words(inp)
        print(f"  tx {h[:12]} sel={sel} -> {nm}  words={len(ws)}")
        for i,wd in enumerate(ws[:9]):
            v = int(wd,16)
            note=""
            if 0 < v < 10**24: note=f" ~price/qty={v/10**qd:.4f}|{v/10**bd:.4f}"
            if v in (0,1): note=" bool/flag?"
            print(f"     [{i}] {v}{note}")
        print()
