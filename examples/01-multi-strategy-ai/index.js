/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { initBrain, getAIDecision, getServer } from './brain/index.js';
import { fetchMarketInfo, depositUsdsoOnce, getVaultBalances, getWalletBalances, getOpenOrdersOnChain } from './executor/vault.js';
import { getAuthHeaders, clearAuth } from './utils/auth.js';
import { walletClient, account } from './executor/viemClient.js';
import { placeVaultLimitOrder, cancelOrderById, getOpenOrdersFromAPI } from './executor/orders.js';
import { updateCircuitBreakerState, validateTrade } from './executor/riskManager.js';
import {
  addTrade,
  getTrades,
  getStrategyStats,
  getOpenPositions,
  addSnapshot,
  addCoinGeckoSnapshot,
  getState,
  setState,
  closePosition,
  markInitialDeposit,
} from './memory/index.js';
import { analyzeGrid } from './strategies/grid.js';
import { analyzeMomentum } from './strategies/momentum.js';
import { analyzeMeanReversion } from './strategies/meanReversion.js';
import { analyzeCoinGeckoSentiment } from './strategies/coingeckoSentiment.js';
import { fetchCoinGeckoData, calculateLocalRSI, calculateLocalSMA } from './data/coingecko.js';
import { httpRequest } from './utils/http.js';
import { log, alert, success, error as logError, separator } from './utils/logger.js';
import { CONFIG } from './config.js';

let authHeaders = null;

async function authenticate() {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      authHeaders = await getAuthHeaders(walletClient, account);
      return;
    } catch (err) {
      attempts++;
      logError(`Auth attempt ${attempts}/${maxAttempts} failed: ${err.message}`);
      if (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  throw new Error('Authentication failed after max retries');
}

async function fetchMarketData() {
  const tasks = [
    httpRequest('GET', `/v0/markets/${CONFIG.MARKET_SYMBOL}/tickers`),
    httpRequest('GET', `/v0/orderbooks?symbols=${CONFIG.MARKET_SYMBOL}`),
    httpRequest('GET', `/v0/markets/${CONFIG.MARKET_SYMBOL}/candles?interval=5m&limit=30`),
    httpRequest('GET', `/v0/markets/${CONFIG.MARKET_SYMBOL}/trades?limit=20`),
  ];

  if (CONFIG.COINGECKO_ENABLED) {
    tasks.push(fetchCoinGeckoData());
  }

  const results = await Promise.all(tasks);
  const [tickerRes, obRes, candleRes, tradeRes] = results;
  const cgData = CONFIG.COINGECKO_ENABLED ? results[4] : null;

  let midPrice = 0;
  let change24h = '0';
  let bestBid = 0;
  let bestAsk = 0;
  let bidQty = 0;
  let askQty = 0;
  let spread = '0';

  if (tickerRes.status === 200 && tickerRes.body) {
    const sym = (tickerRes.body.symbols || [])[0] || tickerRes.body;
    midPrice = parseFloat(sym.close || sym.lastPrice || sym.last || sym.price || 0);
    change24h = sym.priceChangePercent || sym.change24h || sym['24hChange'] || '0';
    bestBid = parseFloat(sym.bid || sym.bidPrice || sym.bestBid || 0);
    bestAsk = parseFloat(sym.ask || sym.askPrice || sym.bestAsk || 0);
  }

  if (obRes.status === 200 && obRes.body) {
    const obs = obRes.body.orderbooks || [obRes.body];
    const ob = obs[0] || {};
    const bids = ob.bids || [];
    const asks = ob.asks || [];
    if (bids.length > 0) {
      const b = bids[0];
      bestBid = parseFloat(b.price || b[0] || bestBid);
      bidQty = parseFloat(b.quantity || b.amount || b[1] || 0);
    }
    if (asks.length > 0) {
      const a = asks[0];
      bestAsk = parseFloat(a.price || a[0] || bestAsk);
      askQty = parseFloat(a.quantity || a.amount || a[1] || 0);
    }
  }
  if (midPrice === 0 && bestBid > 0 && bestAsk > 0) {
    midPrice = (bestBid + bestAsk) / 2;
  }

  if (bestAsk > 0 && bestBid > 0) {
    spread = (((bestAsk - bestBid) / bestBid) * 100).toFixed(4);
  }

  let candles = [];
  if (candleRes.status === 200 && candleRes.body) {
    const raw = candleRes.body.candles || candleRes.body;
    candles = (Array.isArray(raw) ? raw : []).map((c) => ({
      timestamp: c.timestamp || c.time || c[0],
      open: parseFloat(c.open || c[1] || 0),
      high: parseFloat(c.high || c[2] || 0),
      low: parseFloat(c.low || c[3] || 0),
      close: parseFloat(c.close || c[4] || 0),
      volume: parseFloat(c.volume || c[5] || 0),
    }));
  }

  let trades = [];
  if (tradeRes.status === 200 && tradeRes.body) {
    trades = tradeRes.body.trades || tradeRes.body || [];
  }

  const vaultBalances = await getVaultBalances();
  let openOrdersCount = 0;

  try {
    const openOrders = await getOpenOrdersOnChain();
    openOrdersCount = openOrders?.length || 0;
  } catch {
    openOrdersCount = 0;
  }

  // Calculate local RSI/SMA from CoinGecko history
  let coingeckoData = null;
  if (cgData) {
    const btcRSI = calculateLocalRSI('bitcoin', 14);
    const ethRSI = calculateLocalRSI('ethereum', 14);
    const btcSMA = calculateLocalSMA('bitcoin', 20);
    const ethSMA = calculateLocalSMA('ethereum', 20);

    coingeckoData = {
      raw: cgData,
      btcRSI,
      ethRSI,
      btcSMA,
      ethSMA,
    };
  }

  return {
    midPrice,
    change24h,
    bestBid,
    bestAsk,
    bidQty,
    askQty,
    spread,
    candles,
    trades,
    vaultBalances,
    openOrdersCount,
    coingeckoData,
  };
}

async function checkStopLosses(marketData, currentAuthHeaders) {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    if (!pos.stopLoss) continue;

    const sl = parseFloat(pos.stopLoss);
    const tp = parseFloat(pos.takeProfit || 0);
    const currentPrice = marketData.midPrice || marketData.bestBid || 0;

    if (currentPrice <= 0) continue;

    let shouldClose = false;
    let reason = '';

    if (pos.side === 'BUY') {
      if (sl > 0 && currentPrice <= sl) {
        shouldClose = true;
        reason = `Stop loss hit: ${currentPrice.toFixed(6)} <= ${sl.toFixed(6)}`;
      } else if (tp > 0 && currentPrice >= tp) {
        shouldClose = true;
        reason = `Take profit hit: ${currentPrice.toFixed(6)} >= ${tp.toFixed(6)}`;
      }
    }

    if (shouldClose) {
      log('warn', 'sl', `${reason}. Closing position ${pos.id}...`);
      try {
        const result = await placeVaultLimitOrder(currentAuthHeaders, {
          side: 'SELL',
          price: marketData.bestBid || currentPrice,
          amount: pos.amount,
        });

        if (result) {
          const closed = closePosition(pos.id, parseFloat(result.price || currentPrice), result.txHash);
          log('success', 'sl', `Position closed. PnL: ${closed?.pnl?.toFixed(4)} USDso`);
        } else {
          log('error', 'sl', `Failed to close position ${pos.id}`);
        }
      } catch (err) {
        log('error', 'sl', `SL execution failed: ${err.message}`);
      }
    }
  }
}

async function executeTrade(decision, currentAuthHeaders, marketData) {
  const { action, strategy, price, amount, stopLoss, takeProfit } = decision;

  const actionMap = { BUY: 'buy', SELL: 'sell' };
  const side = actionMap[action];

  if (!side) return null;

  const result = await placeVaultLimitOrder(currentAuthHeaders, {
    side,
    price: parseFloat(price),
    amount: parseFloat(amount),
  });

  if (!result) {
    log('error', 'trade', `${action} execution failed`);
    return null;
  }

  const trade = {
    action,
    side,
    strategy,
    entryPrice: parseFloat(price),
    amount: parseFloat(amount),
    stopLoss: parseFloat(stopLoss || 0),
    takeProfit: parseFloat(takeProfit || 0),
    orderId: result.orderId,
    txHash: result.txHash,
    status: 'OPEN',
    marketSnapshot: {
      midPrice: marketData.midPrice,
      bestBid: marketData.bestBid,
      bestAsk: marketData.bestAsk,
    },
    reasoning: decision.reasoning,
  };

  return addTrade(trade);
}

async function runCycle() {
  separator();

  const cb = updateCircuitBreakerState();
  if (cb.halted) {
    log('warn', 'main', `Bot halted. Reason: ${cb.reason}`);
    log('info', 'main', 'Halting loop. Manual restart required.');
    return false;
  }

  const marketData = await fetchMarketData();

  log('info', 'market', `Price: ${marketData.midPrice?.toFixed(8) || 'N/A'} USDso | Spread: ${marketData.spread}% | Vault: ${marketData.vaultBalances.wethFree} WETH / ${marketData.vaultBalances.usdsoFree} USDso`);

  await checkStopLosses(marketData, authHeaders);

  const signals = {
    grid: analyzeGrid(marketData.candles, marketData, marketData.midPrice),
    momentum: analyzeMomentum(marketData.candles, marketData.trades, marketData),
    meanReversion: analyzeMeanReversion(marketData.candles, marketData.midPrice),
  };

  // CoinGecko sentiment analysis
  let cgSentiment = null;
  if (marketData.coingeckoData) {
    const cg = marketData.coingeckoData;
    cgSentiment = analyzeCoinGeckoSentiment(
      cg.raw?.bitcoin,
      cg.raw?.ethereum,
      cg.btcRSI,
      cg.ethRSI
    );
    signals.coingecko = cgSentiment;

    log(
      'info',
      'sentiment',
      `CG: ${cgSentiment.signal} | BTC: $${cgSentiment.btcPrice?.toLocaleString()} (${cgSentiment.btcChange24h?.toFixed(1)}%) RSI:${cgSentiment.btcRSI?.toFixed(1)} | ` +
      `ETH: $${cgSentiment.ethPrice?.toLocaleString()} (${cgSentiment.ethChange24h?.toFixed(1)}%) RSI:${cgSentiment.ethRSI?.toFixed(1)} | ${cgSentiment.reason}`
    );
  }

  const stats = getStrategyStats();
  const openPositions = getOpenPositions();

  const state = getState();
  const realizedPnl = state.cumulativePnl || 0;

  log(
    'info',
    'ai',
    `Signals: GRID[${signals.grid.signal}](c:${signals.grid.confidence?.toFixed(2)}) ` +
      `MOM[${signals.momentum.signal}](c:${signals.momentum.confidence?.toFixed(2)}) ` +
      `MR[${signals.meanReversion.signal}](c:${signals.meanReversion.confidence?.toFixed(2)}) ` +
      `CG[${cgSentiment ? cgSentiment.signal : 'N/A'}](c:${cgSentiment ? cgSentiment.confidence?.toFixed(2) : 'N/A'}) ` +
      `RSI:${signals.meanReversion.rsi?.toFixed(1) || 'N/A'}`
  );

  const decision = await getAIDecision({
    marketData,
    signals,
    stats,
    openPositions,
    vaultBalances: marketData.vaultBalances,
    realizedPnl,
  });

  log(
    'ai',
    'decision',
    `${decision.action} | ${decision.strategy} | confidence: ${decision.confidence?.toFixed(2)} | ${(decision.reasoning || '').substring(0, 100)}`
  );

  if (decision.action !== 'HOLD') {
    log('info', 'ai', `AI wants: ${decision.action} ${decision.amount} WETH @ ${decision.price} USDso, SL: ${decision.stopLoss}, TP: ${decision.takeProfit}`);
  }

  const validation = validateTrade(decision, marketData.vaultBalances);

  if (!validation.approved) {
    log('warn', 'risk', `Trade rejected by risk manager: ${validation.reason}`);
  } else if (decision.action !== 'HOLD') {
    const trade = await executeTrade(validation.adjusted || decision, authHeaders, marketData);
    if (trade) {
      log('success', 'trade', `${decision.action} executed: ${trade.amount} WETH @ ${trade.entryPrice} (${decision.strategy})`);
    }
  }

  addSnapshot(marketData);

  if (marketData.coingeckoData) {
    addCoinGeckoSnapshot({
      raw: marketData.coingeckoData.raw,
      btcRSI: marketData.coingeckoData.btcRSI,
      ethRSI: marketData.coingeckoData.ethRSI,
      sentiment: signals.coingecko,
    });
  }

  return true;
}

async function main() {
  console.log(`\n\x1b[35m${'='.repeat(60)}\x1b[0m`);
  console.log(`\x1b[35m  🤖 DreamDEX AI Autonomous Trading Bot\x1b[0m`);
  console.log(`\x1b[35m  Market: ${CONFIG.MARKET_SYMBOL} | Testnet | ${CONFIG.RPC_URL}\x1b[0m`);
  console.log(`\x1b[35m  Wallet: ${CONFIG.WALLET_ADDRESS}\x1b[0m`);
  console.log(`\x1b[35m  AI Engine: OpenCode SDK (auto)\x1b[0m`);
  console.log(`\x1b[35m  CoinGecko: ${CONFIG.COINGECKO_ENABLED ? 'Enabled' : 'Disabled'} | Sentiment: ON\x1b[0m`);
  console.log(`\x1b[35m  Loop: every ${CONFIG.LOOP_INTERVAL_MS / 60000} min | Risk: ${CONFIG.MAX_RISK_PERCENT * 100}% | Initial: ${CONFIG.INITIAL_DEPOSIT_USDSO} USDso\x1b[0m`);
  console.log(`\x1b[35m${'='.repeat(60)}\x1b[0m\n`);

  try {
    log('info', 'main', 'Fetching market metadata...');
    await fetchMarketInfo();

    log('info', 'main', 'Initializing AI brain...');
    const brain = await initBrain();

    log('info', 'main', 'Authenticating with DreamDEX API...');
    await authenticate();

    log('info', 'main', 'Checking initial deposit...');
    await depositUsdsoOnce();

    const walletBal = await getWalletBalances();
    const vaultBal = await getVaultBalances();
    log('info', 'main', `Wallet: ${walletBal.native} SOMI (gas), ${walletBal.usdso} USDso`);
    log('info', 'main', `Vault: ${vaultBal.wethFree} WETH, ${vaultBal.usdsoFree} USDso`);

    let running = true;
    let consecutiveErrors = 0;

    process.on('SIGINT', () => {
      log('info', 'main', 'Shutdown signal received. Closing...');
      running = false;
    });

    process.on('SIGTERM', () => {
      log('info', 'main', 'Termination signal received. Closing...');
      running = false;
    });

    while (running) {
      const cycleStart = Date.now();

      try {
        const shouldContinue = await runCycle();
        if (!shouldContinue) {
          running = false;
          break;
        }
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        log('error', 'main', `Cycle error: ${err.message}`);

        if (err.message.includes('auth') || err.message.includes('token') || err.message.includes('401')) {
          log('info', 'main', 'Auth issue detected, re-authenticating...');
          clearAuth();
          try {
            await authenticate();
            consecutiveErrors = 0;
          } catch (authErr) {
            log('error', 'main', `Re-auth failed: ${authErr.message}`);
          }
        }

        if (consecutiveErrors >= 10) {
          log('error', 'main', 'Too many consecutive errors. Pausing bot.');
          running = false;
        }
      }

      const elapsed = Date.now() - cycleStart;
      const waitTime = Math.max(5000, CONFIG.LOOP_INTERVAL_MS - elapsed);

      if (running) {
        log('cycle', 'main', `Cycle done in ${(elapsed / 1000).toFixed(1)}s. Next in ${(waitTime / 1000).toFixed(0)}s...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    log('info', 'main', 'Bot shutting down...');
    try {
      const server = getServer();
      if (server) server.close();
    } catch {}
    log('info', 'main', 'Goodbye.');
    process.exit(0);
  } catch (err) {
    log('error', 'fatal', `Startup error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
