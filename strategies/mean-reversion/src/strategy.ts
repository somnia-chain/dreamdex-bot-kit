/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Mean-reversion (RSI + Bollinger) taker — the opposite thesis to momentum.
//
// Where momentum buys strength and rides the trend, mean-reversion buys
// *weakness*: it waits for price to get statistically stretched to the downside
// (RSI oversold AND at/below the lower Bollinger band), takes a long, and exits
// when price reverts to the mean (RSI recovers) or a TP/SL fires.
//
// Long-only (spot): it's flat or long. It works on a pair that oscillates around
// a mean; it will (correctly) sit out a strong trend, where the stop-loss caps
// the "catching a falling knife" risk.

import { Pool, ORDER_TYPE, shiftBps, createStatusLogger } from "@dreamdex-bot-kit/core";
import type { Config } from "./config.js";
import { rsi, bollinger } from "./indicators.js";

interface Position {
  entry: number;
  qty: number;
}

export class MeanReversion {
  private mids: number[] = [];
  private position?: Position;

  /** Throttled "here's what I'm waiting for" line — see core/status.ts. */
  private readonly status: (msg: string) => void;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: unknown) => void,
  ) {
    this.status = createStatusLogger(log);
  }

  async tick(): Promise<void> {
    const { bestBid, bestAsk, mid } = await this.pool.topOfBook();
    if (mid === undefined || bestBid === undefined || bestAsk === undefined) {
      this.status("one-sided or empty book — waiting for quotes");
      return;
    }

    this.mids.push(mid);
    if (this.mids.length > this.cfg.windowSize) this.mids.shift();

    const r = rsi(this.mids, this.cfg.rsiPeriod);
    const bands = bollinger(this.mids, this.cfg.bbPeriod, this.cfg.bbMult);
    if (r === undefined || bands === undefined) {
      // Warming up: RSI needs rsiPeriod+1 samples, Bollinger needs bbPeriod.
      const needed = Math.max(this.cfg.rsiPeriod + 1, this.cfg.bbPeriod);
      this.status(`warming up ${this.mids.length}/${needed} samples — no signal yet`);
      return;
    }

    if (this.position) {
      const pnlPct = (mid - this.position.entry) / this.position.entry;
      this.status(
        `long ${this.position.qty.toFixed(6)} from ${this.position.entry.toFixed(6)} | pnl ${(pnlPct * 100).toFixed(2)}%` +
          ` | exit at +${(this.cfg.takeProfitPct * 100).toFixed(2)}% / -${(this.cfg.stopLossPct * 100).toFixed(2)}%` +
          ` or RSI ≥ ${this.cfg.rsiExit} (now ${r.toFixed(0)})`,
      );
      if (pnlPct >= this.cfg.takeProfitPct) return this.exit(bestBid, `take-profit ${(pnlPct * 100).toFixed(2)}%`);
      if (pnlPct <= -this.cfg.stopLossPct) return this.exit(bestBid, `stop-loss ${(pnlPct * 100).toFixed(2)}%`);
      if (r >= this.cfg.rsiExit) return this.exit(bestBid, `reverted to mean (RSI ${r.toFixed(0)})`);
      return;
    }

    this.status(
      `mid=${mid.toFixed(6)} RSI ${r.toFixed(0)} (need ≤ ${this.cfg.rsiOversold})` +
        ` lowerBand ${bands.lower.toFixed(6)} — flat, waiting to enter`,
    );

    // Enter long when oversold AND stretched below the lower band.
    if (r <= this.cfg.rsiOversold && mid <= bands.lower) {
      await this.enter(bestAsk, r, bands.lower);
    }
  }

  private async enter(bestAsk: number, r: number, lower: number): Promise<void> {
    const price = shiftBps(bestAsk, this.cfg.crossBps);
    const qty = this.cfg.notionalUsdso / bestAsk;
    if (qty < this.pool.minQty) {
      this.log(`qty ${qty} below min ${this.pool.minQty} — raise MR_NOTIONAL_USDSO`);
      return;
    }
    this.log(`ENTER long ${qty.toFixed(6)} @ ~${bestAsk.toFixed(6)} (RSI ${r.toFixed(0)}, lowerBand ${lower.toFixed(6)})`);
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
    this.position = undefined; // clear before await so shutdown can't double-sell
    const price = shiftBps(bestBid, -this.cfg.crossBps);
    this.log(`EXIT ${pos.qty.toFixed(6)} @ ~${bestBid.toFixed(6)} — ${reason}`);
    if (this.cfg.dryRun) return;
    try {
      await this.pool.place({ isBid: false, price, qty: pos.qty, orderType: ORDER_TYPE.ImmediateOrCancel });
    } catch (err) {
      this.log("exit failed", (err as Error).message);
    }
  }

  async flatten(): Promise<void> {
    const { bestBid } = await this.pool.topOfBook();
    if (this.position && bestBid !== undefined) await this.exit(bestBid, "shutdown flatten");
  }
}
