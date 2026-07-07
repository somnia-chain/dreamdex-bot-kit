# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

import json
from unittest.mock import AsyncMock

import pytest

from dreamdex_bot.core.ws_client import WsClient


async def _handler(_data):
    return None


@pytest.mark.asyncio
async def test_subscribe_order_sends_documented_order_subscription():
    ws = WsClient("wss://example.invalid")
    ws._ws = AsyncMock()

    await ws.subscribe_order("123", _handler)

    ws._ws.send.assert_awaited_once()
    payload = json.loads(ws._ws.send.await_args.args[0])
    assert payload == {
        "operation": "subscribe",
        "channel": "order",
        "params": {"orderId": "123"},
    }
    assert "order.123" in ws._handlers


@pytest.mark.asyncio
async def test_unsubscribe_order_sends_documented_unsubscribe():
    ws = WsClient("wss://example.invalid")
    ws._ws = AsyncMock()
    await ws.subscribe_order("123", _handler)
    ws._ws.send.reset_mock()

    await ws.unsubscribe_order("123")

    ws._ws.send.assert_awaited_once()
    payload = json.loads(ws._ws.send.await_args.args[0])
    assert payload == {
        "operation": "unsubscribe",
        "channel": "order",
        "params": {"orderId": "123"},
    }
    assert "order.123" not in ws._handlers
