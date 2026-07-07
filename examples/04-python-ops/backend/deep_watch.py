#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Per-opponent trade profiler. Scans the last ~minute of WETH:USDso on-chain
activity for each trader and reports: trade rate (→ RPC vs REST), avg leg size,
buy/sell counts, and capital bleed over the window. Read-only."""
import sys
sys.path.insert(0, "/app")
from web3 import Web3
from config import SOMNIA_RPC, MARKETS

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 25}))
m = MARKETS["WETH:USDso"]
weth = Web3.to_checksum_address(m["base"]); usdso = Web3.to_checksum_address(m["quote"])
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
POOL = [{"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels",
        "outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],
        "name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"}]
pc = w3.eth.contract(address=Web3.to_checksum_address(m["contract"]), abi=POOL)
try:
    bid = pc.functions.getBookLevels(True,1).call(); ask = pc.functions.getBookLevels(False,1).call()
    wprice = ((bid[0][0]+ask[0][0])/2)/1e18
except Exception:
    wprice = 1660.0

OPP = [
    ("trader-3", "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86"),
    ("trader-2", "0x43876c4668Ac0207F000C387eAf1eC8884f26BC7"),
    ("trader-4", "0x4258950186a12492Bf805f2B9D7facd202921F34"),
    ("us(t9)",   "0xF4c825F3C2970153d78B407CF190861dd4E2b905"),
]

latest = w3.eth.block_number
WIN = 400  # blocks
lo = latest - WIN
t_hi = w3.eth.get_block(latest)["timestamp"]
t_lo = w3.eth.get_block(lo)["timestamp"]
span = max(t_hi - t_lo, 1)
print(f"window: blocks {lo}..{latest} = {span}s (~{span/60:.1f} min)  WETHprice={wprice:.1f}\n")

def logs(token, topics):
    out = []
    for k in range((WIN//1000)+1):
        hi = latest - k*1000; l = max(hi-999, lo)
        if hi < lo: break
        try: out += w3.eth.get_logs({"fromBlock": l, "toBlock": hi, "address": token, "topics": topics})
        except Exception: pass
    return out

for name, addr in OPP:
    ap = "0x" + "0"*24 + addr[2:].lower()
    win  = logs(weth, [TRANSFER, None, ap])   # WETH IN  = BUY fills
    wout = logs(weth, [TRANSFER, ap, None])   # WETH OUT = SELL fills
    uin  = logs(usdso,[TRANSFER, None, ap])   # USDso IN = sell proceeds
    uout = logs(usdso,[TRANSFER, ap, None])   # USDso OUT= buy cost
    buys, sells = len(win), len(wout)
    legs = [int(l["data"].hex(),16)/1e18 for l in win+wout]
    avg_leg_weth = sum(legs)/len(legs) if legs else 0
    avg_leg_usd = avg_leg_weth*wprice
    usdso_net = (sum(int(l["data"].hex(),16) for l in uin) - sum(int(l["data"].hex(),16) for l in uout))/1e18
    weth_net  = (sum(int(l["data"].hex(),16) for l in win) - sum(int(l["data"].hex(),16) for l in wout))/1e18
    cap_delta = usdso_net + weth_net*wprice          # capital change over window (toll = negative)
    fills = buys + sells
    rate = fills/span*60                              # fills per minute
    rate_s = fills/span                               # fills per second
    method = "RPC (fast)" if rate_s > 0.6 else ("REST/slow" if rate_s > 0.05 else "idle")
    vol_win = sum(legs)*wprice                        # volume generated in window
    print(f"{name}: {fills} fills/{span}s ({rate:.0f}/min, {rate_s:.2f}/s → {method})")
    print(f"   buys={buys} sells={sells}  avg leg={avg_leg_weth:.4f} WETH (~${avg_leg_usd:.1f})")
    print(f"   volume this window ~${vol_win:.0f}  | capital Δ ${cap_delta:+.3f} (bleed/min ~${cap_delta/span*60:+.3f})")
