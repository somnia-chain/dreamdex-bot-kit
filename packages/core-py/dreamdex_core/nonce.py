# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Thread-safe local nonce manager + gas fields.

The naive path — read getTransactionCount('pending') before every tx and wait
for the receipt — is slow and races: back-to-back sends can grab the same nonce
and one dies with 'nonce too low'. This manages the nonce locally so multi-tx
flows (approve -> deposit -> order) and high-frequency loops don't collide, and
resyncs from chain on a nonce error. See docs/24-7-operations.md.
"""
from __future__ import annotations

import threading

from web3 import Web3


class NonceManager:
    def __init__(self, w3: Web3, address: str) -> None:
        self.w3 = w3
        self.address = Web3.to_checksum_address(address)
        self._next: int | None = None
        self._lock = threading.Lock()

    def reserve(self) -> int:
        """Return the next nonce and advance the counter. Lazily syncs from chain."""
        with self._lock:
            if self._next is None:
                self._next = self.w3.eth.get_transaction_count(self.address, "pending")
            n = self._next
            self._next += 1
            return n

    def reset(self) -> None:
        """Force a fresh chain query on the next reserve() — use after a failed tx."""
        with self._lock:
            self._next = None

    def resync(self) -> int:
        with self._lock:
            self._next = self.w3.eth.get_transaction_count(self.address, "pending")
            return self._next

    def gas_fields(self) -> dict:
        """EIP-1559 fields if supported (so txs compete under load), else legacy."""
        try:
            base = self.w3.eth.get_block("latest").get("baseFeePerGas")
            if base:
                priority = self.w3.eth.max_priority_fee
                return {"maxFeePerGas": int(base * 2 + priority), "maxPriorityFeePerGas": int(priority)}
        except Exception:
            pass
        return {"gasPrice": self.w3.eth.gas_price}


def is_nonce_too_low(err: Exception) -> bool:
    m = str(err).lower()
    return "nonce too low" in m or "nonce is too low" in m or "already known" in m
