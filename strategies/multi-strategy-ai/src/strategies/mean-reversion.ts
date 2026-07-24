/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Classical mean-reversion analyzer — RSI + Bollinger (advisory only).

import { rsi, bollinger } from "../indicators.js";
import { Strategy, type StrategyContext } from "./base.js";
import type { MarketSnapshot, SignalResult } from "../types.js";

export class MeanReversionStrategy extends Strategy {
  constructor(ctx: StrategyContext) {
    super("MEAN_REVERSION", ctx);
  }

  analyze(snap: MarketSnapshot): SignalResult {
    const { mids, mid } = snap;
    const r = rsi(mids, this.ctx.cfg.rsiPeriod);
    const bands = bollinger(mids, this.ctx.cfg.bbPeriod, this.ctx.cfg.bbMult);
    if (r === undefined || bands === undefined) {
      return this.hold("warming up (RSI/BB)");
    }

    const oversold = this.ctx.cfg.rsiOversold;
    const overbought = this.ctx.cfg.rsiOverbought;

    if (r <= oversold && mid <= bands.lower) {
      return {
        strategy: this.name,
        signal: "BUY",
        confidence: Math.min(0.9, (oversold - r + 10) / 40),
        reason: `Oversold RSI ${r.toFixed(0)} at/below lower band ${bands.lower.toFixed(6)}`,
        extras: { rsi: r, lower: bands.lower, upper: bands.upper },
      };
    }
    if (r >= overbought && mid >= bands.upper) {
      return {
        strategy: this.name,
        signal: "SELL",
        confidence: Math.min(0.9, (r - overbought + 10) / 40),
        reason: `Overbought RSI ${r.toFixed(0)} at/above upper band ${bands.upper.toFixed(6)}`,
        extras: { rsi: r, lower: bands.lower, upper: bands.upper },
      };
    }
    if (r <= oversold + 5 && mid <= bands.lower * 1.03) {
      return {
        strategy: this.name,
        signal: "BUY",
        confidence: Math.min(0.7, (oversold + 5 - r) / 35),
        reason: `Near oversold RSI ${r.toFixed(0)} near lower band`,
        extras: { rsi: r, lower: bands.lower, upper: bands.upper },
      };
    }
    if (r >= overbought - 5 && mid >= bands.upper * 0.97) {
      return {
        strategy: this.name,
        signal: "SELL",
        confidence: Math.min(0.7, (r - (overbought - 5)) / 35),
        reason: `Near overbought RSI ${r.toFixed(0)} near upper band`,
        extras: { rsi: r, lower: bands.lower, upper: bands.upper },
      };
    }

    return this.hold(`RSI neutral at ${r.toFixed(0)}`, { rsi: r, lower: bands.lower, upper: bands.upper });
  }
}
