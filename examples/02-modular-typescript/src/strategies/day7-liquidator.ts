/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";
import { Strategy, type StrategyContext } from "./base.js";
import { readBookLevels, readOwnOpenOrders } from "../dex/contracts.js";
import { safePlaceOrder, safeCancelOrder } from "../dex/safe-broadcast.js";
import { buildExpireNs } from "../utils/gotchas.js";
import { ORDER_TYPE, SELF_MATCH, MS_PER_HOUR } from "../config/constants.js";

export interface Day7LiquidatorConfig {
  fireAtIsoUtc: string;
  checkIntervalMs: number;
  slippageBps: number;
}

export class Day7LiquidatorStrategy extends Strategy {
  private fired = false;
  private checkTimer: NodeJS.Timeout | undefined;
  private readonly fireAtMs: number;

  constructor(ctx: StrategyContext, private readonly config: Day7LiquidatorConfig) {
    super(`Day7Liq:${ctx.pool.pool.symbol}`, ctx);
    const t = Date.parse(config.fireAtIsoUtc);
    if (Number.isNaN(t)) {
      throw new Error(`Day7LiquidatorConfig.fireAtIsoUtc invalid: ${config.fireAtIsoUtc}`);
    }
    this.fireAtMs = t;
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    const msUntil = this.fireAtMs - Date.now();
    if (msUntil <= 0) {
      this.ctx.logger.warn(
        { fireAt: this.config.fireAtIsoUtc },
        "Day7Liquidator fire time is in the past — firing immediately",
      );
      await this.liquidate();
      this.setStatus("stopped");
      return;
    }

    this.ctx.logger.info(
      {
        fireAt: this.config.fireAtIsoUtc,
        secondsUntilFire: Math.round(msUntil / 1000),
        pool: this.ctx.pool.pool.symbol,
      },
      "Day7Liquidator armed — will fire at the configured time",
    );

    this.checkTimer = setInterval(() => {
      this.maybeFire().catch((err) => this.recordError(err));
    }, this.config.checkIntervalMs);
    this.setStatus("running");
  }

  async stop(): Promise<void> {
    this.setStatus("stopping");
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    this.setStatus("stopped");
  }

  private async maybeFire(): Promise<void> {
    if (this.fired) return;
    if (Date.now() < this.fireAtMs) return;
    this.fired = true;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    this.ctx.logger.warn(
      { pool: this.ctx.pool.pool.symbol },
      "Day7Liquidator firing now",
    );
    try {
      await this.liquidate();
    } catch (err) {
      this.recordError(err);
    }
  }

  async liquidate(): Promise<void> {
    await this.cancelAllResting();
    await this.dumpBaseToQuote();
    await this.withdrawAllToWallet();
    this.ctx.logger.info("Day7Liquidator finished pass");
  }

  private async withdrawAllToWallet(): Promise<void> {
    const base = this.ctx.pool.baseToken;
    const quote = this.ctx.pool.quoteToken;

    const quoteFree: bigint = await this.ctx.pool.readonly.getWithdrawableBalance(
      this.ctx.walletAddress,
      quote.address,
    );
    const baseFree: bigint = await this.ctx.pool.readonly.getWithdrawableBalance(
      this.ctx.walletAddress,
      base.address,
    );

    this.ctx.logger.info(
      {
        [`${quote.symbol}_free`]: quoteFree.toString(),
        [`${base.symbol}_free`]: baseFree.toString(),
      },
      "Withdrawing vault free balances to wallet",
    );

    if (quoteFree > 0n) {
      try {
        const tx = await this.ctx.pool.contract.withdraw(quote.address, quoteFree);
        const receipt = await tx.wait();
        this.ctx.logger.info(
          { token: quote.symbol, amount: quoteFree.toString(), txHash: receipt?.hash },
          "Withdrew quote token to wallet",
        );
      } catch (err) {
        this.recordError(err);
      }
    }

    if (baseFree > 0n) {
      try {
        const tx = await this.ctx.pool.contract.withdraw(base.address, baseFree);
        const receipt = await tx.wait();
        this.ctx.logger.info(
          { token: base.symbol, amount: baseFree.toString(), txHash: receipt?.hash },
          "Withdrew base token to wallet (couldn't dump — manual swap to USDso needed)",
        );
      } catch (err) {
        this.recordError(err);
      }
    }
  }

  private async cancelAllResting(): Promise<void> {
    let ids: bigint[];
    try {
      ids = await readOwnOpenOrders(this.ctx.pool, this.ctx.walletAddress);
    } catch (err) {
      this.ctx.logger.warn(
        { err: (err as Error).message },
        "readOwnOpenOrders reverted — assuming empty (Obs-003 pattern)",
      );
      ids = [];
    }
    this.ctx.logger.info({ count: ids.length }, "Cancelling resting orders");
    for (const id of ids) {
      try {
        await safeCancelOrder(this.ctx.pool, id);
        this.metrics.ordersCancelled += 1;
      } catch (err) {
        this.recordError(err);
      }
    }
  }

  private async dumpBaseToQuote(): Promise<void> {
    const base = this.ctx.pool.baseToken;
    const quote = this.ctx.pool.quoteToken;
    const baseInVault: bigint = await this.ctx.pool.readonly.getWithdrawableBalance(
      this.ctx.walletAddress,
      base.address,
    );
    if (baseInVault <= 0n) {
      this.ctx.logger.info({ symbol: base.symbol }, "No base inventory to dump");
      return;
    }

    const book = await readBookLevels(this.ctx.pool, 5);
    const topBid = book.bids[0];
    if (!topBid) {
      this.ctx.logger.error(
        { baseInVault: baseInVault.toString() },
        "Cannot dump base: no resting bids on book. Leaving inventory in vault for manual handling.",
      );
      return;
    }

    const slippageMultiplier = 10_000n - BigInt(this.config.slippageBps);
    const aggressiveBidRaw = (topBid.priceRaw * slippageMultiplier) / 10_000n;

    if (aggressiveBidRaw === 0n) {
      this.ctx.logger.error("Aggressive bid price computed to zero — aborting dump");
      return;
    }

    const expireNs = buildExpireNs(MS_PER_HOUR);

    this.ctx.logger.info(
      {
        symbol: base.symbol,
        qtyRaw: baseInVault.toString(),
        bidPriceRaw: aggressiveBidRaw.toString(),
        topBidPriceRaw: topBid.priceRaw.toString(),
      },
      "Placing IOC dump order",
    );

    try {
      const { orderId, txHash } = await safePlaceOrder(this.ctx.pool, {
        isBid: false,
        userData: 0n,
        priceRaw: aggressiveBidRaw,
        quantityRaw: baseInVault,
        expireTimestampNs: expireNs,
        orderType: ORDER_TYPE.ImmediateOrCancel,
        selfMatchingOption: SELF_MATCH.CancelTaker,
      });
      this.metrics.ordersPlaced += 1;
      this.ctx.logger.info(
        { orderId: orderId.toString(), txHash, quoteSymbol: quote.symbol },
        "Dump order broadcast — IOC will fill at best bid or expire",
      );
    } catch (err) {
      this.recordError(err);
    }
  }
}
