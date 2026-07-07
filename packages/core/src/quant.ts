/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Price / quantity quantization and decimal helpers.
//
// On-chain values are raw integers: human value × 10^decimals. Prices must be a
// whole multiple of tickSize; quantities a whole multiple of lotSize and at
// least minQuantity. Do the rounding in integer (bigint) space to avoid the
// float artifacts that produce off-by-one-tick rejections.

import { parseUnits, formatUnits } from "viem";

export function toRaw(human: number | string, decimals: number): bigint {
  // Route through a fixed-precision string so `1e-7` etc. never reach parseUnits.
  const s = typeof human === "number" ? human.toFixed(decimals) : human;
  return parseUnits(s, decimals);
}

export function fromRaw(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

/** Round a raw price DOWN (bid) or UP (ask) to the nearest tick multiple. */
export function alignToTick(priceRaw: bigint, tickRaw: bigint, side: "bid" | "ask"): bigint {
  if (tickRaw <= 0n) throw new Error("tickRaw must be > 0");
  const rem = priceRaw % tickRaw;
  if (rem === 0n) return priceRaw;
  // Bids round down (stay ≤ target so they don't cross accidentally); asks round up.
  return side === "bid" ? priceRaw - rem : priceRaw - rem + tickRaw;
}

/** Round a raw quantity DOWN to the nearest lot multiple (never over-spend). */
export function alignToLot(qtyRaw: bigint, lotRaw: bigint): bigint {
  if (lotRaw <= 0n) throw new Error("lotRaw must be > 0");
  return qtyRaw - (qtyRaw % lotRaw);
}

/** Shift a human price by ±bps. Positive widens up, negative widens down. */
export function shiftBps(price: number, bps: number): number {
  return price * (1 + bps / 10_000);
}

export function spreadBps(bestBid: number, bestAsk: number): number {
  const mid = (bestBid + bestAsk) / 2;
  return mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;
}
