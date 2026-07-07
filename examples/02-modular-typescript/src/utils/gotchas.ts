/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";
import { NS_PER_MS, MS_PER_HOUR } from "../config/constants.js";

export class GotchaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "GotchaError";
  }
}

export function buildExpireNs(durationMs: bigint = MS_PER_HOUR): bigint {
  const ns = BigInt(Date.now()) * NS_PER_MS + durationMs * NS_PER_MS;
  if (ns <= 0n) {
    throw new GotchaError("EXPIRE_NS_ZERO", "buildExpireNs produced non-positive value");
  }
  return ns;
}

export function assertExpireNs(expireNs: bigint): void {
  if (expireNs <= 0n) {
    throw new GotchaError(
      "EXPIRE_NS_ZERO",
      `expireTimestampNs must be > 0 (got ${expireNs}). DreamDEX rejects 0 — set to now + 1h in ns.`,
    );
  }
  const nowNs = BigInt(Date.now()) * NS_PER_MS;
  if (expireNs <= nowNs) {
    throw new GotchaError(
      "EXPIRE_NS_PAST",
      `expireTimestampNs is in the past (expire=${expireNs}, now=${nowNs}).`,
    );
  }
}

export function assertPriceRawNonZero(priceRaw: bigint): void {
  if (priceRaw <= 0n) {
    throw new GotchaError(
      "PRICE_RAW_ZERO",
      `priceRaw must be > 0 (got ${priceRaw}). priceRaw=0 is LITERAL on DreamDEX — order won't cross.`,
    );
  }
}

export function assertBuilderDisabled(builder: string, builderFeeBpsTimes1k: bigint): void {
  if (builder !== ethers.ZeroAddress) {
    throw new GotchaError(
      "BUILDER_NOT_ZERO",
      `builder must be address(0) on the untagged order path (got ${builder}). Builder codes exist on mainnet (1% cap); this bot does not tag orders.`,
    );
  }
  if (builderFeeBpsTimes1k !== 0n) {
    throw new GotchaError(
      "BUILDER_FEE_NOT_ZERO",
      `builderFeeBpsTimes1k must be 0 when builder is address(0) (got ${builderFeeBpsTimes1k}).`,
    );
  }
}

export function assertQtyMultipleOfLot(qty: bigint, lotRaw: bigint): void {
  if (lotRaw <= 0n) {
    throw new GotchaError("LOT_RAW_ZERO", `lotRaw must be > 0`);
  }
  if (qty % lotRaw !== 0n) {
    throw new GotchaError(
      "QTY_NOT_LOT_MULTIPLE",
      `qty=${qty} is not a multiple of lotRaw=${lotRaw}`,
    );
  }
}

export function assertQtyAboveMin(qty: bigint, minQtyRaw: bigint): void {
  if (qty < minQtyRaw) {
    throw new GotchaError(
      "QTY_BELOW_MIN",
      `qty=${qty} is below minimum=${minQtyRaw}`,
    );
  }
}

export function assertOrderPlacedEvent(receipt: ethers.TransactionReceipt, orderPlacedTopic: string): void {
  const found = receipt.logs.some((l) => l.topics[0] === orderPlacedTopic);
  if (!found) {
    throw new GotchaError(
      "SILENT_REJECTION",
      `Tx mined but OrderPlaced event missing — silent rejection. Tx hash: ${receipt.hash}`,
    );
  }
}
