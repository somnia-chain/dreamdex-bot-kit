# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""WebSocket public trades feed for dreamDEX — rolling order-flow window.

Subscribes to the `trades` channel and keeps a short rolling window of recent
executed trades per symbol so strategies can measure aggressive buy/sell flow
(whale detection / momentum).
"""
import asyncio
import json
import logging
import time
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

import websockets

logger = logging.getLogger(__name__)

DEFAULT_WS_URL = "wss://api.dreamdex.io/v0/ws/public"


class TradesFeed:
    """Maintains a rolling window of recent trades per symbol.

    Each trade is stored as (timestamp_ms, side, price, quantity, quote_value).
    side is the aggressor side: 'buy' = taker bought (bullish pressure).
    """

    def __init__(
        self,
        symbols: List[str],
        ws_url: str = DEFAULT_WS_URL,
        window_sec: float = 60.0,
        ping_interval_sec: float = 25.0,
    ):
        self.symbols = symbols
        self.ws_url = ws_url
        self.window_sec = window_sec
        self.ping_interval_sec = ping_interval_sec
        self._trades: Dict[str, Deque[tuple]] = {s: deque() for s in symbols}
        self._task: Optional[asyncio.Task] = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    def _record(self, symbol: str, trade: Dict) -> None:
        if symbol not in self._trades:
            return
        try:
            price = float(trade.get("price"))
            qty = float(trade.get("quantity") or trade.get("amount") or 0)
            side = str(trade.get("side", "")).lower()
            ts = int(trade.get("timestamp", time.time() * 1000))
        except (TypeError, ValueError):
            return
        if price <= 0 or qty <= 0 or side not in ("buy", "sell"):
            return
        self._trades[symbol].append((ts, side, price, qty, price * qty))
        self._prune(symbol)

    def _prune(self, symbol: str) -> None:
        cutoff_ms = (time.time() - self.window_sec) * 1000
        dq = self._trades[symbol]
        while dq and dq[0][0] < cutoff_ms:
            dq.popleft()

    def recent_flow(self, symbol: str, window_sec: Optional[float] = None) -> Dict[str, float]:
        """Net and gross aggressive flow (in quote/USDso terms) over the window."""
        dq = self._trades.get(symbol)
        result = {"net_quote": 0.0, "total_quote": 0.0, "n": 0,
                  "buy_quote": 0.0, "sell_quote": 0.0, "last_price": 0.0}
        if not dq:
            return result
        w = self.window_sec if window_sec is None else window_sec
        cutoff_ms = (time.time() - w) * 1000
        for ts, side, price, qty, quote_val in dq:
            if ts < cutoff_ms:
                continue
            result["total_quote"] += quote_val
            result["n"] += 1
            result["last_price"] = price
            if side == "buy":
                result["buy_quote"] += quote_val
            else:
                result["sell_quote"] += quote_val
        result["net_quote"] = result["buy_quote"] - result["sell_quote"]
        return result

    def _ingest(self, message: Dict) -> None:
        symbol = message.get("symbol") or (message.get("data") or {}).get("symbol")
        if not symbol:
            return
        msg_type = message.get("type", "")
        if msg_type == "snapshot" or "snapshot" in msg_type:
            for tr in (message.get("trades") or []):
                self._record(symbol, tr)
        elif msg_type == "update" or "update" in msg_type:
            tr = message.get("trade")
            if tr:
                self._record(symbol, tr)

    async def _listen(self) -> None:
        while True:
            try:
                async with websockets.connect(self.ws_url, ping_interval=None) as ws:
                    await ws.send(json.dumps({
                        "operation": "subscribe",
                        "channel": "trades",
                        "params": {"symbols": self.symbols},
                    }))
                    self._connected = True
                    logger.info(f"WS trades feed connected for {self.symbols}")
                    last_ping = asyncio.get_event_loop().time()
                    async for raw in ws:
                        now = asyncio.get_event_loop().time()
                        if now - last_ping >= self.ping_interval_sec:
                            await ws.send(json.dumps({"operation": "ping"}))
                            last_ping = now
                        if not raw:
                            continue
                        message = json.loads(raw)
                        if message.get("operation") == "pong":
                            continue
                        if message.get("channel") == "trades" or message.get("type") in (
                            "snapshot", "update"
                        ):
                            self._ingest(message)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._connected = False
                logger.warning(f"WS trades feed disconnected: {exc}; reconnecting in 5s")
                await asyncio.sleep(5)

    async def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._connected = False
