/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export type FundingSource = 'wallet' | 'vault';
export type OrderType = 'normalOrder' | 'fillOrKill' | 'immediateOrCancel' | 'postOnly';
export type SelfMatchingOption = 'cancelTaker' | 'cancelMaker';
export type Side = 'buy' | 'sell';
export type ExecutionMode = 'http' | 'contract';
export type AllowedSide = 'buy' | 'sell' | 'both';
export type StrategyMode = 'threshold' | 'marketMaker' | 'minuteRebalance' | 'grid';

export interface MarketInfo {
  symbol: string;
  contract: string;
  base: string;
  quote: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
  stopRegistry?: string;
}

export interface AuthNonceResponse {
  nonce: string;
}

export interface AuthLoginResponse {
  token: string;
  expiresAt: number;
}

export interface UnsignedApproval {
  token: string;
  amount: string;
}

export interface UnsignedTransactionPayload {
  to: string;
  data: string;
  value: string;
  chainId: string | number;
  gasLimit?: string | number;
  nonce?: string | number;
  approval?: UnsignedApproval;
}

export interface Order {
  id: string;
  status: string;
  createdAt: number;
  symbol: string;
  type: string;
  side: Side;
  price: string;
  amount: string;
  filled: string;
  remaining: string;
  executionPrice?: string;
  txHash?: string;
  walletAddress?: string;
}

export interface OrderBookLevel {
  price: string;
  quantity: string;
  timestamp?: number;
}

export interface OrderBook {
  symbol: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface PrepareOrderRequest {
  walletAddress: string;
  type: 'limit' | 'market';
  side: Side;
  amount: string;
  price?: string;
  fundingSource: FundingSource;
  orderType: OrderType;
  selfMatchingOption?: SelfMatchingOption;
  expiresAt?: number;
}

export interface OrderExecutionResult {
  mode: ExecutionMode;
  txHash: string;
  approvalTxHash?: string;
  simulatedOrderId?: string;
}

// Shared execution/persistence types (used by store and strategies)
export interface StrategyExecution {
  side: Side;
  requestedPrice: string;
  requestedAmount: string;
  filledAmount: string;
  executionPrice: string;
  status?: string;
}

export interface StrategyPersistentState {
  name: string;
  data: Record<string, unknown>;
}

export interface WebSocketOrderBookMessage {
  channel: 'orderbook';
  type: 'snapshot' | 'update' | 'subscribed' | 'unsubscribed' | 'error';
  symbol?: string;
  symbols?: string[];
  bids?: OrderBookLevel[];
  asks?: OrderBookLevel[];
  timestamp?: number;
  description?: string;
}
