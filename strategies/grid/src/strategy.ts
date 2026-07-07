/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Grid trading with FIFO lots and maker/taker switching.
//
// A grid buys dips and sells rips around a moving anchor price:
//   - Buy trigger  = anchor × (1 − step). Each buy opens a LOT at its fill price.
//   - Sell trigger = oldest lot's price × (1 + step). Each sell closes lots FIFO,
//     so every position exits at a profit relative to where it was opened.
//
// Two execution modes, chosen by book state:
//   - If the counterpart side is present and price has crossed the trigger, TAKE
//     with an IOC order priced to cross.
//   - If the counterpart side is absent (thin/one-sided book), REST a PostOnly
//     order at the trigger and wait to be lifted.
//
// Guards: a spread gate, a session stop-loss that flips to offload-only, and a
// "stuck lot" timeout that cuts a position that can't reach its sell trigger and
// re-anchors, so the grid doesn't freeze holding inventory in a trend.

import { Pool, ORDER_TYPE, shiftBps, spreadBps } from "@dreamdex-bot-kit/core";
import type { Config } from "./config.js";

interface Lot {
  price: number; // entry price
  qty: number; // base remaining
}

export class Grid {
  private lots: Lot[] = [];
  private anchor?: number;
  private realizedPnl = 0;
  private stuckSince?: number;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: unknown) => void,
  ) {}

  async tick(): Promise<void> {
    const { bestBid, bestAsk, mid } = await this.pool.topOfBook();
    if (mid === undefined) return;
    if (this.anchor === undefined) this.anchor = mid;

    if (bestBid !== undefined && bestAsk !== undefined && spreadBps(bestBid, bestAsk) > this.cfg.maxSpreadBps) {
      return; // dislocated book — sit out
    }

    const offloadOnly = this.realizedPnl <= -this.cfg.maxSessionLossUsdso;
    const buyTrigger = shiftBps(this.anchor, -this.cfg.stepBps);
    const sellTrigger = shiftBps(this.lots[0]?.price ?? this.anchor, +this.cfg.stepBps);
    const inventoryUsdso = this.baseHeld() * mid;
    const qty = this.cfg.lotUsdso / mid;

    // ── SELL: oldest lot's target crossed by the best bid ──────────────────
    if (this.lots.length > 0 && bestBid !== undefined && bestBid >= sellTrigger) {
      await this.sell(sellTrigger, bestBid, qty);
      this.stuckSince = undefined;
      return;
    }

    // ── BUY: price dipped through the buy trigger, room in inventory ────────
    if (
      !offloadOnly &&
      bestAsk !== undefined &&
      bestAsk <= buyTrigger &&
      inventoryUsdso < this.cfg.maxInventoryUsdso &&
      qty >= this.pool.minQty
    ) {
      await this.buy(buyTrigger, bestAsk, qty);
      return;
    }

    // ── STUCK: holding lots but no sell trigger for too long → cut + re-anchor
    if (this.lots.length > 0 && this.cfg.stuckTimeoutMs > 0 && bestBid !== undefined) {
      const now = Date.now();
      this.stuckSince ??= now;
      if (now - this.stuckSince >= this.cfg.stuckTimeoutMs) {
        this.log(`stuck ${Math.round((now - this.stuckSince) / 60_000)}m — cutting inventory at bid ${bestBid.toFixed(6)}`);
        await this.sellAll(bestBid);
        this.anchor = mid; // re-anchor to current mid
        this.stuckSince = undefined;
      }
    }
  }

  private async buy(triggerPrice: number, bestAsk: number, qty: number): Promise<void> {
    // Book has an ask → take it (IOC). Otherwise rest a maker bid at the trigger.
    const hasAsk = bestAsk !== undefined && Number.isFinite(bestAsk);
    const price = hasAsk ? bestAsk : triggerPrice;
    const orderType = hasAsk ? ORDER_TYPE.ImmediateOrCancel : ORDER_TYPE.PostOnly;
    if (this.cfg.dryRun) {
      this.log(`[dry-run] BUY ${qty.toFixed(6)} @ ${price.toFixed(6)} (${hasAsk ? "IOC" : "maker"})`);
      this.lots.push({ price, qty });
      return;
    }
    try {
      const res = await this.pool.place({ isBid: true, price, qty, orderType });
      this.lots.push({ price, qty });
      this.log(`BUY ${qty.toFixed(6)} @ ${price.toFixed(6)} lots=${this.lots.length} tx=${res.txHash}`);
    } catch (err) {
      this.log("buy failed", (err as Error).message);
    }
  }

  private async sell(triggerPrice: number, bestBid: number, qty: number): Promise<void> {
    const price = bestBid; // take the bid
    const closing = Math.min(qty, this.baseHeld());
    if (closing < this.pool.minQty) return;
    if (this.cfg.dryRun) {
      this.log(`[dry-run] SELL ${closing.toFixed(6)} @ ${price.toFixed(6)}`);
      this.closeLots(closing, price);
      return;
    }
    try {
      const res = await this.pool.place({ isBid: false, price, qty: closing, orderType: ORDER_TYPE.ImmediateOrCancel });
      this.closeLots(closing, price);
      this.log(`SELL ${closing.toFixed(6)} @ ${price.toFixed(6)} realizedPnl=${this.realizedPnl.toFixed(4)} tx=${res.txHash}`);
    } catch (err) {
      this.log("sell failed", (err as Error).message);
    }
  }

  private async sellAll(price: number): Promise<void> {
    const held = this.baseHeld();
    if (held < this.pool.minQty) {
      this.lots = [];
      return;
    }
    if (this.cfg.dryRun) {
      this.log(`[dry-run] SELL-ALL ${held.toFixed(6)} @ ${price.toFixed(6)}`);
      this.closeLots(held, price);
      return;
    }
    try {
      await this.pool.place({ isBid: false, price, qty: held, orderType: ORDER_TYPE.ImmediateOrCancel });
      this.closeLots(held, price);
    } catch (err) {
      this.log("sell-all failed", (err as Error).message);
    }
  }

  private closeLots(qty: number, exitPrice: number): void {
    let remaining = qty;
    while (remaining > 1e-12 && this.lots.length > 0) {
      const lot = this.lots[0]!;
      const take = Math.min(lot.qty, remaining);
      this.realizedPnl += (exitPrice - lot.price) * take;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) this.lots.shift();
    }
  }

  private baseHeld(): number {
    return this.lots.reduce((s, l) => s + l.qty, 0);
  }
}
