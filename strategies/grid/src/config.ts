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
  symbol: str("GRID_SYMBOL", "SOMI:USDso"),
  /** Grid step: buy one step below the anchor, sell one step above each lot's entry. */
  stepBps: num("GRID_STEP_BPS", 30),
  /** Size of each grid lot, in quote (USDso) notional. */
  lotUsdso: num("GRID_LOT_USDSO", 15),
  /** Stop opening new longs once total base inventory exceeds this (USDso terms). */
  maxInventoryUsdso: num("GRID_MAX_INVENTORY_USDSO", 90),
  /** Skip a cycle if the book spread is wider than this. */
  maxSpreadBps: num("GRID_MAX_SPREAD_BPS", 60),
  /** Halt buying (offload-only) once session PnL drops below −this (USDso). */
  maxSessionLossUsdso: num("GRID_MAX_SESSION_LOSS_USDSO", 25),
  /** If a lot can't hit its sell trigger within this long, cut it and re-anchor (ms). 0 = off. */
  stuckTimeoutMs: num("GRID_STUCK_TIMEOUT_MS", 15 * 60_000),
  /** Poll interval, ms. */
  intervalMs: num("GRID_INTERVAL_MS", 8_000),
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
