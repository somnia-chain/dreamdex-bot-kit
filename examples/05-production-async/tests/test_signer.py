# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for NonceManager: concurrent allocation, backpressure, stuck-tx detection."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from dreamdex_bot.core.signer import NonceManager


@pytest.fixture
def web3_mock():
    w3 = MagicMock()
    w3.eth.get_transaction_count = AsyncMock(return_value=100)
    return w3


@pytest.fixture
def account_mock():
    acct = MagicMock()
    acct.address = "0x" + "1" * 40
    return acct


@pytest.fixture
def nonces(web3_mock, account_mock):
    return NonceManager(web3_mock, account_mock, max_in_flight=4, max_stuck_seconds=10.0)


class TestNonceAllocation:
    @pytest.mark.asyncio
    async def test_initialize_reads_chain_nonce(self, nonces, web3_mock):
        await nonces.initialize()
        assert nonces._next_nonce == 100
        web3_mock.eth.get_transaction_count.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_acquire_returns_sequential_nonces(self, nonces):
        await nonces.initialize()
        n1 = await nonces.acquire()
        n2 = await nonces.acquire()
        n3 = await nonces.acquire()
        assert (n1, n2, n3) == (100, 101, 102)

    @pytest.mark.asyncio
    async def test_concurrent_acquires_are_serialized(self, nonces):
        """Critical safety test — no two coroutines should ever get the same nonce."""
        await nonces.initialize()
        nonces_obtained = await asyncio.gather(*(nonces.acquire() for _ in range(10)))
        assert len(set(nonces_obtained)) == 10
        assert sorted(nonces_obtained) == list(range(100, 110))


class TestBackpressure:
    @pytest.mark.asyncio
    async def test_blocks_when_in_flight_exceeds_cap(self, nonces):
        """When pending dict is full, acquire() should block until pending drains."""
        await nonces.initialize()
        # Pre-load pending up to the cap
        for i in range(4):
            n = await nonces.acquire()
            nonces.mark_submitted(n, f"0x{i:0>4}", 1000, {})

        # Now another acquire should block — start it as a task and verify it doesn't complete
        task = asyncio.create_task(nonces.acquire())
        await asyncio.sleep(0.05)  # let task try to start
        assert not task.done(), "Acquire should be blocked when at in-flight cap"

        # Drain one
        nonces.mark_confirmed(100)
        # Allow the backpressure sleep loop to notice
        result = await asyncio.wait_for(task, timeout=2.0)
        assert result == 104


class TestRollback:
    @pytest.mark.asyncio
    async def test_aborted_nonce_rolls_back_if_no_later_issued(self, nonces):
        await nonces.initialize()
        n = await nonces.acquire()
        assert nonces._next_nonce == n + 1
        await nonces.mark_aborted(n)
        assert nonces._next_nonce == n

    @pytest.mark.asyncio
    async def test_aborted_nonce_does_not_rollback_if_later_issued(self, nonces):
        await nonces.initialize()
        n1 = await nonces.acquire()  # 100
        n2 = await nonces.acquire()  # 101
        # Abort the earlier nonce — should NOT rollback because 101 already issued
        await nonces.mark_aborted(n1)
        assert nonces._next_nonce == n2 + 1


class TestStuckDetection:
    @pytest.mark.asyncio
    async def test_confirmed_nonces_cleaned_from_pending(self, nonces, web3_mock):
        await nonces.initialize()
        for i in range(3):
            n = await nonces.acquire()
            nonces.mark_submitted(n, f"0x{i:0>4}", 1000, {})
        assert len(nonces._pending) == 3

        # Simulate chain advancing past nonce 101
        web3_mock.eth.get_transaction_count = AsyncMock(return_value=102)
        await nonces._reconcile_once()
        # Nonces 100 and 101 should be cleaned (latest is 102 = next-to-be-issued)
        assert 100 not in nonces._pending
        assert 101 not in nonces._pending
        assert 102 in nonces._pending
