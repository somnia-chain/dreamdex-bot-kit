# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""WebSocket order book feed for dreamDEX public WS API."""
import asyncio
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

import websockets

logger = logging.getLogger(__name__)

DEFAULT_WS_URL = "wss://api.dreamdex.io/v0/ws/public"


class OrderBookFeed:
    """Maintains best bid/ask from WS orderbook channel with RPC fallback."""

    def __init__(
        self,
        symbol: str,
        ws_url: str = DEFAULT_WS_URL,
        ping_interval_sec: float = 25.0,
    ):
        self.symbol = symbol
        self.ws_url = ws_url
        self.ping_interval_sec = ping_interval_sec
        self._best_bid: Optional[int] = None
        self._best_ask: Optional[int] = None
        self._bids: Dict[int, int] = {}
        self._asks: Dict[int, int] = {}
        self._task: Optional[asyncio.Task] = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    def best_prices(self) -> Tuple[Optional[int], Optional[int]]:
        return self._best_bid, self._best_ask

    def top_depth(self, n_levels: int = 5) -> Tuple[int, int]:
        """Summed quantity of the top N bid and ask levels (raw units)."""
        bid_levels = sorted(self._bids.keys(), reverse=True)[:n_levels]
        ask_levels = sorted(self._asks.keys())[:n_levels]
        bid_qty = sum(self._bids[p] for p in bid_levels)
        ask_qty = sum(self._asks[p] for p in ask_levels)
        return bid_qty, ask_qty

    def _apply_levels(self, side: str, levels: List[Dict[str, Any]], quote_decimals: int) -> None:
        book = self._bids if side == "bid" else self._asks
        for level in levels:
            price_human = level.get("price") or level.get("priceRaw")
            qty_human = level.get("quantity") or level.get("amount") or level.get("quantityRaw")
            if price_human is None:
                continue
            if isinstance(price_human, str) and "." in price_human:
                price_raw = int(float(price_human) * (10**quote_decimals))
            else:
                price_raw = int(price_human)
            if qty_human is None:
                qty_raw = 0
            elif isinstance(qty_human, str) and "." in str(qty_human):
                qty_raw = int(float(qty_human) * (10**18))
            else:
                qty_raw = int(qty_human)
            if qty_raw <= 0:
                book.pop(price_raw, None)
            else:
                book[price_raw] = qty_raw
        if side == "bid":
            self._best_bid = max(book.keys()) if book else None
        else:
            self._best_ask = min(book.keys()) if book else None

    def _handle_snapshot(self, message: Dict[str, Any], quote_decimals: int) -> None:
        data = message.get("data") or message
        bids = data.get("bids") or []
        asks = data.get("asks") or []
        self._bids.clear()
        self._asks.clear()
        self._apply_levels("bid", bids, quote_decimals)
        self._apply_levels("ask", asks, quote_decimals)

    def _handle_update(self, message: Dict[str, Any], quote_decimals: int) -> None:
        data = message.get("data") or message
        for side_key, side in (("bids", "bid"), ("asks", "ask")):
            levels = data.get(side_key)
            if levels:
                self._apply_levels(side, levels, quote_decimals)

    async def _listen(self, quote_decimals: int) -> None:
        while True:
            try:
                async with websockets.connect(self.ws_url, ping_interval=None) as ws:
                    sub = {
                        "operation": "subscribe",
                        "channel": "orderbook",
                        "params": {"symbols": [self.symbol]},
                    }
                    await ws.send(json.dumps(sub))
                    self._connected = True
                    logger.info(f"WS orderbook connected for {self.symbol}")

                    last_ping = asyncio.get_event_loop().time()
                    async for raw in ws:
                        now = asyncio.get_event_loop().time()
                        if now - last_ping >= self.ping_interval_sec:
                            await ws.send(json.dumps({"operation": "ping"}))
                            last_ping = now

                        if not raw:
                            continue
                        message = json.loads(raw)
                        op = message.get("operation") or message.get("type")
                        channel = message.get("channel", "")

                        if op == "pong":
                            continue
                        if channel != "orderbook" and "orderbook" not in str(message.get("type", "")):
                            msg_type = message.get("type", "")
                            if msg_type == "orderbook:snapshot":
                                self._handle_snapshot(message, quote_decimals)
                            elif msg_type == "orderbook:update":
                                self._handle_update(message, quote_decimals)
                            continue

                        msg_type = message.get("type", "")
                        if msg_type == "orderbook:snapshot" or "snapshot" in msg_type:
                            self._handle_snapshot(message, quote_decimals)
                        elif msg_type == "orderbook:update" or "update" in msg_type:
                            self._handle_update(message, quote_decimals)
                        elif "bids" in message or "asks" in message:
                            self._handle_snapshot(message, quote_decimals)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._connected = False
                logger.warning(f"WS orderbook disconnected: {exc}; reconnecting in 5s")
                await asyncio.sleep(5)

    async def start(self, quote_decimals: int) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._listen(quote_decimals))

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


class MultiOrderBookFeed:
    """WebSocket order books for multiple symbols."""

    def __init__(
        self,
        symbols: List[str],
        ws_url: str = DEFAULT_WS_URL,
        quote_decimals: int = 18,
        ping_interval_sec: float = 25.0,
    ):
        self.symbols = symbols
        self.ws_url = ws_url
        self.quote_decimals = quote_decimals
        self.ping_interval_sec = ping_interval_sec
        self._books: Dict[str, OrderBookFeed] = {
            symbol: OrderBookFeed(symbol, ws_url=ws_url, ping_interval_sec=ping_interval_sec)
            for symbol in symbols
        }
        self._task: Optional[asyncio.Task] = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    def best_prices(self, symbol: str) -> Tuple[Optional[int], Optional[int]]:
        feed = self._books.get(symbol)
        if feed is None:
            return None, None
        return feed.best_prices()

    def top_depth(self, symbol: str, n_levels: int = 5) -> Tuple[int, int]:
        feed = self._books.get(symbol)
        if feed is None:
            return 0, 0
        return feed.top_depth(n_levels)

    async def _listen(self) -> None:
        while True:
            try:
                async with websockets.connect(self.ws_url, ping_interval=None) as ws:
                    sub = {
                        "operation": "subscribe",
                        "channel": "orderbook",
                        "params": {"symbols": self.symbols},
                    }
                    await ws.send(json.dumps(sub))
                    self._connected = True
                    logger.info(f"WS multi orderbook connected for {self.symbols}")

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

                        symbol = message.get("symbol") or (message.get("data") or {}).get("symbol")
                        if not symbol and "params" in message:
                            symbol = message.get("params", {}).get("symbol")
                        if not symbol:
                            continue

                        feed = self._books.get(symbol)
                        if feed is None:
                            continue

                        msg_type = message.get("type", "")
                        if msg_type == "orderbook:snapshot" or "snapshot" in msg_type:
                            feed._handle_snapshot(message, self.quote_decimals)
                        elif msg_type == "orderbook:update" or "update" in msg_type:
                            feed._handle_update(message, self.quote_decimals)
                        elif "bids" in message or "asks" in message:
                            feed._handle_snapshot(message, self.quote_decimals)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._connected = False
                logger.warning(f"WS multi orderbook disconnected: {exc}; reconnecting in 5s")
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

