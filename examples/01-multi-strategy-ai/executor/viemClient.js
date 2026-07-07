/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseUnits,
  formatUnits,
  parseEther,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from '../config.js';

const somniaTestnet = defineChain({
  id: CONFIG.CHAIN_ID,
  name: 'Somnia Testnet',
  network: 'somnia-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Somnia Token',
    symbol: 'STT',
  },
  rpcUrls: {
    default: { http: [CONFIG.RPC_URL] },
    public: { http: [CONFIG.RPC_URL] },
  },
});

export const account = privateKeyToAccount(CONFIG.PRIVATE_KEY);

export const publicClient = createPublicClient({
  chain: somniaTestnet,
  transport: http(),
});

export const walletClient = createWalletClient({
  account,
  chain: somniaTestnet,
  transport: http(),
});

export const SPOT_POOL_ABI = [
  {
    inputs: [],
    name: 'getPoolParams',
    outputs: [
      { internalType: 'address', name: 'baseToken_', type: 'address' },
      { internalType: 'address', name: 'quoteToken_', type: 'address' },
      { internalType: 'uint256', name: 'makerFeeBpsTimes1k_', type: 'uint256' },
      { internalType: 'uint256', name: 'takerFeeBpsTimes1k_', type: 'uint256' },
      { internalType: 'uint256', name: 'tickSize_', type: 'uint256' },
      { internalType: 'uint256', name: 'minQuantity_', type: 'uint256' },
      { internalType: 'uint256', name: 'lotSize_', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'token', type: 'address' },
    ],
    name: 'getWithdrawableBalance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getOwnOpenOrders',
    outputs: [{ internalType: 'uint128[]', name: '', type: 'uint128[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'depositNative',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint128', name: 'orderId', type: 'uint128' }],
    name: 'cancelOrder',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

export const ERC20_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export async function safeEstimateGas(txParams, fallback = 5000000n) {
  try {
    const estimate = await publicClient.estimateContractGas(txParams);
    return (estimate * 12n) / 10n;
  } catch {
    return fallback;
  }
}
