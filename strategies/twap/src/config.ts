/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { loadEnv } from "@dreamdex-bot-kit/core";
loadEnv();

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key}="${v}" is not a number`);
  return n;
}
function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  symbol: str("TWAP_SYMBOL", "SOMI:USDso"),
  /** "buy" to accumulate base, "sell" to distribute it. */
  side: (str("TWAP_SIDE", "buy").toLowerCase() === "sell" ? "sell" : "buy") as "buy" | "sell",
  /** Total quote (USDso) notional to execute across the whole schedule. */
  totalUsdso: num("TWAP_TOTAL_USDSO", 20),
  /** Number of equal slices to split it into. */
  slices: num("TWAP_SLICES", 5),
  /** Seconds between slices. total duration ≈ slices × this. */
  intervalSec: num("TWAP_INTERVAL_SEC", 30),
  /** Max slippage each slice is allowed to cross by, in bps (the price bound). */
  maxSlippageBps: num("TWAP_MAX_SLIPPAGE_BPS", 15),
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
