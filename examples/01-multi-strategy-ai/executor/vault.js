/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { parseUnits, formatUnits, formatEther } from 'viem';
import {
  publicClient,
  walletClient,
  account,
  SPOT_POOL_ABI,
  ERC20_ABI,
  safeEstimateGas,
} from './viemClient.js';
import { httpRequest } from '../utils/http.js';
import { log } from '../utils/logger.js';
import { CONFIG } from '../config.js';
import { getAuthHeaders } from '../utils/auth.js';
import { isInitialDepositDone, markInitialDeposit, getState } from '../memory/index.js';

let cachedPoolAddress = null;
let cachedBaseToken = null;
let cachedQuoteToken = null;
let cachedQuoteDecimals = 6;

export function getPoolAddress() {
  return cachedPoolAddress;
}

export function getBaseToken() {
  return cachedBaseToken;
}

export function getQuoteToken() {
  return cachedQuoteToken;
}

export function getQuoteDecimals() {
  return cachedQuoteDecimals;
}

export async function fetchMarketInfo() {
  log('info', 'vault', 'Fetching market metadata...');

  const res = await httpRequest('GET', '/v0/markets');
  if (res.status !== 200) throw new Error('Failed to fetch markets');

  const markets = res.body.markets || [];
  const market = markets.find((m) => m.symbol === CONFIG.MARKET_SYMBOL);
  if (!market) throw new Error(`Market ${CONFIG.MARKET_SYMBOL} not found`);

  cachedPoolAddress = market.contract;
  cachedBaseToken = market.base;
  cachedQuoteToken = market.quote;

  const currRes = await httpRequest('GET', '/v0/currencies');
  if (currRes.status === 200) {
    const currencies = currRes.body.currencies || [];
    const usdso = currencies.find((c) => c.code === 'USDso');
    if (usdso) {
      cachedQuoteDecimals = usdso.decimals || 6;
      log('info', 'vault', `USDso decimals: ${cachedQuoteDecimals}`);
    }
  }

  log('info', 'vault', `Pool: ${cachedPoolAddress}`);
  return { poolAddress: cachedPoolAddress, baseToken: cachedBaseToken, quoteToken: cachedQuoteToken };
}

export async function getVaultBalances() {
  const baseBal = await publicClient.readContract({
    address: cachedPoolAddress,
    abi: SPOT_POOL_ABI,
    functionName: 'getWithdrawableBalance',
    args: [CONFIG.WALLET_ADDRESS, cachedBaseToken],
  });

  const quoteBal = await publicClient.readContract({
    address: cachedPoolAddress,
    abi: SPOT_POOL_ABI,
    functionName: 'getWithdrawableBalance',
    args: [CONFIG.WALLET_ADDRESS, cachedQuoteToken],
  });

  return {
    wethFree: formatEther(baseBal),
    usdsoFree: formatUnits(quoteBal, cachedQuoteDecimals),
    wethRaw: baseBal,
    usdsoRaw: quoteBal,
  };
}

export async function getWalletBalances() {
  const native = await publicClient.getBalance({ address: CONFIG.WALLET_ADDRESS });

  const usdsoBal = await publicClient.readContract({
    address: cachedQuoteToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONFIG.WALLET_ADDRESS],
  });

  return {
    native: formatEther(native),
    usdso: formatUnits(usdsoBal, cachedQuoteDecimals),
    nativeRaw: native,
    usdsoRaw: usdsoBal,
  };
}

export async function depositUsdsoOnce() {
  const vaultBal = await getVaultBalances();

  if (isInitialDepositDone() && parseFloat(vaultBal.usdsoFree) > 0) {
    log('info', 'vault', 'Initial deposit already done and vault funded, skipping.');
    return;
  }

  if (parseFloat(vaultBal.usdsoFree) > 0) {
    log('info', 'vault', `Vault already has ${vaultBal.usdsoFree} USDso, no deposit needed.`);
    return;
  }

  const amount = CONFIG.INITIAL_DEPOSIT_USDSO;
  const amountRaw = parseUnits(String(amount), cachedQuoteDecimals);

  log('info', 'vault', `Performing one-time deposit of ${amount} USDso...`);

  const walletBal = await getWalletBalances();
  if (walletBal.usdsoRaw < amountRaw) {
    throw new Error(
      `Insufficient USDso in wallet: ${walletBal.usdso} < ${amount}. Need to fund wallet first.`
    );
  }

  const authHeaders = await getAuthHeaders(walletClient, account);

  const allowanceRaw = await publicClient.readContract({
    address: cachedQuoteToken,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [CONFIG.WALLET_ADDRESS, cachedPoolAddress],
  });

  if (allowanceRaw < amountRaw) {
    log('info', 'vault', 'Approving USDso spending...');
    const maxApproval = parseUnits('1000000', cachedQuoteDecimals);
    const approveHash = await walletClient.writeContract({
      address: cachedQuoteToken,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [cachedPoolAddress, maxApproval],
      gas: 5000000n,
    });
    log('info', 'vault', `Approve tx: ${approveHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 60000 });
    log('success', 'vault', 'USDso approved.');
  }

  const depositPayloadRes = await httpRequest(
    'POST',
    `/v0/markets/${CONFIG.MARKET_SYMBOL}/vault/deposit`,
    authHeaders,
    {
      walletAddress: CONFIG.WALLET_ADDRESS,
      currency: 'USDso',
      amount: String(amount),
    }
  );

  let depositHash;
  if (depositPayloadRes.status === 200 && depositPayloadRes.body?.to) {
    const p = depositPayloadRes.body;
    depositHash = await walletClient.sendTransaction({
      to: p.to,
      data: p.data,
      value: p.value ? BigInt(p.value) : 0n,
      gas: p.gasLimit ? BigInt(p.gasLimit) : 5000000n,
    });
  } else {
    depositHash = await walletClient.writeContract({
      address: cachedPoolAddress,
      abi: SPOT_POOL_ABI,
      functionName: 'deposit',
      args: [cachedQuoteToken, amountRaw],
      gas: 5000000n,
    });
  }

  log('info', 'vault', `Deposit tx: ${depositHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 60000 });

  if (receipt.status === 'success') {
    markInitialDeposit(amount);
    log('success', 'vault', `Initial deposit of ${amount} USDso confirmed!`);
  } else {
    throw new Error(`Deposit reverted: ${depositHash}`);
  }
}

export async function getOpenOrdersOnChain() {
  return await publicClient.readContract({
    address: cachedPoolAddress,
    abi: SPOT_POOL_ABI,
    functionName: 'getOwnOpenOrders',
  });
}
