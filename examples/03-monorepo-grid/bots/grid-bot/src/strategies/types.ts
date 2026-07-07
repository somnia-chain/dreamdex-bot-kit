/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type {
  AllowedSide,
  MarketInfo,
  OrderBook,
  OrderType,
  PrepareOrderRequest,
  Side,
  StrategyExecution,
  StrategyPersistentState,
} from '@trading/sdk';

export type { StrategyExecution, StrategyPersistentState };

export interface StrategySignal {
  side: Side;
  price: string;
  amount: string;
  reason: string;
  orderType?: OrderType;
}

export interface StrategyContext {
  market: MarketInfo;
  orderAmount: string;
  allowedSide: AllowedSide;
  buyBelowPrice: number;
  sellAbovePrice: number;
  rebalanceTradeSizeQuote?: number;
  rebalanceTargetBaseQuote?: number;
  rebalanceTargetToleranceQuote?: number;
  rebalanceMaxSpreadBps?: number;
  gridTradeSizeQuote?: number;
  gridStepBps?: number;
  gridMaxSpreadBps?: number;
  gridMaxLongQuote?: number;
}

export interface StrategyInventorySnapshot {
  baseBalance: number;
  quoteBalance: number;
}

export interface TradingStrategy {
  evaluate(orderBook: OrderBook, context: StrategyContext): StrategySignal | undefined;
  onExecution?(execution: StrategyExecution): void;
  getStatusLine?(): string;
  getStartupNotes?(): string[];
  getDecisionLine?(): string | undefined;
  getPersistentState?(): StrategyPersistentState;
  hydrate?(state: StrategyPersistentState): void;
  syncInventory?(snapshot: StrategyInventorySnapshot): void;
}

export function toPrepareOrderRequest(
  walletAddress: string,
  signal: StrategySignal,
  fundingSource: PrepareOrderRequest['fundingSource'],
  orderType: PrepareOrderRequest['orderType'],
  selfMatchingOption: PrepareOrderRequest['selfMatchingOption'],
): PrepareOrderRequest {
  return {
    walletAddress,
    type: 'limit',
    side: signal.side,
    amount: signal.amount,
    price: signal.price,
    fundingSource,
    orderType: signal.orderType ?? orderType,
    selfMatchingOption,
  };
}
