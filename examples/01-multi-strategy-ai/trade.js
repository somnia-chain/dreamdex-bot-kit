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
import { parseUnits, formatUnits } from 'viem';
import { CONFIG } from './config.js';
import { getAuthHeaders } from './utils/auth.js';
import { httpRequest } from './utils/http.js';
import { log } from './utils/logger.js';
import { publicClient, ERC20_ABI } from './executor/viemClient.js';
import { fetchMarketInfo } from './executor/vault.js';
import { walletClient, account } from './executor/viemClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const PAIR = CONFIG.MARKET_SYMBOL;
const NOMINAL_USDSO = 10;
const LOT_SIZE = 0.0001;
const TICK_SIZE = 0.01;
const BUFFER = 0.0001;

const args = process.argv.slice(2);
const isBuy = args.includes('--buy') || args.includes('-b');
const isSell = args.includes('--sell') || args.includes('-s');

if (!isBuy && !isSell) {
  console.error('Usage: node trade.js --buy  (or --sell)');
  process.exit(1);
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
    bid: parseFloat(bids[0].price || bids[0][0] || 0),
    ask: parseFloat(asks[0].price || asks[0][0] || 0),
  };
}

async function placeOrder(side, price, amount) {
  const authHeaders = await getAuthHeaders(walletClient, account);
  const payload = {
    type: 'limit',
    side,
    price: String(price),
    amount: String(amount),
    walletAddress: CONFIG.WALLET_ADDRESS,
    fundingSource: 'wallet',
    orderType: 'immediateOrCancel',
  };
  log('info', 'trade', `Placing ${side.toUpperCase()} ${amount} WETH @ ${price} (IOC)...`);

  const prep = await httpRequest('POST', `/v0/markets/${PAIR}/orders`, authHeaders, payload);
  if (prep.status !== 200 || !prep.body?.to) {
    log('error', 'trade', `Prepare failed: ${prep.status} ${JSON.stringify(prep.body)}`);
    return null;
  }

  const p = prep.body;
  const txHash = await walletClient.sendTransaction({
    to: p.to, data: p.data,
    value: p.value ? BigInt(p.value) : 0n,
    gas: p.gasLimit ? BigInt(p.gasLimit) : 8000000n,
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
      log('success', 'trade', `${side.toUpperCase()} filled! Tx: ${txHash}`);
      return { txHash, receipt };
    }
  }
  log('warn', 'trade', `${side.toUpperCase()} IOC cancelled (not filled).`);
  return null;
}

let baseToken = null;

async function main() {
  log('info', 'trade', `Initializing market info...`);
  const marketInfo = await fetchMarketInfo();
  baseToken = marketInfo.baseToken;

  log('info', 'trade', `Fetching WETH:USDso...`);

  const ob = await fetchOrderbook();
  if (!ob) {
    log('error', 'trade', 'Failed to fetch orderbook');
    process.exit(1);
  }
  log('info', 'trade', `Bid: ${ob.bid.toFixed(4)} | Ask: ${ob.ask.toFixed(4)}`);

  if (isBuy) {
    const price = roundToTickSize(ob.ask + BUFFER);
    let amount = roundToLotSize(NOMINAL_USDSO / ob.ask);
    if (amount <= 0) { log('error', 'trade', 'Amount too small'); process.exit(1); }
    log('info', 'trade', `Buying ${amount} WETH @ ask ${ob.ask.toFixed(4)} (order @ ${price})`);

    const result = await placeOrder('buy', price.toFixed(8), amount.toFixed(8));
    if (!result) {
      log('error', 'trade', 'Buy failed');
      process.exit(1);
    }

    const bal = await publicClient.readContract({
      address: baseToken,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [CONFIG.WALLET_ADDRESS],
    });
    log('success', 'trade', `WETH balance: ${formatUnits(bal, 18)}`);
  }

  if (isSell) {
    const wethBal = await publicClient.readContract({
      address: baseToken,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [CONFIG.WALLET_ADDRESS],
    });
    let amount = roundToLotSize(parseFloat(formatUnits(wethBal, 18)));
    if (amount <= 0) { log('error', 'trade', 'No WETH to sell'); process.exit(1); }

    const price = roundToTickSize(ob.bid - BUFFER);
    log('info', 'trade', `Selling ${amount} WETH @ bid ${ob.bid.toFixed(4)} (order @ ${price})`);

    const result = await placeOrder('sell', price.toFixed(8), amount.toFixed(8));
    if (!result) {
      log('error', 'trade', 'Sell failed');
      process.exit(1);
    }
    log('success', 'trade', `Sell complete.`);
  }
}

main().catch(err => {
  log('error', 'trade', err.message);
  process.exit(1);
});
