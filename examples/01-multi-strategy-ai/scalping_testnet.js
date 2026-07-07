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
import { parseUnits, formatUnits, formatEther, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from './config.js';
import { getAuthHeaders } from './utils/auth.js';
import { httpRequest } from './utils/http.js';
import { log } from './utils/logger.js';
import { publicClient, ERC20_ABI } from './executor/viemClient.js';
import { fetchMarketInfo } from './executor/vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// ====== Use new bot wallet ======
const BOT_PK = process.env.BOT_PK || CONFIG.PRIVATE_KEY;
const botAccount = privateKeyToAccount(BOT_PK);
const somniaTestnet = {
  id: CONFIG.CHAIN_ID,
  name: 'Somnia Testnet',
  network: 'somnia-testnet',
  nativeCurrency: { decimals: 18, name: 'Somnia Token', symbol: 'STT' },
  rpcUrls: { default: { http: [CONFIG.RPC_URL] }, public: { http: [CONFIG.RPC_URL] } },
};
const botWalletClient = createWalletClient({
  account: botAccount,
  chain: somniaTestnet,
  transport: http(),
});
log('info', 'wallet', `Using bot wallet: ${botAccount.address}`);

const PAIR = CONFIG.MARKET_SYMBOL;
const BUY_USDSO_VALUE = 10;
const APPROVE_AMOUNT = 1000000;
const POLL_INTERVAL_MS = 3000;
const RETRY_DELAY_MS = 2000;
const LOT_SIZE = 0.0001;
const BALANCE_CHECK_RETRY_MS = 1000;
const BALANCE_CHECK_MAX_RETRIES = 60;
const SELL_WAIT_MS = 3000;
const HOLD_POLL_MS = 500;
const MIN_CONSECUTIVE = 7;
const CONFIRM_COUNT = 3;
const MIN_MOVE = 0.50;
const SELL_BUFFER = 0.10;

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

// Directional reversal state
let dirCount = 0;
let lastDir = null;
let lastMid = 0;
let streakStartPrice = 0;
let bigMoveCount = 0;
let bigMoveDir = null;
let bigMoveStartPrice = 0;
let bigMoveEndPrice = 0;
let confirmCount = 0;
let phase = 'MONITOR';

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

async function gapMonitor(entryBid, entryAsk, tpAmount, slAmount) {
  log('info', 'hold', `Monitoring. EntryBid: ${entryBid.toFixed(6)} | EntryAsk: ${entryAsk.toFixed(6)} | TP: +${tpAmount.toFixed(2)} | SL: -${slAmount.toFixed(2)}`);

  while (!stopFlag) {
    const ob = await fetchOrderbook();
    if (ob && ob.bestBid > 0) {
      const bid = ob.bestBid;
      const tpGap = bid - entryAsk;
      const slGap = bid - entryBid;

      if (tpGap > tpAmount) {
        log('success', 'hold', `TP! bid=${bid.toFixed(6)} ask=${entryAsk.toFixed(6)} gap=${tpGap.toFixed(4)} > ${tpAmount.toFixed(2)}`);
        authHeaders = await getAuthHeaders(botWalletClient, botAccount);
        return await sellAllWeth(SELL_BUFFER);
      }

      if (slGap < -slAmount) {
        log('warn', 'hold', `SL! bid=${bid.toFixed(6)} bidRef=${entryBid.toFixed(6)} gap=${slGap.toFixed(4)} < -${slAmount.toFixed(2)}`);
        authHeaders = await getAuthHeaders(botWalletClient, botAccount);
        return await sellAllWeth(SELL_BUFFER);
      }
    }
    await sleep(HOLD_POLL_MS);
  }

  log('warn', 'hold', `Stop flag set. Force selling...`);
  authHeaders = await getAuthHeaders(botWalletClient, botAccount);
  return await sellAllWeth(SELL_BUFFER);
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

async function executeScalp(tpAmount, slAmount) {
  log('banner', 'scalp', `=== Buy Signal | TP: +${tpAmount.toFixed(2)} / SL: -${slAmount.toFixed(2)} ===`);

  const bal = await getWalletBalances();
  const existingWeth = parseFloat(bal.weth);

  if (existingWeth >= 0.001) {
    log('warn', 'scalp', `WETH ${existingWeth.toFixed(4)} leftover. Selling first...`);
    authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    await sellAllWeth(0.30);
  }

  if (parseFloat(bal.usdso) < BUY_USDSO_VALUE) {
    log('error', 'scalp', `Insufficient USDso: ${bal.usdso}. Exiting.`);
    process.exit(1);
  }

  const ob = await fetchOrderbook();
  if (!ob || ob.bestAsk <= 0) {
    log('error', 'scalp', 'Cannot fetch ask. Aborting.');
    return;
  }
  const entryAsk = ob.bestAsk;
  const entryBid = ob.bestBid;

  let buyAmount = (BUY_USDSO_VALUE * 0.995) / entryAsk;
  buyAmount = roundToLotSize(buyAmount);
  if (buyAmount <= 0) return;
  log('info', 'scalp', `Buying ${buyAmount.toFixed(4)} WETH @ ask ${entryAsk.toFixed(6)} (bid ref: ${entryBid.toFixed(6)})`);

  let buyResult = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const buyPrice = roundToTickSize(entryAsk + attempt * 0.10);
    authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    buyResult = await placeWalletLimitOrder('buy', buyPrice.toFixed(8), buyAmount.toFixed(4));
    if (buyResult && buyResult.filled) break;
    if (attempt < 2) {
      log('info', 'scalp', `Buy not filled at ${buyPrice.toFixed(6)}, retrying at ${roundToTickSize(buyPrice + 0.10).toFixed(6)}...`);
      await sleep(500);
    }
  }
  if (!buyResult || !buyResult.filled) {
    log('info', 'scalp', 'Buy not filled after 3 retries. Will retry next poll.');
    return;
  }

  const totalWeth = await waitForWethInWallet(BALANCE_CHECK_MAX_RETRIES * BALANCE_CHECK_RETRY_MS);
  if (totalWeth <= 0) {
    log('error', 'scalp', 'WETH never appeared. Aborting.');
    return;
  }
  log('info', 'scalp', `WETH received: ${totalWeth.toFixed(8)}. EntryBid: ${entryBid.toFixed(6)}`);

  log('info', 'scalp', 'Stabilizing 3s before monitoring...');
  await sleep(3000);

  await gapMonitor(entryBid, entryAsk, tpAmount, slAmount);

  if (!stopFlag) {
    log('info', 'scalp', `Waiting ${SELL_WAIT_MS / 1000}s before next cycle...`);
    await sleep(SELL_WAIT_MS);
  }
}

async function runBot() {
  log('banner', 'startup', '=== DreamDex Scalping Testnet ===');
  log('banner', 'startup', `Pair: ${PAIR} | Buy: ${BUY_USDSO_VALUE} USDso | ${MIN_CONSECUTIVE}+ cons & ≥$${MIN_MOVE} move → confirm ${CONFIRM_COUNT}x | TP: move/3 (min 0.44) | SL: move/6 (min 0.50)`);

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

      const mid = (ob.bestBid + ob.bestAsk) / 2;

      // First poll: initialize lastMid only
      if (lastMid === 0 || lastDir === null) {
        lastMid = mid;
        lastDir = 'UP';
        isTrading = false;
        return;
      }

      const currentDir = mid > lastMid ? 'UP' : mid < lastMid ? 'DOWN' : lastDir;
      if (phase === 'MONITOR' && currentDir === lastDir && dirCount === 0) streakStartPrice = lastMid;
      lastMid = mid;

      if (phase === 'MONITOR') {
        if (currentDir === lastDir) {
          dirCount++;
          if (dirCount >= MIN_CONSECUTIVE) {
            const totalMove = Math.abs(lastMid - streakStartPrice);
            if (totalMove >= MIN_MOVE) {
              bigMoveCount = dirCount;
              bigMoveDir = lastDir;
              bigMoveStartPrice = streakStartPrice;
              phase = 'BIG_MOVE';
              log('info', 'phase', `BIG_MOVE ${lastDir} ${bigMoveCount}x ($${totalMove.toFixed(2)}). Awaiting reversal...`);
            }
          }
        } else {
          dirCount = 1;
          streakStartPrice = lastMid;
        }
      } else if (phase === 'BIG_MOVE') {
        bigMoveEndPrice = lastMid;
        if (currentDir === lastDir) {
          bigMoveCount++;
        } else {
          phase = 'CONFIRM';
          confirmCount = 1;
          log('info', 'phase', `Reversal start. ${bigMoveDir}→${currentDir} (${confirmCount}/${CONFIRM_COUNT})...`);
        }
      } else if (phase === 'CONFIRM') {
        if (currentDir === lastDir) {
          confirmCount++;
          log('info', 'phase', `Confirmed ${confirmCount}/${CONFIRM_COUNT}...`);
          if (confirmCount >= CONFIRM_COUNT) {
            const action = bigMoveDir === 'DOWN' ? 'BUY' : 'SELL';
            const totalMove = Math.abs(bigMoveEndPrice - bigMoveStartPrice);
            const tpAmount = Math.max(0.44, totalMove / 3);
            const slAmount = Math.max(0.50, totalMove / 6);
            log('success', 'phase', `${action}! Big ${bigMoveCount}x ${bigMoveDir} ($${totalMove.toFixed(2)}) → TP:+${tpAmount.toFixed(2)} / SL:-${slAmount.toFixed(2)}`);
            const capturedTp = tpAmount;
            const capturedSl = slAmount;
            phase = 'MONITOR'; dirCount = 0; lastDir = null; bigMoveCount = 0; bigMoveDir = null; bigMoveStartPrice = 0; bigMoveEndPrice = 0; streakStartPrice = 0; confirmCount = 0; lastMid = 0;
            if (action === 'BUY') {
              try { await executeScalp(capturedTp, capturedSl); } finally { isTrading = false; }
            } else {
              log('info', 'phase', 'SELL signal. Selling any WETH...');
              authHeaders = await getAuthHeaders(botWalletClient, botAccount);
              await sellAllWeth(SELL_BUFFER);
              isTrading = false;
            }
            return;
          }
        } else {
          log('info', 'phase', 'Reversal failed, back to MONITOR.');
          phase = 'MONITOR'; dirCount = 0; lastDir = null; bigMoveCount = 0; bigMoveDir = null; bigMoveStartPrice = 0; bigMoveEndPrice = 0; streakStartPrice = 0; confirmCount = 0; lastMid = 0;
        }
      }

      lastDir = currentDir;
      isTrading = false;
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
