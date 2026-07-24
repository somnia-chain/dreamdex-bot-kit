/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Small, dependency-free indicator helpers: RSI, SMA, and Bollinger Bands.

export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/** Wilder-style RSI over the last `period` changes. Returns 0–100, or undefined if too short. */
export function rsi(values: number[], period: number): number | undefined {
  if (values.length < period + 1) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface Bands {
  mid: number;
  upper: number;
  lower: number;
}

export function bollinger(values: number[], period: number, mult: number): Bands | undefined {
  const mid = sma(values, period);
  if (mid === undefined) return undefined;
  const slice = values.slice(-period);
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}
