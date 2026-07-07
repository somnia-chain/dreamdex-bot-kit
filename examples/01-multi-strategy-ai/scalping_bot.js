/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { initBrain, getAIDecision, getServer } from './brain/index.js';
import { getAuthHeaders, clearAuth } from './utils/auth.js';
import { updateCircuitBreakerState, validateTrade } from './executor/riskManager.js';
import { fetchBinanceMarketData } from './data/binance.js';
import {
  addTrade, getStrategyStats, getOpenPositions, getState, setState, closePosition,
} from './memory/index.js';
import { httpRequest } from './utils/http.js';
import { log, alert, error as logError, separator } from './utils/logger.js';
import { CONFIG } from './config.js';
import { ERC20_ABI } from './executor/viemClient.js';
import {
  parseUnits, formatUnits, formatEther,
  createWalletClient, createPublicClient, http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

CONFIG.RPC_URL = process.env.MAINNET_RPC_URL || CONFIG.RPC_URL;
CONFIG.API_URL = process.env.MAINNET_API_URL || CONFIG.API_URL;
CONFIG.CHAIN_ID = parseInt(process.env.MAINNET_CHAIN_ID || String(CONFIG.CHAIN_ID), 10);
CONFIG.WALLET_ADDRESS = (process.env.MAINNET_WALLET_ADDRESS || CONFIG.WALLET_ADDRESS).toLowerCase();

log('info', 'config', `Mainnet: RPC=${CONFIG.RPC_URL} | API=${CONFIG.API_URL} | ChainID=${CONFIG.CHAIN_ID}`);

const mainnetChain = {
  id: CONFIG.CHAIN_ID,
  name: 'Somnia',
  nativeCurrency: { decimals: 18, name: 'Somnia Token', symbol: 'STT' },
  rpcUrls: { default: { http: [CONFIG.RPC_URL] }, public: { http: [CONFIG.RPC_URL] } },
};

const publicClient = createPublicClient({ chain: mainnetChain, transport: http() });

const BOT_PK = process.env.MAINNET_BOT_PK || CONFIG.PRIVATE_KEY;
const botAccount = privateKeyToAccount(BOT_PK);
const walletClient = createWalletClient({
  account: botAccount, chain: mainnetChain, transport: http(),
});
log('info', 'wallet', `Bot wallet: ${botAccount.address}`);

const PAIR = CONFIG.MARKET_SYMBOL;
const APPROVE_AMOUNT = 1000000;
const RETRY_DELAY_MS = 2000;
const SCALPING_INTERVAL_MS = 2 * 60 * 1000;
const SL_CHECK_INTERVAL_MS = 5000;
const DEFAULT_TP_PERCENT = 0.5;
const DEFAULT_SL_PERCENT = 0.3;
const MAX_TRADE_RETRIES = 3;
const SELL_BUFFER = 0.01;
const MIN_CONFIDENCE = 0.55;
const SL_COOLDOWN_MS = 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let poolAddress = null;
let baseToken = null;
let quoteToken = null;
let quoteDecimals = 6;
let authHeaders = null;

async function authenticate() {
  for (let i = 0; i < 3; i++) {
    try {
      authHeaders = await getAuthHeaders(walletClient, botAccount);
      return;
    } catch (err) {
      logError(`Auth attempt ${i + 1}/3 failed: ${err.message}`);
      if (i < 2) await sleep(5000);
    }
  }
  throw new Error('Authentication failed');
}

async function fetchMarketInfo() {
  log('info', 'vault', 'Fetching market metadata...');
  const res = await httpRequest('GET', '/v0/markets');
  if (res.status !== 200) throw new Error('Failed to fetch markets');
  const market = (res.body.markets || []).find(m => m.symbol === PAIR);
  if (!market) throw new Error(`Market ${PAIR} not found`);
  poolAddress = market.contract;
  baseToken = market.base;
  quoteToken = market.quote;
  const currRes = await httpRequest('GET', '/v0/currencies');
  if (currRes.status === 200) {
    const usdso = (currRes.body.currencies || []).find(c => c.code === 'USDso');
    if (usdso) quoteDecimals = usdso.decimals || 6;
  }
  log('info', 'vault', `Pool: ${poolAddress} | Base: ${baseToken} | Quote: ${quoteToken} | Decimals: ${quoteDecimals}`);
}

async function getWalletBalances() {
  const native = await publicClient.getBalance({ address: botAccount.address });
  const usdsoBal = await publicClient.readContract({
    address: quoteToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [botAccount.address],
  });
  const wethBal = await publicClient.readContract({
    address: baseToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [botAccount.address],
  });
  return {
    native: formatEther(native),
    usdso: formatUnits(usdsoBal, quoteDecimals),
    weth: formatUnits(wethBal, 18),
  };
}

async function approveIfNeeded(tokenAddress, tokenSymbol, decimals) {
  const allowance = await publicClient.readContract({
    address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance',
    args: [botAccount.address, poolAddress],
  });
  const raw = parseUnits(String(APPROVE_AMOUNT), decimals);
  if (allowance < raw) {
    log('info', 'approve', `Approving ${APPROVE_AMOUNT} ${tokenSymbol}...`);
    const tx = await walletClient.writeContract({
      address: tokenAddress, abi: ERC20_ABI, functionName: 'approve',
      args: [poolAddress, raw * 10n], gas: 5000000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60000 });
    log('success', 'approve', `${tokenSymbol} approved.`);
  } else {
    log('info', 'approve', `${tokenSymbol} already approved.`);
  }
}

async function fetchOrderbook() {
  const res = await httpRequest('GET', `/v0/orderbooks?symbols=${PAIR}`);
  if (res.status !== 200 || !res.body) return null;
  const obs = res.body.orderbooks || [res.body];
  const ob = obs[0] || {};
  const bids = ob.bids || [];
  const asks = ob.asks || [];
  if (bids.length === 0 || asks.length === 0) return null;
  return {
    bestBid: parseFloat(bids[0].price || bids[0][0] || 0),
    bestAsk: parseFloat(asks[0].price || asks[0][0] || 0),
    bidQty: parseFloat(bids[0].quantity || bids[0].amount || bids[0][1] || 0),
    askQty: parseFloat(asks[0].quantity || asks[0].amount || asks[0][1] || 0),
  };
}

async function placeWalletLimitOrder(side, price, amount) {
  const payload = {
    type: 'limit', side: side, price: String(price), amount: String(amount),
    walletAddress: botAccount.address, fundingSource: 'wallet', orderType: 'immediateOrCancel',
  };
  log('info', 'trade', `Preparing ${side.toUpperCase()} ${amount} WETH @ ${price} (IOC)`);
  const prep = await httpRequest('POST', `/v0/markets/${PAIR}/orders`, authHeaders, payload);
  if (prep.status !== 200 || !prep.body?.to) {
    log('error', 'trade', `Prepare failed: ${prep.status}`);
    return null;
  }
  const p = prep.body;
  const txHash = await walletClient.sendTransaction({
    to: p.to, data: p.data, value: p.value ? BigInt(p.value) : 0n,
    gas: p.gasLimit ? BigInt(p.gasLimit) : 8000000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45000 });
  if (receipt.status !== 'success') {
    log('error', 'trade', 'Tx reverted');
    return null;
  }
  const ORDER_PLACED_TOPIC = '0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d';
  for (const logEntry of receipt.logs) {
    if (logEntry.topics?.[0] === ORDER_PLACED_TOPIC) {
      log('success', 'trade', `${side.toUpperCase()} filled! Amount: ${amount} Tx: ${txHash}`);
      return { txHash, filled: true };
    }
  }
  log('warn', 'trade', `${side.toUpperCase()} IOC cancelled at ${price}`);
  return { filled: false };
}

async function sellAllWeth(sellBuffer = 0) {
  for (let attempt = 0; attempt < MAX_TRADE_RETRIES; attempt++) {
    const bal = await getWalletBalances();
    const weth = parseFloat(bal.weth);
    if (weth <= 0) return true;

    const ob = await fetchOrderbook();
    const bid = ob ? ob.bestBid : 0;
    if (bid <= 0) { await sleep(RETRY_DELAY_MS); continue; }

    const sellPrice = bid - sellBuffer;
    log('info', 'sell', `Selling ${weth.toFixed(4)} WETH @ ${sellPrice.toFixed(2)}`);
    authHeaders = await getAuthHeaders(walletClient, botAccount);
    const result = await placeWalletLimitOrder('sell', sellPrice.toFixed(2), weth.toFixed(4));

    if (result && result.filled) {
      const after = await getWalletBalances();
      log('success', 'sell', `Sold. Wallet: ${after.usdso} USDso`);
      return true;
    }
    if (attempt < MAX_TRADE_RETRIES - 1) await sleep(RETRY_DELAY_MS);
  }
  return false;
}

async function checkStopLosses(marketPrice) {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    const sl = parseFloat(pos.stopLoss || 0);
    const tp = parseFloat(pos.takeProfit || 0);
    const entry = parseFloat(pos.entryPrice);
    const currentPrice = marketPrice;
    if (currentPrice <= 0 || entry <= 0) continue;

    let shouldClose = false;
    let reason = '';

    if (pos.side === 'BUY') {
      const pnlPercent = ((currentPrice - entry) / entry) * 100;
      if (sl > 0 && currentPrice <= sl) {
        shouldClose = true;
        reason = `SL hit: ${currentPrice.toFixed(2)} <= ${sl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`;
      } else if (tp > 0 && currentPrice >= tp) {
        shouldClose = true;
        reason = `TP hit: ${currentPrice.toFixed(2)} >= ${tp.toFixed(2)} (${pnlPercent.toFixed(2)}%)`;
      } else if (pnlPercent <= -(DEFAULT_SL_PERCENT * 2)) {
        shouldClose = true;
        reason = `Emergency SL: ${pnlPercent.toFixed(2)}% loss`;
      }
    }

    if (!shouldClose) continue;

    log('warn', 'sl', `${reason}. Closing position ${pos.id}...`);
    setState('lastSlTime', Date.now());
    let closed = false;
    for (let attempt = 0; attempt < MAX_TRADE_RETRIES; attempt++) {
      authHeaders = await getAuthHeaders(walletClient, botAccount);
      closed = await sellAllWeth(SELL_BUFFER);
      if (closed) {
        const r = closePosition(pos.id, currentPrice, 'market-sell');
        log('success', 'sl', `Position closed. PnL: ${r?.pnl?.toFixed(4)} USDso`);
        break;
      }
      if (attempt < MAX_TRADE_RETRIES - 1) await sleep(RETRY_DELAY_MS);
    }
    if (!closed) log('error', 'sl', `Failed to close position ${pos.id}`);
  }
}

function formatKlines(klineData, maxRows = 300) {
  const rows = klineData.slice(-maxRows);
  return rows.map(k => {
    const t = new Date(k.timestamp).toISOString().replace('T', ' ').substring(0, 19);
    return `[${t}] O:${k.open.toFixed(2)} H:${k.high.toFixed(2)} L:${k.low.toFixed(2)} C:${k.close.toFixed(2)} V:${k.volume.toFixed(4)} QV:${k.quoteVolume.toFixed(2)} T:${k.trades}`;
  }).join('\n');
}

function buildScalpingPrompt(ctx) {
  const { analysis, klines1m, klines30m, balances, stats, openPositions, realizedPnl, lastDecision } = ctx;
  const a = analysis;

  const totalValue = parseFloat(balances.weth) * a.currentPrice + parseFloat(balances.usdso);

  let positionText = 'None';
  let unrealizedPnl = '0';
  if (openPositions && openPositions.length > 0) {
    const pos = openPositions[0];
    positionText = `${pos.amount} WETH @ ${pos.entryPrice} USDso`;
    if (a.currentPrice > 0) {
      unrealizedPnl = ((a.currentPrice - parseFloat(pos.entryPrice)) * parseFloat(pos.amount)).toFixed(4);
    }
  }

  let statsText = '';
  for (const [strategy, data] of Object.entries(stats)) {
    if (strategy === 'totalTrades' || strategy === 'closedTrades' || strategy === 'overallWinRate') continue;
    if (data.totalTrades > 0) {
      statsText += `- ${strategy.toUpperCase()}: ${data.winRate}% win (${data.wins}W/${data.losses}L), avg PnL: ${data.avgReturn} USDso\n`;
    }
  }

  const klines1mRaw = formatKlines(klines1m, 60);
  const klines30mRaw = formatKlines(klines30m, 60);

  return `You are a high-frequency scalping AI on DreamDEX. Goal: execute many small profitable trades.

CORE STRATEGY — SHORT TERM (PREFERRED):
- Target profit: $3-5 USD per trade (0.15-0.25%).
- Hold time: just a few minutes. Enter and exit quickly.
- Be aggressive — look for entries constantly. Aim for multiple trades per hour.
- Tight TP/SL: TP ~$3-5 above entry, SL ~$3-5 below entry.
- If you see a bounce off support, a volume spike, or an RSI reversal → take it immediately.

LONG TERM (OPTIONAL):
- Only if 30m trend is STRONG BULLISH/BEARISH and RSI(30m) confirms.
- TP can be wider (1-2%) for these.

DECISION FRAMEWORK:
STEP 1 - TREND: EMA9 vs EMA21. Crossed recently?
STEP 2 - RSI: 1m < 40 = dip buy zone. 1m > 60 = rip sell zone. 30m for direction.
STEP 3 - VOLUME: Spike? Buy pressure direction?
STEP 4 - BOLLINGER: Price near lower band? Near upper band?
STEP 5 - S/R: Bouncing off support? Rejecting resistance?
STEP 6 - MACD: Histogram direction? Divergence?
STEP 7 - DECIDE: >= 2 signals align → trade. Be quick. Don't overthink.

RULES:
- BUY (USDso -> WETH). Include TP and SL.
- SELL (WETH -> USDso). Include TP and SL.
- HOLD only if zero signals.
- BUY amount auto-calculated (80% balance). Ignore amount field.
- SELL amount auto-calculated (all WETH). Ignore amount field.
- SHORT TERM: TP $3-5, hold minutes. LONG TERM: wider TP, hold longer.
- NEVER buy after a 1%+ rally in 5 candles. Wait for pullback.
- NEVER sell after a 1%+ dump in 5 candles. Wait for bounce.

BINANCE ETHUSDT MARKET:
Price: $${a.currentPrice.toFixed(2)} | Change: ${a.priceChangePercent.toFixed(2)}%
Trend: ${a.trend} (strength: ${(a.trendStrength * 100).toFixed(0)}%)
30m Range: ${a.range1m.toFixed(2)}%

TECHNICAL:
RSI(1m): ${a.rsi['1m']?.toFixed(1) || 'N/A'} | RSI(30m): ${a.rsi['30m']?.toFixed(1) || 'N/A'}
EMA9: $${a.ema.ema9?.toFixed(2) || 'N/A'} | EMA21: $${a.ema.ema21?.toFixed(2) || 'N/A'}
MACD Hist: ${a.macd?.histogram?.toFixed(2) || 'N/A'}
Bollinger Upper: $${a.bollinger?.upper?.toFixed(2) || 'N/A'} | Lower: $${a.bollinger?.lower?.toFixed(2) || 'N/A'}
Volatility: ${(a.volatility * 100).toFixed(2) || 'N/A'}%
${a.volatility ? `Suggested TP/SL range: ${a.volatility < 0.1 ? 'tight (0.3-0.5%)' : a.volatility < 0.2 ? 'moderate (0.5-1.0%)' : 'wide (1.0-2.0%)'}` : ''}

VOLUME:
Vol Ratio: ${a.volume?.volRatio?.toFixed(2) || 'N/A'} | Buy Pressure: ${(a.volume?.buyRatio * 100).toFixed(0) || 'N/A'}%

PRICE ACTION:
Bullish/Bearish (last 5): ${a.priceAction?.upCandles || 0} / ${a.priceAction?.downCandles || 0}

S/R (30m):
Support: ${a.supportResistance?.supports?.map(s => '$' + s.toFixed(2)).join(', ') || 'N/A'}
Resistance: ${a.supportResistance?.resistances?.map(r => '$' + r.toFixed(2)).join(', ') || 'N/A'}

RAW KLINES 1m (${klines1m.length} candles):
${klines1mRaw}

RAW KLINES 30m (${klines30m.length} candles):
${klines30mRaw}

LAST CYCLE DECISION:
${lastDecision ? `Action: ${lastDecision.action} | Reasoning: ${lastDecision.reasoning || 'N/A'} (${lastDecision.time})` : 'None — first cycle'}

ACCOUNT:
Wallet: ${balances.weth} WETH / ${balances.usdso} USDso | Total: $${totalValue.toFixed(2)}
Position: ${positionText} | Unrealized: ${unrealizedPnl} USDso
Realized PnL: ${realizedPnl || '0'} USDso

HISTORY:
${stats.totalTrades || 0} trades (${stats.closedTrades || 0} closed) | WinRate: ${stats.overallWinRate || '0'}%
${statsText}

Respond ONLY with JSON. Examples:
{"action":"BUY","strategy":"SHORT_TERM","price":"2010.00","stopLoss":"2006.00","takeProfit":"2015.00","confidence":0.75,"reasoning":"Bounce off support $2007, RSI 1m recovering, quick scalp $5 target"}
{"action":"BUY","strategy":"LONG_TERM","price":"1995.00","stopLoss":"1985.00","takeProfit":"2020.00","confidence":0.8,"reasoning":"Strong 30m bullish divergence, RSI oversold, major support, aiming bigger move"}
{"action":"SELL","strategy":"SHORT_TERM","price":"2018.00","stopLoss":"2022.00","takeProfit":"2013.00","confidence":0.7,"reasoning":"Rejected at resistance $2020, RSI overbought, quick scalp"}
{"action":"HOLD","strategy":"SCALP","confidence":0.3,"reasoning":"No clear setup, waiting"}

Make your scalping decision now. Output ONLY the JSON.`;
}

async function executeTrade(decision, orderbook) {
  const { action, price, amount, stopLoss, takeProfit, strategy } = decision;

  if (action === 'HOLD') return null;

  const side = action === 'BUY' ? 'buy' : 'sell';
  let result = null;

  for (let attempt = 0; attempt < MAX_TRADE_RETRIES; attempt++) {
    try {
      authHeaders = await getAuthHeaders(walletClient, botAccount);
      result = await placeWalletLimitOrder(side, parseFloat(price).toFixed(2), parseFloat(amount).toFixed(4));
      if (result && result.filled) break;
    } catch (err) {
      log('error', 'trade', `${action} attempt ${attempt + 1} failed: ${err.message}`);
    }
    if (attempt < MAX_TRADE_RETRIES - 1) {
      log('info', 'trade', `Retrying ${action} in 2s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (!result || !result.filled) {
    log('error', 'trade', `${action} failed after ${MAX_TRADE_RETRIES} attempts`);
    return null;
  }

  const trade = {
    action, side: action, strategy: strategy || 'SCALP',
    entryPrice: parseFloat(price), amount: parseFloat(amount),
    stopLoss: parseFloat(stopLoss || 0), takeProfit: parseFloat(takeProfit || 0),
    orderId: result.txHash, txHash: result.txHash,
    status: 'OPEN',
    marketSnapshot: { bestBid: orderbook?.bestBid, bestAsk: orderbook?.bestAsk },
    reasoning: decision.reasoning,
  };
  return addTrade(trade);
}

async function runCycle() {
  separator();
  log('info', 'scalp', '=== Scalping AI Cycle ===');

  const cb = updateCircuitBreakerState();
  if (cb.halted) {
    log('warn', 'scalp', `Bot halted: ${cb.reason}`);
    return false;
  }

  let binanceData;
  try {
    binanceData = await fetchBinanceMarketData();
  } catch (err) {
    log('error', 'scalp', `Binance fetch failed: ${err.message}`);
    return true;
  }

  const { analysis } = binanceData;
  log('info', 'binance', `ETH: $${analysis.currentPrice.toFixed(2)} | Trend: ${analysis.trend} | RSI(1m): ${analysis.rsi['1m']?.toFixed(1) || 'N/A'} | RSI(30m): ${analysis.rsi['30m']?.toFixed(1) || 'N/A'}`);

  const balances = await getWalletBalances();
  log('info', 'wallet', `USDso: ${balances.usdso} | WETH: ${balances.weth} | Native: ${balances.native}`);

  const stats = getStrategyStats();
  const openPositions = getOpenPositions();
  const state = getState();
  const realizedPnl = state.cumulativePnl || 0;
  const lastDecision = state.lastDecision || null;
  const lastSlTime = state.lastSlTime || 0;
  const inSlCooldown = (Date.now() - lastSlTime) < SL_COOLDOWN_MS;

  if (openPositions.length > 0) {
    const currPos = openPositions[0];
    log('info', 'position', `Open: ${currPos.amount} WETH @ ${currPos.entryPrice} | SL: ${currPos.stopLoss} TP: ${currPos.takeProfit} (${currPos.side})`);
    return true;
  }

  if (inSlCooldown) {
    const remaining = Math.ceil((SL_COOLDOWN_MS - (Date.now() - lastSlTime)) / 1000);
    log('info', 'cooldown', `SL cooldown ${remaining}s remaining. Skipping trade.`);
    return true;
  }

  const decision = await getAIDecision({
    analysis,
    klines1m: binanceData.klines1m,
    klines30m: binanceData.klines30m,
    balances,
    stats,
    openPositions,
    realizedPnl,
    lastDecision,
    customPrompt: buildScalpingPrompt,
  });

  setState('lastDecision', { action: decision.action, reasoning: decision.reasoning, time: new Date().toISOString() });

  log('ai', 'decision', `${decision.action} | confidence: ${decision.confidence?.toFixed(2) || 'N/A'} | ${(decision.reasoning || '').substring(0, 120)}`);

  if (decision.action === 'HOLD') return true;

  const conf = parseFloat(decision.confidence || 0);
  if (conf < MIN_CONFIDENCE) {
    log('info', 'confidence', `${decision.action} skipped — confidence ${conf.toFixed(2)} < ${MIN_CONFIDENCE}`);
    return true;
  }

  const ob = await fetchOrderbook();
  const currentPrice = ob ? (ob.bestBid + ob.bestAsk) / 2 : analysis.currentPrice;

  let finalAmount = parseFloat(decision.amount || 0);
  if (decision.action === 'BUY') {
    const usdsoBalance = parseFloat(balances.usdso);
    const buyPower = usdsoBalance * 0.8;
    finalAmount = Math.floor((buyPower / currentPrice) * 10000) / 10000;
    if (finalAmount < 0.001) finalAmount = 0.001;
    log('info', 'sizing', `80% of USDso: $${buyPower.toFixed(2)} → ${finalAmount.toFixed(4)} WETH @ $${currentPrice.toFixed(2)}`);
  } else if (decision.action === 'SELL') {
    const wethBalance = parseFloat(balances.weth);
    finalAmount = Math.floor(wethBalance * 10000) / 10000;
    log('info', 'sizing', `Sell all WETH: ${finalAmount.toFixed(4)} WETH`);
  }

  let execPrice = parseFloat(decision.price || currentPrice);
  if (decision.action === 'BUY' && ob) {
    execPrice = ob.bestAsk + 0.05;
    log('info', 'exec', `BUY buffer: ask ${ob.bestAsk} + 0.05 = ${execPrice.toFixed(2)}`);
  } else if (decision.action === 'SELL' && ob) {
    execPrice = ob.bestBid - 0.05;
    log('info', 'exec', `SELL buffer: bid ${ob.bestBid} - 0.05 = ${execPrice.toFixed(2)}`);
  }

  log('info', 'ai', `AI wants: ${decision.action} ${finalAmount.toFixed(4)} @ ${execPrice.toFixed(2)}, SL: ${decision.stopLoss}, TP: ${decision.takeProfit}`);

  const tradeDecision = {
    ...decision,
    price: String(execPrice),
    amount: String(finalAmount),
  };

  const trade = await executeTrade(tradeDecision, ob);
  if (trade) {
    log('success', 'trade', `${tradeDecision.action} ${trade.amount} WETH @ ${trade.entryPrice} | SL: ${trade.stopLoss} TP: ${trade.takeProfit}`);
  }

  return true;
}

let stopFlag = false;

async function monitorPositions() {
  while (!stopFlag) {
    const positions = getOpenPositions();
    if (positions.length === 0) {
      await sleep(SL_CHECK_INTERVAL_MS);
      continue;
    }
    try {
      const ob = await fetchOrderbook();
      const price = ob ? (ob.bestBid + ob.bestAsk) / 2 : 0;
      if (price > 0) await checkStopLosses(price);
    } catch (err) {
      log('error', 'monitor', `Price check failed: ${err.message}`);
    }
    await sleep(SL_CHECK_INTERVAL_MS);
  }
}

async function main() {
  console.log(`\n\x1b[35m${'='.repeat(60)}\x1b[0m`);
  console.log(`\x1b[35m  DreamDEX AI Scalping Bot (Mainnet)\x1b[0m`);
  console.log(`\x1b[35m  Data: Binance ETHUSDT (1m + 30m)\x1b[0m`);
  console.log(`\x1b[35m  Interval: AI every 3 min | SL check every 5s\x1b[0m`);
  console.log(`\x1b[35m  Default TP: +${DEFAULT_TP_PERCENT}% | SL: -${DEFAULT_SL_PERCENT}%\x1b[0m`);
  console.log(`\x1b[35m  Wallet: ${botAccount.address}\x1b[0m`);
  console.log(`\x1b[35m${'='.repeat(60)}\x1b[0m\n`);

  try {
    log('info', 'main', 'Fetching market metadata...');
    await fetchMarketInfo();

    log('info', 'main', 'Approving tokens...');
    await approveIfNeeded(quoteToken, 'USDso', quoteDecimals);
    await approveIfNeeded(baseToken, 'WETH', 18);

    log('info', 'main', 'Initializing AI brain...');
    await initBrain();

    log('info', 'main', 'Authenticating...');
    await authenticate();

    log('info', 'main', 'Checking startup state...');
    const startupBal = await getWalletBalances();
    const startupPos = getOpenPositions();
    const startupWeth = parseFloat(startupBal.weth);
    if (startupWeth > 0.001 && startupPos.length === 0) {
      log('warn', 'main', `WETH ${startupWeth.toFixed(4)} found with no tracked position. Selling...`);
      await sellAllWeth(SELL_BUFFER);
      const after = await getWalletBalances();
      log('info', 'main', `Cleaned up. Wallet: ${after.usdso} USDso / ${after.weth} WETH`);
    }

    log('info', 'main', 'Starting position monitor...');
    monitorPositions();

    let running = true;
    let consecutiveErrors = 0;

    process.on('SIGINT', () => {
      log('info', 'main', 'Shutting down...');
      running = false;
      stopFlag = true;
      try { const server = getServer(); if (server) server.close(); } catch {}
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      log('info', 'main', 'Terminated.');
      running = false;
      stopFlag = true;
      try { const server = getServer(); if (server) server.close(); } catch {}
      process.exit(0);
    });

    while (running) {
      const cycleStart = Date.now();
      try {
        const shouldContinue = await runCycle();
        if (!shouldContinue) { running = false; break; }
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        log('error', 'main', `Cycle error: ${err.message}`);
        if (err.message.includes('auth') || err.message.includes('401')) {
          clearAuth();
          try { await authenticate(); } catch {}
        }
        if (consecutiveErrors >= 5) {
          log('error', 'main', 'Too many errors. Stopping.');
          running = false;
        }
      }
      const elapsed = Date.now() - cycleStart;
      const waitTime = Math.max(5000, SCALPING_INTERVAL_MS - elapsed);
      if (running) {
        log('cycle', 'main', `Cycle done in ${(elapsed / 1000).toFixed(1)}s. Next in ${(waitTime / 1000).toFixed(0)}s...`);
        await sleep(waitTime);
      }
    }

    log('info', 'main', 'Shutting down...');
    try { const server = getServer(); if (server) server.close(); } catch {}
    process.exit(0);
  } catch (err) {
    log('error', 'fatal', `Startup error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
