/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Adaptive regime by capital state: the deeper the drawdown, the less risk.
// healthy → all modules; caution → disable pure volume (it burns capital), keep earn;
// defensive → growth only (pure earn). Hysteresis so it doesn't flip at the boundary.

export interface RegimeConfig {
  cautionDrawdownPct: number;
  defensiveDrawdownPct: number;
  cautionClipMult: number;
  defensiveClipMult: number;
}
export type Regime = "healthy" | "caution" | "defensive";

export class RegimeManager {
  private current: Regime = "healthy";
  private readonly hysteresis = 2; // must recover 2% past the threshold to step back up
  constructor(private cfg: RegimeConfig) {}

  update(ddPct: number): Regime {
    const { cautionDrawdownPct: C, defensiveDrawdownPct: D } = this.cfg;
    const h = this.hysteresis;
    switch (this.current) {
      case "healthy":
        if (ddPct >= D) this.current = "defensive";
        else if (ddPct >= C) this.current = "caution";
        break;
      case "caution":
        if (ddPct >= D) this.current = "defensive";
        else if (ddPct < C - h) this.current = "healthy";
        break;
      case "defensive":
        if (ddPct < C - h) this.current = "healthy";
        else if (ddPct < D - h) this.current = "caution";
        break;
    }
    return this.current;
  }

  activeModules(): Set<string> {
    if (this.current === "healthy") return new Set(["grid", "growth", "volume", "pickoff"]);
    if (this.current === "caution") return new Set(["grid", "growth", "pickoff"]); // mute pure volume
    return new Set(["grid", "growth"]);                                            // defensive: grid + earn
  }

  clipMult(): number {
    if (this.current === "healthy") return 1;
    if (this.current === "caution") return this.cfg.cautionClipMult;
    return this.cfg.defensiveClipMult;
  }
}
