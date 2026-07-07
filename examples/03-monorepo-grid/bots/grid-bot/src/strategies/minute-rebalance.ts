/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { AllowedSide, OrderBook } from '@trading/sdk';
import { alignToStep } from '@trading/sdk';
import type {
  StrategyContext,
  StrategyExecution,
  StrategyInventorySnapshot,
  StrategyPersistentState,
  StrategySignal,
  TradingStrategy,
} from './types.js';

interface MinuteRebalanceSettings {
  tradeSizeQuote: number;
  targetBaseQuote: number;
  targetToleranceQuote: number;
  maxSpreadBps: number;
}

export class MinuteRebalanceStrategy implements TradingStrategy {
  private tradableBaseBalance = 0;
  private reservedBaseBalance = 0;
  private quoteBalance = 0;
  private lastMidPrice?: number;
  private lastDecisionLine = 'waiting for the first usable order book';
  private tradeCount = 0;
  private tradedQuoteVolume = 0;

  constructor(private readonly settings: MinuteRebalanceSettings) {}

  evaluate(orderBook: OrderBook, context: StrategyContext): StrategySignal | undefined {
    const bestBid = orderBook.bids[0];
    const bestAsk = orderBook.asks[0];

    if (!bestBid || !bestAsk) {
      this.lastDecisionLine = 'no trade: best bid/ask not available yet';
      return undefined;
    }

    const bestBidPrice = Number(bestBid.price);
    const bestAskPrice = Number(bestAsk.price);
    const midPrice = (bestBidPrice + bestAskPrice) / 2;
    const spreadBps = ((bestAskPrice - bestBidPrice) / midPrice) * 10_000;

    if (!Number.isFinite(midPrice) || midPrice <= 0) {
      this.lastDecisionLine = 'no trade: mid price is not usable yet';
      return undefined;
    }

    this.lastMidPrice = midPrice;

    if (spreadBps > this.settings.maxSpreadBps) {
      this.lastDecisionLine = `no trade: spread ${spreadBps.toFixed(1)}bps is above max ${this.settings.maxSpreadBps}bps`;
      return undefined;
    }

    const baseValueQuote = this.tradableBaseBalance * midPrice;
    const lowerBound = this.settings.targetBaseQuote - this.settings.targetToleranceQuote;
    const upperBound = this.settings.targetBaseQuote + this.settings.targetToleranceQuote;

    if (
      baseValueQuote < lowerBound &&
      context.allowedSide !== 'sell'
    ) {
      const quoteGapToTarget = Math.max(0, this.settings.targetBaseQuote - baseValueQuote);
      const quoteToDeploy = Math.min(
        this.quoteBalance,
        this.settings.tradeSizeQuote,
        quoteGapToTarget,
      );
      const baseAmount = quoteToDeploy / bestAskPrice;
      return this.buildSignal(
        'buy',
        bestAsk.price,
        baseAmount,
        context,
        `bootstrap/rebalance buy: tradable base value ${baseValueQuote.toFixed(2)} quote is below target band ${lowerBound.toFixed(2)}-${upperBound.toFixed(2)}; deploying ${quoteToDeploy.toFixed(2)} quote toward target ${this.settings.targetBaseQuote.toFixed(2)}`,
      );
    }

    if (
      baseValueQuote > upperBound &&
      context.allowedSide !== 'buy'
    ) {
      const quoteGapToTarget = Math.max(0, baseValueQuote - this.settings.targetBaseQuote);
      const quoteToReduce = Math.min(
        this.settings.tradeSizeQuote,
        quoteGapToTarget,
      );
      const baseAmount = Math.min(
        this.tradableBaseBalance,
        quoteToReduce / bestBidPrice,
      );
      return this.buildSignal(
        'sell',
        bestBid.price,
        baseAmount,
        context,
        `rebalance sell: tradable base value ${baseValueQuote.toFixed(2)} quote is above target band ${lowerBound.toFixed(2)}-${upperBound.toFixed(2)}; trimming ${quoteToReduce.toFixed(2)} quote toward target ${this.settings.targetBaseQuote.toFixed(2)}`,
      );
    }

    this.lastDecisionLine = `no trade: tradable base value ${baseValueQuote.toFixed(2)} quote is inside target band ${lowerBound.toFixed(2)}-${upperBound.toFixed(2)} with spread ${spreadBps.toFixed(1)}bps`;
    return undefined;
  }

  onExecution(execution: StrategyExecution): void {
    const filledAmount = Number(execution.filledAmount);
    const executionPrice = Number(execution.executionPrice);
    if (!Number.isFinite(filledAmount) || !Number.isFinite(executionPrice)) {
      return;
    }
    if (filledAmount <= 0 || executionPrice <= 0) {
      return;
    }

    const notionalQuote = filledAmount * executionPrice;
    if (execution.side === 'buy') {
      this.tradableBaseBalance += filledAmount;
      this.quoteBalance = Math.max(0, this.quoteBalance - notionalQuote);
    } else {
      this.tradableBaseBalance = Math.max(0, this.tradableBaseBalance - filledAmount);
      this.quoteBalance += notionalQuote;
    }

    this.tradeCount += 1;
    this.tradedQuoteVolume += notionalQuote;
  }

  getStartupNotes(): string[] {
    return [
      `Minute rebalance uses up to ${this.settings.tradeSizeQuote.toFixed(2)} quote per trade and checks whether tradable SOMI stays around ${this.settings.targetBaseQuote.toFixed(2)} quote.`,
      `Startup SOMI is reserved for gas first. The bot only rebalances tradable SOMI and skips if spread exceeds ${this.settings.maxSpreadBps.toFixed(1)}bps.`,
    ];
  }

  getDecisionLine(): string {
    return this.lastDecisionLine;
  }

  getStatusLine(): string {
    const baseValueQuote = this.lastMidPrice
      ? this.tradableBaseBalance * this.lastMidPrice
      : 0;
    return [
      `tradableBase=${this.tradableBaseBalance.toFixed(4)}`,
      `reservedBase=${this.reservedBaseBalance.toFixed(4)}`,
      `quote=${this.quoteBalance.toFixed(2)} USDso`,
      `tradableBaseValue=${baseValueQuote.toFixed(2)} USDso`,
      `tradedVolume=${this.tradedQuoteVolume.toFixed(2)} USDso`,
      `trades=${this.tradeCount}`,
    ].join(' | ');
  }

  syncInventory(snapshot: StrategyInventorySnapshot): void {
    if (this.reservedBaseBalance === 0 && snapshot.baseBalance > 0) {
      this.reservedBaseBalance = snapshot.baseBalance;
    }

    this.tradableBaseBalance = Math.max(0, snapshot.baseBalance - this.reservedBaseBalance);
    this.quoteBalance = snapshot.quoteBalance;
    this.lastDecisionLine = `inventory synced from live balances: tradableBase=${this.tradableBaseBalance.toFixed(4)} reservedBase=${this.reservedBaseBalance.toFixed(4)} quote=${snapshot.quoteBalance.toFixed(2)}`;
  }

  getPersistentState(): StrategyPersistentState {
    return {
      name: 'minuteRebalance',
      data: {
        tradableBaseBalance: this.tradableBaseBalance,
        reservedBaseBalance: this.reservedBaseBalance,
        quoteBalance: this.quoteBalance,
        lastMidPrice: this.lastMidPrice,
        tradedQuoteVolume: this.tradedQuoteVolume,
        tradeCount: this.tradeCount,
      },
    };
  }

  hydrate(state: StrategyPersistentState): void {
    if (state.name !== 'minuteRebalance') {
      return;
    }

    const data = state.data;
    this.tradableBaseBalance = readNumber(data.tradableBaseBalance, this.tradableBaseBalance);
    this.reservedBaseBalance = readNumber(data.reservedBaseBalance, this.reservedBaseBalance);
    this.quoteBalance = readNumber(data.quoteBalance, this.quoteBalance);
    this.lastMidPrice = readOptionalNumber(data.lastMidPrice);
    this.tradedQuoteVolume = readNumber(data.tradedQuoteVolume, this.tradedQuoteVolume);
    this.tradeCount = readNumber(data.tradeCount, this.tradeCount);
  }

  private buildSignal(
    side: 'buy' | 'sell',
    bookPrice: string,
    baseAmount: number,
    context: StrategyContext,
    reason: string,
  ): StrategySignal | undefined {
    const amount = alignToStep(baseAmount.toString(), context.market.lotSize);
    if (Number(amount) < Number(context.market.minQuantity)) {
      this.lastDecisionLine = `no trade: computed ${side} amount ${amount} is below market minimum ${context.market.minQuantity}`;
      return undefined;
    }

    this.lastDecisionLine = `signal ${side}: ${reason}`;
    return {
      side,
      price: alignToStep(bookPrice, context.market.tickSize),
      amount,
      reason,
    };
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
