/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { AllowedSide, OrderBook } from '@trading/sdk';
import { adjustPriceByBps, alignToStep } from '@trading/sdk';
import type {
  StrategyContext,
  StrategyExecution,
  StrategyInventorySnapshot,
  StrategyPersistentState,
  StrategySignal,
  TradingStrategy,
} from './types.js';

interface MarketMakerSettings {
  startingQuoteBalanceQuote: number;
  startingBaseBalance: number;
  quoteSizeQuote: number;
  targetBaseInventoryQuote: number;
  maxBaseInventoryQuote: number;
  minSpreadBps: number;
  targetHalfSpreadBps: number;
  inventorySkewBps: number;
  maxSessionLossQuote: number;
}

export class MarketMakerStrategy implements TradingStrategy {
  private estimatedQuoteBalanceQuote: number;
  private estimatedBaseBalance: number;
  private reservedBaseBalance = 0;
  private anchorPrice?: number;
  private lastMidPrice?: number;
  private initialEquityQuote?: number;
  private realizedVolumeQuote = 0;
  private tradeCount = 0;
  private lastDecisionLine = 'waiting for the first usable order book';

  constructor(private readonly settings: MarketMakerSettings) {
    this.estimatedQuoteBalanceQuote = settings.startingQuoteBalanceQuote;
    this.estimatedBaseBalance = settings.startingBaseBalance;
  }

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
    this.anchorPrice =
      this.anchorPrice === undefined
        ? midPrice
        : this.anchorPrice * 0.8 + midPrice * 0.2;

    if (this.initialEquityQuote === undefined) {
      this.initialEquityQuote = this.getCurrentEquityQuote(midPrice);
    }

    if (spreadBps < this.settings.minSpreadBps) {
      this.lastDecisionLine = `no trade: spread ${spreadBps.toFixed(1)}bps is below minimum ${this.settings.minSpreadBps}bps`;
      return undefined;
    }

    const equityQuote = this.getCurrentEquityQuote(midPrice);
    if (equityQuote <= this.initialEquityQuote - this.settings.maxSessionLossQuote) {
      this.lastDecisionLine = `no trade: estimated equity ${equityQuote.toFixed(2)} is below stop level ${(this.initialEquityQuote - this.settings.maxSessionLossQuote).toFixed(2)}`;
      return undefined;
    }

    const baseInventoryQuote = this.estimatedBaseBalance * midPrice;
    const inventoryGapQuote =
      this.settings.targetBaseInventoryQuote - baseInventoryQuote;
    const bootstrapTargetQuote = this.getBootstrapTargetQuote();
    const inventoryPressure = clamp(
      inventoryGapQuote / Math.max(this.settings.maxBaseInventoryQuote, 1),
      -1,
      1,
    );

    if (
      baseInventoryQuote < bootstrapTargetQuote &&
      this.canBuy(context.allowedSide, bestAskPrice, baseInventoryQuote, context)
    ) {
      const bootstrapSignal = this.buildSignal('buy', bestAsk.price, context, {
        triggerPrice: bestAskPrice,
        spreadBps,
        inventoryGapQuote,
      });

      if (bootstrapSignal) {
        this.lastDecisionLine = `signal buy: bootstrap tradable SOMI with USDso (current base value ${baseInventoryQuote.toFixed(2)} / target ${bootstrapTargetQuote.toFixed(2)} quote)`;
        return bootstrapSignal;
      }
    }

    const buyOffsetBps = Math.max(
      1,
      this.settings.targetHalfSpreadBps - inventoryPressure * this.settings.inventorySkewBps,
    );
    const sellOffsetBps = Math.max(
      1,
      this.settings.targetHalfSpreadBps + inventoryPressure * this.settings.inventorySkewBps,
    );

    const desiredBidPrice = Number(
      alignToStep(
        adjustPriceByBps(this.anchorPrice.toString(), buyOffsetBps, 'down'),
        context.market.tickSize,
      ),
    );
    const desiredAskPrice = Number(
      alignToStep(
        adjustPriceByBps(this.anchorPrice.toString(), sellOffsetBps, 'up'),
        context.market.tickSize,
      ),
    );

    const buySignal =
      this.canBuy(context.allowedSide, bestAskPrice, baseInventoryQuote, context) &&
      bestAskPrice <= desiredBidPrice
        ? this.buildSignal('buy', bestAsk.price, context, {
            triggerPrice: desiredBidPrice,
            spreadBps,
            inventoryGapQuote,
          })
        : undefined;

    const sellSignal =
      this.canSell(context.allowedSide, bestBidPrice, context) &&
      bestBidPrice >= desiredAskPrice
        ? this.buildSignal('sell', bestBid.price, context, {
            triggerPrice: desiredAskPrice,
            spreadBps,
            inventoryGapQuote,
          })
        : undefined;

    if (buySignal && sellSignal) {
      this.lastDecisionLine =
        inventoryGapQuote >= 0
          ? `signal buy: both sides available, inventory gap ${inventoryGapQuote.toFixed(2)} quote favors rebuilding base`
          : `signal sell: both sides available, inventory gap ${inventoryGapQuote.toFixed(2)} quote favors trimming base`;
      return inventoryGapQuote >= 0 ? buySignal : sellSignal;
    }

    const signal = buySignal ?? sellSignal;
    if (signal) {
      this.lastDecisionLine = `signal ${signal.side}: ${signal.reason}`;
      return signal;
    }

    this.lastDecisionLine = this.buildNoTradeReason({
      allowedSide: context.allowedSide,
      spreadBps,
      bestBidPrice,
      bestAskPrice,
      desiredBidPrice,
      desiredAskPrice,
      baseInventoryQuote,
      inventoryGapQuote,
      marketMinQuantity: Number(context.market.minQuantity),
    });
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
      this.estimatedBaseBalance += filledAmount;
      this.estimatedQuoteBalanceQuote = Math.max(0, this.estimatedQuoteBalanceQuote - notionalQuote);
    } else {
      this.estimatedBaseBalance = Math.max(0, this.estimatedBaseBalance - filledAmount);
      this.estimatedQuoteBalanceQuote += notionalQuote;
    }

    this.realizedVolumeQuote += notionalQuote;
    this.tradeCount += 1;
  }

  getStatusLine(): string {
    const mid = this.lastMidPrice;
    const equityQuote = mid ? this.getCurrentEquityQuote(mid) : this.estimatedQuoteBalanceQuote;
    const baseInventoryQuote = mid ? this.estimatedBaseBalance * mid : 0;

    return [
      `inventory base=${this.estimatedBaseBalance.toFixed(4)}`,
      `reservedBase=${this.reservedBaseBalance.toFixed(4)}`,
      `inventory quote=${this.estimatedQuoteBalanceQuote.toFixed(2)} USDso`,
      `baseValue=${baseInventoryQuote.toFixed(2)} USDso`,
      `equity=${equityQuote.toFixed(2)} USDso`,
      `volume=${this.realizedVolumeQuote.toFixed(2)} USDso`,
      `anchor=${this.anchorPrice?.toFixed(4) ?? 'n/a'}`,
    ].join(' | ');
  }

  getStartupNotes(): string[] {
    return [
      `Micro market maker starting with ${this.settings.startingQuoteBalanceQuote.toFixed(2)} quote and ${this.settings.startingBaseBalance.toFixed(4)} base.`,
      `Quote size ${this.settings.quoteSizeQuote.toFixed(2)} quote, target base inventory ${this.settings.targetBaseInventoryQuote.toFixed(2)} quote, max session loss ${this.settings.maxSessionLossQuote.toFixed(2)} quote.`,
      `Startup SOMI is reserved as gas first, so the bot will bootstrap by buying with USDso until tradable SOMI reaches about ${this.getBootstrapTargetQuote().toFixed(2)} quote of inventory.`,
    ];
  }

  getDecisionLine(): string {
    return this.lastDecisionLine;
  }

  syncInventory(snapshot: StrategyInventorySnapshot): void {
    if (this.reservedBaseBalance === 0 && snapshot.baseBalance > 0) {
      this.reservedBaseBalance = snapshot.baseBalance;
    }

    this.estimatedBaseBalance = Math.max(
      0,
      snapshot.baseBalance - this.reservedBaseBalance,
    );
    this.estimatedQuoteBalanceQuote = snapshot.quoteBalance;

    // Only (re)set the equity baseline if it hasn't been loaded from persisted
    // state. Resetting it on every sync would forget losses from prior sessions.
    if (this.initialEquityQuote === undefined && this.lastMidPrice) {
      this.initialEquityQuote = this.getCurrentEquityQuote(this.lastMidPrice);
    }

    this.lastDecisionLine = `inventory synced from live balances: tradableBase=${this.estimatedBaseBalance.toFixed(4)} reservedBase=${this.reservedBaseBalance.toFixed(4)} quote=${snapshot.quoteBalance.toFixed(2)}`;
  }

  getPersistentState(): StrategyPersistentState {
    const markedEquityQuote = this.lastMidPrice
      ? this.getCurrentEquityQuote(this.lastMidPrice)
      : this.estimatedQuoteBalanceQuote;

    return {
      name: 'marketMaker',
      data: {
        estimatedQuoteBalanceQuote: this.estimatedQuoteBalanceQuote,
        estimatedBaseBalance: this.estimatedBaseBalance,
        reservedBaseBalance: this.reservedBaseBalance,
        anchorPrice: this.anchorPrice,
        lastMidPrice: this.lastMidPrice,
        initialEquityQuote: this.initialEquityQuote,
        realizedVolumeQuote: this.realizedVolumeQuote,
        markedEquityQuote,
        tradeCount: this.tradeCount,
      },
    };
  }

  hydrate(state: StrategyPersistentState): void {
    if (state.name !== 'marketMaker') {
      return;
    }

    const data = state.data;
    this.estimatedQuoteBalanceQuote = readNumber(
      data.estimatedQuoteBalanceQuote,
      this.estimatedQuoteBalanceQuote,
    );
    this.estimatedBaseBalance = readNumber(
      data.estimatedBaseBalance,
      this.estimatedBaseBalance,
    );
    this.reservedBaseBalance = readNumber(
      data.reservedBaseBalance,
      this.reservedBaseBalance,
    );
    this.anchorPrice = readOptionalNumber(data.anchorPrice);
    this.lastMidPrice = readOptionalNumber(data.lastMidPrice);
    this.initialEquityQuote = readOptionalNumber(data.initialEquityQuote);
    this.realizedVolumeQuote = readNumber(
      data.realizedVolumeQuote,
      this.realizedVolumeQuote,
    );
    this.tradeCount = readNumber(data.tradeCount, this.tradeCount);
  }

  private buildSignal(
    side: 'buy' | 'sell',
    bookPrice: string,
    context: StrategyContext,
    details: {
      triggerPrice: number;
      spreadBps: number;
      inventoryGapQuote: number;
    },
  ): StrategySignal | undefined {
    const price = Number(bookPrice);
    const baseAmount =
      side === 'buy'
        ? this.getAffordableBuyBaseAmount(price)
        : this.getAvailableSellBaseAmount(price);
    const amount = alignToStep(baseAmount.toString(), context.market.lotSize);

    if (Number(amount) < Number(context.market.minQuantity)) {
      return undefined;
    }

    return {
      side,
      price: alignToStep(bookPrice, context.market.tickSize),
      amount,
      reason: `${side} ${amount} because book price ${bookPrice} crossed target ${details.triggerPrice.toFixed(4)} with spread ${details.spreadBps.toFixed(1)}bps and inventory gap ${details.inventoryGapQuote.toFixed(2)} quote`,
    };
  }

  private canBuy(
    allowedSide: AllowedSide,
    bestAskPrice: number,
    baseInventoryQuote: number,
    context: StrategyContext,
  ): boolean {
    if (allowedSide === 'sell') {
      return false;
    }

    if (
      this.getAffordableBuyBaseAmount(bestAskPrice) <
      Number(context.market.minQuantity)
    ) {
      return false;
    }

    if (baseInventoryQuote >= this.settings.maxBaseInventoryQuote) {
      return false;
    }

    return bestAskPrice > 0;
  }

  private canSell(
    allowedSide: AllowedSide,
    bestBidPrice: number,
    context: StrategyContext,
  ): boolean {
    if (allowedSide === 'buy') {
      return false;
    }

    if (bestBidPrice <= 0) {
      return false;
    }

    return (
      this.getAvailableSellBaseAmount(bestBidPrice) >=
      Number(context.market.minQuantity)
    );
  }

  private getBaseAmountForQuote(quoteAmount: number, price: number): number {
    if (price <= 0) return 0;
    return quoteAmount / price;
  }

  private getAffordableBuyBaseAmount(price: number): number {
    const quoteToUse = Math.min(
      this.settings.quoteSizeQuote,
      this.estimatedQuoteBalanceQuote,
    );
    return this.getBaseAmountForQuote(quoteToUse, price);
  }

  private getAvailableSellBaseAmount(price: number): number {
    const targetBaseAmount = this.getBaseAmountForQuote(
      this.settings.quoteSizeQuote,
      price,
    );
    return Math.min(targetBaseAmount, this.estimatedBaseBalance);
  }

  private getCurrentEquityQuote(midPrice: number): number {
    return this.estimatedQuoteBalanceQuote + this.estimatedBaseBalance * midPrice;
  }

  private getBootstrapTargetQuote(): number {
    return Math.min(
      this.settings.targetBaseInventoryQuote,
      Math.max(this.settings.quoteSizeQuote, 1),
    );
  }

  private buildNoTradeReason(input: {
    allowedSide: AllowedSide;
    spreadBps: number;
    bestBidPrice: number;
    bestAskPrice: number;
    desiredBidPrice: number;
    desiredAskPrice: number;
    baseInventoryQuote: number;
    inventoryGapQuote: number;
    marketMinQuantity: number;
  }): string {
    const reasons: string[] = [];

    if (
      input.allowedSide !== 'sell' &&
      this.getAffordableBuyBaseAmount(input.bestAskPrice) < input.marketMinQuantity
    ) {
      reasons.push(
        `quote balance ${this.estimatedQuoteBalanceQuote.toFixed(2)} is too small to buy the market minimum size`,
      );
    }

    if (input.allowedSide !== 'buy') {
      if (this.getAvailableSellBaseAmount(input.bestBidPrice) < input.marketMinQuantity) {
        reasons.push(
          `base balance ${this.estimatedBaseBalance.toFixed(4)} is too small to sell the market minimum size`,
        );
      }
    }

    if (input.baseInventoryQuote >= this.settings.maxBaseInventoryQuote) {
      reasons.push(
        `base inventory value ${input.baseInventoryQuote.toFixed(2)} reached max ${this.settings.maxBaseInventoryQuote.toFixed(2)}`,
      );
    }

    if (input.allowedSide !== 'sell' && input.bestAskPrice > input.desiredBidPrice) {
      reasons.push(
        `ask ${input.bestAskPrice.toFixed(4)} is above desired bid ${input.desiredBidPrice.toFixed(4)}`,
      );
    }

    if (input.allowedSide !== 'buy' && input.bestBidPrice < input.desiredAskPrice) {
      reasons.push(
        `bid ${input.bestBidPrice.toFixed(4)} is below desired ask ${input.desiredAskPrice.toFixed(4)}`,
      );
    }

    if (reasons.length === 0) {
      reasons.push(
        `spread ${input.spreadBps.toFixed(1)}bps, inventory gap ${input.inventoryGapQuote.toFixed(2)} quote, waiting for a cleaner edge`,
      );
    }

    return `no trade: ${reasons.join('; ')}`;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
