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

// ====== Mainnet Config ======
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
const publicClient = mainnetPublicClient;

const BOT_PK = process.env.MAINNET_BOT_PK || CONFIG.PRIVATE_KEY;
const botAccount = privateKeyToAccount(BOT_PK);
const botWalletClient = createWalletClient({
  account: botAccount, chain: mainnetChain, transport: http(),
});
log('info', 'wallet', `Mainnet wallet: ${botAccount.address}`);

// ====== Constants ======
const PAIR = CONFIG.MARKET_SYMBOL;
const BUY_USDSO = 30;
const APPROVE_AMOUNT = 1000000;
const POLL_INTERVAL_MS = 60000; // 1 minute
const RETRY_DELAY_MS = 2000;
const LOT_SIZE = 0.0001;
const BALANCE_CHECK_RETRY_MS = 1000;
const BALANCE_CHECK_MAX_RETRIES = 60;
const SELL_WAIT_MS = 3000;
const HOLD_POLL_MS = 500;
const BUY_BUFFER = 0.01;
const SELL_BUFFER = 0.01;
const TP_AMOUNT = 2.0;
const SL_AMOUNT = 1.0;
const MAX_BUY_RETRIES = 3;
const MIN_RANGE = 3;
const COOLDOWN_POLLS = 3;
const NORMAL_WINDOW = 5;
const SL_WINDOW = 10;

const TICK_SIZE = 0.01;

function roundToLotSize(amount) {
  return Math.floor(amount / LOT_SIZE + 1e-9) * LOT_SIZE;
}

function roundToTickSize(amount) {
  return Math.round(amount / TICK_SIZE + 1e-9) * TICK_SIZE;
}

let poolAddress = null;
let baseToken = null;
let quoteToken = null;
let quoteDecimals = 6;
let authHeaders = null;
let isTrading = false;
let stopFlag = false;

// Strategy state
let priceWindow = [];
let cooldown = 0;
let windowSize = NORMAL_WINDOW;
let initialBalance = 0;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getWalletBalances() {
  const native = await publicClient.getBalance({ address: botAccount.address });
  const usdsoBal = await publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [botAccount.address] });
  const wethBal = await publicClient.readContract({ address: baseToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [botAccount.address] });
  return {
    native: formatEther(native),
    usdso: formatUnits(usdsoBal, quoteDecimals),
    weth: formatUnits(wethBal, 18),
  };
}

async function approveIfNeeded(tokenAddress, tokenSymbol, tokenDecimals) {
  const allowance = await publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance', args: [botAccount.address, poolAddress] });
  const raw = parseUnits(String(APPROVE_AMOUNT), tokenDecimals);
  if (allowance < raw) {
    log('info', 'approve', `Approving ${APPROVE_AMOUNT} ${tokenSymbol}...`);
    const tx = await botWalletClient.writeContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'approve', args: [poolAddress, raw * 10n], gas: 5000000n });
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
  return {
    bestBid: parseFloat(bids[0].price || bids[0][0] || 0),
    bestAsk: parseFloat(asks[0].price || asks[0][0] || 0),
    bidQty: parseFloat(bids[0].quantity || bids[0].amount || bids[0][1] || 0),
    askQty: parseFloat(asks[0].quantity || asks[0].amount || asks[0][1] || 0),
    spread: parseFloat(asks[0].price || asks[0][0] || 0) - parseFloat(bids[0].price || bids[0][0] || 0),
  };
}

async function placeWalletLimitOrder(side, price, amount) {
  const payload = {
    type: 'limit', side: side.toLowerCase(), price: String(price), amount: String(amount),
    walletAddress: botAccount.address, fundingSource: 'wallet', orderType: 'immediateOrCancel',
  };
  log('info', 'trade', `Placing ${side.toUpperCase()} ${amount} WETH @ ${price} (IOC)`);
  const prep = await httpRequest('POST', `/v0/markets/${PAIR}/orders`, authHeaders, payload);
  if (prep.status !== 200 || !prep.body?.to) {
    log('error', 'trade', `Prepare failed: ${prep.status}`);
    return null;
  }
  const p = prep.body;
  const txHash = await botWalletClient.sendTransaction({
    to: p.to, data: p.data, value: p.value ? BigInt(p.value) : 0n, gas: p.gasLimit ? BigInt(p.gasLimit) : 8000000n,
  });
  log('info', 'trade', `Tx: ${txHash}`);
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

async function waitForWethInWallet(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !stopFlag) {
    const bal = await getWalletBalances();
    const weth = parseFloat(bal.weth);
    if (weth > 0) return weth;
    await sleep(BALANCE_CHECK_RETRY_MS);
  }
  return 0;
}

async function sellAllWeth(sellBuffer = 0) {
  while (!stopFlag) {
    const bal = await getWalletBalances();
    let weth = roundToLotSize(parseFloat(bal.weth));
    if (weth <= 0) return true;

    const ob = await fetchOrderbook();
    const bid = ob ? ob.bestBid : 0;
    if (bid <= 0) { await sleep(RETRY_DELAY_MS); continue; }

    const sellPrice = roundToTickSize(bid - sellBuffer);
    log('info', 'sell', `Selling ${weth.toFixed(4)} WETH @ ${sellPrice.toFixed(6)} (bid ${bid.toFixed(4)} - buffer ${sellBuffer})`);
    authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    const result = await placeWalletLimitOrder('sell', sellPrice.toFixed(8), weth.toFixed(4));

    if (result && result.filled) {
      const after = await getWalletBalances();
      const remaining = roundToLotSize(parseFloat(after.weth));
      if (remaining > 0) {
        if (remaining >= 0.001) { log('warn', 'sell', `Partial fill, selling rest...`); continue; }
        log('info', 'sell', `${remaining.toFixed(4)} remaining (< 0.001), skip.`);
        return true;
      }
      const pnl = parseFloat(after.usdso) - initialBalance;
      log('success', 'sell', `Sold all. Wallet: ${after.usdso} USDso | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`);
      return true;
    }
    log('warn', 'sell', `Not filled, retrying...`);
    await sleep(RETRY_DELAY_MS);
  }
  return false;
}

// ====== Core Strategy ======

async function gapMonitor(entryBid, entryAsk) {
  log('info', 'hold', `Monitoring. EntryBid=${entryBid.toFixed(4)} EntryAsk=${entryAsk.toFixed(4)} TP:+${TP_AMOUNT} SL:-${SL_AMOUNT}`);

  while (!stopFlag) {
    const ob = await fetchOrderbook();
    if (ob && ob.bestBid > 0) {
      const bid = ob.bestBid;
      if (bid >= entryAsk + TP_AMOUNT) {
        log('success', 'hold', `TP! bid=${bid.toFixed(4)} >= ${(entryAsk + TP_AMOUNT).toFixed(4)}`);
        authHeaders = await getAuthHeaders(botWalletClient, botAccount);
        await sellAllWeth(SELL_BUFFER);
        const bal = await getWalletBalances();
        const pnl = parseFloat(bal.usdso) - initialBalance;
        log('success', 'hold', `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDso`);
        return 'TP';
      }
      if (bid <= entryBid - SL_AMOUNT) {
        log('warn', 'hold', `SL! bid=${bid.toFixed(4)} <= ${(entryBid - SL_AMOUNT).toFixed(4)}`);
        authHeaders = await getAuthHeaders(botWalletClient, botAccount);
        await sellAllWeth(SELL_BUFFER);
        const bal = await getWalletBalances();
        const pnl = parseFloat(bal.usdso) - initialBalance;
        log('warn', 'hold', `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDso`);
        return 'SL';
      }
    }
    await sleep(HOLD_POLL_MS);
  }
  authHeaders = await getAuthHeaders(botWalletClient, botAccount);
  await sellAllWeth(SELL_BUFFER);
  return 'SL';
}

async function executeScalp() {
  log('banner', 'scalp', `Buy | TP:+${TP_AMOUNT} SL:-${SL_AMOUNT}`);

  const bal = await getWalletBalances();
  if (parseFloat(bal.usdso) < BUY_USDSO) { log('error', 'scalp', 'Insufficient USDso'); return; }

  if (parseFloat(bal.weth) >= 0.001) {
    log('warn', 'scalp', `WETH ${parseFloat(bal.weth).toFixed(4)} leftover, selling first...`);
    authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    await sellAllWeth(SELL_BUFFER);
  }

  const ob = await fetchOrderbook();
  if (!ob || ob.bestAsk <= 0) return;
  const entryAsk = ob.bestAsk;
  const entryBid = ob.bestBid;

  let buyAmount = roundToLotSize(BUY_USDSO / entryAsk);
  if (buyAmount <= 0) return;
  log('info', 'scalp', `Buy ${buyAmount.toFixed(4)} WETH @ ask ${entryAsk.toFixed(4)} + buffer ${BUY_BUFFER}`);

  let buyResult = null;
  for (let attempt = 0; attempt < MAX_BUY_RETRIES; attempt++) {
    const buyPrice = roundToTickSize(entryAsk + BUY_BUFFER).toFixed(8);
    authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    buyResult = await placeWalletLimitOrder('buy', buyPrice, buyAmount.toFixed(8));
    if (buyResult && buyResult.filled) break;
    log('info', 'scalp', `Retry ${attempt + 2}/${MAX_BUY_RETRIES}...`);
    await sleep(500);
  }
  if (!buyResult || !buyResult.filled) {
    log('info', 'scalp', 'Buy failed after retries.');
    return;
  }

  const totalWeth = await waitForWethInWallet(BALANCE_CHECK_MAX_RETRIES * BALANCE_CHECK_RETRY_MS);
  if (totalWeth <= 0) { log('error', 'scalp', 'WETH never appeared.'); return; }
  log('info', 'scalp', `WETH received: ${totalWeth.toFixed(4)}`);

  log('info', 'scalp', 'Stabilizing 3s...');
  await sleep(3000);

  const result = await gapMonitor(entryBid, entryAsk);

  if (result === 'SL') {
    windowSize = SL_WINDOW;
    cooldown = COOLDOWN_POLLS;
    log('warn', 'scalp', `SL. Window=${SL_WINDOW} Cooldown=${COOLDOWN_POLLS}polls.`);
  } else {
    windowSize = NORMAL_WINDOW;
    cooldown = COOLDOWN_POLLS;
    log('info', 'scalp', `TP. Window=${NORMAL_WINDOW} Cooldown=${COOLDOWN_POLLS}polls.`);
  }

  await sleep(SELL_WAIT_MS);
}

// ====== Main ======

async function runBot() {
  log('banner', 'startup', '=== Scalper Mainnet (Range) ===');
  log('banner', 'startup', `Pair=${PAIR} Buy=$${BUY_USDSO} Win=${NORMAL_WINDOW}/${SL_WINDOW} Range≥$${MIN_RANGE} TP+${TP_AMOUNT} SL-${SL_AMOUNT} Buffer=${SELL_BUFFER} Poll=${POLL_INTERVAL_MS / 1000}s`);

  log('info', 'main', 'Fetching market info...');
  const marketInfo = await fetchMarketInfo();
  poolAddress = marketInfo.poolAddress;
  baseToken = marketInfo.baseToken;
  quoteToken = marketInfo.quoteToken;

  try {
    const dec = await publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: 'decimals' });
    quoteDecimals = dec;
  } catch {}

  let balances = await getWalletBalances();
  log('info', 'main', `Wallet: ${balances.usdso} USDso | ${balances.weth} WETH`);
  initialBalance = parseFloat(balances.usdso);

  await authenticate();

  const startupWeth = parseFloat(balances.weth);
  if (startupWeth >= 0.001) {
    log('warn', 'main', `WETH ${startupWeth.toFixed(4)} leftover, selling...`);
    await sellAllWeth(SELL_BUFFER);
    balances = await getWalletBalances();
  } else if (startupWeth > 0) {
    log('info', 'main', `WETH ${startupWeth.toFixed(4)} (< 0.001), skip.`);
  }

  if (parseFloat(balances.usdso) < BUY_USDSO) {
    log('error', 'main', `Insufficient USDso. Exiting.`);
    process.exit(1);
  }

  await approveIfNeeded(quoteToken, 'USDso', quoteDecimals);
  await approveIfNeeded(baseToken, 'WETH', 18);

  log('info', 'main', `Polling ${POLL_INTERVAL_MS / 1000}s. Window: ${NORMAL_WINDOW}/${SL_WINDOW} Range≥$${MIN_RANGE} TP+${TP_AMOUNT} SL-${SL_AMOUNT}`);

  const intervalId = setInterval(async () => {
    if (isTrading || stopFlag) return;
    isTrading = true;
    try {
      const ob = await fetchOrderbook();
      if (!ob) { isTrading = false; return; }

      const mid = (ob.bestBid + ob.bestAsk) / 2;
      priceWindow.push(mid);
      if (priceWindow.length > windowSize) priceWindow.shift();

      // Check range trigger whenever window is full
      if (priceWindow.length >= windowSize) {
        const range = Math.max(...priceWindow) - Math.min(...priceWindow);
        log('info', 'state', `Window ${priceWindow.length}/${windowSize} Range: $${range.toFixed(2)}${cooldown > 0 ? ` Cooldown:${cooldown}` : ''}${range >= MIN_RANGE ? ' → TRIGGER!' : ''}`);

        if (range >= MIN_RANGE) {
          // Allow trigger even during cooldown
          log('success', 'signal', `Range $${range.toFixed(2)} >= $${MIN_RANGE}! Buying...`);
          try { await executeScalp(); } finally { isTrading = false; }
          return;
        }
      }

      // Decrease cooldown if active
      if (cooldown > 0) {
        cooldown--;
        if (cooldown <= 0) {
          windowSize = NORMAL_WINDOW;
          log('info', 'state', 'Cooldown done. Back to normal.');
        }
      }

      isTrading = false;
    } catch (err) {
      log('error', 'poll', err.message);
      isTrading = false;
    }
  }, POLL_INTERVAL_MS);

  process.on('SIGINT', () => { log('info', 'shutdown', 'SIGINT'); stopFlag = true; clearInterval(intervalId); process.exit(0); });
  process.on('SIGTERM', () => { log('info', 'shutdown', 'SIGTERM'); stopFlag = true; clearInterval(intervalId); process.exit(0); });
}

runBot().catch(err => { log('error', 'fatal', err.message); console.error(err); process.exit(1); });
