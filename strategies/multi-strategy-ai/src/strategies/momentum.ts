/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Classical momentum analyzer — half-window momentum + breakout (advisory only).

import { Strategy, type StrategyContext } from "./base.js";
import type { MarketSnapshot, SignalResult } from "../types.js";

export class MomentumStrategy extends Strategy {
  constructor(ctx: StrategyContext) {
    super("MOMENTUM", ctx);
  }

  analyze(snap: MarketSnapshot): SignalResult {
    const { mids, mid } = snap;
    const need = Math.max(10, Math.floor(this.ctx.cfg.windowSize / 2));
    if (mids.length < need) {
      return this.hold(`warming up (${mids.length}/${need})`);
    }

    const half = Math.floor(mids.length / 2);
    const older = mids.slice(0, half);
    const recent = mids.slice(half);
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const olderAvg = avg(older);
    const momentum = olderAvg > 0 ? (avg(recent) - olderAvg) / olderAvg : 0;
    const windowHigh = Math.max(...mids);
    const breakout = mid >= windowHigh * 0.999;
    const direction = momentum > 0.005 ? "UP" : momentum < -0.005 ? "DOWN" : "SIDEWAYS";

    const strong = this.ctx.cfg.momStrongMomentum;
    const entry = this.ctx.cfg.momEntryMomentum;

    if (momentum >= strong && breakout) {
      return {
        strategy: this.name,
        signal: "BUY",
        confidence: Math.min(0.95, Math.abs(momentum) * 25),
        reason: `Strong breakout: ${(momentum * 100).toFixed(2)}% momentum`,
        extras: { momentum, breakout, direction },
      };
    }
    if (momentum >= entry) {
      return {
        strategy: this.name,
        signal: "BUY",
        confidence: Math.min(0.75, Math.abs(momentum) * 20),
        reason: `Upward trend: ${(momentum * 100).toFixed(2)}% momentum`,
        extras: { momentum, breakout, direction },
      };
    }
    if (momentum <= -strong) {
      return {
        strategy: this.name,
        signal: "SELL",
        confidence: Math.min(0.8, Math.abs(momentum) * 18),
        reason: `Downward trend: ${(momentum * 100).toFixed(2)}% momentum`,
        extras: { momentum, breakout, direction },
      };
    }

    return this.hold(`No clear momentum (${direction}, ${(momentum * 100).toFixed(2)}%)`, {
      momentum,
      breakout,
      direction,
    });
  }
}
