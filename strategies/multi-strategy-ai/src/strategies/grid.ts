/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Classical grid analyzer — position in recent mid range (advisory only).

import { Strategy, type StrategyContext } from "./base.js";
import type { MarketSnapshot, SignalResult } from "../types.js";

export class GridStrategy extends Strategy {
  constructor(ctx: StrategyContext) {
    super("GRID", ctx);
  }

  analyze(snap: MarketSnapshot): SignalResult {
    const { mids, mid } = snap;
    if (mids.length < 10) {
      return this.hold(`warming up (${mids.length}/10)`);
    }

    const rangeHigh = Math.max(...mids);
    const rangeLow = Math.min(...mids);
    const rangeSize = rangeHigh - rangeLow;
    if (rangeSize <= 0 || rangeHigh <= 0) {
      return this.hold("No valid price range");
    }

    const positionInRange = (mid - rangeLow) / rangeSize;
    const rangePercent = (rangeSize / rangeLow) * 100;

    if (positionInRange <= 0.25) {
      return {
        strategy: this.name,
        signal: "BUY",
        confidence: Math.min(0.85, (0.25 - positionInRange) * 3.4),
        reason: `Price at ${(positionInRange * 100).toFixed(0)}% of range, near bottom`,
        extras: { positionInRange, rangeLow, rangeHigh, rangePercent },
      };
    }
    if (positionInRange >= 0.75) {
      return {
        strategy: this.name,
        signal: "SELL",
        confidence: Math.min(0.85, (positionInRange - 0.75) * 3.4),
        reason: `Price at ${(positionInRange * 100).toFixed(0)}% of range, near top`,
        extras: { positionInRange, rangeLow, rangeHigh, rangePercent },
      };
    }

    return this.hold(`Mid-range (${(positionInRange * 100).toFixed(0)}%), waiting`, {
      positionInRange,
      rangeLow,
      rangeHigh,
      rangePercent,
    });
  }
}
