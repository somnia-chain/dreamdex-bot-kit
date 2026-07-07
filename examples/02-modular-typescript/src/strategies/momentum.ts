/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";
import { Strategy, type StrategyContext, type WsEvent } from "./base.js";
import { readBookLevels } from "../dex/contracts.js";
import {
  assertExpireNs,
  assertPriceRawNonZero,
  assertBuilderDisabled,
  buildExpireNs,
} from "../utils/gotchas.js";
import {
  ORDER_TYPE,
  SELF_MATCH,
  MS_PER_HOUR,
} from "../config/constants.js";

export interface MomentumConfig {
  windowMs: number;
  thresholdBps: number;
  notionalUsdso: number;
  cooldownMs: number;
}

interface PricePoint {
  ts: number;
  mid: number;
}

export class MomentumStrategy extends Strategy {
  private priceHistory: PricePoint[] = [];
  private lastFireAt = 0;
  private tickTimer: NodeJS.Timeout | undefined;

  constructor(ctx: StrategyContext, private readonly config: MomentumConfig) {
    super(`Momentum:${ctx.pool.pool.symbol}`, ctx);
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    this.tickTimer = setInterval(() => {
      this.onTick().catch((err) => this.recordError(err));
    }, 5_000);
    this.setStatus("running");
  }

  async stop(): Promise<void> {
    this.setStatus("stopping");
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.setStatus("stopped");
  }

  override async onTick(): Promise<void> {
    await super.onTick();
    try {
      const mid = await this.readMid();
      if (mid === undefined) return;
      this.recordPrice(mid);
      const drift = this.computeDriftBps();
      if (drift === undefined) return;
      if (Math.abs(drift) < this.config.thresholdBps) return;
      const now = Date.now();
      if (now - this.lastFireAt < this.config.cooldownMs) return;
      this.lastFireAt = now;
      await this.fire(drift > 0 ? "buy" : "sell", mid);
    } catch (err) {
      this.recordError(err);
    }
  }

  override async onWsEvent(event: WsEvent): Promise<void> {
    if (event.channel === "trades" || event.channel === "orderbook") {
      await this.onTick();
    }
  }

  private async readMid(): Promise<number | undefined> {
    const book = await readBookLevels(this.ctx.pool, 1);
    const topBid = book.bids[0];
    const topAsk = book.asks[0];
    if (topBid && topAsk) return (topBid.price + topAsk.price) / 2;
    if (topBid) return topBid.price;
    if (topAsk) return topAsk.price;
    return undefined;
  }

  private recordPrice(mid: number): void {
    const now = Date.now();
    this.priceHistory.push({ ts: now, mid });
    const cutoff = now - this.config.windowMs;
    while (this.priceHistory.length > 0 && (this.priceHistory[0]?.ts ?? 0) < cutoff) {
      this.priceHistory.shift();
    }
  }

  private computeDriftBps(): number | undefined {
    const oldest = this.priceHistory[0];
    const newest = this.priceHistory[this.priceHistory.length - 1];
    if (!oldest || !newest || oldest === newest) return undefined;
    if (oldest.mid <= 0) return undefined;
    return ((newest.mid - oldest.mid) / oldest.mid) * 10_000;
  }

  private async fire(direction: "buy" | "sell", mid: number): Promise<void> {
    const isBid = direction === "buy";
    const slippageBps = isBid ? 50 : -50;
    const slippageMult = 10_000 + slippageBps;
    const targetPrice = mid * (slippageMult / 10_000);

    const baseDec = this.ctx.pool.baseToken.decimals;
    const quoteDec = this.ctx.pool.quoteToken.decimals;
    const minQtyRaw = ethers.parseUnits(
      this.ctx.pool.pool.minQuantity.toString(),
      baseDec,
    );
    const qtyFromNotional = this.config.notionalUsdso / mid;
    let qtyRaw = ethers.parseUnits(qtyFromNotional.toFixed(baseDec), baseDec);
    if (qtyRaw < minQtyRaw) qtyRaw = minQtyRaw;

    const priceRaw = ethers.parseUnits(targetPrice.toFixed(quoteDec), quoteDec);
    assertPriceRawNonZero(priceRaw);

    const expireNs = buildExpireNs(MS_PER_HOUR);
    assertExpireNs(expireNs);
    assertBuilderDisabled(ethers.ZeroAddress, 0n);

    this.ctx.logger.warn(
      {
        direction,
        mid,
        targetPrice,
        qtyRaw: qtyRaw.toString(),
        windowMs: this.config.windowMs,
        thresholdBps: this.config.thresholdBps,
      },
      `Momentum trigger — firing IOC ${direction}`,
    );

    if (this.ctx.dryRun) {
      this.ctx.logger.info("[dry-run] would fire IOC taker");
      return;
    }

    try {
      const callArgs: [
        boolean,
        bigint,
        bigint,
        bigint,
        bigint,
        number,
        number,
        string,
        bigint,
      ] = [
        isBid,
        0n,
        priceRaw,
        qtyRaw,
        expireNs,
        ORDER_TYPE.ImmediateOrCancel,
        SELF_MATCH.CancelTaker,
        ethers.ZeroAddress,
        0n,
      ];

      const isNativeBase =
        this.ctx.pool.baseToken.isNative && !isBid;
      const value = isNativeBase ? qtyRaw : 0n;

      const [simSuccess, simOrderId] =
        await this.ctx.pool.contract.placeTakerOrderWithoutVault.staticCall(
          ...callArgs,
          { value },
        );
      if (!simSuccess) {
        this.ctx.logger.warn(
          { simOrderId: simOrderId.toString() },
          "Momentum sim returned success=false — skipping",
        );
        return;
      }

      const tx = await this.ctx.pool.contract.placeTakerOrderWithoutVault(...callArgs, {
        value,
      });
      const receipt = await tx.wait();
      if (!receipt) {
        this.ctx.logger.warn({ txHash: tx.hash }, "Momentum receipt null");
        return;
      }

      this.metrics.ordersPlaced += 1;
      this.ctx.logger.info(
        { txHash: receipt.hash, direction },
        "Momentum IOC executed",
      );
    } catch (err) {
      this.recordError(err);
    }
  }
}
