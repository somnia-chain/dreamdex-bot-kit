/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { alignToStep, adjustPriceByBps } from '@trading/sdk';
import type { AllowedSide, OrderBook } from '@trading/sdk';
import type {
  StrategyContext,
  StrategyExecution,
  StrategyInventorySnapshot,
  StrategyPersistentState,
  StrategySignal,
  TradingStrategy,
} from './types.js';

interface GridSettings {
  tradeSizeQuote: number;
  stepBps: number;
  maxSpreadBps: number;
  maxLongQuote: number;
  maxSessionLossQuote: number;
  // How long (ms) to wait before cutting a stuck long position and re-anchoring.
  stuckTimeoutMs: number;
}

// A single open long position created by one buy fill.
// Sells close lots FIFO — each sell is sized to the exact lot that was bought.
interface GridLot {
  price: number;
  amount: number;  // base units remaining to be sold
}

const EPSILON = 1e-10;

export class GridStrategy implements TradingStrategy {
  private lots: GridLot[] = [];
  private reservedBaseBalance = 0;
  private quoteBalance = 0;
  private referencePrice?: number;
  private lastMidPrice?: number;
  private initialEquityQuote?: number;
  private lastDecisionLine = 'waiting for the first usable order book';
  private tradedQuoteVolume = 0;
  private tradeCount = 0;
  // Timestamp (ms) when we first noticed lots are held but sell trigger hasn't been met.
  private stuckSince?: number;

  constructor(private readonly settings: GridSettings) {}

  evaluate(orderBook: OrderBook, context: StrategyContext): StrategySignal | undefined {
    const bestBid = orderBook.bids[0];
    const bestAsk = orderBook.asks[0];

    const bestBidPrice = bestBid ? Number(bestBid.price) : undefined;
    const bestAskPrice = bestAsk ? Number(bestAsk.price) : undefined;

    // Derive the best available mid price; fall back to cached reference if the
    // book is one-sided or empty so we can still quote in thin markets.
    const midPrice =
      bestBidPrice !== undefined && bestAskPrice !== undefined
        ? (bestBidPrice + bestAskPrice) / 2
        : bestAskPrice ?? bestBidPrice ?? this.referencePrice;

    if (!midPrice || !Number.isFinite(midPrice) || midPrice <= 0) {
      this.lastDecisionLine = 'no trade: no price data available yet';
      return undefined;
    }

    this.lastMidPrice = midPrice;
    if (!this.referencePrice) {
      this.referencePrice = midPrice;
    }

    if (this.initialEquityQuote === undefined) {
      this.initialEquityQuote = this.getCurrentEquityQuote(midPrice);
    }

    const stopTriggered =
      this.settings.maxSessionLossQuote > 0 &&
      this.getCurrentEquityQuote(midPrice) <=
        this.initialEquityQuote - this.settings.maxSessionLossQuote;
    if (stopTriggered) {
      this.lastDecisionLine = `stop-loss: offload-only mode (equity ${this.getCurrentEquityQuote(midPrice).toFixed(2)})`;
    }

    // Spread guard only applies when we have a full two-sided book.
    if (bestBidPrice !== undefined && bestAskPrice !== undefined) {
      const spreadBps = ((bestAskPrice - bestBidPrice) / midPrice) * 10_000;
      if (spreadBps > this.settings.maxSpreadBps) {
        this.lastDecisionLine = `no trade: spread ${spreadBps.toFixed(1)}bps is above max ${this.settings.maxSpreadBps}bps`;
        return undefined;
      }
    }

    const minQuantity = Number(context.market.minQuantity);

    // Remove sub-epsilon dust — lots far below any practical fill size.
    this.lots = this.lots.filter(l => l.amount > EPSILON);

    const tradableBaseBalance = this.getTradableBaseBalance();
    const tradableBaseValueQuote = tradableBaseBalance * midPrice;

    // Buy trigger: one step below reference price.
    const buyTriggerPrice = Number(
      alignToStep(
        adjustPriceByBps(this.referencePrice.toString(), this.settings.stepBps, 'down'),
        context.market.tickSize,
      ),
    );

    // Sell trigger: one step above the oldest lot's entry price.
    // Falls back to reference when no lots exist yet.
    const sellAnchor = this.lots[0]?.price ?? this.referencePrice;
    const sellTriggerPrice = Number(
      alignToStep(
        adjustPriceByBps(sellAnchor.toString(), this.settings.stepBps, 'up'),
        context.market.tickSize,
      ),
    );

    const noAsk = bestAskPrice === undefined;
    const noBid = bestBidPrice === undefined;
    // haveLots: total tradable must meet minQuantity, not just the front lot.
    // Fragmented lots (many small amounts) can still add up to a sellable position.
    const haveLots = tradableBaseBalance >= minQuantity;

    // Maker path — post a resting limit whenever the side we need to trade against
    // is absent (empty book OR one-sided book).
    //
    // No bid → can't sell IOC → post resting ask if holding base.
    if (noBid && haveLots && context.allowedSide !== 'buy') {
      const label = noAsk ? 'empty book' : 'no bid';
      const lotPrice = this.lots[0].price;
      const signal = this.buildSellSignal(
        sellTriggerPrice.toString(),
        context,
        `${label}: resting ask at ${sellTriggerPrice.toFixed(4)} (lot @${lotPrice.toFixed(4)})`,
        true,
      );
      if (signal) {
        this.lastDecisionLine = `signal sell: ${signal.reason}`;
        return signal;
      }
    }

    // No ask → can't buy IOC → post resting bid if fully in stable.
    if (noAsk && !haveLots && !stopTriggered && context.allowedSide !== 'sell') {
      const label = noBid ? 'empty book' : 'no ask';
      const signal = this.buildBuySignal(
        buyTriggerPrice.toString(),
        context,
        `${label}: resting bid at ${buyTriggerPrice.toFixed(4)} (ref ${this.referencePrice.toFixed(4)})`,
        true,
      );
      if (signal) {
        this.lastDecisionLine = `signal buy: ${signal.reason}`;
        return signal;
      }
    }

    // Both sides absent and maker signals didn't fire — nothing to do this tick.
    if (noAsk && noBid) {
      // fall through to no-trade reason
    } else {
      // Taker path — IOC only when the counterpart side is present and price has
      // crossed our trigger.
      if (!noAsk && !stopTriggered && this.shouldBuy(buyTriggerPrice, bestAskPrice, tradableBaseValueQuote, context.allowedSide, context)) {
        const reason = tradableBaseValueQuote < minQuantity * midPrice
          ? `bootstrap buy: posting bid at ${buyTriggerPrice.toFixed(4)} (ask ${bestAskPrice!.toFixed(4)})`
          : `grid buy: ask ${bestAskPrice!.toFixed(4)} crossed trigger ${buyTriggerPrice.toFixed(4)} (ref ${this.referencePrice.toFixed(4)})`;
        const signal = this.buildBuySignal(buyTriggerPrice.toString(), context, reason);
        if (signal) {
          this.lastDecisionLine = `signal buy: ${reason}`;
          return signal;
        }
      }

      if (this.shouldSell(sellTriggerPrice, bestBidPrice, context.allowedSide, minQuantity)) {
        this.stuckSince = undefined;
        const lotPrice = this.lots[0]?.price;
        const signal = this.buildSellSignal(
          sellTriggerPrice.toString(),
          context,
          `grid sell: bid ${bestBidPrice!.toFixed(4)} crossed target ${sellTriggerPrice.toFixed(4)} (lot @${lotPrice?.toFixed(4) ?? 'n/a'})`,
        );
        if (signal) {
          this.lastDecisionLine = `signal sell: ${signal.reason}`;
          return signal;
        }
      } else if (
        this.lots.length > 0 &&
        context.allowedSide !== 'buy' &&
        this.settings.stuckTimeoutMs > 0 &&
        bestBidPrice !== undefined
      ) {
        // Position is held but sell trigger not met — start/maintain stuck clock.
        const now = Date.now();
        if (this.stuckSince === undefined) {
          this.stuckSince = now;
        } else if (now - this.stuckSince >= this.settings.stuckTimeoutMs) {
          // Timeout expired: cut the position at best bid, re-anchor reference.
          const elapsed = Math.round((now - this.stuckSince) / 60_000);
          const signal = this.buildSellAllSignal(
            bestBidPrice.toString(),
            context,
            `stuck exit: ${elapsed}min at bid ${bestBidPrice.toFixed(4)}, re-anchoring from ${this.referencePrice.toFixed(4)}`,
          );
          if (signal) {
            this.referencePrice = bestBidPrice;
            this.stuckSince = undefined;
            this.lastDecisionLine = `signal sell-all: ${signal.reason}`;
            return signal;
          }
        }
      } else {
        // No lots held — clear the stuck clock.
        this.stuckSince = undefined;
      }
    }

    this.lastDecisionLine = this.buildNoTradeReason({
      bestBidPrice,
      bestAskPrice,
      buyTriggerPrice,
      sellTriggerPrice,
      midPrice,
      tradableBaseBalance,
      tradableBaseValueQuote,
      allowedSide: context.allowedSide,
      minQuantity,
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
      this.quoteBalance = Math.max(0, this.quoteBalance - notionalQuote);
      this.lots.push({ price: executionPrice, amount: filledAmount });
    } else {
      this.quoteBalance += notionalQuote;
      let toConsume = filledAmount;
      while (toConsume > EPSILON && this.lots.length > 0) {
        const lot = this.lots[0];
        if (lot.amount <= toConsume + EPSILON) {
          toConsume -= lot.amount;
          this.lots.shift();
        } else {
          lot.amount -= toConsume;
          toConsume = 0;
        }
      }
    }

    this.referencePrice = executionPrice;
    this.tradedQuoteVolume += notionalQuote;
    this.tradeCount += 1;
  }

  getStartupNotes(): string[] {
    const stopNote = this.settings.maxSessionLossQuote > 0
      ? `Stop-loss halts trading if portfolio value drops more than ${this.settings.maxSessionLossQuote.toFixed(2)} quote from session start.`
      : 'No session stop-loss configured (DREAMDEX_GRID_MAX_SESSION_LOSS_QUOTE=0).';
    return [
      `Grid bot uses ${this.settings.tradeSizeQuote.toFixed(2)} quote clips with a ${this.settings.stepBps.toFixed(1)}bps step. Each sell closes the exact lot bought (FIFO).`,
      `Orders are posted at the trigger price (maker style). Set DREAMDEX_ORDER_TYPE=postOnly for resting limit orders, or keep immediateOrCancel to fill only when the market is already there.`,
      `Startup SOMI is reserved for gas; the grid bootstraps by buying with USDso and sells only tradable SOMI.`,
      `Grid buys are capped once tradable SOMI reaches about ${this.settings.maxLongQuote.toFixed(2)} quote of inventory.`,
      stopNote,
    ];
  }

  getDecisionLine(): string {
    return this.lastDecisionLine;
  }

  getStatusLine(): string {
    const tradableBaseBalance = this.getTradableBaseBalance();
    const baseValueQuote = this.lastMidPrice ? tradableBaseBalance * this.lastMidPrice : 0;
    const equityQuote = this.lastMidPrice
      ? this.getCurrentEquityQuote(this.lastMidPrice)
      : this.quoteBalance;
    const lotSummary = this.lots.length > 0
      ? `${this.lots.length} lot(s) oldest@${this.lots[0].price.toFixed(4)}`
      : 'no lots';

    return [
      `tradableBase=${tradableBaseBalance.toFixed(4)}`,
      `reservedBase=${this.reservedBaseBalance.toFixed(4)}`,
      `quote=${this.quoteBalance.toFixed(2)} USDso`,
      `tradableBaseValue=${baseValueQuote.toFixed(2)} USDso`,
      `equity=${equityQuote.toFixed(2)} USDso`,
      `reference=${this.referencePrice?.toFixed(4) ?? 'n/a'}`,
      lotSummary,
      `gridVolume=${this.tradedQuoteVolume.toFixed(2)} USDso`,
      `trades=${this.tradeCount}`,
    ].join(' | ');
  }

  syncInventory(snapshot: StrategyInventorySnapshot): void {
    if (this.reservedBaseBalance === 0 && snapshot.baseBalance > 0) {
      this.reservedBaseBalance = snapshot.baseBalance;
    }

    const liveTradable = Math.max(0, snapshot.baseBalance - this.reservedBaseBalance);
    this.quoteBalance = snapshot.quoteBalance;

    const lotTotal = this.lots.reduce((s, l) => s + l.amount, 0);

    if (lotTotal === 0 && liveTradable > 0 && this.referencePrice) {
      this.lots.push({ price: this.referencePrice, amount: liveTradable });
    } else if (lotTotal > liveTradable + EPSILON) {
      if (liveTradable < EPSILON) {
        this.lots = [];
      } else {
        const scale = liveTradable / lotTotal;
        this.lots = this.lots
          .map((l) => ({ ...l, amount: l.amount * scale }))
          .filter((l) => l.amount > EPSILON);
      }
    } else if (liveTradable > lotTotal + EPSILON && this.referencePrice) {
      // Wallet holds more tradable base than lots track (e.g. after a partial stuck
      // exit or an out-of-band fill). Add a synthetic lot for the untracked amount.
      this.lots.push({ price: this.referencePrice, amount: liveTradable - lotTotal });
    }

    if (this.initialEquityQuote === undefined && this.lastMidPrice) {
      this.initialEquityQuote = this.getCurrentEquityQuote(this.lastMidPrice);
    }

    this.lastDecisionLine = `inventory synced: tradable=${liveTradable.toFixed(4)} reserved=${this.reservedBaseBalance.toFixed(4)} quote=${snapshot.quoteBalance.toFixed(2)} lots=${this.lots.length}`;
  }

  getPersistentState(): StrategyPersistentState {
    const markedEquityQuote = this.lastMidPrice
      ? this.getCurrentEquityQuote(this.lastMidPrice)
      : this.quoteBalance;

    return {
      name: 'grid',
      data: {
        lots: this.lots,
        reservedBaseBalance: this.reservedBaseBalance,
        quoteBalance: this.quoteBalance,
        referencePrice: this.referencePrice,
        lastMidPrice: this.lastMidPrice,
        initialEquityQuote: this.initialEquityQuote,
        markedEquityQuote,
        tradedQuoteVolume: this.tradedQuoteVolume,
        tradeCount: this.tradeCount,
        stuckSince: this.stuckSince,
      },
    };
  }

  hydrate(state: StrategyPersistentState): void {
    if (state.name !== 'grid') {
      return;
    }

    const data = state.data;
    this.lots = readLots(data.lots);
    this.reservedBaseBalance = readNumber(data.reservedBaseBalance, this.reservedBaseBalance);
    this.quoteBalance = readNumber(data.quoteBalance, this.quoteBalance);
    this.referencePrice = readOptionalNumber(data.referencePrice);
    this.lastMidPrice = readOptionalNumber(data.lastMidPrice);
    this.initialEquityQuote = readOptionalNumber(data.initialEquityQuote);
    this.tradedQuoteVolume = readNumber(data.tradedQuoteVolume, this.tradedQuoteVolume);
    this.tradeCount = readNumber(data.tradeCount, this.tradeCount);
    this.stuckSince = readOptionalNumber(data.stuckSince);
  }

  private getTradableBaseBalance(): number {
    return this.lots.reduce((s, l) => s + l.amount, 0);
  }

  private shouldBuy(
    buyTriggerPrice: number,
    bestAskPrice: number | undefined,
    tradableBaseValueQuote: number,
    allowedSide: AllowedSide,
    context: StrategyContext,
  ): boolean {
    if (allowedSide === 'sell') return false;
    if (tradableBaseValueQuote >= this.settings.maxLongQuote) return false;
    if (this.getAffordableBuyBaseAmount(buyTriggerPrice) < Number(context.market.minQuantity)) return false;
    return bestAskPrice !== undefined && bestAskPrice <= buyTriggerPrice;
  }

  private shouldSell(
    sellTriggerPrice: number,
    bestBidPrice: number | undefined,
    allowedSide: AllowedSide,
    minQuantity: number,
  ): boolean {
    if (allowedSide === 'buy') return false;
    if (this.getTradableBaseBalance() < minQuantity) return false;
    return bestBidPrice !== undefined && bestBidPrice >= sellTriggerPrice;
  }

  private buildBuySignal(
    price: string,
    context: StrategyContext,
    reason: string,
    passive = false,
  ): StrategySignal | undefined {
    const priceNum = Number(price);
    if (priceNum <= 0) return undefined;
    const amount = alignToStep(
      this.getAffordableBuyBaseAmount(priceNum).toString(),
      context.market.lotSize,
    );
    if (Number(amount) < Number(context.market.minQuantity)) return undefined;

    return {
      side: 'buy',
      price: alignToStep(price, context.market.tickSize),
      amount,
      reason,
      orderType: passive ? 'normalOrder' : undefined,
    };
  }

  private buildSellSignal(
    price: string,
    context: StrategyContext,
    reason: string,
    passive = false,
  ): StrategySignal | undefined {
    const priceNum = Number(price);
    if (priceNum <= 0 || this.lots.length === 0) return undefined;

    const tradable = this.getTradableBaseBalance();
    // If the front lot is below minQuantity (fragmented), sell the full tradable
    // balance so fragmented lots don't permanently block the sell path.
    const frontLot = this.lots[0].amount;
    const rawAmount = frontLot >= Number(context.market.minQuantity)
      ? Math.min(frontLot, tradable)
      : tradable;
    const amount = alignToStep(rawAmount.toString(), context.market.lotSize);
    if (Number(amount) < Number(context.market.minQuantity)) return undefined;

    return {
      side: 'sell',
      price: alignToStep(price, context.market.tickSize),
      amount,
      reason,
      orderType: passive ? 'normalOrder' : undefined,
    };
  }

  private buildSellAllSignal(
    price: string,
    context: StrategyContext,
    reason: string,
  ): StrategySignal | undefined {
    const priceNum = Number(price);
    if (priceNum <= 0 || this.lots.length === 0) return undefined;
    const totalAmount = this.getTradableBaseBalance();
    const amount = alignToStep(totalAmount.toString(), context.market.lotSize);
    if (Number(amount) < Number(context.market.minQuantity)) return undefined;
    return { side: 'sell', price: alignToStep(price, context.market.tickSize), amount, reason };
  }

  private getAffordableBuyBaseAmount(price: number): number {
    if (price <= 0) return 0;
    const quoteToUse = Math.min(this.settings.tradeSizeQuote, this.quoteBalance);
    return quoteToUse / price;
  }

  private getCurrentEquityQuote(midPrice: number): number {
    return this.quoteBalance + this.getTradableBaseBalance() * midPrice;
  }

  private buildNoTradeReason(input: {
    bestBidPrice: number | undefined;
    bestAskPrice: number | undefined;
    buyTriggerPrice: number;
    sellTriggerPrice: number;
    midPrice: number;
    tradableBaseBalance: number;
    tradableBaseValueQuote: number;
    allowedSide: AllowedSide;
    minQuantity: number;
  }): string {
    const reasons: string[] = [];

    if (
      input.allowedSide !== 'sell' &&
      this.getAffordableBuyBaseAmount(input.buyTriggerPrice) < input.minQuantity
    ) {
      reasons.push(`quote balance ${this.quoteBalance.toFixed(2)} is too small for a minimum-size buy`);
    }

    if (input.allowedSide !== 'buy' && this.lots.length === 0) {
      reasons.push('no open lots to sell');
    } else if (input.allowedSide !== 'buy' && this.lots[0].amount < input.minQuantity) {
      reasons.push(`oldest lot ${this.lots[0].amount.toFixed(4)} is below minimum sell size`);
    }

    if (input.tradableBaseValueQuote >= this.settings.maxLongQuote) {
      reasons.push(`tradable base value ${input.tradableBaseValueQuote.toFixed(2)} reached max long ${this.settings.maxLongQuote.toFixed(2)}`);
    }

    if (
      input.allowedSide !== 'sell' &&
      input.bestAskPrice !== undefined &&
      input.bestAskPrice > input.buyTriggerPrice
    ) {
      reasons.push(`ask ${input.bestAskPrice.toFixed(4)} is above buy trigger ${input.buyTriggerPrice.toFixed(4)}`);
    }

    if (
      input.allowedSide !== 'buy' &&
      input.bestBidPrice !== undefined &&
      input.bestBidPrice < input.sellTriggerPrice
    ) {
      reasons.push(`bid ${input.bestBidPrice.toFixed(4)} is below sell trigger ${input.sellTriggerPrice.toFixed(4)}`);
    }

    if (reasons.length === 0) {
      reasons.push(`waiting for the next grid level`);
    }

    return `no trade: ${reasons.join('; ')}`;
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readLots(value: unknown): GridLot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is GridLot =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as GridLot).price === 'number' &&
      typeof (item as GridLot).amount === 'number' &&
      Number.isFinite((item as GridLot).price) &&
      Number.isFinite((item as GridLot).amount) &&
      (item as GridLot).amount > 0,
  );
}
