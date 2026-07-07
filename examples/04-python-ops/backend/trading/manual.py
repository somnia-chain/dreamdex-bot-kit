# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/trading/manual.py
from trading.dreamdex import DreamDEX
from monitor import db as agent_db
from config import MARKETS

class ManualTrader:
    def __init__(self):
        self.dex = DreamDEX()

    def execute(self, pair: str, side: str, amount_usdso: float, prices: dict = None, skip_sim: bool = False) -> dict:
        print(f"[ManualTrader] Triggered manual trade: {side} {pair} for ${amount_usdso}")

        if not prices:
            return {"status": "error", "error": "No price feed provided"}

        mid = prices.get(pair, {}).get("mid", 0)
        if not mid:
            return {"status": "error", "error": f"No price available for {pair}"}

        # H1 fix: read lot/min from the live-refreshed MARKETS dict instead of a
        # hardcoded table. Old table missed USDC.e entirely (6-decimal base) and
        # would drift if the pool ever re-paramed.
        mkt = MARKETS.get(pair)
        if not mkt:
            return {"status": "error", "error": f"Unknown pair {pair} — not in MARKETS"}

        qty = round(amount_usdso / mid, 8)
        try:
            lot     = float(mkt.get("lotSize", 0.0001))
            min_qty = float(mkt.get("minQuantity", 0.001))
            qty = round(round(qty / lot) * lot, 8)
            if qty < min_qty:
                # Notify the caller they're requesting below pool minimum — bumping
                # to min_qty means actual spend will exceed amount_usdso.
                bumped_cost = min_qty * mid
                print(f"[ManualTrader] qty {qty} < min {min_qty} — bumping (cost ~${bumped_cost:.2f} vs requested ${amount_usdso})")
                qty = min_qty
        except Exception as e:
            print(f"[ManualTrader] Error snapping qty: {e}")

        result = self.dex.place_order(
            symbol=pair,
            side=side,
            qty=qty,
            order_type="market",
            skip_sim=skip_sim,
        )

        # Mirror to sqlite so manual trades show up in /agent/stats alongside
        # agent trades. Tagged with mode="manual" for easy filtering.
        try:
            agent_db.record_trade({
                "action":       side,
                "pair":         pair,
                "qty":          qty,
                "amount_usdso": amount_usdso,
                "mid":          mid,
                "reason":       "manual override (dashboard or watch)",
                "confidence":   100,
                "result":       result,
            }, mode="manual")
        except Exception as e:
            print(f"[ManualTrader] db.record_trade failed: {e}")

        return result
