/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { toRaw, fromRaw } from "./decimals.js";
import type { PoolConfig } from "../config/pairs.js";

const QUOTE_DECIMALS_DEFAULT = 18;

export function priceToRaw(price: number, quoteDecimals = QUOTE_DECIMALS_DEFAULT): bigint {
  if (price <= 0) {
    throw new Error(`priceToRaw: price must be > 0 (got ${price})`);
  }
  return toRaw(price.toString(), quoteDecimals);
}

export function rawToPrice(raw: bigint, quoteDecimals = QUOTE_DECIMALS_DEFAULT): number {
  return Number(fromRaw(raw, quoteDecimals));
}

export function qtyToRaw(qty: number, baseDecimals: number): bigint {
  if (qty <= 0) {
    throw new Error(`qtyToRaw: qty must be > 0 (got ${qty})`);
  }
  return toRaw(qty.toString(), baseDecimals);
}

export function rawToQty(raw: bigint, baseDecimals: number): number {
  return Number(fromRaw(raw, baseDecimals));
}

export function alignToTick(price: number, tickSize: number, side: "bid" | "ask"): number {
  if (tickSize <= 0) throw new Error(`alignToTick: tickSize must be > 0`);
  const ticks = price / tickSize;
  const rounded = side === "bid" ? Math.floor(ticks) : Math.ceil(ticks);
  return Number((rounded * tickSize).toFixed(decimalsOf(tickSize)));
}

export function alignToLot(qty: number, lotSize: number): number {
  if (lotSize <= 0) throw new Error(`alignToLot: lotSize must be > 0`);
  const lots = Math.floor(qty / lotSize);
  return Number((lots * lotSize).toFixed(decimalsOf(lotSize)));
}

export function shiftBps(price: number, bps: number): number {
  return price * (1 + bps / 10_000);
}

export function spreadAroundMid(
  mid: number,
  spreadBps: number,
  pool: Pick<PoolConfig, "tickSize">,
): { bid: number; ask: number } {
  const bid = alignToTick(shiftBps(mid, -spreadBps), pool.tickSize, "bid");
  const ask = alignToTick(shiftBps(mid, spreadBps), pool.tickSize, "ask");
  return { bid, ask };
}

function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  const dotIdx = s.indexOf(".");
  if (dotIdx === -1) return 0;
  return s.length - dotIdx - 1;
}
