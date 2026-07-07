#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Cancel ALL open orders on the given pairs (default WETH+WBTC) for the wallet
in PROFIT_PRIVATE_KEY/PROFIT_ADDRESS (falls back to MAINNET key / H address).
Needed because --shutdown only cancels one order; restarts can leave several
resting, which self-match and silently block taker sells (CancelMaker)."""
import os, sys
sys.path.insert(0, "/app")
from trading.dreamdex import DreamDEX

KEY = os.environ.get("PROFIT_PRIVATE_KEY") or os.environ.get("MAINNET_PRIVATE_KEY")
ADDR = os.environ.get("PROFIT_ADDRESS", "0xF4c825F3C2970153d78B407CF190861dd4E2b905")
pairs = sys.argv[1:] or ["WETH:USDso", "WBTC:USDso"]

dex = DreamDEX(private_key=KEY, address=ADDR)
for pair in pairs:
    for _ in range(30):
        try:
            o = dex.get_open_orders(pair)
        except Exception as e:
            print(pair, "list err", str(e)[:70]); break
        if not o:
            break
        for x in o:
            oid = str(x.get("id") or x.get("orderId") or x.get("order_id") or "")
            if oid:
                try:
                    r = dex.cancel_order(pair, oid)
                    print(pair, "cancel", oid[:18], r.get("status"))
                except Exception as e:
                    print(pair, "cancel err", str(e)[:50])
    try:
        print(pair, "remaining:", len(dex.get_open_orders(pair)))
    except Exception:
        pass
