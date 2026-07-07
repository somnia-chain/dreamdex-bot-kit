/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { OrderBook } from '@trading/sdk';
import type { StrategyContext, StrategySignal, TradingStrategy } from './types.js';
import { alignToStep } from '@trading/sdk';

export class ThresholdStrategy implements TradingStrategy {
  private lastDecisionLine = 'waiting for the first usable order book';

  evaluate(orderBook: OrderBook, context: StrategyContext): StrategySignal | undefined {
    const bestBid = orderBook.bids[0];
    const bestAsk = orderBook.asks[0];
    const amount = alignToStep(context.orderAmount, context.market.lotSize);

    if (!bestBid || !bestAsk) {
      this.lastDecisionLine = 'no trade: best bid/ask not available yet';
      return undefined;
    }

    if (Number(amount) < Number(context.market.minQuantity)) {
      throw new Error(
        `Configured order amount ${amount} is below market minimum ${context.market.minQuantity}`,
      );
    }

    const bestBidPrice = Number(bestBid.price);
    const bestAskPrice = Number(bestAsk.price);

    if (
      (context.allowedSide === 'both' || context.allowedSide === 'buy') &&
      bestAskPrice <= context.buyBelowPrice
    ) {
      this.lastDecisionLine = `signal buy: ask ${bestAsk.price} <= threshold ${context.buyBelowPrice}`;
      return {
        side: 'buy',
        price: alignToStep(bestAsk.price, context.market.tickSize),
        amount,
        reason: `best ask ${bestAsk.price} <= buy threshold ${context.buyBelowPrice}`,
      };
    }

    if (
      (context.allowedSide === 'both' || context.allowedSide === 'sell') &&
      bestBidPrice >= context.sellAbovePrice
    ) {
      this.lastDecisionLine = `signal sell: bid ${bestBid.price} >= threshold ${context.sellAbovePrice}`;
      return {
        side: 'sell',
        price: alignToStep(bestBid.price, context.market.tickSize),
        amount,
        reason: `best bid ${bestBid.price} >= sell threshold ${context.sellAbovePrice}`,
      };
    }

    this.lastDecisionLine = `no trade: ask ${bestAsk.price} > buy threshold ${context.buyBelowPrice} and bid ${bestBid.price} < sell threshold ${context.sellAbovePrice}`;
    return undefined;
  }

  getDecisionLine(): string {
    return this.lastDecisionLine;
  }
}
