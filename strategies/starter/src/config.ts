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
  /** Which market to trade. SOMI:USDso exists on both mainnet and testnet. */
  symbol: str("SYMBOL", "SOMI:USDso"),
  /** Total quoted spread in bps (split half above / half below mid). */
  spreadBps: num("STARTER_SPREAD_BPS", 10),
  /** Order size per side, in quote (USDso) notional. */
  sizeUsdso: num("STARTER_SIZE_USDSO", 20),
  /** How often to re-evaluate and requote, ms. */
  tickMs: num("STARTER_TICK_MS", 5_000),
  /** Resting order lifetime, ms. */
  expireMs: num("STARTER_EXPIRE_MS", 60 * 60_000),
  /** Log intended orders without sending any transaction. */
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
