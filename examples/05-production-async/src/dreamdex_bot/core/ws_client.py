# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
WebSocket client for the DreamDEX real-time feed.

Channels (per docs):
  - orderbook  — snapshots and incremental bid/ask updates
  - trades     — recent trade snapshots and new trade updates
  - order      — one specific order by orderId

The docs use operation-based messages and a 60s inactivity timeout. We implement:
  - Application ping every 20s (well under the 30s recommendation)
  - Reconnect with exponential backoff on disconnect
  - Re-subscribe automatically on reconnect

This is the bot's vital nervous system. If it goes silent, the risk manager
should kill all orders. The engine watches `ws_last_message_ts` for staleness.
"""

from __future__ import annotations

import asyncio
import json
import ssl
import time
from collections.abc import Callable, Awaitable
from typing import Any

import websockets
import certifi
from websockets.client import WebSocketClientProtocol
from websockets.exceptions import ConnectionClosed

from dreamdex_bot.utils.logger import get_logger


log = get_logger(__name__)


# Type alias for channel handlers
Handler = Callable[[dict[str, Any]], Awaitable[None]]


class WsClient:
    """Lifetime-managed WebSocket connection with auto-reconnect.

    Usage:
        ws = WsClient(url="wss://...", jwt_provider=client.ensure_auth)
        ws.subscribe("orderbook.SOMI:USDso", handle_book)
        await ws.start()  # runs forever
    """

    def __init__(
        self,
        url: str,
        jwt_provider: Callable[[], Awaitable[str]] | None = None,
        ping_interval: float = 20.0,
        max_reconnect_backoff: float = 30.0,
    ) -> None:
        self.url = url
        self.jwt_provider = jwt_provider  # Async fn that returns a fresh JWT
        self.ping_interval = ping_interval
        self.max_reconnect_backoff = max_reconnect_backoff

        self._handlers: dict[str, list[tuple[Handler, bool]]] = {}  # channel → (handler, authed)
        self._reconnect_hooks: list[Callable[[], Awaitable[None]]] = []
        self._ws: WebSocketClientProtocol | None = None
        self._stopped = False
        self._last_message_ts: float = time.time()
        self._request_id_counter = 0
        self._has_connected_once: bool = False
        self._ssl_context = ssl.create_default_context(cafile=certifi.where())

    @property
    def last_message_ts(self) -> float:
        return self._last_message_ts

    def subscribe(self, channel: str, handler: Handler, authed: bool = False) -> None:
        """Register a handler for a channel. Handlers run in order of registration."""
        self._handlers.setdefault(channel, []).append((handler, authed))

    async def subscribe_order(self, order_id: str, handler: Handler) -> None:
        """Subscribe to the documented per-order lifecycle channel.

        dreamDEX does not expose account-wide private order/fill channels. The
        documented lifecycle path is one dynamic subscription per orderId.
        """
        channel = f"order.{order_id}"
        handlers = self._handlers.setdefault(channel, [])
        if not any(existing is handler for existing, _ in handlers):
            handlers.append((handler, False))
        if self._ws is not None:
            await self._send({
                "operation": "subscribe",
                "channel": "order",
                "params": {"orderId": str(order_id)},
            })

    async def unsubscribe_order(self, order_id: str) -> None:
        """Unsubscribe from a per-order lifecycle channel."""
        channel = f"order.{order_id}"
        self._handlers.pop(channel, None)
        if self._ws is not None:
            await self._send({
                "operation": "unsubscribe",
                "channel": "order",
                "params": {"orderId": str(order_id)},
            })

    def on_reconnect(self, hook: Callable[[], Awaitable[None]]) -> None:
        """Register a coroutine to be called after every successful reconnect
        (NOT the initial connect). Use this to refresh REST-derived state after
        a WS gap — open orders, balances, anything that may have changed during
        the disconnect.
        """
        self._reconnect_hooks.append(hook)

    async def start(self) -> None:
        """Main loop. Reconnects forever until stop() is called."""
        backoff = 1.0
        while not self._stopped:
            try:
                await self._run_once()
                backoff = 1.0  # reset on clean run
            except (ConnectionClosed, OSError, asyncio.TimeoutError) as e:
                log.warning("ws.disconnected", error=str(e), reconnect_in=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.max_reconnect_backoff)
            except Exception as e:
                log.error("ws.unexpected_error", error=str(e), reconnect_in=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.max_reconnect_backoff)

    async def _run_once(self) -> None:
        log.info("ws.connecting", url=self.url)
        async with websockets.connect(
            self.url, ping_interval=None, ssl=self._ssl_context  # we drive pings ourselves
        ) as ws:
            self._ws = ws
            log.info("ws.connected")
            self._last_message_ts = time.time()

            # Send all subscriptions
            await self._send_subscriptions()

            # If this is a reconnect (not the first connect), fire reconnect hooks
            if self._has_connected_once:
                for hook in self._reconnect_hooks:
                    try:
                        await hook()
                    except Exception as e:
                        log.error("ws.reconnect_hook_failed", error=str(e))
            self._has_connected_once = True

            # Spin up ping task and message reader concurrently
            tasks = [
                asyncio.create_task(self._ping_loop()),
                asyncio.create_task(self._read_loop()),
            ]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                # Re-raise any exception from the finished task
                for t in done:
                    exc = t.exception()
                    if exc is not None:
                        raise exc
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _send_subscriptions(self) -> None:
        """Subscribe to all registered channels using the documented protocol."""
        assert self._ws is not None
        orderbook_symbols: list[str] = []
        trade_symbols: list[str] = []
        order_ids: list[str] = []

        for channel in self._handlers:
            if channel.startswith("orderbook."):
                orderbook_symbols.append(channel.split(".", 1)[1])
            elif channel.startswith("trades."):
                trade_symbols.append(channel.split(".", 1)[1])
            elif channel.startswith("order."):
                order_ids.append(channel.split(".", 1)[1])
            elif channel in {"orders", "fills"}:
                log.warning(
                    "ws.subscription_skipped",
                    channel=channel,
                    note="Docs expose per-order `order` subscriptions, not global orders/fills.",
                )

        if orderbook_symbols:
            await self._send({
                "operation": "subscribe",
                "channel": "orderbook",
                "params": {"symbols": sorted(set(orderbook_symbols))},
            })
        if trade_symbols:
            await self._send({
                "operation": "subscribe",
                "channel": "trades",
                "params": {"symbols": sorted(set(trade_symbols)), "limit": 100},
            })
        for order_id in sorted(set(order_ids)):
            await self._send({
                "operation": "subscribe",
                "channel": "order",
                "params": {"orderId": order_id},
            })

    async def _send(self, payload: dict[str, Any]) -> None:
        assert self._ws is not None
        await self._ws.send(json.dumps(payload))
        log.debug("ws.sent", payload=payload)

    async def _ping_loop(self) -> None:
        """Send a ping every ping_interval seconds to keep the connection alive."""
        assert self._ws is not None
        while True:
            await asyncio.sleep(self.ping_interval)
            try:
                await self._ws.send(json.dumps({"operation": "ping"}))
            except (asyncio.TimeoutError, ConnectionClosed):
                log.warning("ws.ping_failed")
                raise  # bubble up so _run_once reconnects

    async def _read_loop(self) -> None:
        assert self._ws is not None
        async for raw in self._ws:
            self._last_message_ts = time.time()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("ws.malformed_json", raw=raw[:200])
                continue
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        """Route a message to the right channel handler(s).

        Server frame shape:
            {"channel": "orderbook", "type": "snapshot", "symbol": "...", ...}
            {"channel": "trades", "type": "update", "symbol": "...", "trade": {...}}
            {"channel": "order", "type": "update", "order": {...}}
        """
        if msg.get("channel") == "error" or "error" in msg:
            log.warning("ws.server_error", error=msg.get("error") or msg.get("message"))
            return
        if msg.get("operation") == "pong":
            return
        if "channel" not in msg:
            # Subscribe-ack or other control message
            log.debug("ws.control_msg", msg=msg)
            return
        channel = msg["channel"]
        dispatch_data = msg
        keys = [channel]
        symbol = msg.get("symbol")
        if channel in {"orderbook", "trades"} and symbol:
            keys.insert(0, f"{channel}.{symbol}")
        if channel == "trades" and msg.get("type") == "update" and isinstance(msg.get("trade"), dict):
            dispatch_data = {"market": symbol, **msg["trade"]}
        elif channel == "order" and isinstance(msg.get("order"), dict):
            dispatch_data = msg["order"]
            order_id = dispatch_data.get("id")
            if order_id:
                keys.insert(0, f"order.{order_id}")

        handlers: list[tuple[Handler, bool]] = []
        for key in keys:
            handlers.extend(self._handlers.get(key, []))

        for handler, _ in handlers:
            try:
                await handler(dispatch_data)
            except Exception as e:
                log.error("ws.handler_error", channel=channel, error=str(e))

    def stop(self) -> None:
        self._stopped = True
        if self._ws is not None:
            try:
                asyncio.create_task(self._ws.close())
            except RuntimeError:
                pass
