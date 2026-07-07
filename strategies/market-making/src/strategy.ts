/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Two-sided PostOnly market maker with inventory skew.
//
// The idea (proven out by the top competition maker): rank on volume by being
// the MAKER on a low-risk pair. A resting order that someone else lifts earns
// you volume — and maker rewards — at near-zero cost, instead of paying the
// spread as a taker every cycle. We quote a bid below mid and an ask above mid,
// skew both toward the side that reduces our inventory, and only requote when
// the mid actually moves (leaving good quotes in place saves gas).
//
// PostOnly guarantees we never cross (a crossing quote is rejected, not filled
// as a taker), so we always stay on the maker side.

import { Pool, ORDER_TYPE, shiftBps, spreadBps } from "@dreamdex-bot-kit/core";
import type { Config } from "./config.js";

interface RestingOrder {
  orderId: bigint;
  price: number;
  qty: number;
}

export class MarketMaker {
  private bid?: RestingOrder;
  private ask?: RestingOrder;
  private lastMid?: number;
  private lastRequoteAt = 0;
  private requoting = false;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: unknown) => void,
  ) {}

  /** Called on every book update (WS) and on the poll interval. */
  async onBook(): Promise<void> {
    if (this.requoting) return;
    if (Date.now() - this.lastRequoteAt < this.cfg.requoteCooldownMs) return;
    this.requoting = true;
    try {
      await this.requote();
    } finally {
      this.requoting = false;
    }
  }

  private async requote(): Promise<void> {
    const { bestBid, bestAsk, mid } = await this.pool.topOfBook();
    if (mid === undefined) {
      this.log("no mid price (empty book) — skipping requote");
      return;
    }

    // Skip dislocated books — quoting into a huge spread just parks stale orders.
    if (bestBid !== undefined && bestAsk !== undefined) {
      const bookBps = spreadBps(bestBid, bestAsk);
      if (bookBps > this.cfg.maxBookSpreadBps) {
        this.log(`book spread ${bookBps.toFixed(1)}bps > max ${this.cfg.maxBookSpreadBps}bps — skipping`);
        return;
      }
    }

    // Only requote once the mid has drifted enough (and only if we have quotes up).
    if (this.lastMid !== undefined && this.bid && this.ask) {
      const driftBps = Math.abs((mid - this.lastMid) / this.lastMid) * 10_000;
      if (driftBps < this.cfg.requoteTriggerBps) return;
    }
    this.lastMid = mid;
    this.lastRequoteAt = Date.now();

    // Inventory skew: if we're long base vs target, lean quotes DOWN so we sell
    // more / buy less, and vice-versa. skewBps is proportional to the imbalance.
    // Read the WALLET balance, not the vault: in the default auto-pull/auto-
    // deliver mode fills land in the wallet and the vault reads ~0, so reading
    // the vault would leave the skew permanently at zero (no inventory defense).
    const invUsdso = (await this.pool.walletBase()) * mid;
    const imbalance = (invUsdso - this.cfg.targetInventoryUsdso) / this.cfg.notionalUsdso;
    const skewBps = imbalance * this.cfg.inventorySkewBps;

    const bidPrice = shiftBps(mid, -this.cfg.halfSpreadBps - skewBps);
    const askPrice = shiftBps(mid, +this.cfg.halfSpreadBps - skewBps);
    const qty = this.cfg.notionalUsdso / mid;

    if (qty < this.pool.minQty) {
      this.log(`qty ${qty} below market min ${this.pool.minQty} — raise MM_NOTIONAL_USDSO`);
      return;
    }

    this.log(`requote mid=${mid.toFixed(6)} bid=${bidPrice.toFixed(6)} ask=${askPrice.toFixed(6)} qty=${qty.toFixed(6)} skewBps=${skewBps.toFixed(2)}`);

    // Place legs SEQUENTIALLY, not concurrently. Two writeContract calls fired
    // together race on the auto-assigned nonce, and one of the pair reverts.
    // (For pipelined concurrent sends, use the core NonceManager — see the
    // volume strategy.)
    await this.replaceLeg("bid", bidPrice, qty);
    await this.replaceLeg("ask", askPrice, qty);
  }

  private async replaceLeg(side: "bid" | "ask", price: number, qty: number): Promise<void> {
    const existing = side === "bid" ? this.bid : this.ask;
    // Leave an identical quote in place — re-posting it just burns gas.
    if (existing && approxEq(existing.price, price) && approxEq(existing.qty, qty)) return;

    if (this.cfg.dryRun) {
      this.log(`[dry-run] ${side} ${qty.toFixed(6)} @ ${price.toFixed(6)}`);
      if (side === "bid") this.bid = { orderId: 0n, price, qty };
      else this.ask = { orderId: 0n, price, qty };
      return;
    }

    if (existing) {
      try {
        await this.pool.cancel(existing.orderId);
      } catch (err) {
        this.log(`cancel ${side} failed`, (err as Error).message);
      }
    }

    try {
      const res = await this.pool.place({
        isBid: side === "bid",
        price,
        qty,
        orderType: ORDER_TYPE.PostOnly,
        expireMs: this.cfg.expireMs,
      });
      const rec = { orderId: res.orderId ?? 0n, price, qty };
      if (side === "bid") this.bid = rec;
      else this.ask = rec;
      this.log(`posted ${side} ${qty.toFixed(6)} @ ${price.toFixed(6)} id=${res.orderId} tx=${res.txHash}`);
    } catch (err) {
      // A PostOnly order rejected for crossing is normal near a fast-moving mid.
      this.log(`post ${side} failed`, (err as Error).message);
      if (side === "bid") this.bid = undefined;
      else this.ask = undefined;
    }
  }

  /** Cancel all resting quotes — call on shutdown. */
  async cancelAll(): Promise<void> {
    for (const o of [this.bid, this.ask]) {
      if (o && o.orderId !== 0n) {
        try {
          await this.pool.cancel(o.orderId);
        } catch { /* best-effort */ }
      }
    }
    this.bid = undefined;
    this.ask = undefined;
  }
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) / (b || 1) < 1e-9;
}
