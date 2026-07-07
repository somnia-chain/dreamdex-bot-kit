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
  symbol: str("MOM_SYMBOL", "WETH:USDso"),
  /** Rolling window length (number of mid samples) used to measure momentum. */
  windowSize: num("MOM_WINDOW_SIZE", 20),
  /** Enter long when window momentum exceeds this (fraction, e.g. 0.008 = 0.8%). */
  entryMomentum: num("MOM_ENTRY_MOMENTUM", 0.008),
  /** Exit when momentum falls back below this (fraction). */
  exitMomentum: num("MOM_EXIT_MOMENTUM", 0.0),
  /** Position size in quote (USDso) notional. */
  notionalUsdso: num("MOM_NOTIONAL_USDSO", 25),
  /** Take profit / stop loss on the open position, as fractions of entry. */
  takeProfitPct: num("MOM_TAKE_PROFIT_PCT", 0.01),
  stopLossPct: num("MOM_STOP_LOSS_PCT", 0.006),
  /** Cross buffer (bps) added to the touch price so the IOC actually fills. */
  crossBps: num("MOM_CROSS_BPS", 8),
  /** Poll interval (also the sample cadence for the window), ms. */
  intervalMs: num("MOM_INTERVAL_MS", 5_000),
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
