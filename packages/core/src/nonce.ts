/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Serialized nonce allocation for high-throughput signing.
//
// Why this exists: the naive approach — read `getTransactionCount("pending")`
// before every tx and wait for the receipt before sending the next — caps you
// at roughly one order every few seconds. The competition's top traders instead
// managed the nonce LOCALLY and fired transactions without waiting for receipts,
// reaching many orders per second. This class is that pattern, made safe:
//
//   * one allocator, so two concurrent sends can't grab the same nonce;
//   * backpressure, so a stuck tx can't let unbounded sends pile up;
//   * resync-from-chain on "nonce too low" (external consumption / a dropped tx).
//
// See docs/24-7-operations.md for the full throughput discussion.

import type { PublicClient } from "viem";

export class NonceManager {
  private next: number | null = null;
  private inFlight = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: PublicClient,
    private readonly address: `0x${string}`,
    private readonly maxInFlight = 8,
  ) {}

  /** Sync the local counter with the chain. Call once at startup. */
  async initialize(): Promise<void> {
    this.next = await this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
  }

  /**
   * Allocate the next nonce. Serialized, and blocks while too many txs are in
   * flight. Caller MUST then call `settled()` (on confirm) or `resync()` (on a
   * nonce error) so the in-flight counter drains.
   */
  async acquire(): Promise<number> {
    // Backpressure: don't hand out a nonce while the mempool is backed up.
    while (this.inFlight >= this.maxInFlight) {
      await sleep(200);
    }
    // Chain the allocation onto the queue so concurrent callers serialize.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prev = this.queue;
    this.queue = prev.then(() => gate);
    await prev;
    try {
      if (this.next === null) await this.initialize();
      const n = this.next as number;
      this.next = n + 1;
      this.inFlight += 1;
      return n;
    } finally {
      release();
    }
  }

  /** A tx you acquired a nonce for has confirmed (or you gave up on it). */
  settled(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /**
   * Re-read the pending nonce from chain after a "nonce too low" error — the
   * chain already consumed a nonce, so a local decrement would reuse it and
   * loop. Resets the in-flight counter.
   */
  async resync(): Promise<number> {
    this.next = await this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
    this.inFlight = 0;
    return this.next;
  }
}

export function isNonceTooLow(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return m.includes("nonce too low") || m.includes("nonce is too low") || m.includes("already known");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
