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
  /** Which market to quote. USDC.e:USDso (a stable/stable pair) is the low-risk default. */
  symbol: str("MM_SYMBOL", "USDC.e:USDso"),
  /** Half-spread each side of mid, in bps. Total quoted spread = 2× this. */
  halfSpreadBps: num("MM_HALF_SPREAD_BPS", 5),
  /** Order size, in quote (USDso) notional per side. */
  notionalUsdso: num("MM_NOTIONAL_USDSO", 20),
  /** Target base inventory in quote terms; quotes skew to pull inventory back here. */
  targetInventoryUsdso: num("MM_TARGET_INVENTORY_USDSO", 0),
  /** How hard to skew per unit of inventory imbalance, in bps per 1× notional. */
  inventorySkewBps: num("MM_INVENTORY_SKEW_BPS", 4),
  /** Only requote once mid has moved this many bps (saves gas leaving good quotes). */
  requoteTriggerBps: num("MM_REQUOTE_TRIGGER_BPS", 3),
  /** Don't quote if the book's own spread is wider than this (thin/dislocated book). */
  maxBookSpreadBps: num("MM_MAX_BOOK_SPREAD_BPS", 50),
  /** Minimum wall-time between requotes, ms. */
  requoteCooldownMs: num("MM_REQUOTE_COOLDOWN_MS", 2_000),
  /** Fallback poll interval if the WS feed is quiet, ms. */
  refreshIntervalMs: num("MM_REFRESH_INTERVAL_MS", 5_000),
  /** Resting order lifetime, ms (rebuilt on each requote anyway). */
  expireMs: num("MM_EXPIRE_MS", 60 * 60_000),
  /** Log intended actions without sending any transaction. */
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
