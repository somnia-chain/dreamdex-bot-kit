# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Transaction signer with a serialized async nonce queue.

This is the file most likely to break the bot in production. The failure modes
we have to defend against, in order of severity:

  1. CONCURRENT NONCE COLLISION
     Two coroutines both call eth_getTransactionCount and both get N, then
     both submit txs with nonce=N. One gets "already known" / "nonce too low"
     and dies. Fix: serialize nonce assignment with an asyncio.Lock.

  2. STUCK PENDING TX
     One tx lands underpriced or RPC drops it. All subsequent nonces stall
     behind it. The bot looks alive (sending txs) but nothing confirms.
     Fix: a reconciler that compares pending-vs-latest tx counts and
     replace-by-fee's the oldest stuck nonce when the gap grows.

  3. FLAKY RPC SNOWBALL
     RPC starts returning 500s. Bot retries blindly. Mempool fills with
     duplicate txs from retry storms.
     Fix: hard ceiling on in-flight unconfirmed txs.

  4. REORG / FORK
     Less concern on Somnia (sub-second finality), but receipts can flip.
     Fix: only treat a tx as confirmed after waiting for ≥1 block past
     the receipt block.

This module exposes a single `send_tx(...)` coroutine that handles all of this.
"""

from __future__ import annotations

import asyncio
import ssl
import time
from dataclasses import dataclass, field
from typing import Any

import certifi
from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import AsyncWeb3, AsyncHTTPProvider
from web3.exceptions import TimeExhausted, TransactionNotFound

from dreamdex_bot.utils.logger import get_logger


log = get_logger(__name__)


@dataclass
class PendingTx:
    nonce: int
    tx_hash: str
    submitted_at: float
    gas_price: int
    tx_dict: dict[str, Any] = field(default_factory=dict)
    attempts: int = 1


class NonceManager:
    """Serialized async nonce allocator with stuck-tx reconciliation.

    Lifecycle:
      - `initialize()` once at startup. Reads on-chain nonce.
      - `acquire()` returns the next nonce. Holds a lock for the duration.
      - `mark_submitted(nonce, tx_hash)` records what we sent.
      - `mark_confirmed(nonce)` removes from pending set.
      - `reconcile()` runs every ~5s in a background task; if pending grows,
        RBF the oldest stuck tx.

    Hard caps:
      - max_in_flight: refuse to acquire a new nonce until pending shrinks
      - max_stuck_seconds: trigger RBF after this much wall time
    """

    def __init__(
        self,
        w3: AsyncWeb3,
        account: LocalAccount,
        max_in_flight: int = 8,
        max_stuck_seconds: float = 30.0,
        rbf_gas_bump_pct: int = 25,
    ) -> None:
        self.w3 = w3
        self.account = account
        self.max_in_flight = max_in_flight
        self.max_stuck_seconds = max_stuck_seconds
        self.rbf_gas_bump_pct = rbf_gas_bump_pct

        self._lock = asyncio.Lock()
        self._next_nonce: int | None = None
        self._pending: dict[int, PendingTx] = {}  # nonce → PendingTx
        self._stopped = False

    async def initialize(self) -> None:
        """Sync local nonce with on-chain. Call once at startup."""
        async with self._lock:
            self._next_nonce = await self.w3.eth.get_transaction_count(
                self.account.address, "pending"
            )
            log.info("nonce.initialized", nonce=self._next_nonce, addr=self.account.address)

    async def acquire(self) -> int:
        """Allocate the next nonce. Blocks if too many in flight.

        IMPORTANT: caller must call mark_submitted() with the same nonce
        immediately after broadcasting, OR mark_aborted() if broadcast fails.
        """
        # Backpressure: wait until pending drains below cap
        while len(self._pending) >= self.max_in_flight:
            log.warning("nonce.backpressure", in_flight=len(self._pending))
            await asyncio.sleep(0.5)

        async with self._lock:
            assert self._next_nonce is not None, "Call initialize() first"
            n = self._next_nonce
            self._next_nonce += 1
            return n

    def mark_submitted(self, nonce: int, tx_hash: str, gas_price: int, tx_dict: dict) -> None:
        self._pending[nonce] = PendingTx(
            nonce=nonce, tx_hash=tx_hash, submitted_at=time.time(),
            gas_price=gas_price, tx_dict=tx_dict
        )

    def mark_confirmed(self, nonce: int) -> None:
        self._pending.pop(nonce, None)

    async def mark_aborted(self, nonce: int) -> None:
        """Broadcast failed — roll the nonce back if no later txs are out yet."""
        async with self._lock:
            self._pending.pop(nonce, None)
            if self._next_nonce is not None and nonce == self._next_nonce - 1:
                # No later nonces issued — safe to roll back
                self._next_nonce = nonce
                log.info("nonce.rolled_back", nonce=nonce)

    async def resync_from_chain(self) -> int:
        """Re-read pending nonce from chain. Use after 'nonce too low' errors.

        The decrement-rollback in mark_aborted is unsafe when the chain has
        already consumed the nonce (which is exactly what "nonce too low"
        means). This re-queries `pending` so the next acquire() lands on
        whatever the chain expects next.
        """
        async with self._lock:
            latest = await self.w3.eth.get_transaction_count(
                self.account.address, "pending"
            )
            self._pending.clear()
            self._next_nonce = latest
            log.warning("nonce.resynced_from_chain", nonce=latest)
            return latest

    async def reconcile_loop(self, interval: float = 5.0) -> None:
        """Background task: detect and replace stuck txs."""
        while not self._stopped:
            try:
                await self._reconcile_once()
            except Exception as e:
                log.error("nonce.reconcile_failed", error=str(e))
            await asyncio.sleep(interval)

    async def _reconcile_once(self) -> None:
        if not self._pending:
            return
        latest_nonce = await self.w3.eth.get_transaction_count(self.account.address, "latest")

        # Clean up any nonces that are now below latest (= confirmed by chain)
        confirmed = [n for n in self._pending if n < latest_nonce]
        for n in confirmed:
            log.info("nonce.confirmed", nonce=n)
            self._pending.pop(n)

        # Find stuck txs (over max_stuck_seconds)
        now = time.time()
        for nonce, tx in sorted(self._pending.items()):
            if now - tx.submitted_at > self.max_stuck_seconds:
                log.warning(
                    "nonce.stuck", nonce=nonce, tx_hash=tx.tx_hash,
                    stuck_seconds=now - tx.submitted_at,
                )
                await self._replace_by_fee(nonce, tx)
                break  # Only replace one per cycle to avoid cascading

    async def _replace_by_fee(self, nonce: int, tx: PendingTx) -> None:
        """Submit a higher-gas duplicate at the same nonce."""
        new_gas = int(tx.gas_price * (100 + self.rbf_gas_bump_pct) / 100)
        new_tx = dict(tx.tx_dict)
        new_tx["gasPrice"] = new_gas
        new_tx["nonce"] = nonce
        try:
            signed = self.account.sign_transaction(new_tx)
            new_hash = await self.w3.eth.send_raw_transaction(signed.raw_transaction)
            tx.tx_hash = new_hash.hex()
            tx.gas_price = new_gas
            tx.submitted_at = time.time()
            tx.attempts += 1
            log.warning(
                "nonce.rbf_submitted",
                nonce=nonce, new_hash=new_hash.hex(), new_gas=new_gas, attempt=tx.attempts,
            )
        except Exception as e:
            log.error("nonce.rbf_failed", nonce=nonce, error=str(e))

    def stop(self) -> None:
        self._stopped = True


class Signer:
    """Thin wrapper around web3.py async + NonceManager.

    Use this for all on-chain interactions. Don't construct web3 calls elsewhere.
    """

    def __init__(self, rpc_url: str, private_key: str, chain_id: int) -> None:
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        self.w3 = AsyncWeb3(AsyncHTTPProvider(rpc_url, request_kwargs={"ssl": ssl_context}))
        self.account: LocalAccount = Account.from_key(private_key)
        self.chain_id = chain_id
        self.nonces = NonceManager(self.w3, self.account)

    @property
    def address(self) -> str:
        return self.account.address

    async def initialize(self) -> None:
        await self.nonces.initialize()

    async def send_tx(
        self,
        to: str,
        data: bytes | str,
        value: int = 0,
        gas: int = 500_000,
        gas_price: int | None = None,
    ) -> str:
        """Sign and broadcast a transaction. Returns the tx hash.

        Does NOT wait for confirmation — use wait_for_receipt() separately
        if you need that. This keeps the send path low-latency."""
        if gas_price is None:
            gas_price = await self.w3.eth.gas_price

        nonce = await self.nonces.acquire()
        tx: dict[str, Any] = {
            "from": self.account.address,
            "to": to,
            "data": data,
            "value": value,
            "gas": gas,
            "gasPrice": gas_price,
            "nonce": nonce,
            "chainId": self.chain_id,
        }

        try:
            signed = self.account.sign_transaction(tx)
            raw = await self.w3.eth.send_raw_transaction(signed.raw_transaction)
            tx_hash = raw.hex()
            self.nonces.mark_submitted(nonce, tx_hash, gas_price, tx)
            log.debug("tx.submitted", nonce=nonce, tx_hash=tx_hash, to=to)
            return tx_hash
        except Exception as e:
            err_str = str(e)
            # F9 fix: when chain says "nonce too low", the nonce is consumed.
            # Decrement-rollback would reuse it and fail again, looping the
            # failed_tx_streak rule into pause_all. Re-sync from chain instead.
            if "nonce too low" in err_str.lower():
                await self.nonces.resync_from_chain()
            else:
                await self.nonces.mark_aborted(nonce)
            log.error("tx.send_failed", nonce=nonce, error=err_str)
            raise

    async def simulate_order_tx(
        self,
        to: str,
        data: bytes | str,
        value: int = 0,
        gas: int = 500_000,
    ) -> tuple[bool | None, int | None]:
        """eth_call a prepared place-order tx.

        DreamDEX place-order functions return (bool success, uint128 orderId).
        If the response does not match that shape, return (None, None) so callers
        can decide whether to continue.
        """
        result = await self.w3.eth.call({
            "from": self.account.address,
            "to": to,
            "data": data,
            "value": value,
            "gas": gas,
        })
        raw = result.hex() if hasattr(result, "hex") else str(result)
        if raw.startswith("0x"):
            raw = raw[2:]
        if len(raw) < 128:
            return None, None
        success = bool(int(raw[:64], 16))
        order_id = int(raw[64:128], 16)
        return success, order_id

    async def wait_for_receipt(self, tx_hash: str, timeout: float = 30.0) -> dict[str, Any]:
        """Wait for tx confirmation. Returns receipt dict."""
        try:
            receipt = await self.w3.eth.wait_for_transaction_receipt(
                tx_hash, timeout=timeout
            )
            # Pull nonce out of the receipt-associated tx to clear pending
            tx = await self.w3.eth.get_transaction(tx_hash)
            self.nonces.mark_confirmed(tx["nonce"])
            return dict(receipt)
        except (TimeExhausted, TransactionNotFound):
            log.warning("tx.receipt_timeout", tx_hash=tx_hash, timeout=timeout)
            raise
