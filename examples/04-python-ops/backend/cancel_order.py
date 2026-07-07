#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Cancel a SPECIFIC order by id (reliable — bypasses the unreliable
get_open_orders enumeration). Usage: cancel_order.py PAIR ORDER_ID"""
import os, sys
sys.path.insert(0, "/app")
from trading.dreamdex import DreamDEX
KEY = os.environ.get("PROFIT_PRIVATE_KEY") or os.environ.get("MAINNET_PRIVATE_KEY")
ADDR = os.environ.get("PROFIT_ADDRESS", "0xF4c825F3C2970153d78B407CF190861dd4E2b905")
pair, oid = sys.argv[1], sys.argv[2]
dex = DreamDEX(private_key=KEY, address=ADDR)
print("cancel", pair, oid, "->", dex.cancel_order(pair, oid))
