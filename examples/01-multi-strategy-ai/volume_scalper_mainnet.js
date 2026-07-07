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
CONFIG.PRIVATE_KEY = process.env.MAINNET_BOT_PK || CONFIG.PRIVATE_KEY;
CONFIG.WALLET_ADDRESS = (process.env.MAINNET_WALLET_ADDRESS || CONFIG.WALLET_ADDRESS).toLowerCase();

log('info', 'config', `Mainnet: RPC=${CONFIG.RPC_URL} | API=${CONFIG.API_URL} | ChainID=${CONFIG.CHAIN_ID}`);

const mainnetChain = {
  id: CONFIG.CHAIN_ID,
  name: 'Somnia',
  nativeCurrency: { decimals: 18, name: 'Somnia Token', symbol: 'STT' },
  rpcUrls: { default: { http: [CONFIG.RPC_URL] }, public: { http: [CONFIG.RPC_URL] } },
};

const mainnetPublicClient = createPublicClient({ chain: mainnetChain, transport: http() });
const publicClient = mainnetPublicClient;

const botAccount = privateKeyToAccount(CONFIG.PRIVATE_KEY);
const botWalletClient = createWalletClient({
  account: botAccount,
  chain: mainnetChain,
  transport: http(),
});
log('info', 'wallet', `Wallet: ${botAccount.address}`);

const PAIR = 'WETH:USDso';
const BUY_USDSO = 10;
const APPROVE_AMOUNT = 1000000;
const LOT_SIZE = 0.0001;
const TICK_SIZE = 0.01;
const POLL_MS = 1000;
const RETRY_SELL_MS = 500;
const BALANCE_RETRY_MS = 200;
const SELL_BUFFER = 0.05;
const MAX_SPREAD = 0.43;

let poolAddress = null;
let baseToken = null;
let quoteToken = null;
let quoteDecimals = 18;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function roundToLotSize(amount) {
  return Math.floor(amount / LOT_SIZE + 1e-9) * LOT_SIZE;
}

function roundToTickSize(amount) {
  return Math.round(amount / TICK_SIZE + 1e-9) * TICK_SIZE;
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
    bid: parseFloat(bids[0].price || bids[0][0]),
    ask: parseFloat(asks[0].price || asks[0][0]),
    bidQty: parseFloat(bids[0].quantity || bids[0].amount || bids[0][1] || 0),
    askQty: parseFloat(asks[0].quantity || asks[0].amount || asks[0][1] || 0),
  };
}

async function placeOrder(side, price, amount) {
  try {
    const authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    const payload = {
      type: 'limit',
      side,
      price: String(price),
      amount: String(amount),
      walletAddress: CONFIG.WALLET_ADDRESS,
      fundingSource: 'wallet',
      orderType: 'immediateOrCancel',
    };
    log('info', 'trade', `Placing ${side.toUpperCase()} ${amount} WETH @ ${price}`);
    const prep = await httpRequest('POST', `/v0/markets/${PAIR}/orders`, authHeaders, payload);
    if (prep.status !== 200 || !prep.body?.to) {
      log('error', 'trade', `Prepare failed: ${prep.status} ${JSON.stringify(prep.body?.description || '')}`);
      return null;
    }
    const p = prep.body;
    const txHash = await botWalletClient.sendTransaction({
      to: p.to, data: p.data,
      value: p.value ? BigInt(p.value) : 0n,
      gas: 1000000n,
    });
    log('info', 'trade', `Tx sent: ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45000 });
    if (receipt.status !== 'success') {
      log('error', 'trade', 'Tx reverted');
      return null;
    }

    const ORDER_PLACED_TOPIC = '0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d';
    for (const logEntry of receipt.logs) {
      if (logEntry.topics?.[0] === ORDER_PLACED_TOPIC) {
        log('success', 'trade', `${side.toUpperCase()} filled! ${amount} WETH @ ${price} | Tx: ${txHash}`);
        return { txHash };
      }
    }
    log('warn', 'trade', `${side.toUpperCase()} IOC not filled at ${price}`);
    return { filled: false };
  } catch (err) {
    log('error', 'trade', `Order error: ${err.message}`);
    return null;
  }
}

async function getWethBalance() {
  const bal = await publicClient.readContract({
    address: baseToken, abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONFIG.WALLET_ADDRESS],
  });
  return parseFloat(formatUnits(bal, 18));
}

async function buySellCycle(authHeaders, initialAsk, initialBid) {
  log('info', 'cycle', `Ask: ${initialAsk.toFixed(4)} | Initial bid: ${initialBid.toFixed(4)} | Spread: ${(initialAsk - initialBid).toFixed(4)}`);

  let buyAmount = roundToLotSize(BUY_USDSO / initialAsk);
  if (buyAmount <= 0) return false;

  let buyResult = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const freshOb = await fetchOrderbook();
    const currentAsk = freshOb ? freshOb.ask : initialAsk;
    const buyPrice = roundToTickSize(currentAsk).toFixed(8);
    log('info', 'cycle', `BUY ${buyAmount.toFixed(4)} WETH @ ${buyPrice} (retry ${attempt + 1}/3)`);
    buyResult = await placeOrder('buy', buyPrice, buyAmount.toFixed(8));
    if (buyResult && buyResult.filled !== false) break;
    await sleep(500);
  }
  if (!buyResult || buyResult.filled === false) return false;

  // 3. Wait for WETH to appear in wallet
  let weth = 0;
  for (let i = 0; i < 30; i++) {
    weth = await getWethBalance();
    if (weth > 0) break;
    await sleep(BALANCE_RETRY_MS);
  }
  if (weth <= 0) {
    log('error', 'cycle', 'WETH never appeared');
    return false;
  }

  let sellAmount = roundToLotSize(weth);
  if (sellAmount <= 0) return false;

  // 4. Sell at initial bid - buffer (same price every attempt)
  const sellPrice = roundToTickSize(initialBid - SELL_BUFFER).toFixed(8);
  log('info', 'cycle', `SELL ${sellAmount.toFixed(4)} WETH @ ${sellPrice} (initial bid ${initialBid.toFixed(4)} - buffer ${SELL_BUFFER})`);

  for (let attempt = 1; attempt <= 20; attempt++) {
    const sellResult = await placeOrder('sell', sellPrice, sellAmount.toFixed(8));
    if (sellResult && sellResult.filled !== false) {
      const finalWeth = await getWethBalance();
      log('success', 'cycle', `Sell success! WETH left: ${finalWeth.toFixed(4)}`);
      return true;
    }
    log('info', 'cycle', `Sell retry ${attempt}/20 @ ${sellPrice}...`);
    await sleep(RETRY_SELL_MS);
  }

  log('error', 'cycle', 'Sell failed after 20 retries');
  return false;
}

async function main() {
  log('info', 'main', '=== Volume Scalper Mainnet ===');
  log('info', 'main', `Pair: ${PAIR} | Buy: ${BUY_USDSO} USDso | Max spread: ${MAX_SPREAD} | Sell buffer: ${SELL_BUFFER}`);

  // Setup
  log('info', 'main', 'Fetching market info...');
  const marketInfo = await fetchMarketInfo();
  poolAddress = marketInfo.poolAddress;
  baseToken = marketInfo.baseToken;
  quoteToken = marketInfo.quoteToken;

  const dec = await publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: 'decimals' });
  quoteDecimals = dec || 6;

  const balances = await getWethBalance();
  log('info', 'main', `Wallet ready. SOMI gas: OK`);

  // Approve
  for (const [addr, sym, decs] of [[quoteToken, 'USDso', quoteDecimals], [baseToken, 'WETH', 18]]) {
    const allowance = await publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'allowance', args: [CONFIG.WALLET_ADDRESS, poolAddress] });
    const raw = parseUnits(String(APPROVE_AMOUNT), decs);
    if (allowance < raw) {
      log('info', 'approve', `Approving ${APPROVE_AMOUNT} ${sym}...`);
      const tx = await botWalletClient.writeContract({ address: addr, abi: ERC20_ABI, functionName: 'approve', args: [poolAddress, raw * 10n], gas: 5000000n });
      await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60000 });
    } else {
      log('info', 'approve', `${sym} already approved`);
    }
  }

  log('info', 'main', `Starting volume loops...\n`);

  // Main loop
  let cycleCount = 0;
  while (true) {
    // Check spread first
    const ob = await fetchOrderbook();
    if (!ob) {
      await sleep(POLL_MS);
      continue;
    }
    const spread = ob.ask - ob.bid;
    log('info', 'main', `Spread: ${spread.toFixed(4)} (max: ${MAX_SPREAD})`);

    if (spread > MAX_SPREAD) {
      log('info', 'main', `Spread ${spread.toFixed(4)} > ${MAX_SPREAD}, waiting...`);
      await sleep(POLL_MS);
      continue;
    }

    cycleCount++;
    log('banner', 'main', `=== Volume Cycle #${cycleCount} | Spread: ${spread.toFixed(4)} ===`);

    const authHeaders = await getAuthHeaders(botWalletClient, botAccount);
    const success = await buySellCycle(authHeaders, ob.ask, ob.bid);

    if (!success) {
      log('warn', 'main', `Cycle ${cycleCount} incomplete. Continuing...`);
    }

    await sleep(POLL_MS);
  }
}

main().catch(err => {
  log('error', 'fatal', err.message);
  console.error(err);
  process.exit(1);
});
