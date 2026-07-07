#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Deep sweep of opponents: on-chain wallet balances (all tokens + native SOMI),
total tx count, and open resting orders per pair. Reveals hidden inventory the
leaderboard (wallet-USDso only) hides. Read-only."""
import os, sys
sys.path.insert(0, "/app")
from web3 import Web3
from config import SOMNIA_RPC, MARKETS
from trading.dreamdex import DreamDEX

w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 20}))
ERC20 = [{"name":"balanceOf","type":"function","stateMutability":"view",
          "inputs":[{"name":"a","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]
POOL = [{"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels",
        "outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],
        "name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"}]

OPP = [
    ("trader-3", "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86"),
    ("trader-2", "0x43876c4668Ac0207F000C387eAf1eC8884f26BC7"),
    ("trader-4", "0x4258950186a12492Bf805f2B9D7facd202921F34"),
    ("trader-6", "0xf181221f2e6fb0a3c37558ee2e1f4bc93f161406"),
    ("trader-9(us)", "0xF4c825F3C2970153d78B407CF190861dd4E2b905"),
]

# token map {addr_lower: (sym, decimals)} from MARKETS
toks = {}
for sym, m in MARKETS.items():
    b, q = m["base"], m["quote"]
    bd = int(m.get("baseDecimals", 18)); qd = int(m.get("quoteDecimals", 18))
    base_sym = sym.split(":")[0]
    if b and b != "0x0000000000000000000000000000000000000000":
        toks[Web3.to_checksum_address(b)] = (base_sym, bd)
    toks[Web3.to_checksum_address(q)] = ("USDso", qd)

# mid price per pair for valuing base inventory
px = {}
for sym, m in MARKETS.items():
    try:
        c = w3.eth.contract(address=Web3.to_checksum_address(m["contract"]), abi=POOL)
        bid = c.functions.getBookLevels(True, 1).call()
        ask = c.functions.getBookLevels(False, 1).call()
        b = bid[0][0] if bid else 0; a = ask[0][0] if ask else 0
        mid = ((b + a) / 2) / 1e18 if (b and a) else (b or a) / 1e18
        px[sym.split(":")[0]] = mid
    except Exception:
        px[sym.split(":")[0]] = 0
px["USDso"] = 1.0

dex = DreamDEX(private_key=os.environ.get("MAINNET_PRIVATE_KEY"),
               address="0xF4c825F3C2970153d78B407CF190861dd4E2b905")
dex._ensure_auth()

def opp_orders(addr):
    """Probe whether the orders API honors a walletAddress filter for arbitrary
    addresses. Returns (orders_for_addr, api_filters_bool)."""
    out = []
    filt = None
    for sym in MARKETS:
        try:
            r = dex._session.get(f"{dex.base_url}/v0/markets/{sym}/orders",
                                 params={"status":"open","walletAddress":addr}, timeout=10)
            if r.status_code != 200: continue
            j = r.json(); orders = j if isinstance(j, list) else j.get("orders", [])
            for o in orders:
                wa = (o.get("walletAddress") or "").lower()
                if wa == addr.lower():
                    out.append((sym, o.get("side"), o.get("remaining"), o.get("price")))
                    filt = True
                elif wa:
                    filt = False  # API returned someone else's order = ignores filter
        except Exception:
            pass
    return out, filt

print(f"{'trader':<14}{'SOMI':>9}{'USDso':>10}{'WETH$':>9}{'WBTC$':>9}{'USDC.e$':>9}{'invTot$':>9}{'txCount':>9}")
for name, addr in OPP:
    a = Web3.to_checksum_address(addr)
    somi = w3.eth.get_balance(a) / 1e18
    nonce = w3.eth.get_transaction_count(a)
    vals = {}
    for taddr, (tsym, dec) in toks.items():
        try:
            bal = w3.eth.contract(address=taddr, abi=ERC20).functions.balanceOf(a).call() / (10**dec)
        except Exception:
            bal = 0
        vals[tsym] = vals.get(tsym, 0) + bal
    usdso = vals.get("USDso", 0)
    weth = vals.get("WETH", 0) * px.get("WETH", 0)
    wbtc = vals.get("WBTC", 0) * px.get("WBTC", 0)
    usdce = vals.get("USDC.e", 0) * px.get("USDC.e", 1)
    somi_usd = somi * px.get("SOMI", 0)
    inv = weth + wbtc + usdce + somi_usd  # base inventory value (sellable for a burst)
    print(f"{name:<14}{somi:>9.2f}{usdso:>10.3f}{weth:>9.2f}{wbtc:>9.2f}{usdce:>9.2f}{inv:>9.2f}{nonce:>9}")

print("\n=== open resting orders (per opponent) ===")
filtnote = None
for name, addr in OPP:
    oo, filt = opp_orders(addr)
    filtnote = filt if filt is not None else filtnote
    if oo:
        print(f"{name}: " + "; ".join(f"{s} {sd} rem={rm}@{pr}" for s,sd,rm,pr in oo))
    else:
        print(f"{name}: (none returned)")
print(f"\n[orders API walletAddress filter honored: {filtnote}]  (None=undetermined/empty)")
print(f"prices: WETH={px.get('WETH'):.2f} WBTC={px.get('WBTC'):.2f} SOMI={px.get('SOMI'):.4f} USDC.e={px.get('USDC.e'):.4f}")
