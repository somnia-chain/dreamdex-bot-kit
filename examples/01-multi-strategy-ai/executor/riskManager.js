/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { CONFIG } from '../config.js';
import { getState, haltBot, isCircuitBreakerHalted } from '../memory/index.js';
import { log, alert } from '../utils/logger.js';

export function checkCircuitBreaker() {
  if (isCircuitBreakerHalted()) {
    const state = getState();
    alert(`BOT HALTED — ${state.haltReason || 'Loss exceeded 50% of initial deposit'}`);
    return { halted: true, reason: state.haltReason };
  }

  const initialBalance = parseFloat(getState().initialBalance || CONFIG.INITIAL_DEPOSIT_USDSO);
  const cumulativePnl = parseFloat(getState().cumulativePnl || 0);
  const maxLoss = initialBalance * CONFIG.MAX_LOSS_PERCENT;

  if (cumulativePnl <= -maxLoss) {
    const reason = `Cumulative loss: ${cumulativePnl.toFixed(2)} USDso exceeds ${maxLoss.toFixed(2)} USDso (${CONFIG.MAX_LOSS_PERCENT * 100}% of ${initialBalance} USDso initial)`;
    haltBot(reason);
    alert(reason);
    return { halted: true, reason };
  }

  return { halted: false, cumulativePnl, maxLoss, initialBalance };
}

export function validateTrade(decision, vaultBalances) {
  if (circuitBreakerResult.halted) {
    return { approved: false, reason: 'CIRCUIT_BREAKER_HALTED' };
  }

  if (decision.action === 'HOLD') {
    return { approved: true, adjusted: decision, reason: 'HOLD_OK' };
  }

  const usdsoFree = parseFloat(vaultBalances.usdsoFree || 0);
  const wethFree = parseFloat(vaultBalances.wethFree || 0);

  if (decision.action === 'BUY') {
    if (usdsoFree <= 0) {
      return { approved: false, reason: 'No USDso balance for buying' };
    }

    const tradeValue = parseFloat(decision.price || 0) * parseFloat(decision.amount || 0);
    const maxTradeValue = usdsoFree * CONFIG.MAX_RISK_PERCENT;

    if (tradeValue > maxTradeValue) {
      const adjustedAmount = Math.floor(maxTradeValue / parseFloat(decision.price || 1));
      if (adjustedAmount < 0.001) {
        return { approved: false, reason: `Adjusted amount ${adjustedAmount} below minimum 0.001 WETH` };
      }
      decision.amount = adjustedAmount;
      log('warn', 'risk', `Position size adjusted from ${decision.amount} to ${adjustedAmount} WETH (risk limit)`);
    }

    if (parseFloat(decision.amount) < 0.001) {
      return { approved: false, reason: 'Trade amount below minimum 0.001 WETH' };
    }
  }

  if (decision.action === 'SELL') {
    if (wethFree <= 0) {
      return { approved: false, reason: 'No WETH balance for selling' };
    }

    const maxSellAmount = wethFree * CONFIG.MAX_RISK_PERCENT;
    if (parseFloat(decision.amount || 0) > maxSellAmount) {
      decision.amount = Math.floor(maxSellAmount);
      if (decision.amount < 0.001) {
        return { approved: false, reason: 'Adjusted sell amount below minimum' };
      }
      log('warn', 'risk', `Sell amount adjusted to ${decision.amount} WETH (risk limit)`);
    }
  }

  if (decision.stopLoss && parseFloat(decision.stopLoss) > 0) {
    if (decision.action === 'BUY' && parseFloat(decision.stopLoss) >= parseFloat(decision.price)) {
      return { approved: false, reason: 'Stop loss must be below entry price for BUY' };
    }
    if (decision.action === 'SELL' && parseFloat(decision.stopLoss) <= parseFloat(decision.price)) {
      return { approved: false, reason: 'Stop loss must be above entry price for SELL' };
    }
  }

  if (decision.takeProfit && parseFloat(decision.takeProfit) > 0) {
    if (decision.action === 'BUY' && parseFloat(decision.takeProfit) <= parseFloat(decision.price)) {
      return { approved: false, reason: 'Take profit must be above entry price for BUY' };
    }
    if (decision.action === 'SELL' && parseFloat(decision.takeProfit) >= parseFloat(decision.price)) {
      return { approved: false, reason: 'Take profit must be below entry price for SELL' };
    }
  }

  if (parseFloat(decision.confidence || 0) < 0.3) {
    log('warn', 'risk', `Low AI confidence (${decision.confidence}), still executing per AI decision`);
  }

  return { approved: true, adjusted: decision };
}

let circuitBreakerResult = { halted: false };

export function updateCircuitBreakerState() {
  circuitBreakerResult = checkCircuitBreaker();
  return circuitBreakerResult;
}
