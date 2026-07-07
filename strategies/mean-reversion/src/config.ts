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
  /** Needs a pair that actually moves — a stable pair will (correctly) rarely trigger. */
  symbol: str("MR_SYMBOL", "WETH:USDso"),
  /** Rolling window (mid samples) for RSI / Bollinger. Must exceed the periods below. */
  windowSize: num("MR_WINDOW_SIZE", 40),
  rsiPeriod: num("MR_RSI_PERIOD", 14),
  bbPeriod: num("MR_BB_PERIOD", 20),
  bbMult: num("MR_BB_MULT", 2),
  /** Enter long when RSI ≤ oversold AND price is at/below the lower Bollinger band. */
  rsiOversold: num("MR_RSI_OVERSOLD", 30),
  /** Exit when RSI recovers to ≥ this (mean reached) — plus the TP/SL bands below. */
  rsiExit: num("MR_RSI_EXIT", 52),
  notionalUsdso: num("MR_NOTIONAL_USDSO", 25),
  takeProfitPct: num("MR_TAKE_PROFIT_PCT", 0.012),
  stopLossPct: num("MR_STOP_LOSS_PCT", 0.02),
  /** Buffer past the touch so the IOC crosses and fills. */
  crossBps: num("MR_CROSS_BPS", 8),
  intervalMs: num("MR_INTERVAL_MS", 5_000),
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
