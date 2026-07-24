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
  symbol: str("SYMBOL", "WETH:USDso"),
  /** Main ensemble cycle interval, ms. */
  loopMs: num("MSA_LOOP_MS", 60_000),
  /** Default order notional in quote (USDso). */
  notionalUsdso: num("MSA_NOTIONAL_USDSO", 25),
  /** Buffer past the touch so IOC crosses and fills. */
  crossBps: num("MSA_CROSS_BPS", 8),
  takeProfitPct: num("MSA_TAKE_PROFIT_PCT", 0.012),
  stopLossPct: num("MSA_STOP_LOSS_PCT", 0.01),
  /** Max fraction of free balance risked on one trade. */
  maxRiskPercent: num("MSA_MAX_RISK_PERCENT", 0.15),
  /** Halt when cumulative PnL ≤ −this fraction of starting equity. */
  maxLossPercent: num("MSA_MAX_LOSS_PERCENT", 0.5),
  /** Rolling mid samples shared by classical analyzers. */
  windowSize: num("MSA_WINDOW_SIZE", 40),

  /** Momentum analyzer knobs. */
  momEntryMomentum: num("MSA_MOM_ENTRY", 0.008),
  momStrongMomentum: num("MSA_MOM_STRONG", 0.01),

  /** Mean-reversion analyzer knobs. */
  rsiPeriod: num("MSA_RSI_PERIOD", 14),
  bbPeriod: num("MSA_BB_PERIOD", 20),
  bbMult: num("MSA_BB_MULT", 2),
  rsiOversold: num("MSA_RSI_OVERSOLD", 30),
  rsiOverbought: num("MSA_RSI_OVERBOUGHT", 70),

  features: {
    momentum: bool("FEATURES_MOMENTUM", true),
    meanReversion: bool("FEATURES_MEAN_REVERSION", true),
    grid: bool("FEATURES_GRID", true),
    /** When false, fuse signals with majority vote (no LLM). */
    ai: bool("FEATURES_AI", false),
  },

  openai: {
    baseUrl: str("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
    apiKey: str("OPENAI_API_KEY", ""),
    model: str("OPENAI_MODEL", "gpt-4o-mini"),
    timeoutMs: num("OPENAI_TIMEOUT_MS", 45_000),
  },

  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
