/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Wallet, formatUnits } from 'ethers';
import { config } from './config.js';
import { MetricsServer } from './metrics-server.js';
import { DreamDexHttpClient } from '@trading/sdk';
import { DreamDexWsClient } from '@trading/sdk';
import { ContractOrderExecutor } from '@trading/sdk';
import { HttpOrderExecutor } from '@trading/sdk';
import { TransactionExecutor } from '@trading/sdk';
import type { OrderExecutor } from '@trading/sdk';
import { BotStateStore } from '@trading/sdk';
import { VaultManager } from '@trading/sdk';
import type {
  OrderBook,
  OrderBookLevel,
  WebSocketOrderBookMessage,
} from '@trading/sdk';
import { GridStrategy } from './strategies/grid.js';
import { MarketMakerStrategy } from './strategies/market-maker.js';
import { MinuteRebalanceStrategy } from './strategies/minute-rebalance.js';
import { ThresholdStrategy } from './strategies/threshold.js';
import type { StrategyExecution, TradingStrategy } from './strategies/types.js';
import { toPrepareOrderRequest } from './strategies/types.js';

function printStartupWarnings(): void {
  if (config.strategy === 'grid') {
    console.log(
      '[info] Grid mode trades around a reference price: it buys lower grid steps with USDso and sells higher grid steps using only tradable SOMI, while keeping startup SOMI reserved for gas.',
    );
    return;
  }

  if (config.strategy === 'minuteRebalance') {
    console.log(
      '[info] Minute rebalance mode aims for regular small inventory rebalancing around a tiny SOMI target. It keeps startup SOMI reserved for gas and only trades when spread is acceptable.',
    );
    return;
  }

  if (config.strategy === 'marketMaker') {
    if (config.allowedSide !== 'both') {
      console.warn(
        `[warn] Market-maker mode works best with DREAMDEX_ALLOWED_SIDE=both. Current value ${config.allowedSide} will reduce two-sided quoting.`,
      );
    }

    if (config.executionMode !== 'contract') {
      console.warn(
        `[warn] Market-maker mode is currently most reliable with DREAMDEX_EXECUTION_MODE=contract. HTTP mode can still work, but fills are less predictable on Shannon.`,
      );
    }

    console.log(
      '[info] Market-maker mode is autonomous: it derives its buy/sell trigger levels from the live spread, moving anchor price, and current inventory.',
    );
    return;
  }

  if (config.allowedSide === 'sell' && config.buyBelowPrice > 0) {
    console.warn(
      `[warn] SELL-only mode is enabled, so DREAMDEX_BUY_BELOW_PRICE=${config.buyBelowPrice} will be ignored.`,
    );
  }

  if (config.allowedSide === 'buy' && config.sellAbovePrice > 0) {
    console.warn(
      `[warn] BUY-only mode is enabled, so DREAMDEX_SELL_ABOVE_PRICE=${config.sellAbovePrice} will be ignored.`,
    );
  }

  if (config.allowedSide !== 'sell' && config.buyBelowPrice > 100) {
    console.warn(
      `[warn] BUY threshold ${config.buyBelowPrice} is very high for current DreamDEX spot markets and may trigger near-constant buys.`,
    );
  }

  if (config.symbol === 'SOMI:USDso' && config.fundingSource === 'wallet') {
    if (config.allowedSide === 'sell' || config.allowedSide === 'both') {
      console.log(
        '[info] Native SOMI wallet sells use msg.value directly and do not require ERC-20 approval.',
      );
    }

    if (config.allowedSide === 'buy' || config.allowedSide === 'both') {
      console.log(
        '[info] Native SOMI wallet buys spend USDso, so the bot may still need USDso approval before submitting the order.',
      );
    }
  }

  if (
    config.executionMode === 'contract' &&
    config.fundingSource === 'wallet' &&
    config.orderType !== 'immediateOrCancel' &&
    config.orderType !== 'fillOrKill'
  ) {
    throw new Error(
      'Contract wallet mode only supports DREAMDEX_ORDER_TYPE=immediateOrCancel or fillOrKill.',
    );
  }
}

async function main(): Promise<void> {
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl,
    wallet,
    config.chainId,
    config.siweDomain,
    config.siweUri,
  );
  const executor = new TransactionExecutor(
    config.rpcUrl,
    config.privateKey,
    config.chainId,
  );
  const ws = new DreamDexWsClient(config.wsUrl);
  const strategy: TradingStrategy =
    config.strategy === 'marketMaker'
      ? new MarketMakerStrategy({
          startingQuoteBalanceQuote: config.mmStartingQuoteBalanceQuote,
          startingBaseBalance: config.mmStartingBaseBalance,
          quoteSizeQuote: config.mmQuoteSizeQuote,
          targetBaseInventoryQuote: config.mmTargetBaseInventoryQuote,
          maxBaseInventoryQuote: config.mmMaxBaseInventoryQuote,
          minSpreadBps: config.mmMinSpreadBps,
          targetHalfSpreadBps: config.mmTargetHalfSpreadBps,
          inventorySkewBps: config.mmInventorySkewBps,
          maxSessionLossQuote: config.mmMaxSessionLossQuote,
        })
      : config.strategy === 'grid'
        ? new GridStrategy({
            tradeSizeQuote: config.gridTradeSizeQuote,
            stepBps: config.gridStepBps,
            maxSpreadBps: config.gridMaxSpreadBps,
            maxLongQuote: config.gridMaxLongQuote,
            maxSessionLossQuote: config.gridMaxSessionLossQuote,
            stuckTimeoutMs: config.gridStuckTimeoutMs,
          })
        : config.strategy === 'minuteRebalance'
          ? new MinuteRebalanceStrategy({
              tradeSizeQuote: config.rebalanceTradeSizeQuote,
              targetBaseQuote: config.rebalanceTargetBaseQuote,
              targetToleranceQuote: config.rebalanceTargetToleranceQuote,
              maxSpreadBps: config.rebalanceMaxSpreadBps,
            })
          : new ThresholdStrategy();
  const orderExecutor: OrderExecutor =
    config.executionMode === 'contract'
      ? new ContractOrderExecutor(
          executor,
          config.expireSeconds,
          config.chainId,
        )
      : new HttpOrderExecutor(http, executor);
  const stateStore = await BotStateStore.open(config.persistenceDir, {
    symbol: config.symbol,
    strategy: config.strategy,
    executionMode: config.executionMode,
  });

  const markets = await http.listMarkets();
  const market = markets.find((item) => item.symbol === config.symbol);

  if (!market) {
    throw new Error(`Market not found: ${config.symbol}`);
  }

  await executor.assertConnectedChain();
  const previousSnapshot = stateStore.getSnapshot();
  const persistedStrategyState = previousSnapshot.strategyState;
  if (persistedStrategyState) {
    strategy.hydrate?.(persistedStrategyState);
  }

  const liveInventory = await getLiveInventory(executor, market);
  strategy.syncInventory?.(liveInventory);

  const metrics =
    config.metricsPort > 0 ? new MetricsServer(config.metricsPort) : undefined;
  metrics?.start();
  metrics?.update({
    symbol: market.symbol,
    strategy: config.strategy,
    executionMode: config.executionMode,
    baseBalance: liveInventory.baseBalance,
    quoteBalance: liveInventory.quoteBalance,
  });

  const vaultManager = config.autoVault
    ? new VaultManager(executor, market.contract)
    : undefined;

  if (vaultManager) {
    console.log(
      '[vault] Auto-vault enabled: depositing wallet funds to vault...',
    );
    await vaultManager.depositAll(market, config.vaultGasReserve);
  }

  console.log(`Loaded market ${market.symbol}`);
  console.log(
    `Tick size=${market.tickSize}, lot size=${market.lotSize}, min qty=${market.minQuantity}`,
  );
  console.log(`Dry run=${config.dryRun}`);
  console.log(`Strategy=${config.strategy}`);
  console.log(`Execution mode=${config.executionMode}`);
  console.log(`Configured chain=${config.chainId}`);
  console.log(`Allowed side=${config.allowedSide}`);
  console.log(`Persistence=${stateStore.getStatePath()}`);
  console.log(
    `Live balances: base=${liveInventory.baseBalance.toFixed(4)} ${market.symbol.split(':')[0]} quote=${liveInventory.quoteBalance.toFixed(4)} ${market.symbol.split(':')[1]}`,
  );
  printStartupWarnings();
  for (const note of strategy.getStartupNotes?.() ?? []) {
    console.log(`[strategy] ${note}`);
  }
  console.log(
    '[strategy] Inventory is now seeded from live wallet balances at startup. Existing SOMI is reserved as gas first, and fresh buys become tradable inventory.',
  );
  if (previousSnapshot.metrics.totalExecutions > 0) {
    console.log(
      `[state] Loaded ${previousSnapshot.metrics.totalExecutions} past executions and ${previousSnapshot.metrics.totalTradedQuote.toFixed(2)} total traded quote from ${stateStore.getStatePath()}`,
    );
  }
  await stateStore.saveStrategyState(strategy.getPersistentState?.());

  // Graceful shutdown on SIGINT / SIGTERM
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] Received ${signal}; saving state and exiting…`);
    ws.close();
    try {
      await stateStore.saveStrategyState(strategy.getPersistentState?.());
    } catch (error) {
      console.error('[shutdown] Failed to save final state:', error);
    }
    if (vaultManager) {
      console.log('[vault] Withdrawing funds from vault back to wallet...');
      try {
        await vaultManager.withdrawAll(market);
      } catch (error) {
        console.error(
          '[vault] Failed to withdraw from vault on shutdown:',
          error,
        );
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(console.error);
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(console.error);
  });

  let lastActionAt = 0;
  let lastPersistenceAt = 0;
  let lastDecisionLogAt = 0;
  let lastInventorySyncAt = 0;
  let cachedOrderBook: OrderBook | undefined;

  // Serialize async handler: skip the tick if the previous is still in flight.
  let isHandling = false;

  await ws.connect(async (message) => {
    if (shuttingDown) return;

    if (message.type !== 'snapshot' && message.type !== 'update') {
      if (message.type === 'error') {
        console.error('WebSocket error:', message.description ?? message);
      }
      return;
    }

    if (message.symbol && message.symbol !== config.symbol) {
      return;
    }

    if (isHandling) {
      return;
    }
    isHandling = true;

    try {
      cachedOrderBook = applyOrderBookMessage(
        cachedOrderBook,
        message,
        config.symbol,
      );

      // No snapshot received yet — treat as a completely empty book so the
      // strategy can still post a resting limit based on inventory position.
      const effectiveBook = cachedOrderBook ?? {
        symbol: config.symbol,
        timestamp: Date.now(),
        bids: [],
        asks: [],
      };

      const now = Date.now();

      // Re-sync live inventory periodically so HTTP-mode balance estimates don't drift.
      if (now - lastInventorySyncAt >= 5 * 60_000) {
        try {
          const fresh = await getLiveInventory(executor, market, vaultManager);
          strategy.syncInventory?.(fresh);
          lastInventorySyncAt = now;
          console.log(
            `[sync] Live balances refreshed: base=${fresh.baseBalance.toFixed(4)} quote=${fresh.quoteBalance.toFixed(4)}`,
          );
          metrics?.update({ baseBalance: fresh.baseBalance, quoteBalance: fresh.quoteBalance });
          const bid = Number(effectiveBook.bids[0]?.price ?? 0);
          const ask = Number(effectiveBook.asks[0]?.price ?? 0);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid;
          if (mid > 0) metrics?.pushEquity(fresh.quoteBalance + fresh.baseBalance * mid);
        } catch (error) {
          console.warn('[sync] Failed to refresh live inventory:', error);
        }
      }

      const signal = strategy.evaluate(effectiveBook, {
        market,
        orderAmount: config.orderAmount,
        allowedSide: config.allowedSide,
        buyBelowPrice: config.buyBelowPrice,
        sellAbovePrice: config.sellAbovePrice,
        rebalanceTradeSizeQuote: config.rebalanceTradeSizeQuote,
        rebalanceTargetBaseQuote: config.rebalanceTargetBaseQuote,
        rebalanceTargetToleranceQuote: config.rebalanceTargetToleranceQuote,
        rebalanceMaxSpreadBps: config.rebalanceMaxSpreadBps,
        gridTradeSizeQuote: config.gridTradeSizeQuote,
        gridStepBps: config.gridStepBps,
        gridMaxSpreadBps: config.gridMaxSpreadBps,
        gridMaxLongQuote: config.gridMaxLongQuote,
      });

      if (now - lastPersistenceAt >= 15_000) {
        await stateStore.saveStrategyState(strategy.getPersistentState?.());
        lastPersistenceAt = now;
      }

      if (!signal) {
        if (now - lastDecisionLogAt >= 15_000) {
          const decisionLine = strategy.getDecisionLine?.();
          if (decisionLine) {
            console.log(`[decision] ${decisionLine}`);
          }
          lastDecisionLogAt = now;
        }
        return;
      }

      if (now - lastActionAt < config.cooldownMs) {
        return;
      }

      lastActionAt = now;

      const effectiveFundingSource = config.autoVault
        ? 'vault'
        : config.fundingSource;
      const request = toPrepareOrderRequest(
        config.walletAddress,
        signal,
        effectiveFundingSource,
        config.orderType,
        config.selfMatchingOption,
      );

      const effectiveOrderType = signal.orderType ?? config.orderType;

      // Resting orders (normalOrder / postOnly) require vault funding.
      // With wallet funding the API only accepts immediateOrCancel or fillOrKill.
      if (
        effectiveFundingSource === 'wallet' &&
        (effectiveOrderType === 'normalOrder' ||
          effectiveOrderType === 'postOnly')
      ) {
        console.warn(
          `[warn] Skipping ${effectiveOrderType} order — resting orders require DREAMDEX_FUNDING_SOURCE=vault`,
        );
        return;
      }

      console.log(
        `[signal] ${signal.side.toUpperCase()} ${signal.amount} ${config.symbol} @ ${signal.price} [${effectiveOrderType}]`,
      );
      console.log(`[signal] reason: ${signal.reason}`);

      if (config.dryRun) {
        console.log('[dry-run] Skipping prepare/sign/send');
        return;
      }

      try {
        const result = await orderExecutor.executeOrder(market, request);

        if (result.approvalTxHash) {
          console.log(`[exec] Approval tx hash: ${result.approvalTxHash}`);
        }

        if (result.simulatedOrderId) {
          console.log(`[exec] Simulated order id: ${result.simulatedOrderId}`);
        }

        console.log(`[exec] ${result.mode} order tx hash: ${result.txHash}`);

        const execution = await resolveExecution(
          http,
          market.symbol,
          signal.side,
          signal.price,
          signal.amount,
          result.simulatedOrderId,
        );
        strategy.onExecution?.(execution);

        if (execution.status) {
          console.log(
            `[order] status=${execution.status} filled=${execution.filledAmount} executionPrice=${execution.executionPrice}`,
          );
        }

        await stateStore.recordExecution(execution, {
          txHash: result.txHash,
          approvalTxHash: result.approvalTxHash,
          simulatedOrderId: result.simulatedOrderId,
          strategyState: strategy.getPersistentState?.(),
        });

        const notional = Number(execution.filledAmount) * Number(execution.executionPrice);
        if (notional > 0) {
          metrics?.pushTrade({
            at: Date.now(),
            side: signal.side,
            price: execution.executionPrice,
            amount: signal.amount,
            filledAmount: execution.filledAmount,
            notional,
          });
        }

        const statusLine = strategy.getStatusLine?.();
        if (statusLine) {
          console.log(`[strategy] ${statusLine}`);
          metrics?.update({ statusLine });
        }
      } catch (error) {
        console.error('[exec] Failed to prepare or send order:', error);
      }
    } finally {
      isHandling = false;
    }
  });

  ws.subscribeOrderBook(config.symbol);
  console.log(`Subscribed to orderbook for ${config.symbol}`);
}

async function resolveExecution(
  http: DreamDexHttpClient,
  symbol: string,
  side: StrategyExecution['side'],
  requestedPrice: string,
  requestedAmount: string,
  orderId?: string,
): Promise<StrategyExecution> {
  if (!orderId) {
    // HTTP mode: no order ID available. Optimistically record as filled at the
    // requested price so the strategy can update its internal balance estimates.
    // The periodic live inventory resync will correct any accumulated drift.
    return {
      side,
      requestedPrice,
      requestedAmount,
      filledAmount: requestedAmount,
      executionPrice: requestedPrice,
    };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const order = await http.fetchOrder(symbol, orderId);
      return {
        side,
        requestedPrice,
        requestedAmount,
        filledAmount: order.filled,
        executionPrice: order.executionPrice || requestedPrice,
        status: order.status,
      };
    } catch (error) {
      if (attempt === 4) {
        console.warn(
          `[order] Could not reconcile order ${orderId}; assuming no fill. Error: ${String(error)}`,
        );
      } else {
        await sleep(1_000);
      }
    }
  }

  return {
    side,
    requestedPrice,
    requestedAmount,
    filledAmount: '0',
    executionPrice: requestedPrice,
    status: 'unknown',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLiveInventory(
  executor: TransactionExecutor,
  market: {
    symbol: string;
    base: string;
    quote: string;
    baseDecimals: number;
    quoteDecimals: number;
  },
  vaultManager?: VaultManager,
): Promise<{ baseBalance: number; quoteBalance: number }> {
  const isNativeSomiMarket = market.symbol.startsWith('SOMI:');
  const [baseRaw, quoteRaw] = await Promise.all([
    isNativeSomiMarket
      ? executor.getNativeBalance()
      : executor.getErc20Balance(market.base),
    executor.getErc20Balance(market.quote),
  ]);

  if (!vaultManager) {
    return {
      baseBalance: Number(formatUnits(baseRaw, market.baseDecimals)),
      quoteBalance: Number(formatUnits(quoteRaw, market.quoteDecimals)),
    };
  }

  const [vaultBaseRaw, vaultQuoteRaw] = await Promise.all([
    vaultManager.getVaultBalance(market.base),
    vaultManager.getVaultBalance(market.quote),
  ]);

  return {
    baseBalance: Number(
      formatUnits(baseRaw + vaultBaseRaw, market.baseDecimals),
    ),
    quoteBalance: Number(
      formatUnits(quoteRaw + vaultQuoteRaw, market.quoteDecimals),
    ),
  };
}

function applyOrderBookMessage(
  current: OrderBook | undefined,
  message: WebSocketOrderBookMessage,
  symbol: string,
): OrderBook | undefined {
  if (message.type === 'snapshot') {
    if (!message.bids || !message.asks || !message.timestamp) {
      return current;
    }

    return validateBook({
      symbol,
      timestamp: message.timestamp,
      bids: normalizeLevels(message.bids, 'desc'),
      asks: normalizeLevels(message.asks, 'asc'),
    });
  }

  if (!current) {
    if (!message.bids || !message.asks || !message.timestamp) {
      return undefined;
    }

    return validateBook({
      symbol,
      timestamp: message.timestamp,
      bids: normalizeLevels(message.bids, 'desc'),
      asks: normalizeLevels(message.asks, 'asc'),
    });
  }

  return validateBook({
    symbol,
    timestamp: message.timestamp ?? current.timestamp,
    bids: mergeLevels(current.bids, message.bids, 'desc'),
    asks: mergeLevels(current.asks, message.asks, 'asc'),
  });
}

function validateBook(book: OrderBook): OrderBook | undefined {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  if (bestBid && bestAsk && Number(bestBid.price) >= Number(bestAsk.price)) {
    console.warn(
      `[book] Crossed order book ignored: best bid ${bestBid.price} >= best ask ${bestAsk.price}`,
    );
    return undefined;
  }
  return book;
}

function mergeLevels(
  existing: OrderBookLevel[],
  updates: OrderBookLevel[] | undefined,
  direction: 'asc' | 'desc',
): OrderBookLevel[] {
  if (!updates || updates.length === 0) {
    return existing;
  }

  const byPrice = new Map(existing.map((level) => [level.price, level]));

  for (const update of updates) {
    if (Number(update.quantity) <= 0) {
      byPrice.delete(update.price);
      continue;
    }

    byPrice.set(update.price, update);
  }

  return normalizeLevels([...byPrice.values()], direction);
}

function normalizeLevels(
  levels: OrderBookLevel[],
  direction: 'asc' | 'desc',
): OrderBookLevel[] {
  return levels
    .filter((level) => Number(level.quantity) > 0)
    .sort((left, right) =>
      direction === 'asc'
        ? Number(left.price) - Number(right.price)
        : Number(right.price) - Number(left.price),
    );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
