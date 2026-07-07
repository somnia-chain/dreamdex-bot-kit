/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Pre-flight guards for the things that silently reject or revert an order on
// DreamDEX. Call these before you sign. Each maps to an entry in docs/gotchas.md.
//
// The pattern (borrowed from the cleanest competition bots): fail loudly in your
// own code with a typed error, rather than letting the chain reject the order
// with an opaque revert — or worse, mine a tx that did nothing.

import { zeroAddress } from "viem";

/** Order execution type — the on-chain `orderType` enum. */
export const ORDER_TYPE = {
  /** GTC — rests on the book if it doesn't fully fill. */
  Normal: 0,
  /** Fully fill immediately or revert. */
  FillOrKill: 1,
  /** Fill what you can now, cancel the rest. The taker default. */
  ImmediateOrCancel: 2,
  /** Maker-only: rejected if any part would fill immediately. */
  PostOnly: 3,
} as const;

export const SELF_MATCH = {
  /** Cancel the incoming (taker) order if it would hit your own resting order. */
  CancelTaker: 0,
  /** Cancel your resting (maker) order and keep matching. */
  CancelMaker: 1,
} as const;

export const NS_PER_MS = 1_000_000n;

export class GotchaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "GotchaError";
  }
}

/**
 * Build an `expireTimestampNs` value `durationMs` from now, in nanoseconds.
 * There is NO "no expiry" sentinel: 0, past, or current-time values are all
 * rejected. Always pass a future nanosecond timestamp.
 */
export function buildExpireNs(durationMs: number): bigint {
  if (durationMs <= 0) {
    throw new GotchaError("EXPIRE_MS_NONPOSITIVE", `durationMs must be > 0 (got ${durationMs}).`);
  }
  return (BigInt(Date.now()) + BigInt(durationMs)) * NS_PER_MS;
}

export function assertExpireNs(expireNs: bigint): void {
  const nowNs = BigInt(Date.now()) * NS_PER_MS;
  if (expireNs <= nowNs) {
    throw new GotchaError(
      "EXPIRE_NS_NOT_FUTURE",
      `expireTimestampNs must be strictly in the future (got ${expireNs}, now=${nowNs}). ` +
        `0 is NOT "no expiry" — it is rejected. Use buildExpireNs(...).`,
    );
  }
}

/**
 * A taker (IOC/FOK) order must cross the book: priceRaw = 0 never crosses and
 * produces no fill. Price your limit at-or-through the opposite top of book.
 */
export function assertPriceRawNonZero(priceRaw: bigint): void {
  if (priceRaw <= 0n) {
    throw new GotchaError(
      "PRICE_RAW_ZERO",
      `priceRaw must be > 0 (got ${priceRaw}). priceRaw = 0 is a literal price on DreamDEX, ` +
        `not "market" — it will never cross the book.`,
    );
  }
}

/**
 * This kit trades WITHOUT a builder code: it always passes builder = address(0)
 * and builderFeeBpsTimes1k = 0, which produces valid orders on every network.
 * This guard enforces that untagged path.
 *
 * Note: builder codes ARE enabled on mainnet — each pool's
 * `getMaxBuilderFeeBpsTimes1k()` returns 100000 (a 1% fee cap). Testnet's cap is
 * currently 0. To trade with a builder code, read the live cap, call
 * `approveBuilder` once, pass a fee <= cap, and include it in the
 * `getAutoPullRequirement` call. Builder support is intentionally out of scope
 * for this guard (a planned addition to the kit).
 */
export function assertBuilderDisabled(builder: string, builderFeeBpsTimes1k: bigint): void {
  if (builder.toLowerCase() !== zeroAddress) {
    throw new GotchaError(
      "BUILDER_NOT_ZERO",
      `builder must be the zero address on this kit's untagged order path (got ${builder}). ` +
        `Builder codes exist on mainnet (1% cap) but this kit does not tag orders yet.`,
    );
  }
  if (builderFeeBpsTimes1k !== 0n) {
    throw new GotchaError(
      "BUILDER_FEE_NOT_ZERO",
      `builderFeeBpsTimes1k must be 0 when builder is the zero address (got ${builderFeeBpsTimes1k}).`,
    );
  }
}

export function assertQtyMultipleOfLot(qtyRaw: bigint, lotRaw: bigint): void {
  if (lotRaw <= 0n) throw new GotchaError("LOT_RAW_ZERO", "lotRaw must be > 0.");
  if (qtyRaw % lotRaw !== 0n) {
    throw new GotchaError(
      "QTY_NOT_LOT_MULTIPLE",
      `quantity ${qtyRaw} is not a whole multiple of lotSize ${lotRaw}. Use quant.alignToLot().`,
    );
  }
}

export function assertQtyAboveMin(qtyRaw: bigint, minQtyRaw: bigint): void {
  if (qtyRaw < minQtyRaw) {
    throw new GotchaError(
      "QTY_BELOW_MIN",
      `quantity ${qtyRaw} is below the market minimum ${minQtyRaw}. ` +
        `minQuantity is the #1 cause of a rejected first order.`,
    );
  }
}

export function assertPriceMultipleOfTick(priceRaw: bigint, tickRaw: bigint): void {
  if (tickRaw <= 0n) throw new GotchaError("TICK_RAW_ZERO", "tickRaw must be > 0.");
  if (priceRaw % tickRaw !== 0n) {
    throw new GotchaError(
      "PRICE_NOT_TICK_MULTIPLE",
      `price ${priceRaw} is not a whole multiple of tickSize ${tickRaw}. Use quant.alignToTick().`,
    );
  }
}
