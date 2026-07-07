/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Momentum (trend-following) taker.
//
// Unlike the maker and grid strategies, this one is directional: it samples the
// mid into a rolling window, measures momentum (recent average vs older average),
// and TAKES with IOC orders in the trend's direction. It holds a single long
// position, exits when momentum fades, and protects the position with a
// take-profit and stop-loss.
//
// Momentum is a taker strategy by nature — you're paying the spread to get in
// and out quickly on a real move — so sizing and the TP/SL discipline matter
// more here than in the passive strategies.

import { Pool, ORDER_TYPE, shiftBps } from "@dreamdex-bot-kit/core";
import type { Config } from "./config.js";

interface Position {
  entry: number;
  qty: number;
}

export class Momentum {
  private mids: number[] = [];
  private position?: Position;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: unknown) => void,
  ) {}

  async tick(): Promise<void> {
    const { bestBid, bestAsk, mid } = await this.pool.topOfBook();
    if (mid === undefined || bestBid === undefined || bestAsk === undefined) return;

    this.mids.push(mid);
    if (this.mids.length > this.cfg.windowSize) this.mids.shift();
    if (this.mids.length < this.cfg.windowSize) return; // warming up

    const momentum = this.momentum();

    if (this.position) {
      // Exit on TP, SL, or momentum fading.
      const pnlPct = (mid - this.position.entry) / this.position.entry;
      if (pnlPct >= this.cfg.takeProfitPct) return this.exit(bestBid, `take-profit ${(pnlPct * 100).toFixed(2)}%`);
      if (pnlPct <= -this.cfg.stopLossPct) return this.exit(bestBid, `stop-loss ${(pnlPct * 100).toFixed(2)}%`);
      if (momentum <= this.cfg.exitMomentum) return this.exit(bestBid, `momentum faded ${(momentum * 100).toFixed(2)}%`);
      return;
    }

    // Enter long on a confirmed up-move that's also breaking the window high.
    const breakout = mid >= Math.max(...this.mids) * 0.999;
    if (momentum >= this.cfg.entryMomentum && breakout) {
      await this.enter(bestAsk, momentum);
    }
  }

  /** (recent half average − older half average) / older half average. */
  private momentum(): number {
    const half = Math.floor(this.mids.length / 2);
    const older = this.mids.slice(0, half);
    const recent = this.mids.slice(half);
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const o = avg(older);
    return o > 0 ? (avg(recent) - o) / o : 0;
  }

  private async enter(bestAsk: number, momentum: number): Promise<void> {
    const price = shiftBps(bestAsk, this.cfg.crossBps); // cross the ask to fill
    const qty = this.cfg.notionalUsdso / bestAsk;
    if (qty < this.pool.minQty) {
      this.log(`qty ${qty} below min ${this.pool.minQty} — raise MOM_NOTIONAL_USDSO`);
      return;
    }
    this.log(`ENTER long ${qty.toFixed(6)} @ ~${bestAsk.toFixed(6)} momentum=${(momentum * 100).toFixed(2)}%`);
    if (this.cfg.dryRun) {
      this.position = { entry: bestAsk, qty };
      return;
    }
    try {
      await this.pool.place({ isBid: true, price, qty, orderType: ORDER_TYPE.ImmediateOrCancel });
      this.position = { entry: bestAsk, qty };
    } catch (err) {
      this.log("enter failed", (err as Error).message);
    }
  }

  private async exit(bestBid: number, reason: string): Promise<void> {
    const pos = this.position;
    if (!pos) return;
    // Clear the position BEFORE awaiting the sell, so a concurrent shutdown
    // flatten() can't see it and double-sell. If the sell throws we log it; we
    // don't restore the position (re-entering on a failed exit is riskier than
    // being flat).
    this.position = undefined;
    const price = shiftBps(bestBid, -this.cfg.crossBps); // cross the bid to fill
    this.log(`EXIT ${pos.qty.toFixed(6)} @ ~${bestBid.toFixed(6)} — ${reason}`);
    if (this.cfg.dryRun) return;
    try {
      await this.pool.place({ isBid: false, price, qty: pos.qty, orderType: ORDER_TYPE.ImmediateOrCancel });
    } catch (err) {
      this.log("exit failed", (err as Error).message);
    }
  }

  hasPosition(): boolean {
    return this.position !== undefined;
  }

  async flatten(): Promise<void> {
    const { bestBid } = await this.pool.topOfBook();
    if (this.position && bestBid !== undefined) await this.exit(bestBid, "shutdown flatten");
  }
}
