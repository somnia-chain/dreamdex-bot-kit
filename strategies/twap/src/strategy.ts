/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// TWAP (Time-Weighted Average Price) execution.
//
// Not a signal strategy — an EXECUTION algo. Given a target notional to buy or
// sell, it splits the order into equal slices spread evenly over time, so you
// build (or unwind) a position without slamming the book in one go. Each slice
// is an IOC bounded by a max slippage, so you never chase the price further than
// you allow. This is the quant's basic building block for "get into size
// quietly" — the same tool CEX desks use.

import { Pool, ORDER_TYPE, shiftBps } from "@dreamdex-bot-kit/core";
import type { Config } from "./config.js";

export class Twap {
  private slicesDone = 0;
  private filledBase = 0;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: unknown) => void,
  ) {}

  get done(): boolean {
    return this.slicesDone >= this.cfg.slices;
  }

  /** Execute one slice. Call once per interval. */
  async slice(): Promise<void> {
    if (this.done) return;
    const isBid = this.cfg.side === "buy";
    const { bestBid, bestAsk } = await this.pool.topOfBook();
    const touch = isBid ? bestAsk : bestBid;
    if (touch === undefined) {
      this.log(`slice ${this.slicesDone + 1}/${this.cfg.slices}: no ${isBid ? "ask" : "bid"} to cross — skipping this interval`);
      return;
    }

    const sliceNotional = this.cfg.totalUsdso / this.cfg.slices;
    const qty = sliceNotional / touch;
    if (qty < this.pool.minQty) {
      this.log(`slice qty ${qty} below market min ${this.pool.minQty} — raise TWAP_TOTAL_USDSO or lower TWAP_SLICES`);
      this.slicesDone += 1; // don't stall the schedule on an impossible slice
      return;
    }
    // Bound the crossing price by the allowed slippage.
    const price = shiftBps(touch, isBid ? this.cfg.maxSlippageBps : -this.cfg.maxSlippageBps);

    this.slicesDone += 1;
    this.log(`slice ${this.slicesDone}/${this.cfg.slices}: ${this.cfg.side} ${qty.toFixed(6)} @ ≤${price.toFixed(6)} (touch ${touch.toFixed(6)})`);

    if (this.cfg.dryRun) {
      this.filledBase += qty;
      return;
    }
    try {
      const res = await this.pool.place({ isBid, price, qty, orderType: ORDER_TYPE.ImmediateOrCancel });
      this.filledBase += qty; // best-effort; read fills on-chain for exact attribution
      this.log(`  tx=${res.txHash}`);
    } catch (err) {
      this.log(`slice failed`, (err as Error).message);
    }
  }

  summary(): string {
    return `executed ${this.slicesDone}/${this.cfg.slices} slices, ~${this.filledBase.toFixed(6)} base ${this.cfg.side === "buy" ? "bought" : "sold"}`;
  }
}
