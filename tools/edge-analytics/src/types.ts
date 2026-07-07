/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Domain types for edge analytics.
//
// The unit of analysis is a *fill* (your order traded) plus a *mid-price path*
// (where the market was, over time). Everything else — captured spread, adverse
// selection, net edge — is derived from those two.
//
// Prices and quantities here are HUMAN numbers (e.g. 1.0023, not raw 1e18
// integers). Convert once at the boundary (the kit's `quant.fromRaw`) and keep
// the analytics in human units so the reports read in the same terms as the UI.

/** Which side WE ended up on. A filled resting bid means we BOUGHT (long). */
export type FillSide = "buy" | "sell";

/** One execution of our order. Derived from the kit's csv-logger `fill` rows. */
export interface Fill {
  /** Fill time, unix milliseconds. */
  tsMs: number;
  /** Pool address (or any stable market id). Reports group by this. */
  pool: string;
  side: FillSide;
  /** Price we traded at, human units (quote per base). */
  price: number;
  /** Quantity filled, human units (base). */
  qty: number;
  /** Optional: our order id, for joining to the action log. */
  orderId?: string;
}

/** A mid-price observation. Build these from a book poller or the trade tape. */
export interface MidTick {
  tsMs: number;
  /** Mid = (bestBid + bestAsk) / 2, human units. */
  mid: number;
}

/**
 * Counts of order-lifecycle actions per market, used for transactions-per-fill.
 * `post`/`cancel`/`reduce` are the txs you PAY for; `fill` is the result you
 * WANT. A healthy maker requotes ~1–3× per fill; a runaway loop is 50×+.
 */
export interface ActionCounts {
  pool: string;
  post: number;
  cancel: number;
  reduce: number;
  fill: number;
}

/** Horizons (ms after the fill) at which to mark out adverse selection. */
export type Horizons = readonly number[];

/** Per-fill markout record: what happened to this one trade. */
export interface Markout {
  fill: Fill;
  /** Mid at the instant of the fill (t0). null if no mid data spans the fill. */
  mid0: number | null;
  /**
   * Captured half-spread in basis points of mid0: how far inside the mid we
   * got filled. Positive = we were paid to provide liquidity at the touch.
   * capturedBps = sign * (mid0 - price) / mid0 * 1e4, sign = +1 buy / -1 sell.
   */
  capturedBps: number | null;
  /**
   * Adverse-selection drift at each horizon, bps of mid0, signed as PnL:
   * moveBps[h] = sign * (mid(t0+h) - mid0) / mid0 * 1e4.
   * NEGATIVE = the market moved against us after we traded (toxic fill).
   */
  moveBps: Record<number, number | null>;
  /**
   * Net realized edge at each horizon = capturedBps + moveBps[h]. This is the
   * number that decides whether the fill made money marked to mid. Sum/median
   * over all fills < 0 ⇒ the maker is structurally unprofitable.
   */
  netBps: Record<number, number | null>;
}

export interface AnalyzeConfig {
  /** Markout horizons in ms. Default: 1s, 10s, 60s. */
  horizonsMs?: Horizons;
  /**
   * Max staleness (ms) allowed when looking up a mid at a target time. If the
   * nearest tick is older/newer than this, that horizon is null (not fabricated).
   * Default 5000.
   */
  maxMidStalenessMs?: number;
}

export const DEFAULT_HORIZONS_MS: Horizons = [1_000, 10_000, 60_000] as const;
export const DEFAULT_MAX_MID_STALENESS_MS = 5_000;
