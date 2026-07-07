/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// State snapshot: the bot writes its trade/tick history here for reporting.

export interface FillRow { ts: number; symbol: string; side: string; size: number; price: number; }
export interface PairRow { symbol: string; mid: number; spreadBps: number; allocPct: number; invUSDso: number; }
export interface TickRow { ts: number; equity: number; ddPct: number; regime: string; inv: number; gas: number; }

export class Stats {
  startTime = Date.now();
  dry = true;
  halted = false;
  regime = "healthy";
  cumVolume = 0;
  equity = 0; startEquity = 0; ddPct = 0; inv = 0; gas = 0; quoteUSDso = 0; minQuoteUSDso = 0;
  activeModules: string[] = [];
  pairs: PairRow[] = [];
  fills: FillRow[] = [];
  ticks: TickRow[] = [];
  private cap = 1000;

  recordFill(f: FillRow) { this.cumVolume += f.size * f.price; this.fills.push(f); if (this.fills.length > this.cap) this.fills.shift(); }
  recordTick(t: TickRow) { this.ticks.push(t); if (this.ticks.length > this.cap) this.ticks.shift(); }

  snapshot() {
    return {
      dry: this.dry, halted: this.halted, regime: this.regime,
      uptimeSec: Math.floor((Date.now() - this.startTime) / 1000),
      cumVolume: this.cumVolume, estReward: this.cumVolume / 500000 * 25,
      equity: this.equity, startEquity: this.startEquity, ddPct: this.ddPct, inv: this.inv, gas: this.gas,
      quoteUSDso: this.quoteUSDso, minQuoteUSDso: this.minQuoteUSDso,
      activeModules: this.activeModules, pairs: this.pairs,
      fills: this.fills.slice(-60).reverse(),
    };
  }
  export() {
    return { generatedAt: new Date().toISOString(), summary: this.snapshot(), allFills: this.fills, allTicks: this.ticks };
  }
}
