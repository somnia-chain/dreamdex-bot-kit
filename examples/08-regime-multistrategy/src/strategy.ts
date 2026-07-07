/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Strategy MODULES. Each only PROPOSES orders; the orchestrator merges them,
// clips them under the shared risk, and sends via a single execution queue (one nonce).

import { OrderBook, Side } from "./exchange.js";

export interface DesiredOrder { symbol: string; side: Side; price: number; size: number; postOnly: boolean; tag: string; }
export interface StratCtx { symbol: string; ob: OrderBook; invUSDso: number; quoteUSDso: number; clipUSDso: number; fair?: number; vaultBaseUSDso?: number; tick?: number; fairFresh?: boolean; }
export interface Strategy { name: string; enabled: boolean; propose(ctx: StratCtx): DesiredOrder[]; }

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// 1) Harvest Maker (module name "growth"): rests AT THE TOUCH (top-of-book) post-only,
//    to actually catch others' taker flow (taker rivals hit US → volume + spread in our favour).
//    An earlier version quoted INSIDE the spread behind the system MM → 0 fills; and the skew pushed
//    the sell below the bid → postOnly crossed → the API returned an empty tx → deadlock. Both are fixed here:
//    - quote at the best bid/ask (+leadTicks inward, but NEVER cross → postOnly stays valid);
//    - instead of a price skew, an inventory GATE (over-long → don't buy more, only sell);
//    - a 0/+ PROFIT GUARD: with a fresh external fair, buy only below fair, sell only above.
export class HarvestMaker implements Strategy {
  name = "growth";
  // leadTicks: how many ticks to step inside the spread (0=join the best, 1=become the best). minEdgeBps: min edge vs fair.
  // softInvUSDso: inventory threshold above which we DON'T buy more (only sell) → inventory drifts to zero.
  // spreadBps: min offset of EACH quote from the mid (anti-adverse-selection). 0 = at the touch (max volume, max bleed);
  // >0 = quote deeper/wider → fewer fills, but more spread per fill → less "negative gamma" (capital protection).
  constructor(public enabled: boolean, private leadTicks: number, private minEdgeBps: number, private softInvUSDso: number, private spreadBps = 0, private skewBps = 0) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    const ob = c.ob;
    if (!(ob.bid > 0 && ob.ask > ob.bid)) return out;                 // no sane book → stay quiet
    const tick = c.tick && c.tick > 0 ? c.tick : ob.mid * 1e-4;        // price step (fallback ~1bp)
    const lead = Math.max(0, this.leadTicks) * tick;                   // how far to step inside the spread
    // QUOTE CENTER: the adjusted fair (Binance + basis, computed in the bot) if fresh — otherwise the dreamDEX mid.
    // Centering on the LIVE price pulls the "resting" side away from the market → less stale pick-off (adverse selection).
    const center = (c.fairFresh && c.fair && c.fair > 0) ? c.fair : ob.mid;
    const half = Math.max(center * Math.max(0, this.spreadBps) * 1e-4, tick);  // half-spread from center (min 1 tick)
    // Normally at the touch; but if the center moved UP (rally) → the ask rises ABOVE the touch (don't sell cheap);
    // if DOWN (drop) → the bid drops BELOW the touch (don't catch the knife). Never cross (postOnly stays valid).
    let bid = Math.min(center - half, ob.bid + lead, ob.ask - tick);
    let ask = Math.max(center + half, ob.ask - lead, ob.bid + tick);
    if (!(ask > bid)) { bid = ob.bid; ask = ob.ask; }                  // spread = 1 tick → just join
    // INVENTORY SKEW (market-neutral): over-long → move BOTH quotes DOWN. The ask drops toward the bid = aggressive
    // MAKER sell (offload inventory, capturing the spread, WITHOUT a taker cross); the lower bid buys less/cheaper.
    // Pulls inventory to zero → balance stops depending on price moves. We DON'T cross (ask ≥ best bid + tick).
    if (this.skewBps > 0 && c.invUSDso > 0) {
      const invRatio = clamp(c.invUSDso / Math.max(this.softInvUSDso, 1), 0, 1);
      const skew = this.skewBps * 1e-4 * invRatio;
      ask = Math.max(ask * (1 - skew), ob.bid + tick);
      bid = bid * (1 - skew);
    }
    // INVENTORY GATE (no price cross): over-long → stop buying; there's no short side on spot
    const overLong = c.invUSDso >= this.softInvUSDso;
    const sizeFor = (availUSD: number) => Math.min(c.clipUSDso, Math.max(0, availUSD) * 0.9) / ob.mid;
    if (!overLong && c.quoteUSDso > 1) {                               // buy base with free USDso
      const sz = sizeFor(Math.min(c.quoteUSDso, c.clipUSDso));
      if (sz > 0) out.push({ symbol: c.symbol, side: "buy", price: bid, size: sz, postOnly: true, tag: this.name });
    }
    // A wallet-funded maker sells base FROM THE WALLET → what's sellable = the pair's WHOLE inventory (a cancelAll before
    // re-quoting frees it from resting orders). vaultBaseUSDso here ≈0 (that's vault+orders), so we can't use it.
    const sellableUSD = c.invUSDso;
    if (sellableUSD > 1) {                                             // sell the base we hold for USDso
      const sz = sizeFor(Math.min(sellableUSD, c.clipUSDso));
      if (sz > 0) out.push({ symbol: c.symbol, side: "sell", price: ask, size: sz, postOnly: true, tag: this.name });
    }
    return out;
  }
}
// alias for backwards-compatible imports
export { HarvestMaker as CapitalGrowthMaker };

// 2) Volume Booster: CROSSES the spread (taker) → volume against the REAL book.
//    self-cross is IMPOSSIBLE: dreamDEX forbids self-trading (one side is always cancelled),
//    so volume = only trades against others' orders. We take at ask/bid (at market).
//    Costs the spread → cheap on a thin book; only ramps up when there's external liquidity.
export class VolumeBooster implements Strategy {
  name = "volume";
  // maxSpreadBps: cross ONLY when the spread ≤ this (0 = no limit). Taker cost = spread/2,
  // so a narrow spread = cheap volume (keeps cost/volume BELOW rivals); wide spreads are skipped (wait for narrow).
  constructor(public enabled: boolean, private maxSpreadBps = 0) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    const spreadBps = c.ob.mid > 0 ? (c.ob.ask - c.ob.bid) / c.ob.mid * 1e4 : 1e9;
    if (this.maxSpreadBps > 0 && spreadBps > this.maxSpreadBps) return out;        // spread too expensive → DON'T cross now (wait for narrow → lower price)
    const half = c.clipUSDso * 0.5;                                                // target activation threshold — half a clip…
    // …but NOT above an absolute minimum of $12: a strict "half a clip" threshold froze capital tails
    // (inv $28 < half $30 "can't sell" + buyable ~$29 < $30 "can't buy" = hours of idling).
    const actMin = Math.min(half, 12);
    const sizeFor = (availUSD: number) => Math.min(c.clipUSDso, availUSD * 0.95) / c.ob.mid; // size to available (5% buffer)
    if (c.quoteUSDso >= actMin) out.push({ symbol: c.symbol, side: "buy",  price: c.ob.ask, size: sizeFor(c.quoteUSDso), postOnly: false, tag: this.name }); // have USDso → take the ask
    if (c.invUSDso  >= actMin) out.push({ symbol: c.symbol, side: "sell", price: c.ob.bid, size: sizeFor(c.invUSDso),   postOnly: false, tag: this.name }); // have base → hit the bid
    return out;                                                                    // don't buy without USDso, don't sell without base → no reverts or drift
  }
}

// 3) Pick-Off / mini-ARBITRAGE: compares the dreamDEX book against an EXTERNAL fair value (a Binance ETH/BTC feed).
//    Book lags the market (ask cheaper than fair / bid richer) → take with a taker → PROFITABLE volume (mult>1).
//    fair comes from the bot (c.fair); with no feed, c.fair=undefined → compared to ob.mid → won't fire (safe).
export class PickOff implements Strategy {
  name = "pickoff";
  constructor(public enabled: boolean, private edgeBps: number, private clipMult: number) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    if (!(c.fairFresh && c.fair && c.fair > 0)) return out;       // without a FRESH external fair, pickoff doesn't trade
    const fair = c.fair;                                          // external fair (Binance), guaranteed fresh
    const want = c.clipUSDso * this.clipMult;
    const e = this.edgeBps * 1e-4;
    if (c.ob.ask < fair * (1 - e) && c.quoteUSDso > 1)           // dreamDEX cheaper than market → BUY (have USDso)
      out.push({ symbol: c.symbol, side: "buy",  price: c.ob.ask, size: Math.min(want, c.quoteUSDso * 0.95) / c.ob.mid, postOnly: false, tag: this.name });
    if (c.ob.bid > fair * (1 + e) && c.invUSDso > 1)             // dreamDEX richer than market → SELL (have base)
      out.push({ symbol: c.symbol, side: "sell", price: c.ob.bid, size: Math.min(want, c.invUSDso * 0.95) / c.ob.mid, postOnly: false, tag: this.name });
    return out;
  }
}

// 4) Grid: a ladder of post-only orders — buys BELOW the mid, sells ABOVE. Earns on oscillation
//    (bought cheap / sold dear = one grid step in profit) + volume. Maker → we don't lose the spread, doesn't cross.
//    Risk is a strong trend (accumulates inventory); capped by the inventory limit + drawdown stop (risk.ts).
export class GridMaker implements Strategy {
  name = "grid";
  constructor(public enabled: boolean, private levels: number, private stepBps: number, private maxInvUSDso: number) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    const step = this.stepBps * 1e-4;
    const perLevel = c.clipUSDso / Math.max(1, this.levels);     // split the clip across levels
    const invRatio = c.invUSDso / this.maxInvUSDso;
    const tooLong = invRatio > 0.8, tooShort = invRatio < -0.8;  // near the limit edges, don't add to the imbalance
    let quoteLeft = c.quoteUSDso, baseLeft = c.invUSDso;
    for (let i = 1; i <= this.levels; i++) {
      if (!tooLong && quoteLeft >= perLevel * 0.5) {             // buy below the mid (i-th level)
        out.push({ symbol: c.symbol, side: "buy", price: c.ob.mid * (1 - i * step), size: Math.min(perLevel, quoteLeft * 0.95) / c.ob.mid, postOnly: true, tag: this.name });
        quoteLeft -= perLevel;
      }
      if (!tooShort && baseLeft >= perLevel * 0.5) {             // sell above the mid (i-th level)
        out.push({ symbol: c.symbol, side: "sell", price: c.ob.mid * (1 + i * step), size: Math.min(perLevel, baseLeft * 0.95) / c.ob.mid, postOnly: true, tag: this.name });
        baseLeft -= perLevel;
      }
    }
    return out;
  }
}
