#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Deep trade probe: sample each opponent's recent on-chain orders, decode the
order params (method, isBid, price, qty, orderType, selfMatching), and compare
their cross-price to the live mid to read their slippage/aggressiveness. Read-only."""
import sys
sys.path.insert(0, "/app")
from web3 import Web3
from config import SOMNIA_RPC, MARKETS

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 35}))
m = MARKETS["WETH:USDso"]
weth = Web3.to_checksum_address(m["base"])
pool = Web3.to_checksum_address(m["contract"])
base_dec = int(m.get("baseDecimals", 18)); quote_dec = int(m.get("quoteDecimals", 18))
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

ABI = [
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"userData","type":"uint64"},
        {"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"},
        {"name":"expireTimestampNs","type":"uint64"},{"name":"orderType","type":"uint8"},
        {"name":"selfMatchingOption","type":"uint8"},{"name":"builder","type":"address"},
        {"name":"builderFeeBpsTimes1k","type":"uint96"}],
     "name":"placeTakerOrderWithoutVault","outputs":[{"name":"s","type":"bool"},{"name":"o","type":"uint128"}],
     "stateMutability":"payable","type":"function"},
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels",
     "outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],
        "name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"},
]
pc = w3.eth.contract(address=pool, abi=ABI)
bid = pc.functions.getBookLevels(True,1).call(); ask = pc.functions.getBookLevels(False,1).call()
bid_p = bid[0][0]/10**quote_dec if bid else 0
ask_p = ask[0][0]/10**quote_dec if ask else 0
mid = (bid_p+ask_p)/2 if (bid_p and ask_p) else (bid_p or ask_p)
print(f"live book: bid={bid_p:.2f} ask={ask_p:.2f} mid={mid:.2f} spread={(ask_p-bid_p):.2f} ({(ask_p-bid_p)/mid*1e4:.1f}bps)\n")

OPP = [
    ("trader-3", "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86"),
    ("trader-4", "0x4258950186a12492Bf805f2B9D7facd202921F34"),
    ("trader-2", "0x43876c4668Ac0207F000C387eAf1eC8884f26BC7"),
]
latest = w3.eth.block_number
WIN = 200000; N = 14

for name, addr in OPP:
    ap = "0x" + "0"*24 + addr[2:].lower()
    hashes = []
    for k in range(WIN//1000):
        hi = latest - k*1000; lo = hi-999
        for topics in ([TRANSFER, ap, None], [TRANSFER, None, ap]):
            try:
                for l in w3.eth.get_logs({"fromBlock":lo,"toBlock":hi,"address":weth,"topics":topics}):
                    hashes.append(l["transactionHash"].hex())
            except Exception: pass
        if len(set(hashes)) >= N: break
    uniq = list(dict.fromkeys(hashes))[:N]
    methods = {}; otypes = {}; smatch = {}; buys = 0; sells = 0; legs = []; slips = []; tos = {}
    for h in uniq:
        try: tx = w3.eth.get_transaction(h)
        except Exception: continue
        inp = tx["input"] if isinstance(tx["input"], str) else tx["input"].hex()
        if not inp.startswith("0x"): inp = "0x"+inp
        to = (tx["to"] or "").lower()
        tos[to] = tos.get(to, 0) + 1
        try:
            fn, p = pc.decode_function_input(inp)
            methods[fn.fn_name] = methods.get(fn.fn_name, 0)+1
            isb = p["isBid"]; price = p["price"]/10**quote_dec; qty = p["quantity"]/10**base_dec
            ot = p["orderType"]; sm = p["selfMatchingOption"]
            otypes[ot] = otypes.get(ot,0)+1; smatch[sm] = smatch.get(sm,0)+1
            if isb: buys += 1; slip = (price-mid)/mid*1e4
            else: sells += 1; slip = (mid-price)/mid*1e4
            legs.append(qty*mid); slips.append(slip)
        except Exception:
            methods["sel:"+inp[:10]] = methods.get("sel:"+inp[:10],0)+1
    avg_leg = sum(legs)/len(legs) if legs else 0
    avg_slip = sum(slips)/len(slips) if slips else 0
    print(f"== {name} ==  sampled {len(uniq)} tx")
    print(f"   methods: {methods}")
    print(f"   to-contract: {tos}")
    print(f"   orderType: {otypes}  selfMatch: {smatch}  buys={buys} sells={sells}")
    print(f"   avg leg ~${avg_leg:.1f}  avg cross vs mid: {avg_slip:+.1f} bps  (range {min(slips) if slips else 0:+.0f}..{max(slips) if slips else 0:+.0f})\n")
