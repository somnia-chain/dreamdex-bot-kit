/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// ┌──────────────────────────────────────────────────────────────────────────┐
// │  THIS IS THE ONLY FILE YOU EDIT.                                           │
// │                                                                            │
// │  `decide()` is called on every tick with a snapshot of the market and     │
// │  your inventory. Return the list of orders you want resting RIGHT NOW.     │
// │  The harness (index.ts) handles connecting, placing/cancelling, dry-run,   │
// │  and shutdown — you only express the strategy here.                        │
// └──────────────────────────────────────────────────────────────────────────┘

import type { Config } from "./config.js";

/** A snapshot of the market + your position, passed to decide() each tick. */
export interface Snapshot {
  symbol: string;
  bestBid?: number;   // top of book (quote per base), undefined if that side is empty
  bestAsk?: number;
  mid: number;        // (bestBid + bestAsk) / 2, or the one side that exists
  /** Your current base-token balance (e.g. WETH), in whole units. */
  baseInventory: number;
}

/** One order you want resting. `postOnly` orders never cross (maker-only). */
export interface Quote {
  side: "buy" | "sell";
  price: number;      // quote per base
  size: number;       // base units
  postOnly?: boolean; // default true — set false to allow taking
}

/**
 * Decide what orders to rest this tick. Return [] to rest nothing.
 *
 * The default below is a minimal two-sided maker: quote a bid below mid and an
 * ask above mid, `spreadBps` apart, sized to `sizeUsdso`. Edit freely — read
 * `m.baseInventory` to skew, `m.bestBid/bestAsk` to join the touch, add your own
 * signal, etc. For a production-grade version of this idea (inventory skew,
 * gas-efficient requoting) see ../market-making.
 */
export function decide(m: Snapshot, cfg: Config): Quote[] {
  const halfBps = cfg.spreadBps / 2;
  const size = cfg.sizeUsdso / m.mid; // convert USDso notional → base units

  const bid = m.mid * (1 - halfBps / 10_000);
  const ask = m.mid * (1 + halfBps / 10_000);

  return [
    { side: "buy", price: bid, size, postOnly: true },
    { side: "sell", price: ask, size, postOnly: true },
  ];
}
