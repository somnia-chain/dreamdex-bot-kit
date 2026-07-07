/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { parseUnits, formatUnits } from 'viem';
import { walletClient, account, publicClient, safeEstimateGas } from './viemClient.js';
import { getPoolAddress, getBaseToken, getQuoteToken, getQuoteDecimals } from './vault.js';
import { httpRequest } from '../utils/http.js';
import { log } from '../utils/logger.js';
import { CONFIG } from '../config.js';

const ORDER_PLACED_TOPIC =
  '0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d';

export async function placeVaultLimitOrder(authHeaders, { side, price, amount }) {
  const orderPayload = {
    type: 'limit',
    side: side.toLowerCase(),
    price: String(price),
    amount: String(amount),
    walletAddress: CONFIG.WALLET_ADDRESS,
    fundingSource: 'vault',
    orderType: 'postOnly',
  };

  log('info', 'orders', `Preparing ${side} order: ${amount} WETH @ ${price}`);

  const prepRes = await httpRequest(
    'POST',
    `/v0/markets/${CONFIG.MARKET_SYMBOL}/orders`,
    authHeaders,
    orderPayload
  );

  if (prepRes.status !== 200 || !prepRes.body?.to) {
    log('error', 'orders', `Prepare order failed: ${prepRes.status} ${JSON.stringify(prepRes.body)}`);
    return null;
  }

  const p = prepRes.body;
  const txHash = await walletClient.sendTransaction({
    to: p.to,
    data: p.data,
    value: p.value ? BigInt(p.value) : 0n,
    gas: p.gasLimit ? BigInt(p.gasLimit) : 5000000n,
  });

  log('info', 'orders', `Order tx sent: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45000 });

  if (receipt.status !== 'success') {
    log('error', 'orders', 'Order tx reverted');
    return null;
  }

  let orderId = null;
  for (const logEntry of receipt.logs) {
    if (logEntry.topics?.[0] === ORDER_PLACED_TOPIC) {
      orderId = BigInt(logEntry.topics[1]).toString();
      break;
    }
  }

  if (orderId) {
    log('success', 'orders', `Order placed: ID=${orderId}, ${side} ${amount} @ ${price}`);
  }

  return {
    orderId,
    txHash,
    side,
    price,
    amount,
    receipt,
  };
}

export async function placeMarketOrder(authHeaders, { side, amount }) {
  const orderPayload = {
    type: 'market',
    side: side.toLowerCase(),
    amount: String(amount),
    walletAddress: CONFIG.WALLET_ADDRESS,
    fundingSource: 'vault',
  };

  log('info', 'orders', `Placing MARKET ${side} order: ${amount} WETH`);

  const prepRes = await httpRequest(
    'POST',
    `/v0/markets/${CONFIG.MARKET_SYMBOL}/orders`,
    authHeaders,
    orderPayload
  );

  if (prepRes.status !== 200 || !prepRes.body?.to) {
    log('error', 'orders', `Market order prepare failed: ${prepRes.status}`);
    return null;
  }

  const p = prepRes.body;
  const txHash = await walletClient.sendTransaction({
    to: p.to,
    data: p.data,
    value: p.value ? BigInt(p.value) : 0n,
    gas: p.gasLimit ? BigInt(p.gasLimit) : 8000000n,
  });

  log('info', 'orders', `Market order tx: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45000 });

  if (receipt.status !== 'success') {
    log('error', 'orders', 'Market order reverted');
    return null;
  }

  let filledPrice = null;
  let orderId = null;
  for (const logEntry of receipt.logs) {
    if (logEntry.topics?.[0] === ORDER_PLACED_TOPIC) {
      orderId = BigInt(logEntry.topics[1]).toString();
    }
  }

  log('success', 'orders', `Market ${side} executed: ${amount} WETH. Tx: ${txHash}`);
  return { orderId, txHash, side, amount: parseFloat(amount), filledPrice, receipt };
}

export async function cancelOrderById(authHeaders, orderId) {
  log('info', 'orders', `Cancelling order ${orderId}...`);

  const cancelRes = await httpRequest(
    'DELETE',
    `/v0/markets/${CONFIG.MARKET_SYMBOL}/orders/${orderId}`,
    authHeaders
  );

  if (cancelRes.status !== 200 || !cancelRes.body?.to) {
    log('error', 'orders', `Cancel prepare failed: ${cancelRes.status}`);
    return null;
  }

  const cp = cancelRes.body;
  const txHash = await walletClient.sendTransaction({
    to: cp.to,
    data: cp.data,
    value: cp.value ? BigInt(cp.value) : 0n,
    gas: cp.gasLimit ? BigInt(cp.gasLimit) : 5000000n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45000 });

  if (receipt.status === 'success') {
    log('success', 'orders', `Order ${orderId} cancelled: ${txHash}`);
    return { success: true, txHash };
  }

  log('error', 'orders', `Cancel reverted for ${orderId}`);
  return { success: false };
}

export async function getOrderFromAPI(authHeaders, orderId) {
  const res = await httpRequest(
    'GET',
    `/v0/markets/${CONFIG.MARKET_SYMBOL}/orders/${orderId}`,
    authHeaders
  );
  if (res.status === 200) return res.body;
  return null;
}

export async function getOpenOrdersFromAPI(authHeaders) {
  const res = await httpRequest(
    'GET',
    `/v0/markets/${CONFIG.MARKET_SYMBOL}/orders`,
    authHeaders
  );
  if (res.status === 200) return res.body.orders || res.body || [];
  return [];
}
