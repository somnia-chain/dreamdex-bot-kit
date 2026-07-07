/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Strategy, type StrategyContext, type WsEvent } from "./base.js";
import { readBookLevels, type BookLevels } from "../dex/contracts.js";
import { safePlaceOrder, safeCancelOrder } from "../dex/safe-broadcast.js";
import {
  alignToTick,
  alignToLot,
  priceToRaw,
  qtyToRaw,
  shiftBps,
} from "../utils/price.js";
import { buildExpireNs } from "../utils/gotchas.js";
import { ORDER_TYPE, SELF_MATCH } from "../config/constants.js";

export interface MarketMakerConfig {
  spreadBps: number;
  notionalUsdso: number;
  seedMid?: number;
  requoteTriggerBps: number;
  refreshIntervalMs: number;
  expireMs: bigint;
}

interface OpenOrder {
  orderId: bigint;
  side: "bid" | "ask";
  price: number;
  qty: number;
}

export class MarketMakerStrategy extends Strategy {
  private myBid: OpenOrder | undefined;
  private myAsk: OpenOrder | undefined;
  private lastMid: number | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private requoteInProgress = false;
  private lastRequoteAt = 0;
  private readonly requoteCooldownMs = 2_000;

  constructor(
    ctx: StrategyContext,
    private readonly config: MarketMakerConfig,
  ) {
    super(`MM:${ctx.pool.pool.symbol}`, ctx);
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    try {
      await this.requote();
      this.tickTimer = setInterval(() => {
        this.onTick().catch((err) => this.recordError(err));
      }, this.config.refreshIntervalMs);
      this.setStatus("running");
    } catch (err) {
      this.setStatus("errored");
      this.recordError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.setStatus("stopping");
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    await this.cancelAll();
    this.setStatus("stopped");
  }

  override async onTick(): Promise<void> {
    await super.onTick();
    try {
      await this.requote();
    } catch (err) {
      this.recordError(err);
    }
  }

  override async onWsEvent(event: WsEvent): Promise<void> {
    const channel = event.channel ?? event.type;
    if (channel === "orderbook" || channel === "trades") {
      await this.requote();
    }
  }

  private async readMid(): Promise<number | undefined> {
    let book: BookLevels;
    try {
      book = await readBookLevels(this.ctx.pool, 1);
    } catch (err) {
      this.recordError(err);
      return undefined;
    }
    const topBid = book.bids[0];
    const topAsk = book.asks[0];
    if (topBid && topAsk) {
      return (topBid.price + topAsk.price) / 2;
    }
    if (topBid) return topBid.price;
    if (topAsk) return topAsk.price;
    return this.config.seedMid;
  }

  private async requote(): Promise<void> {
    if (this.requoteInProgress) return;
    const now = Date.now();
    if (now - this.lastRequoteAt < this.requoteCooldownMs) return;
    this.requoteInProgress = true;
    this.lastRequoteAt = now;
    try {
      await this.requoteInner();
    } finally {
      this.requoteInProgress = false;
    }
  }

  private async requoteInner(): Promise<void> {
    const mid = await this.readMid();
    if (mid === undefined) {
      this.ctx.logger.warn(
        { strategy: this.name },
        "No mid price available (book empty + no seedMid) — skipping requote",
      );
      return;
    }

    if (this.lastMid !== undefined) {
      const drift = Math.abs((mid - this.lastMid) / this.lastMid) * 10_000;
      if (drift < this.config.requoteTriggerBps && this.myBid && this.myAsk) {
        return;
      }
    }
    this.lastMid = mid;

    const tick = this.ctx.pool.pool.tickSize;
    const lot = this.ctx.pool.pool.lotSize;
    const bidPrice = alignToTick(shiftBps(mid, -this.config.spreadBps), tick, "bid");
    const askPrice = alignToTick(shiftBps(mid, +this.config.spreadBps), tick, "ask");

    const qty = alignToLot(this.config.notionalUsdso / mid, lot);
    const minQty = this.ctx.pool.pool.minQuantity;
    if (qty < minQty) {
      this.ctx.logger.warn(
        { qty, minQty, notional: this.config.notionalUsdso, mid },
        "Computed qty below pool minimum — skipping requote",
      );
      return;
    }

    this.ctx.logger.info(
      { mid, bidPrice, askPrice, qty },
      `Requoting ${this.name}`,
    );

    if (this.ctx.dryRun) {
      this.ctx.logger.info(
        { strategy: this.name },
        "[dry-run] would cancel + repost bid/ask",
      );
      return;
    }

    await Promise.all([
      this.replaceLeg("bid", bidPrice, qty),
      this.replaceLeg("ask", askPrice, qty),
    ]);
  }

  private async replaceLeg(
    side: "bid" | "ask",
    price: number,
    qty: number,
  ): Promise<void> {
    const existing = side === "bid" ? this.myBid : this.myAsk;
    if (existing && existing.price === price && existing.qty === qty) {
      return;
    }
    if (existing) {
      try {
        await safeCancelOrder(this.ctx.pool, existing.orderId);
        this.metrics.ordersCancelled += 1;
      } catch (err) {
        this.recordError(err);
      }
      if (side === "bid") this.myBid = undefined;
      else this.myAsk = undefined;
    }

    const priceRaw = priceToRaw(price, this.ctx.pool.quoteToken.decimals);
    const qtyRaw = qtyToRaw(qty, this.ctx.pool.baseToken.decimals);
    const expireNs = buildExpireNs(this.config.expireMs);

    try {
      const { orderId, txHash } = await safePlaceOrder(this.ctx.pool, {
        isBid: side === "bid",
        userData: 0n,
        priceRaw,
        quantityRaw: qtyRaw,
        expireTimestampNs: expireNs,
        orderType: ORDER_TYPE.PostOnly,
        selfMatchingOption: SELF_MATCH.CancelTaker,
      });
      const open: OpenOrder = { orderId, side, price, qty };
      if (side === "bid") this.myBid = open;
      else this.myAsk = open;
      this.metrics.ordersPlaced += 1;
      this.ctx.logger.info(
        { strategy: this.name, side, price, qty, orderId: orderId.toString(), txHash },
        "Order posted",
      );
    } catch (err) {
      this.recordError(err);
    }
  }

  private async cancelAll(): Promise<void> {
    const all: OpenOrder[] = [];
    if (this.myBid) all.push(this.myBid);
    if (this.myAsk) all.push(this.myAsk);
    for (const ord of all) {
      try {
        await safeCancelOrder(this.ctx.pool, ord.orderId);
        this.metrics.ordersCancelled += 1;
      } catch (err) {
        this.recordError(err);
      }
    }
    this.myBid = undefined;
    this.myAsk = undefined;
  }
}
