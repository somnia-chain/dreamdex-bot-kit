/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env ${key}="${raw}" is not a number`);
  }
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const ALLOCATIONS = {
  primaryMM: envNum("ALLOC_PRIMARY_MM", 0.7),
  secondaryMM: envNum("ALLOC_SECONDARY_MM", 0.2),
  momentum: envNum("ALLOC_MOMENTUM", 0.05),
  rebalancer: envNum("ALLOC_REBALANCER", 0.05),
} as const;

export const PAIRS = {
  primary: envStr("PRIMARY_PAIR", "USDC.e:USDso"),
  secondary: envStr("SECONDARY_PAIR", "SOMI:USDso"),
} as const;

export const SPREADS_BPS = {
  primary: envNum("PRIMARY_SPREAD_BPS", 1),
  secondary: envNum("SECONDARY_SPREAD_BPS", 10),
} as const;

export const ORDER = {
  notionalUsdso: envNum("ORDER_NOTIONAL_USDSO", 5),
  maxOpenOrdersPerSide: envNum("MAX_OPEN_ORDERS_PER_SIDE", 2),
  requoteTriggerBps: envNum("REQUOTE_TRIGGER_BPS", 2),
} as const;

export const RISK = {
  hardFloorUsdso: envNum("RISK_HARD_FLOOR_USDSO", 35),
  maxTxNotionalUsdso: envNum("MAX_TX_NOTIONAL_USDSO", 20),
} as const;

export const DAY7 = {
  liquidateAt: envStr("DAY7_LIQUIDATE_AT", "2026-06-01T08:00:00Z"),
} as const;

export const LLM = {
  enabled: envBool("OLLAMA_ENABLED", false),
  url: envStr("OLLAMA_URL", "http://localhost:11434"),
  model: envStr("OLLAMA_MODEL", "llama3.2"),
  decisionIntervalMin: envNum("LLM_DECISION_INTERVAL_MIN", 15),
} as const;

export const LOGGING = {
  level: envStr("LOG_LEVEL", "info"),
  csvTradeLog: envStr("CSV_TRADE_LOG", "data/trades.csv"),
} as const;

export const FEATURES = {
  primaryMM: envBool("ENABLE_PRIMARY_MM", true),
  secondaryMM: envBool("ENABLE_SECONDARY_MM", false),
  momentum: envBool("ENABLE_MOMENTUM", false),
  rebalancer: envBool("ENABLE_REBALANCER", false),
  day7Liquidator: envBool("ENABLE_DAY7_LIQUIDATOR", true),
  agentKitRegistration: envBool("ENABLE_AGENT_KIT_REGISTRATION", false),
} as const;

export const NS_PER_MS = 1_000_000n;
export const MS_PER_HOUR = 60n * 60n * 1000n;

export const ORDER_TYPE = {
  NormalOrder: 0,
  FillOrKill: 1,
  ImmediateOrCancel: 2,
  PostOnly: 3,
} as const;

export const SELF_MATCH = {
  CancelTaker: 0,
  CancelMaker: 1,
} as const;
