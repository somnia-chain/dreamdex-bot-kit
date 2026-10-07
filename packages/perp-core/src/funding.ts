/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Funding, read the way the contract means it.
//
// The stored rate covers the CALCULATION WINDOW, not one settlement interval.
// Reading it as per-interval overstates the annualised figure by the number of
// intervals in a window, which on the live markets is eight. The SDK's
// converters truncate the way the contract's integer arithmetic does, so they
// are used here rather than dividing by hand.

import { annualizedFundingRate, fundingRatePerInterval } from "@somnia-chain/markets-sdk";
import type { PerpInfo } from "./markets.js";
import type { Side } from "./orders.js";

export interface FundingView {
  /** Annualised, as a fraction: 0.01 is 1% APR. */
  apr: number;
  /** What settles each interval, raw 1e18-scaled. */
  perInterval: bigint;
  /** Positive means longs pay shorts. */
  positive: boolean;
  /** The side funding currently PAYS. */
  paidSide: Side;
  windowSec: number;
  intervalSec: number;
}

/** Read the market row's funding state. */
export function fundingApr(info: PerpInfo): FundingView {
  const rate = BigInt(info.fundingRate ?? 0);
  const windowSec = Number(info.fundingWindowSec);
  const intervalSec = Number(info.fundingIntervalSec);
  const apr = annualizedFundingRate(rate, windowSec);
  return {
    apr,
    perInterval: fundingRatePerInterval(rate, windowSec, intervalSec),
    positive: rate > 0n,
    // Positive funding is longs paying shorts, so the side that GETS paid is
    // the short one. A carry strategy takes the paid side and nothing else.
    paidSide: rate > 0n ? "short" : "long",
    windowSec,
    intervalSec,
  };
}

/**
 * The side worth holding for carry, or undefined when the rate does not clear
 * the threshold.
 *
 * `minApr` is compared against the ABSOLUTE rate, because a large negative rate
 * pays longs exactly as a large positive one pays shorts.
 */
export function fundingSide(info: PerpInfo, minApr: number): Side | undefined {
  const view = fundingApr(info);
  return Math.abs(view.apr) >= minApr ? view.paidSide : undefined;
}
