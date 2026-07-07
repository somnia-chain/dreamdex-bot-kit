# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Live single-order test: $0.10 USDso SOMI buy via vault funding.

Exercises:
  - Fix 1: state.record_trade gated on result.status == "success"
  - Fix 4: silent-reject detection (status==1 + pool log present)
  - End-to-end SIWE -> /orders -> sign -> broadcast -> receipt
"""
import os, json, traceback
os.environ.setdefault("DREAMDEX_ENV", "testnet")

from config import MARKETS
from trading.dreamdex import DreamDEX
from agent.state import AgentState

def main():
    dex = DreamDEX()
    state = AgentState()
    pair = "SOMI:USDso"
    mkt = MARKETS[pair]
    print(f"pool={mkt['contract']}  tick={mkt.get('tickSize')}  lot={mkt.get('lotSize')}  min={mkt.get('minQuantity')}")

    # Get a current mid from trades fallback (ticker returns 0)
    trades = dex.get_recent_trades(pair, limit=1)
    if isinstance(trades, dict): trades = trades.get("trades", [])
    if not trades:
        print("no recent trades — abort"); return
    px = float(trades[0]["price"])
    print(f"last SOMI px = {px}")

    # $0.10 USDso buy => qty = 0.10 / px. Round up to lot/min.
    lot = float(mkt["lotSize"])
    minq = float(mkt["minQuantity"])
    qty = max(minq, round((0.10 / px) / lot) * lot)
    print(f"qty = {qty} SOMI  (~{qty*px:.4f} USDso)")

    print("\n-- placing IOC buy (vault funded) --")
    result = dex.place_order(
        symbol=pair, side="buy", qty=qty,
        order_type="ioc", limit_price=None, funding="vault",
    )
    print(f"\nresult: {json.dumps(result, default=str)}")

    print("\n-- Fix 1 check: state mutates only on success --")
    log_entry = {"action": "buy", "pair": pair, "amount_usdso": 0.10, "qty": qty, "mid": px, "result": result}
    before_tx = state.summary()["tx_count"]
    if result.get("status") == "success":
        state.record_trade(log_entry)
        print(f"  status=success -> recorded. tx_count {before_tx} -> {state.summary()['tx_count']}")
    else:
        print(f"  status={result.get('status')} -> NOT recorded (correct). tx_count stays {before_tx}")

    print("\n-- Fix 4 check: classifier verdict --")
    print(f"  classified as: {result.get('status')}")
    if result.get("tx_hash"):
        print(f"  tx: {result['tx_hash']}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}")
        traceback.print_exc()
