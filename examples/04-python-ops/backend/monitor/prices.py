# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/monitor/prices.py
"""
PriceFeed — polls DreamDEX for live prices.

Primary:  REST GET /v0/markets/{symbol}/tickers  (24h snapshot, includes last price)
Fallback: REST GET /v0/markets/{symbol}/trades   (most recent fill = last mid)

Price is stored as mid = (best_bid + best_ask) / 2 when available, 
or last trade price otherwise.

The PriceFeed also maintains a WebSocket orderbook subscriber (ws_orderbook.py)
for real-time bid/ask updates — but that runs separately and calls .update() here.
"""
import time
import threading
import requests
from collections import deque
from config import DREAMDEX_HTTP, MARKETS, PRICE_POLL_SECONDS, PRICE_HISTORY_LEN


class PriceFeed:
    def __init__(self):
        self._lock    = threading.Lock()
        self._prices  = {
            pair: {"mid": 0.0, "bid": 0.0, "ask": 0.0, "spread": 0.0, "history": deque(maxlen=PRICE_HISTORY_LEN)}
            for pair in MARKETS
        }
        self.running      = False
        self._subscribers = []   # callables: fn(pair, bid, ask)
        self._session     = requests.Session()

    def start(self):
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()
        print("[PriceFeed] Started REST polling")

    def stop(self):
        self.running = False

    def add_subscriber(self, callback):
        self._subscribers.append(callback)

    # ── Called by WebSocket listener (real-time) ──────────
    def update_book(self, pair: str, bid: float, ask: float):
        """Ingest a real-time best bid/ask from the WS orderbook channel."""
        if bid <= 0 or ask <= 0:
            return
        mid    = (bid + ask) / 2
        spread = (ask - bid) / mid * 100 if mid else 0
        with self._lock:
            p = self._prices.get(pair)
            if p is None:
                return
            p["bid"]    = bid
            p["ask"]    = ask
            p["mid"]    = mid
            p["spread"] = spread
            p["history"].append({"mid": mid, "bid": bid, "ask": ask, "ts": time.time()})
        for sub in self._subscribers:
            try:
                sub(pair, bid, ask)
            except Exception as e:
                print(f"[PriceFeed] subscriber error: {e}")

    # ── REST polling fallback ─────────────────────────────
    def _loop(self):
        while self.running:
            self._fetch_all_rest()
            time.sleep(PRICE_POLL_SECONDS)

    def _fetch_all_rest(self):
        for pair in MARKETS:
            self._fetch_ticker(pair)

    def _fetch_ticker(self, pair: str):
        """Pull LIVE top-of-book bid/ask from /v0/orderbooks?symbols=...

        Previously this hit /v0/markets/{pair}/tickers which is a 24h OHLCV
        snapshot — its `close` price changes only daily, producing identical
        polls and a totally flat sparkline. The orderbook endpoint returns
        real bid/ask that move tick-by-tick.
        """
        try:
            url  = f"{DREAMDEX_HTTP}/v0/orderbooks"
            resp = self._session.get(url, params={"symbols": pair}, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                book = data
                if isinstance(data, dict) and "orderbooks" in data and data["orderbooks"]:
                    book = data["orderbooks"][0]
                elif isinstance(data, dict) and "symbols" in data and data["symbols"]:
                    book = data["symbols"][0]
                elif isinstance(data, list) and data:
                    book = data[0]
                bids = book.get("bids") or []
                asks = book.get("asks") or []
                bid_px = ask_px = 0.0
                if bids:
                    t = bids[0]
                    bid_px = float(t.get("price", t[0] if isinstance(t, list) else 0))
                if asks:
                    t = asks[0]
                    ask_px = float(t.get("price", t[0] if isinstance(t, list) else 0))
                if bid_px > 0 and ask_px > 0:
                    self.update_book(pair, bid_px, ask_px)
                    return
            # Empty book or non-200 — fall back to most recent trade
            self._fetch_last_trade(pair)
        except Exception as e:
            print(f"[PriceFeed] orderbook error {pair}: {e}")
            self._fetch_last_trade(pair)

    def _fetch_last_trade(self, pair: str):
        try:
            url  = f"{DREAMDEX_HTTP}/v0/markets/{pair}/trades"
            resp = self._session.get(url, params={"limit": 1}, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                trades_list = []
                if isinstance(data, dict):
                    trades_list = data.get("trades", [])
                elif isinstance(data, list):
                    trades_list = data
                
                if trades_list:
                    t  = trades_list[0]
                    px = float(t.get("price", 0))
                    if px > 0:
                        bid = px * 0.9999
                        ask = px * 1.0001
                        self.update_book(pair, bid, ask)
        except Exception as e:
            print(f"[PriceFeed] last-trade fallback error {pair}: {e}")

    # ── Public API ────────────────────────────────────────
    def latest(self) -> dict:
        """Returns snapshot suitable for Flask JSON response."""
        with self._lock:
            return {
                pair: {
                    "mid":     p["mid"],
                    "bid":     p["bid"],
                    "ask":     p["ask"],
                    "spread":  p["spread"],
                }
                for pair, p in self._prices.items()
            }

    def snapshot_with_history(self) -> dict:
        """Returns full snapshot including price history (for brain.py)."""
        with self._lock:
            return {
                pair: {
                    "mid":     p["mid"],
                    "bid":     p["bid"],
                    "ask":     p["ask"],
                    "spread":  p["spread"],
                    "history": list(p["history"]),
                }
                for pair, p in self._prices.items()
                if p["mid"] > 0
            }
