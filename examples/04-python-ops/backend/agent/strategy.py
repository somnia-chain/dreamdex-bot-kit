# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/agent/strategy.py
import time
from collections import deque
from config import PRICE_HISTORY_LEN

class PriceAnalyzer:
    """
    Tracks price history and computes momentum signals.
    Not financial advice — just math.
    """
    def __init__(self):
        self.history = {pair: deque(maxlen=PRICE_HISTORY_LEN)
                        for pair in ["WETH:USDso","WBTC:USDso",
                                     "SOMI:USDso","USDC.e:USDso"]}

    def update(self, pair: str, bid: float, ask: float):
        mid = (bid + ask) / 2
        self.history[pair].append({
            "mid": mid, "bid": bid, "ask": ask,
            "spread_pct": (ask - bid) / mid * 100,
            "ts": time.time()
        })

    def get_snapshot(self) -> dict:
        """Full price snapshot with history — fed to brain.py"""
        result = {}
        for pair, hist in self.history.items():
            if not hist:
                continue
            latest = hist[-1]
            result[pair] = {
                "mid":     latest["mid"],
                "bid":     latest["bid"],
                "ask":     latest["ask"],
                "spread":  latest["spread_pct"],
                "history": list(hist),
            }
        return result

    def momentum_signal(self, pair: str) -> str:
        """Simple momentum: UP / DOWN / FLAT"""
        h = self.history.get(pair, [])
        if len(h) < 4:
            return "FLAT"
        mids = [x["mid"] for x in list(h)[-4:]]
        change = (mids[-1] - mids[0]) / mids[0] * 100
        if change > 0.15:  return "UP"
        if change < -0.15: return "DOWN"
        return "FLAT"

    def best_spread_pair(self) -> str:
        """Return pair with tightest spread right now"""
        snap = self.get_snapshot()
        return min(snap.items(),
                   key=lambda x: x[1].get("spread", 999))[0]
