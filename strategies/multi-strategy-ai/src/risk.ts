/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { Config } from "./config.js";
import type { Decision } from "./types.js";

export interface Balances {
  base: number;
  quote: number;
}

export interface RiskState {
  halted: boolean;
  haltReason?: string;
  cumulativePnl: number;
  startingEquity: number;
}

export function createRiskState(startingEquity: number): RiskState {
  return { halted: false, cumulativePnl: 0, startingEquity };
}

export function checkCircuitBreaker(state: RiskState, cfg: Config): RiskState {
  if (state.halted) return state;
  const maxLoss = state.startingEquity * cfg.maxLossPercent;
  if (state.startingEquity > 0 && state.cumulativePnl <= -maxLoss) {
    return {
      ...state,
      halted: true,
      haltReason: `Cumulative loss ${state.cumulativePnl.toFixed(2)} exceeds ${maxLoss.toFixed(2)} (${(cfg.maxLossPercent * 100).toFixed(0)}% of starting equity)`,
    };
  }
  return state;
}

export interface ValidationResult {
  approved: boolean;
  reason: string;
  adjusted?: Decision;
}

/** Hard gate after the brain: size to max risk %, reject bad SL/TP, require inventory. */
export function validateTrade(
  decision: Decision,
  balances: Balances,
  minQty: number,
  cfg: Config,
  state: RiskState,
): ValidationResult {
  if (state.halted) {
    return { approved: false, reason: state.haltReason ?? "CIRCUIT_BREAKER_HALTED" };
  }
  if (decision.action === "HOLD") {
    return { approved: true, reason: "HOLD_OK", adjusted: decision };
  }

  const next: Decision = { ...decision };

  if (next.action === "BUY") {
    if (balances.quote <= 0) {
      return { approved: false, reason: "No quote balance for buying" };
    }
    let tradeValue = next.price * next.amount;
    const maxTradeValue = balances.quote * cfg.maxRiskPercent;
    if (tradeValue > maxTradeValue && next.price > 0) {
      next.amount = maxTradeValue / next.price;
      tradeValue = next.price * next.amount;
    }
    if (next.amount < minQty) {
      return { approved: false, reason: `BUY amount ${next.amount.toFixed(6)} below minQty ${minQty}` };
    }
    if (next.stopLoss > 0 && next.stopLoss >= next.price) {
      return { approved: false, reason: "Stop loss must be below entry for BUY" };
    }
    if (next.takeProfit > 0 && next.takeProfit <= next.price) {
      return { approved: false, reason: "Take profit must be above entry for BUY" };
    }
  }

  if (next.action === "SELL") {
    if (balances.base <= 0) {
      return { approved: false, reason: "No base inventory for selling" };
    }
    const maxSell = balances.base * cfg.maxRiskPercent;
    // Spot SELL reduces inventory — cap to risk fraction of what we hold.
    next.amount = Math.min(next.amount, balances.base, maxSell);
    if (next.amount < minQty) {
      return { approved: false, reason: `SELL amount ${next.amount.toFixed(6)} below minQty ${minQty}` };
    }
    // SL/TP apply to open longs managed by the orchestrator; ignore on inventory sells.
  }

  return { approved: true, reason: "OK", adjusted: next };
}

export function recordRealizedPnl(state: RiskState, pnlUsdso: number): RiskState {
  return { ...state, cumulativePnl: state.cumulativePnl + pnlUsdso };
}
