/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseUnits, formatUnits, formatEther, createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from './config.js';
import { getAuthHeaders } from './utils/auth.js';
import { httpRequest } from './utils/http.js';
import { log } from './utils/logger.js';
import { ERC20_ABI } from './executor/viemClient.js';
import { fetchMarketInfo } from './executor/vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// ====== Override CONFIG with MAINNET env vars ======
CONFIG.RPC_URL = process.env.MAINNET_RPC_URL || CONFIG.RPC_URL;
CONFIG.API_URL = process.env.MAINNET_API_URL || CONFIG.API_URL;
CONFIG.CHAIN_ID = parseInt(process.env.MAINNET_CHAIN_ID || String(CONFIG.CHAIN_ID), 10);
log('info', 'config', `Mainnet: RPC=${CONFIG.RPC_URL} | API=${CONFIG.API_URL} | ChainID=${CONFIG.CHAIN_ID}`);

const mainnetChain = {
  id: CONFIG.CHAIN_ID,
  name: 'Somnia',
  nativeCurrency: { decimals: 18, name: 'Somnia Token', symbol: 'STT' },
  rpcUrls: { default: { http: [CONFIG.RPC_URL] }, public: { http: [CONFIG.RPC_URL] } },
};

const mainnetPublicClient = createPublicClient({ chain: mainnetChain, transport: http() });
// Rebind publicClient so rest of script uses mainnet
const publicClient = mainnetPublicClient;

// ====== Use mainnet bot wallet ======
const BOT_PK = process.env.MAINNET_BOT_PK || CONFIG.PRIVATE_KEY;
const botAccount = privateKeyToAccount(BOT_PK);
const botWalletClient = createWalletClient({
  account: botAccount,
  chain: mainnetChain,
  transport: http(),
});
log('info', 'wallet', `Using mainnet wallet: ${botAccount.address}`);

const PAIR = CONFIG.MARKET_SYMBOL;
const SPREAD_THRESHOLD = 0.43; // USDso absolute
const BUY_USDSO_VALUE = 10;
const APPROVE_AMOUNT = 1000000;
const POLL_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 2000;
const LOT_SIZE = 0.0001; // WETH lot size from API error
const BALANCE_CHECK_RETRY_MS = 1000; // cek WETH tiap 1 detik setelah buy
const BALANCE_CHECK_MAX_RETRIES = 60; // max 60 detik nunggu WETH muncul
const SELL_WAIT_MS = 3000; // tunggu 3 detik setelah sell sukses
const TREND_POLLS = 40;
const HOLD_TIMEOUT_MS = 5 * 60 * 1000;

const TICK_SIZE = 0.01;

function roundToLotSize(amount, lotSize = LOT_SIZE) {
  return Math.floor(amount / lotSize + 1e-9) * lotSize;
}

function roundToTickSize(amount, tickSize = TICK_SIZE) {
  return Math.round(amount / tickSize + 1e-9) * tickSize;
}

let poolAddress = null;
let baseToken = null;
let quoteToken = null;
let quoteDecimals = 6; // USDso decimals
let authHeaders = null;
let isTrading = false;
let stopFlag = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWalletBalances() {
  const native = await publicClient.getBalance({ address: botAccount.address });
  const usdsoBal = await publicClient.readContract({
    address: quoteToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [botAccount.address],
  });
  const wethBal = await publicClient.readContract({
    address: baseToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [botAccount.address],
  });
  return {
    native: formatEther(native),
    usdso: formatUnits(usdsoBal, quoteDecimals),
    usdsoRaw: usdsoBal,
    weth: formatUnits(wethBal, 18),
    wethRaw: wethBal,
  };
}

async function approveIfNeeded(tokenAddress, tokenSymbol, tokenDecimals) {
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [botAccount.address, poolAddress],
  });
  const approveRaw = parseUnits(String(APPROVE_AMOUNT), tokenDecimals);
  if (allowance < approveRaw) {
    log('info', 'approve', `Approving ${APPROVE_AMOUNT} ${tokenSymbol}...`);
    const tx = await botWalletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [poolAddress, approveRaw * 10n],
      gas: 5000000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60000 });
    log('success', 'approve', `${tokenSymbol} approved.`);
  } else {
    log('info', 'approve', `${tokenSymbol} already approved.`);
  }
}

async function authenticate() {
  authHeaders = await getAuthHeaders(botWalletClient, botAccount);
  log('success', 'auth', 'Authenticated.');
}

async function fetchOrderbook() {
  const res = await httpRequest('GET', `/v0/orderbooks?symbols=${PAIR}`);
  if (res.status !== 200 || !res.body) return null;
  const obs = res.body.orderbooks || [res.body];
  const ob = obs[0] || {};
  const bids = ob.bids || [];
  const asks = ob.asks || [];
  if (bids.length === 0 || asks.length === 0) return null;
  const bestBid = parseFloat(bids[0].price || bids[0][0] || 0);
  const bestAsk = parseFloat(asks[0].price || asks[0][0] || 0);
  const bidQty = parseFloat(bids[0].quantity || bids[0].amount || bids[0][1] || 0);
  const askQty = parseFloat(asks[0].quantity || asks[0].amount || asks[0][1] || 0);
  return { bestBid, bestAsk, bidQty, askQty, spread: bestAsk - bestBid };
}

async function placeWalletLimitOrder(side, price, amount) {
  const payload = {
    type: 'limit',
    side: side.toLowerCase(),
    price: String(price),
    amount: String(amount),
    walletAddress: botAccount.address,
    fundingSource: 'wallet',
    orderType: 'immediateOrCancel',
  };
  log('info', 'trade', `Placing LIMIT ${side.toUpperCase()} ${amount} WETH @ ${price} USDso via wallet (IOC)...`);
  const prep = await httpRequest('POST', `/v0/markets/${PAIR}/orders`, authHeaders, payload);
  if (prep.status !== 200 || !prep.body?.to) {
    log('error', 'trade', `Prepare failed: ${prep.status} ${JSON.stringify(prep.body)}`);
    return null;
  }
  const p = prep.body;
  const txHash = await botWalletClient.sendTransaction({
    to: p.to,
    data: p.data,
    value: p.value ? BigInt(p.value) : 0n,
    gas: p.gasLimit ? BigInt(p.gasLimit) : 8000000n,
  });
  log('info', 'trade', `Tx sent: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45000 });
  if (receipt.status !== 'success') {
    log('error', 'trade', 'Tx reverted');
    return null;
  }

  // Check if IOC order was actually filled (look for ORDER_PLACED event)
  const ORDER_PLACED_TOPIC = '0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d';
  let wasFilled = false;
  let orderId = null;
  for (const logEntry of receipt.logs) {
    if (logEntry.topics?.[0] === ORDER_PLACED_TOPIC) {
      wasFilled = true;
      orderId = BigInt(logEntry.topics[1]).toString();
      break;
    }
  }

  if (!wasFilled) {
    log('warn', 'trade', `${side.toUpperCase()} IOC was NOT filled (cancelled) at ${price}.`);
    return { txHash, receipt, filled: false };
  }

  log('success', 'trade', `${side.toUpperCase()} filled! Tx: ${txHash} OrderID: ${orderId}`);
  return { txHash, receipt, filled: true };
}

async function waitForWethInWallet(timeoutMs) {
  // Loop cek balance WETH tiap 1 detik sampai muncul
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !stopFlag) {
    const bal = await getWalletBalances();
    const weth = parseFloat(bal.weth);
    if (weth > 0) {
      return weth;
    }
    log('info', 'scalp', `Waiting for WETH to appear in wallet... current: ${weth} WETH`);
    await sleep(BALANCE_CHECK_RETRY_MS);
  }
  return 0;
}

/**
 * Retry IOC order with increasing buffer if not filled
 * isBuy=true: price = base + buffer*n, isBuy=false: price = base - buffer*n
 */
async function placeIocWithRetry(side, basePrice, amount, maxRetries = 5) {
  const isBuy = side === 'buy';
  const bufferIncrement = 0.10; // naik 0.10 per retry
  let currentPrice = basePrice;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    authHeaders = await getAuthHeaders(botWalletClient, botAccount);

    const result = await placeWalletLimitOrder(side, currentPrice.toFixed(8), amount);
    if (result && result.filled) return result;
    if (!result) return null; // tx revert, tidak retry

    // Naikkan buffer untuk retry berikutnya
    currentPrice = isBuy ? currentPrice + bufferIncrement : currentPrice - bufferIncrement;
    log('info', 'scalp', `${side.toUpperCase()} not filled at ${(isBuy ? currentPrice - bufferIncrement : currentPrice + bufferIncrement).toFixed(8)}, retrying at ${currentPrice.toFixed(8)} (attempt ${attempt + 2}/${maxRetries})`);
    await sleep(500);
  }

  log('error', 'scalp', `${side.toUpperCase()} not filled after ${maxRetries} retries.`);
  return null;
}

async function analyzeTrend() {
  const askPrices = [];
  const bidPrices = [];
  log('info', 'trend', `Analyzing trend over ${TREND_POLLS} polls...`);
  for (let i = 0; i < TREND_POLLS; i++) {
    if (stopFlag) return null;
    try {
      const ob = await fetchOrderbook();
      if (ob) {
        if (ob.bestAsk > 0) askPrices.push(ob.bestAsk);
        if (ob.bestBid > 0) bidPrices.push(ob.bestBid);
      }
    } catch {}
    await sleep(POLL_INTERVAL_MS);
  }
  if (askPrices.length < 2 || bidPrices.length < 2) return { trend: 'FLAT', volatility: 0 };

  const askFirst = askPrices[0];
  const askLast = askPrices[askPrices.length - 1];
  const bidFirst = bidPrices[0];
  const bidLast = bidPrices[bidPrices.length - 1];
  const askDiff = askLast - askFirst;
  const bidDiff = bidLast - bidFirst;
  const volatility = Math.max(...askPrices) - Math.min(...askPrices);

  log('info', 'trend', `Samples: ${askPrices.length} | Ask: ${askFirst.toFixed(6)}→${askLast.toFixed(6)} (${askDiff > 0 ? '+' : ''}${askDiff.toFixed(6)}) | Bid: ${bidFirst.toFixed(6)}→${bidLast.toFixed(6)} (${bidDiff > 0 ? '+' : ''}${bidDiff.toFixed(6)}) | Vol: ${volatility.toFixed(6)}`);

  // Double confirmation: ask AND bid must agree
  if (askDiff > 0 && bidDiff > 0) return { trend: 'UP', volatility, askFirst, askLast };
  if (askDiff < 0 && bidDiff < 0) return { trend: 'DOWN', volatility, askFirst, askLast };
  return { trend: 'FLAT', volatility };
}

async function holdAndMonitor(entryPrice, volatility) {
  const tpAmount = Math.max(0.5, Math.min(1.0, volatility * 2));
  const slAmount = Math.max(0.6, Math.min(0.8, volatility * 2));
  const sellBuffer = Math.max(0.10, Math.min(0.50, volatility * 0.5));
  const start = Date.now();

  log('info', 'hold', `Holding. Entry: ${entryPrice.toFixed(6)} | Vol: ${volatility.toFixed(4)} | TP: +${tpAmount.toFixed(2)} @ ${(entryPrice + tpAmount).toFixed(6)} | SL: -${slAmount.toFixed(2)} @ ${(entryPrice - slAmount).toFixed(6)} | Sell buffer: ${sellBuffer.toFixed(2)}`);

  while (!stopFlag && Date.now() - start < HOLD_TIMEOUT_MS) {
    const ob = await fetchOrderbook();
    if (ob && ob.bestBid > 0) {
      const bid = ob.bestBid;
      const pnl = bid - entryPrice;

      if (bid >= entryPrice + tpAmount) {
        log('success', 'hold', `TP! Bid ${bid.toFixed(6)} >= ${(entryPrice + tpAmount).toFixed(6)} | PnL: ${pnl.toFixed(6)}`);
        authHeaders = await getAuthHeaders(botWalletClient, botAccount);
        return await sellAllWeth(sellBuffer);
      }

      if (bid <= entryPrice - slAmount) {
        log('warn', 'hold', `SL! Bid ${bid.toFixed(6)} <= ${(entryPrice - slAmount).toFixed(6)} | PnL: ${pnl.toFixed(6)}`);
        authHeaders = await getAuthHeaders(botWalletClient, botAccount);
        return await sellAllWeth(sellBuffer);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log('warn', 'hold', `Hold timeout. Force selling...`);
  authHeaders = await getAuthHeaders(botWalletClient, botAccount);
  return await sellAllWeth(0.50);
}

async function sellAllWeth(sellBuffer = 0) {
  while (!stopFlag) {
    const bal = await getWalletBalances();
    let weth = roundToLotSize(parseFloat(bal.weth));
    if (weth <= 0) return true;

    const ob = await fetchOrderbook();
    const bid = ob ? ob.bestBid : 0;
    if (bid <= 0) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const sellPrice = roundToTickSize(bid - sellBuffer);
    log('info', 'sell', `Selling ${weth.toFixed(4)} WETH @ ${sellPrice.toFixed(6)} (bid ${bid.toFixed(6)} - buffer ${sellBuffer.toFixed(2)})`);

    authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    const result = await placeWalletLimitOrder('sell', sellPrice.toFixed(8), weth.toFixed(4));

    if (result && result.filled) {
      const after = await getWalletBalances();
      const remaining = roundToLotSize(parseFloat(after.weth));
      if (remaining > 0) {
        if (remaining >= 0.001) {
          log('warn', 'sell', `Partial fill! ${weth.toFixed(4)} → ${remaining.toFixed(4)} remaining. Selling rest...`);
          continue;
        }
        log('info', 'sell', `Partial fill! ${remaining.toFixed(4)} WETH remaining (< 0.001), skipping.`);
        return true;
      }
      log('success', 'sell', `Sold all. Wallet: ${after.usdso} USDso, ${after.weth} WETH`);
      return true;
    }

    log('warn', 'sell', `Sell not filled. Retrying in ${RETRY_DELAY_MS}ms...`);
    await sleep(RETRY_DELAY_MS);
  }
  return false;
}

async function executeScalp() {
  log('banner', 'scalp', '=== New Cycle Started ===');

  // Fase 0: Trend Analysis (40 polling)
  let trendInfo;
  do {
    trendInfo = await analyzeTrend();
    if (stopFlag || trendInfo === null) return;
    if (trendInfo.trend === 'FLAT') {
      log('info', 'trend', 'FLAT. Re-analyzing 40 polls...');
    }
  } while (trendInfo.trend === 'FLAT');

  const bal = await getWalletBalances();

  if (trendInfo.trend === 'DOWN') {
    log('info', 'trend', 'Trend DOWN. Skipping buy.');
    const trendWeth = parseFloat(bal.weth);
    if (trendWeth >= 0.001) {
      log('warn', 'trend', `WETH ${trendWeth.toFixed(4)} detected. Selling...`);
      authHeaders = await getAuthHeaders(botWalletClient, botAccount);
      await sellAllWeth(0.30);
    } else if (trendWeth > 0) {
      log('info', 'trend', `WETH ${trendWeth.toFixed(4)} detected (< 0.001), skipping sell.`);
    }
    return;
  }

  // Trend UP → BUY
  log('success', 'trend', `Trend UP! Volatility: ${trendInfo.volatility.toFixed(4)}. Buying...`);

  if (parseFloat(bal.usdso) < BUY_USDSO_VALUE) {
    log('error', 'scalp', `Insufficient USDso: ${bal.usdso}. Exiting.`);
    process.exit(1);
  }

  const freshOb = await fetchOrderbook();
  if (!freshOb || freshOb.bestAsk <= 0) {
    log('error', 'scalp', 'Cannot fetch ask. Aborting.');
    return;
  }
  const entryPrice = freshOb.bestAsk;

  let buyAmountWeth = (BUY_USDSO_VALUE * 0.995) / entryPrice;
  buyAmountWeth = roundToLotSize(buyAmountWeth);
  if (buyAmountWeth <= 0) return;
  log('info', 'scalp', `Buying ${buyAmountWeth.toFixed(4)} WETH @ ask ${entryPrice.toFixed(6)} (≈${BUY_USDSO_VALUE} USDso)`);

  // Dynamic buy buffer based on volatility
  let buyBuffer = 0;
  if (trendInfo.volatility > 1.5) buyBuffer = 0.50;
  else if (trendInfo.volatility > 0.5) buyBuffer = 0.20;

  const buyBasePrice = roundToTickSize(entryPrice + buyBuffer);
  log('info', 'scalp', `Volatility: ${trendInfo.volatility.toFixed(4)} → buy buffer: ${buyBuffer.toFixed(2)} → start at ${buyBasePrice.toFixed(6)}`);

  const buyResult = await placeIocWithRetry('buy', buyBasePrice, buyAmountWeth.toFixed(4));
  if (!buyResult) {
    log('error', 'scalp', 'BUY failed. Aborting.');
    return;
  }

  const totalWeth = await waitForWethInWallet(BALANCE_CHECK_MAX_RETRIES * BALANCE_CHECK_RETRY_MS);
  if (totalWeth <= 0) {
    log('error', 'scalp', 'WETH never appeared. Aborting.');
    return;
  }
  log('info', 'scalp', `WETH received: ${totalWeth.toFixed(8)}. Entry: ${entryPrice.toFixed(6)}`);

  // Fase Hold: Monitor TP/SL (dynamic)
  await holdAndMonitor(entryPrice, trendInfo.volatility);

  // Wait 3s before resuming
  if (!stopFlag) {
    log('info', 'scalp', `Waiting ${SELL_WAIT_MS / 1000}s before next cycle...`);
    await sleep(SELL_WAIT_MS);
  }
}

async function runBot() {
  log('banner', 'startup', '=== DreamDex Auto Scalp Bot ===');
  log('banner', 'startup', `Pair: ${PAIR} | Buy: ${BUY_USDSO_VALUE} USDso | Trend: ${TREND_POLLS}x polls (bid+ask) | TP/SL: dynamic (×volatility) | Sell buffer: dynamic`);

  // 1. Fetch market metadata
  log('info', 'startup', 'Fetching market info...');
  const marketInfo = await fetchMarketInfo();
  poolAddress = marketInfo.poolAddress;
  baseToken = marketInfo.baseToken;
  quoteToken = marketInfo.quoteToken;

  // Ambil decimals USDso dari chain
  try {
    const dec = await publicClient.readContract({
      address: quoteToken,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    quoteDecimals = dec;
  } catch {
    log('warn', 'startup', 'Could not read USDso decimals, defaulting to 6');
  }

  // 2. Check wallet balance
  let balances = await getWalletBalances();
  log('info', 'startup', `Wallet: ${balances.usdso} USDso | ${balances.weth} WETH | ${balances.native} SOMI`);

  // 3. Authenticate
  await authenticate();

  // 4. Sell any leftover WETH before starting
  const startupWeth = parseFloat(balances.weth);
  if (startupWeth >= 0.001) {
    log('warn', 'startup', `Found ${startupWeth.toFixed(4)} WETH in wallet. Selling before starting cycles...`);
    await sellAllWeth(0.30);
    balances = await getWalletBalances();
    log('info', 'startup', `After sell: ${balances.usdso} USDso, ${balances.weth} WETH`);
  } else if (startupWeth > 0) {
    log('info', 'startup', `Found ${startupWeth.toFixed(4)} WETH (< 0.001), skipping sell.`);
  }

  if (parseFloat(balances.usdso) < BUY_USDSO_VALUE) {
    log('error', 'startup', `Wallet has only ${balances.usdso} USDso. Need at least ${BUY_USDSO_VALUE}. Exiting.`);
    process.exit(1);
  }

  // 5. Approve tokens (one-time)
  await approveIfNeeded(quoteToken, 'USDso', quoteDecimals);
  await approveIfNeeded(baseToken, 'WETH', 18);

  // 6. Start polling
  log('info', 'startup', `Starting orderbook polling every ${POLL_INTERVAL_MS}ms...`);

  const intervalId = setInterval(async () => {
    if (isTrading || stopFlag) return;
    isTrading = true;
    try {
      const ob = await fetchOrderbook();
      if (!ob) {
        log('warn', 'poll', 'Orderbook fetch returned empty');
        isTrading = false;
        return;
      }
      log('info', 'poll', `Orderbook | Bid: ${ob.bestBid.toFixed(8)} (${ob.bidQty.toFixed(4)}) | Ask: ${ob.bestAsk.toFixed(8)} (${ob.askQty.toFixed(4)}) | Spread: ${ob.spread.toFixed(6)}`);
      try {
        await executeScalp();
      } finally {
        isTrading = false;
      }
    } catch (err) {
      log('error', 'poll', err.message);
      isTrading = false;
    }
  }, POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('info', 'shutdown', 'SIGINT received. Stopping...');
    stopFlag = true;
    clearInterval(intervalId);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('info', 'shutdown', 'SIGTERM received. Stopping...');
    stopFlag = true;
    clearInterval(intervalId);
    process.exit(0);
  });
}

runBot().catch((err) => {
  log('error', 'fatal', err.message);
  console.error(err);
  process.exit(1);
});
