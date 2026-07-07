#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Deep opponent recon: full wallet balances (native + every ERC20) AND which
pair each is actively trading (recent base-token transfer activity). Read-only."""
import sys
sys.path.insert(0, "/app")
from web3 import Web3
from config import SOMNIA_RPC, MARKETS

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 20}))
ERC20 = [{"name":"balanceOf","type":"function","stateMutability":"view",
          "inputs":[{"name":"a","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]
POOL = [{"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels",
        "outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],
        "name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"}]
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

OPP = [
    ("trader-3", "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86"),
    ("trader-2", "0x43876c4668Ac0207F000C387eAf1eC8884f26BC7"),
    ("trader-4", "0x4258950186a12492Bf805f2B9D7facd202921F34"),
    ("trader-6", "0xf181221f2e6fb0a3c37558ee2e1f4bc93f161406"),
    ("us(t9)",   "0xF4c825F3C2970153d78B407CF190861dd4E2b905"),
]

# token map: sym -> (addr, decimals)
toks = {}
for sym, mk in MARKETS.items():
    bs = sym.split(":")[0]
    if mk["base"] and mk["base"] != "0x0000000000000000000000000000000000000000":
        toks[bs] = (Web3.to_checksum_address(mk["base"]), int(mk.get("baseDecimals", 18)))
    toks["USDso"] = (Web3.to_checksum_address(mk["quote"]), int(mk.get("quoteDecimals", 18)))

# live prices for USD value
px = {"USDso": 1.0, "USDC.e": 1.0}
for sym, mk in MARKETS.items():
    bs = sym.split(":")[0]
    try:
        c = w3.eth.contract(address=Web3.to_checksum_address(mk["contract"]), abi=POOL)
        bid = c.functions.getBookLevels(True,1).call(); ask = c.functions.getBookLevels(False,1).call()
        b = bid[0][0] if bid else 0; a = ask[0][0] if ask else 0
        px[bs] = ((b+a)/2)/1e18 if (b and a) else (b or a)/1e18
    except Exception:
        px.setdefault(bs, 0)

latest = w3.eth.block_number
SCAN = 3000  # blocks to scan for activity

def activity(addr):
    """Count base-token transfers (in+out) per pair over last SCAN blocks → what they trade."""
    out = {}
    ap = "0x" + "0"*24 + addr[2:].lower()
    for bs, (taddr, dec) in toks.items():
        if bs == "USDso": continue
        n = 0
        for k in range(SCAN // 1000):
            hi = latest - k*1000; lo = hi - 999
            for topics in ([TRANSFER, ap, None], [TRANSFER, None, ap]):
                try:
                    n += len(w3.eth.get_logs({"fromBlock": lo, "toBlock": hi, "address": taddr, "topics": topics}))
                except Exception:
                    pass
        if n: out[bs] = n
    return out

print(f"{'trader':<11}{'SOMI':>8}{'USDso':>9}{'WETH$':>8}{'WBTC$':>8}{'USDC.e$':>9}{'total$':>8}  trading(last {0}blk: pair=xfers)".format(SCAN))
for name, addr in OPP:
    a = Web3.to_checksum_address(addr)
    somi = w3.eth.get_balance(a)/1e18
    vals = {}
    for bs,(taddr,dec) in toks.items():
        try: vals[bs] = w3.eth.contract(address=taddr,abi=ERC20).functions.balanceOf(a).call()/(10**dec)
        except Exception: vals[bs]=0
    usdso = vals.get("USDso",0)
    weth = vals.get("WETH",0)*px.get("WETH",0)
    wbtc = vals.get("WBTC",0)*px.get("WBTC",0)
    usdce = vals.get("USDC.e",0)*px.get("USDC.e",1)
    tot = usdso+weth+wbtc+usdce+somi*px.get("SOMI",0)
    act = activity(addr)
    actstr = " ".join(f"{k}={v}" for k,v in sorted(act.items(), key=lambda x:-x[1]))
    print(f"{name:<11}{somi:>8.2f}{usdso:>9.2f}{weth:>8.1f}{wbtc:>8.1f}{usdce:>9.1f}{tot:>8.1f}  {actstr}")
print(f"prices: WETH={px.get('WETH',0):.1f} WBTC={px.get('WBTC',0):.0f} SOMI={px.get('SOMI',0):.4f}")
