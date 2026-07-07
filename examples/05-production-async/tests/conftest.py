# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Shared pytest fixtures for the dreamdex-bot test suite.

These tests run offline — no network, no chain. We mock httpx and web3 via
unittest.mock so the tests are deterministic and fast.
"""

from __future__ import annotations

import os
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest

# Ensure imports work whether tests run via pytest or directly
os.environ.setdefault("WALLET_ADDRESS", "0x" + "1" * 40)
os.environ.setdefault("PRIVATE_KEY", "0x" + "1" * 64)
os.environ.setdefault("NETWORK", "testnet")


@pytest.fixture
def mock_settings():
    """Settings object with placeholder values that won't try to touch a real network."""
    from dreamdex_bot.config import Settings, Network
    s = Settings(
        network=Network.TESTNET,
        wallet_address="0x" + "1" * 40,
        private_key="0x" + "1" * 64,
    )
    return s


@pytest.fixture
def mock_web3():
    """A web3 mock that returns deterministic responses for the calls our code makes."""
    w3 = MagicMock()
    w3.eth.get_transaction_count = AsyncMock(return_value=100)
    w3.eth.get_balance = AsyncMock(return_value=10**18)
    w3.eth.gas_price = AsyncMock(return_value=1_000_000_000)
    w3.eth.send_raw_transaction = AsyncMock(return_value=MagicMock(hex=lambda: "0xdeadbeef"))
    w3.eth.wait_for_transaction_receipt = AsyncMock(return_value={"status": 1, "blockNumber": 1})
    w3.eth.get_transaction = AsyncMock(return_value={"nonce": 100})
    return w3


@pytest.fixture
def mock_account():
    """eth_account mock — signs anything and returns a fake signed tx."""
    acct = MagicMock()
    acct.address = "0x" + "1" * 40
    signed = MagicMock()
    signed.raw_transaction = b"\x00" * 100
    signed.signature = b"\x00" * 65
    acct.sign_transaction.return_value = signed
    acct.sign_message.return_value = MagicMock(signature=b"\x00" * 65)
    return acct
