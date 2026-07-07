/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import 'dotenv/config';
import { config } from './config.js';
import { GridStrategy } from './strategies/grid.js';
import { MarketMakerStrategy } from './strategies/market-maker.js';
import { MinuteRebalanceStrategy } from './strategies/minute-rebalance.js';
import { ThresholdStrategy } from './strategies/threshold.js';
import type { TradingStrategy } from './strategies/types.js';
import type { MarketInfo, OrderBook, StrategyExecution } from '@trading/sdk';

// ── Simulation parameters ────────────────────────────────────────────────────
const INITIAL_QUOTE  = Number(process.env.BT_INITIAL_QUOTE   ?? '50');
const INITIAL_BASE   = Number(process.env.BT_INITIAL_BASE    ?? '0');
const START_PRICE    = Number(process.env.BT_START_PRICE     ?? '0.175');
const TICKS          = Number(process.env.BT_TICKS           ?? '2000');
const SPREAD_BPS     = Number(process.env.BT_SPREAD_BPS      ?? '10');
const VOLATILITY     = Number(process.env.BT_VOLATILITY      ?? '0.003');
const TICK_MS        = Number(process.env.BT_TICK_MS         ?? '30000');
const SEED           = process.env.BT_SEED ? Number(process.env.BT_SEED) : Date.now();

// ── Seeded RNG (Mulberry32) — use BT_SEED for reproducible runs ──────────────
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Mock market ───────────────────────────────────────────────────────────────
const MARKET: MarketInfo = {
  symbol: config.symbol,
  contract: '0x0000000000000000000000000000000000000000',
  base:     '0x0000000000000000000000000000000000000001',
  quote:    '0x0000000000000000000000000000000000000002',
  baseDecimals: 18,
  quoteDecimals: 18,
  tickSize: '0.0001',
  lotSize:  '0.01',
  minQuantity: '0.01',
};

// ── Geometric Brownian Motion with light mean reversion ───────────────────────
function generatePrices(rng: () => number): number[] {
  const prices = [START_PRICE];
  for (let i = 1; i < TICKS; i++) {
    const shock      = VOLATILITY * (rng() - 0.5) * 2;
    const reversion  = 0.001 * (START_PRICE - prices[i - 1]);
    prices.push(Math.max(prices[i - 1] * (1 + shock) + reversion, 0.0001));
  }
  return prices;
}

function buildBook(price: number, ts: number): OrderBook {
  const half = price * (SPREAD_BPS / 10_000) / 2;
  return {
    symbol: MARKET.symbol,
    timestamp: ts,
    bids: [{ price: (price - half).toFixed(6), quantity: '10000000' }],
    asks: [{ price: (price + half).toFixed(6), quantity: '10000000' }],
  };
}

// ── Strategy factory ─────────────────────────────────────────────────────────
function createStrategy(): TradingStrategy {
  switch (config.strategy) {
    case 'grid':
      return new GridStrategy({
        tradeSizeQuote:       config.gridTradeSizeQuote,
        stepBps:              config.gridStepBps,
        maxSpreadBps:         config.gridMaxSpreadBps,
        maxLongQuote:         config.gridMaxLongQuote,
        maxSessionLossQuote:  config.gridMaxSessionLossQuote,
        stuckTimeoutMs:       config.gridStuckTimeoutMs,
      });
    case 'marketMaker':
      return new MarketMakerStrategy({
        startingQuoteBalanceQuote: config.mmStartingQuoteBalanceQuote,
        startingBaseBalance:       config.mmStartingBaseBalance,
        quoteSizeQuote:            config.mmQuoteSizeQuote,
        targetBaseInventoryQuote:  config.mmTargetBaseInventoryQuote,
        maxBaseInventoryQuote:     config.mmMaxBaseInventoryQuote,
        minSpreadBps:              config.mmMinSpreadBps,
        targetHalfSpreadBps:       config.mmTargetHalfSpreadBps,
        inventorySkewBps:          config.mmInventorySkewBps,
        maxSessionLossQuote:       config.mmMaxSessionLossQuote,
      });
    case 'minuteRebalance':
      return new MinuteRebalanceStrategy({
        tradeSizeQuote:        config.rebalanceTradeSizeQuote,
        targetBaseQuote:       config.rebalanceTargetBaseQuote,
        targetToleranceQuote:  config.rebalanceTargetToleranceQuote,
        maxSpreadBps:          config.rebalanceMaxSpreadBps,
      });
    default:
      return new ThresholdStrategy();
  }
}

// ── Sparkline (unicode block chars) ──────────────────────────────────────────
function sparkline(values: number[], width = 56): string {
  if (values.length === 0) return '';
  const BLOCKS = '▁▂▃▄▅▆▇█';
  const min    = Math.min(...values);
  const max    = Math.max(...values);
  const range  = max - min || 1;
  const step   = Math.max(1, Math.floor(values.length / width));
  const out: string[] = [];
  for (let i = 0; i < values.length && out.length < width; i += step) {
    const idx = Math.min(
      Math.round(((values[i] - min) / range) * (BLOCKS.length - 1)),
      BLOCKS.length - 1,
    );
    out.push(BLOCKS[idx]);
  }
  return out.join('');
}

function fmt(n: number, decimals = 2): string {
  const s = Math.abs(n).toFixed(decimals);
  return n >= 0 ? `+${s}` : `-${s}`;
}

// ── Main simulation ───────────────────────────────────────────────────────────
function main(): void {
  const rng     = makeRng(SEED);
  const prices  = generatePrices(rng);
  const strategy = createStrategy();

  strategy.syncInventory?.({ baseBalance: INITIAL_BASE, quoteBalance: INITIAL_QUOTE });

  let quote        = INITIAL_QUOTE;
  let base         = INITIAL_BASE;
  let totalVolume  = 0;
  let buys         = 0;
  let sells        = 0;
  let buyNotional  = 0;
  let lastActionTick = -Infinity;
  let peakEquity   = INITIAL_QUOTE + INITIAL_BASE * START_PRICE;
  let maxDrawdown  = 0;

  const equitySeries: number[] = [];

  const ctx = {
    market:                       MARKET,
    orderAmount:                  config.orderAmount,
    allowedSide:                  config.allowedSide,
    buyBelowPrice:                config.buyBelowPrice,
    sellAbovePrice:               config.sellAbovePrice,
    rebalanceTradeSizeQuote:      config.rebalanceTradeSizeQuote,
    rebalanceTargetBaseQuote:     config.rebalanceTargetBaseQuote,
    rebalanceTargetToleranceQuote:config.rebalanceTargetToleranceQuote,
    rebalanceMaxSpreadBps:        config.rebalanceMaxSpreadBps,
    gridTradeSizeQuote:           config.gridTradeSizeQuote,
    gridStepBps:                  config.gridStepBps,
    gridMaxSpreadBps:             config.gridMaxSpreadBps,
    gridMaxLongQuote:             config.gridMaxLongQuote,
  };

  const startTs = Date.now() - TICKS * TICK_MS;

  for (let tick = 0; tick < prices.length; tick++) {
    const price = prices[tick];
    const ts    = startTs + tick * TICK_MS;
    const book  = buildBook(price, ts);
    const simMs = tick * TICK_MS;

    const signal = strategy.evaluate(book, ctx);

    if (signal && simMs - lastActionTick >= config.cooldownMs) {
      const fillPrice = signal.side === 'buy'
        ? Number(book.asks[0].price)
        : Number(book.bids[0].price);
      const amount   = Number(signal.amount);
      const notional = amount * fillPrice;

      if (amount < Number(MARKET.minQuantity)) continue;

      if (signal.side === 'buy') {
        if (quote < notional) continue;
        quote        -= notional;
        base         += amount;
        buyNotional  += notional;
        buys++;
      } else {
        if (base < amount) continue;
        base   -= amount;
        quote  += notional;
        sells++;
      }

      totalVolume   += notional;
      lastActionTick = simMs;

      const execution: StrategyExecution = {
        side:            signal.side,
        requestedPrice:  signal.price,
        requestedAmount: signal.amount,
        filledAmount:    amount.toFixed(6),
        executionPrice:  fillPrice.toFixed(6),
        status:          'filled',
      };
      strategy.onExecution?.(execution);
    }

    const equity = quote + base * price;
    equitySeries.push(equity);
    if (equity > peakEquity)   peakEquity = equity;
    const dd = peakEquity - equity;
    if (dd > maxDrawdown)      maxDrawdown = dd;
  }

  // ── Results ────────────────────────────────────────────────────────────────
  const initialEquity  = INITIAL_QUOTE + INITIAL_BASE * prices[0];
  const finalEquity    = equitySeries.at(-1) ?? initialEquity;
  const pnl            = finalEquity - initialEquity;
  const pnlPct         = initialEquity > 0 ? (pnl / initialEquity) * 100 : 0;
  const ddPct          = peakEquity > 0 ? (maxDrawdown / peakEquity) * 100 : 0;
  const priceChangePct = ((prices.at(-1)! - prices[0]) / prices[0]) * 100;
  const roundTrips     = Math.min(buys, sells);
  const openBaseValue  = base * (prices.at(-1) ?? 0);

  const HR  = '═'.repeat(58);
  const DIV = '─'.repeat(58);

  console.log('');
  console.log(HR);
  console.log(`  BACKTEST  ·  ${config.strategy.toUpperCase()}  ·  ${config.symbol}`);
  console.log(HR);
  console.log('');
  console.log('  Configuration');
  console.log(`  ${DIV}`);
  console.log(`  Ticks         : ${TICKS.toLocaleString()}  (${(TICKS * TICK_MS / 3_600_000).toFixed(1)}h simulated)`);
  console.log(`  Seed          : ${SEED}`);
  console.log(`  Start price   : $${prices[0].toFixed(4)}   End: $${prices.at(-1)!.toFixed(4)}  (${fmt(priceChangePct)}%)`);
  console.log(`  Spread        : ${SPREAD_BPS} bps   Volatility: ${(VOLATILITY * 100).toFixed(2)}%/tick`);
  console.log(`  Capital       : $${INITIAL_QUOTE.toFixed(2)} quote  +  ${INITIAL_BASE.toFixed(4)} base`);
  console.log('');
  console.log('  Results');
  console.log(`  ${DIV}`);
  console.log(`  Final equity  : $${finalEquity.toFixed(2)}`);
  console.log(`  Session P&L   : $${fmt(pnl)}  (${fmt(pnlPct)}%)`);
  console.log(`  Max drawdown  : $${maxDrawdown.toFixed(2)}  (${fmt(-ddPct)}%)`);
  console.log(`  Open position : ${base.toFixed(4)} base  ≈  $${openBaseValue.toFixed(2)}`);
  console.log(`  Quote balance : $${quote.toFixed(2)}`);
  console.log('');
  console.log(`  Volume        : $${totalVolume.toFixed(2)}`);
  console.log(`  Trades        : ${buys + sells}  (${buys} buys  ${sells} sells  ${roundTrips} round-trips)`);
  console.log('');
  console.log('  Equity Curve');
  console.log(`  ${DIV}`);

  const spark = sparkline(equitySeries);
  const lo    = Math.min(...equitySeries).toFixed(2);
  const hi    = Math.max(...equitySeries).toFixed(2);
  const label = (s: string) => s.padStart(7);

  console.log(`  ${label('$' + hi)} ┤`);
  console.log(`           ${spark}`);
  console.log(`  ${label('$' + lo)} ┤`);
  console.log('');
  console.log(HR);
  console.log('');
}

main();
