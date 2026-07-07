/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";

export function toRaw(amount: number | string, decimals: number): bigint {
  return ethers.parseUnits(amount.toString(), decimals);
}

export function fromRaw(raw: bigint, decimals: number): string {
  return ethers.formatUnits(raw, decimals);
}

export function fromRawAsNumber(raw: bigint, decimals: number): number {
  return Number(fromRaw(raw, decimals));
}

export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

export function fractionToBps(frac: number): number {
  return Math.round(frac * 10_000);
}
