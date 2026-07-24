/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export type SideSignal = "BUY" | "SELL" | "HOLD";
export type StrategyTag = "MOMENTUM" | "MEAN_REVERSION" | "GRID";

export interface SignalResult {
  strategy: StrategyTag;
  signal: SideSignal;
  confidence: number;
  reason: string;
  extras?: Record<string, number | string | boolean | undefined>;
}

export interface MarketSnapshot {
  symbol: string;
  mid: number;
  bestBid?: number;
  bestAsk?: number;
  baseInventory: number;
  quoteInventory: number;
  mids: number[];
}

export interface Decision {
  action: SideSignal;
  strategy: StrategyTag;
  price: number;
  amount: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reasoning: string;
  source: "llm" | "vote";
}

export interface Position {
  entry: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  strategy: StrategyTag;
  openedAt: number;
}
